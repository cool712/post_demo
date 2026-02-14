import {
    PoseLandmarker,
    FilesetResolver
} from "/mediapipe/tasks-vision/tasks-vision@latest.js";

import { state, CONSTANTS } from './state.js';
import { showDynamicIsland, hideDynamicIsland, updateDynamicIslandRotation } from './ui.js';
import { drawSafeZone, drawSkeleton, drawCountdown } from './drawing.js';
import { pauseRecord, stopAndUpload, _startMediaRecorder, updateRecordingCanvas } from './recorder.js';

/* ---------- 拍人模式初始化 ---------- */
state.facingMode = "environment";
state.isHandheld = false; // 拍人模式禁用手持检测

/* ---------- DOM 初始化 ---------- */
state.video = document.getElementById("video");
state.canvas = document.getElementById("canvas");
state.ctx = state.canvas.getContext("2d", { alpha: true });

// iOS 权限遮罩元素
const authMask = document.getElementById('ios-auth-mask');
const authBtn = document.getElementById('auth-btn');

let dynamicScale = 0.5;
let frameCount = 0;
let lastFpsCheck = 0;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
             (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// 按钮点击事件
authBtn.addEventListener('click', async () => {
    await requestSensorPermission(); // 必须在点击回调内立即执行
    authMask.style.display = 'none'; // 关闭遮罩
    main(); // 启动摄像头和 AI
});
/* ---------- 事件监听器 ---------- */
// 应要求，拍人模式不需要 devicemotion 监听器

window.addEventListener('deviceorientation', (event) => {
    const gamma = event.gamma;
    const beta = event.beta;
    
    if (gamma === null || beta === null) return;

    if (Math.abs(gamma) > 45) {
        if (gamma > 0) {
            state.currentDeviceRotation = -90;
        } else {
            state.currentDeviceRotation = 90;
        }
    } else {
        if (Math.abs(beta) > 135) {
            state.currentDeviceRotation = 180;
        } else {
            state.currentDeviceRotation = 0;
        }
    }
    // updateToastRotation(); // 已移除
    try { updateDynamicIslandRotation(); } catch(e){}
    try { updateAllDialogsRotation(); } catch(e){}
});

/* ---------- 按钮监听器 ---------- */
// 没有弹窗，所以不需要按钮监听器。
// 暴露给外部触发的方法（替换标准的 startRecord 行为）
window.startRecord = () => {
    if (state.isRecording || state.autoRecordState === 'COUNTDOWN') return;

    // 开始倒计时
    state.autoRecordState = 'COUNTDOWN';
    state.countdownStartTime = Date.now();
    console.log("通过手动触发开始倒计时 (startRecord)");
};

/* ---------- 摄像头 ---------- */
async function startCamera() {
    if (state.video.srcObject) state.video.srcObject.getTracks().forEach(t => t.stop());
    
    state.video.style.transform = state.facingMode === "user" ? "scaleX(-1)" : "none";

    try {
        // 1. 获取权限并刷新标签
        const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        tempStream.getTracks().forEach(t => t.stop());

        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        console.log("设备列表明细:", videoDevices);

        // 2. 智能选镜：优先匹配后置主摄
        let targetDevice = null;
        if (state.facingMode === "environment") {
            // 华为策略：寻找 label 包含 "back" 且包含 "0" 的，通常这才是真正的 1.0x 主摄
            targetDevice = videoDevices.find(d => {
                const l = d.label.toLowerCase();
                return l.includes('back') && l.includes('0');
            }) || videoDevices.find(d => d.label.toLowerCase().includes('back'));
        } else {
            targetDevice = videoDevices.find(d => d.label.toLowerCase().includes('front'));
        }

        // 3. 确定最终 ID 和 镜像状态
        const finalDeviceId = targetDevice ? targetDevice.deviceId : null;
        
        // 【关键】修正镜像判定：只要是后置，哪怕驱动报错，我们也强制不镜像
        state.isMirror = (state.facingMode === "user");
        
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                deviceId: finalDeviceId ? { exact: finalDeviceId } : undefined,
                facingMode: state.facingMode,
                width: { ideal: 1280 },
                height: { ideal: 768 },
                resizeMode: "none"
            }
        });
        state.video.srcObject = stream;
        // 打印摄像头信息，不影响
        const videoTrack = stream.getVideoTracks()[0];
        const capabilities = videoTrack.getCapabilities?.();
        console.log('当前激活镜头:', videoTrack.label);
        console.log('[Camera Capabilities]', capabilities);
        
        // 4. 应用 UI 镜像
        state.video.style.transform = state.isMirror ? "scaleX(-1)" : "none";
        return new Promise(resolve => {
            state.video.onloadedmetadata = () => {
                state.video.play();
                state.canvas.width = state.video.videoWidth;
                state.canvas.height = state.video.videoHeight;
                state.running = true;
                resolve();
            };
        });
    } catch (err) {
        console.error("Camera Error: " + err.message);
    }
}

window.toggleCamera = async () => {
    state.running = false;
    state.facingMode = state.facingMode === "user" ? "environment" : "user";
    await startCamera();
    return state.facingMode;
};

/* ---------- AI 模型 ---------- */
/* ---------- 修正后的 AI 模型加载 ---------- */
async function initAI() {
    try {
        const vision = await FilesetResolver.forVisionTasks("/mediapipe/tasks-vision/wasm");
        
        // 封装具体的创建逻辑
        const createLandmarker = async (delegateType) => {
            return await PoseLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: "/mediapipe/model/pose_landmarker_full.task", // 路径保持不变
                    delegate: delegateType
                },
                runningMode: "VIDEO",
                numPoses: 1,
                minPoseDetectionConfidence: 0.5,
                minPosePresenceConfidence: 0.5,
                minTrackingConfidence: 0.5
            });
        };

        try {
            console.log("🚀 尝试初始化 GPU 模式...");
            state.poseLandmarker = await createLandmarker("GPU");
            console.log("✅ GPU 模式加载成功");
        } catch (gpuError) {
            // 这里非常关键：捕获到 GPU 错误（即你日志里的 WebGL 错误）后，强制进入 CPU 流程
            console.warn("⚠️ 检测到环境不支持 WebGL，强制回退至 CPU 运算模式...");
            
            try {
                // 在 CPU 模式下，MediaPipe 有时会因为内存分配报错，这里再次 try-catch
                state.poseLandmarker = await createLandmarker("CPU");
                console.log("ℹ️ CPU 模式加载成功（Full模型在CPU上压力较大）");
            } catch (cpuError) {
                console.error("❌ 严重错误：该设备无法运行 Full 模型", cpuError);
                showDynamicIsland("设备性能不足以运行AI");
            }
        }
    } catch (err) {
        console.error("运行时解析失败:", err);
    }
}

/* ---------- 循环 ---------- */
function loop(ts) {
    requestAnimationFrame(loop);
    // try { updateAllDialogsRotation(); } catch(e){} // 已移除

    if (!state.running) return;

    // 每一帧检查并更新 Canvas 尺寸，确保与视频流一致
    if (state.video.videoWidth && state.video.videoHeight && 
        (state.canvas.width !== state.video.videoWidth || state.canvas.height !== state.video.videoHeight)) {
        state.canvas.width = state.video.videoWidth;
        state.canvas.height = state.video.videoHeight;
    }

    if (!state.poseLandmarker) {
        state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        if (!state.isRecording) {
            state.SAFE_ZONE = { x: 0.025, y: 0.025, w: 0.95, h: 0.95 };
            drawSafeZone(ts);
            
            showDynamicIsland("AI模型加载中");
            // 新增测试
             if (state.autoRecordState === 'COUNTDOWN') {
                const elapsed = Date.now() - state.countdownStartTime;
                const remaining = Math.ceil((CONSTANTS.COUNTDOWN_DURATION - elapsed) / 1000);
                
                drawCountdown(remaining);
                if (elapsed >= CONSTANTS.COUNTDOWN_DURATION) {
                    _startMediaRecorder();
                }
            } else {
                showDynamicIsland("AI模型加载中");
            }
            // 测试用，确保模型加载成功
        }
        return;
    }

    // 1. 始终先绘制视频底图（防止黑屏）
    state.ctx.save();
    if (state.facingMode === "user") {
        state.ctx.translate(state.canvas.width, 0);
        state.ctx.scale(-1, 1);
    }
    state.ctx.drawImage(state.video, 0, 0, state.canvas.width, state.canvas.height);
    state.ctx.restore();

    if (!state.isRecording) {
        state.SAFE_ZONE = { x: 0.025, y: 0.025, w: 0.95, h: 0.95 };
        drawSafeZone(ts);
    }

    frameCount++;
    if (ts - lastFpsCheck > 1000) {
        const fps = frameCount;
        if (fps < 12 && dynamicScale > 0.3) dynamicScale -= 0.1;
        else if (fps > 14 && dynamicScale < 1.0) dynamicScale += 0.1;
        frameCount = 0;
        lastFpsCheck = ts;
    }

    try {
        if (state.video.readyState >= 2) {
            const result = state.poseLandmarker.detectForVideo(state.video, ts);
            if (result.landmarks && result.landmarks.length > 0) {
                processAndDraw(result.landmarks[0]);
                if (state.autoRecordState === 'DISABLED') {
                    hideDynamicIsland();
                }
            } else {
                hideDynamicIsland();
                if (!state.isRecording && state.autoRecordState !== 'DISABLED') {
                    // showToast("请站在检测框内"); // 已移除
                    // 即使没人，倒计时也不中断（已移除失去目标中断逻辑）
                    
                    // 确保没人时倒计时也能继续刷新
                    if (state.autoRecordState === 'COUNTDOWN') {
                         const elapsed = Date.now() - state.countdownStartTime;
                         const remaining = Math.ceil((CONSTANTS.COUNTDOWN_DURATION - elapsed) / 1000);
                         
                         drawCountdown(remaining);

                         if (elapsed >= CONSTANTS.COUNTDOWN_DURATION) {
                             _startMediaRecorder();
                         }
                    }
                }
            }
        }
    } catch (e) {
        console.warn("Detection skipped:", e);
    }

    // 如果正在录制，无论是否检测到人体，都更新录制画布
    if (state.isRecording) {
        updateRecordingCanvas();
    }
}

function processAndDraw(lm) {
    if (!state.isRecording && (state.autoRecordState === 'IDLE' || state.autoRecordState === 'COUNTDOWN')) {
                
        state.lastFrameLandmarks = lm;

        if (state.autoRecordState === 'COUNTDOWN') {
            const elapsed = Date.now() - state.countdownStartTime;
            const remaining = Math.ceil((CONSTANTS.COUNTDOWN_DURATION - elapsed) / 1000);

            drawCountdown(remaining);

            if (elapsed >= CONSTANTS.COUNTDOWN_DURATION) {
                _startMediaRecorder();
            }
        }
    } 

    if (state.isRecording) {
        state.poseDataJson[`frame_${state.currentRecordFrameIndex}`] = lm.map(p => [
            Math.round(p.x * 1000) / 1000,
            Math.round(p.y * 1000) / 1000,
            Math.round(p.z * 1000) / 1000,
            Math.round(p.visibility * 100) / 100
        ]);
        state.currentRecordFrameIndex++;
    }

    drawSkeleton(lm);
}

/* ---------- 导出到 Window ---------- */
// window.startRecord = startRecord; // 被上面的手动触发覆盖
window.pauseRecord = pauseRecord;
window.stopAndUpload = stopAndUpload;
async function requestSensorPermission() {
    // 针对 iOS 13+ 的主动授权请求
    if (typeof DeviceOrientationEvent !== 'undefined' && 
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
            const permission = await DeviceOrientationEvent.requestPermission();
            if (permission === 'granted') {
                console.log("传感器授权成功");
            }
        } catch (err) {
            console.warn("传感器授权被拒绝或环境不支持:", err);
        }
    }
}
/* ---------- 初始化 ---------- */
async function main() {
    try {
        // 1. 先启动摄像头，确保用户能看到预览，降低焦虑
        await startCamera();
        // 2. 启动渲染循环
        requestAnimationFrame(loop);
        
        // 3. 异步初始化 AI，不阻塞摄像头预览显示
        // 延迟 100ms 避开摄像头启动瞬间的 CPU 峰值
        setTimeout(initAI, 100);
    } catch (err) {
        console.error("初始化流程崩溃:", err);
    }
}

// 检测传感器权限状态
async function checkSensorPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' && 
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
            // 尝试获取权限状态
            const permission = await DeviceOrientationEvent.requestPermission();
            return permission === 'granted';
        } catch (err) {
            console.warn("传感器权限检查失败:", err);
            return false;
        }
    }
    return true; // 非 iOS 设备默认有权限
}

// 根据设备类型初始化
async function initializeApp() {
    if (isIOS) {
        // 检查是否已经授权
        const hasPermission = await checkSensorPermission();
        if (hasPermission) {
            // 已经授权，直接启动
            main();
        } else {
            // 未授权，显示权限请求按钮
            authMask.style.display = 'flex';
        }
    } else {
        // 非 iOS 设备直接启动
        main();
    }
}

// 启动应用
initializeApp();