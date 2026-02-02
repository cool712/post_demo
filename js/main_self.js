import {
    PoseLandmarker,
    FilesetResolver
} from "/mediapipe/tasks-vision/tasks-vision@latest.js";

import { state, CONSTANTS } from './state.js';
import { showToast, hideToast, showDynamicIsland, hideDynamicIsland, updateToastRotation, updateDynamicIslandRotation, updateAllDialogsRotation } from './ui.js';
import { calcAngle } from './utils.js';
import { checkBodyInFrame } from './pose-logic.js';
import { drawSafeZone, drawSkeleton, drawCountdown } from './drawing.js';
import { startRecord, pauseRecord, stopAndUpload, _startMediaRecorder, updateRecordingCanvas } from './recorder.js';

/* ---------- 自拍模式初始化 ---------- */
state.facingMode = "user";
state.isHandheld = false; // 自拍模式禁用手持检测
state.autoRecordState = 'IDLE'; // 默认开启自动检测逻辑

/* ---------- DOM 初始化 ---------- */
state.video = document.getElementById("video");
state.canvas = document.getElementById("canvas");
state.ctx = state.canvas.getContext("2d", { alpha: true });

let dynamicScale = 0.5;
let frameCount = 0;
let lastFpsCheck = 0;

/* ---------- 事件监听器 ---------- */
// 自拍模式不需要 devicemotion 监听器

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
    updateToastRotation();
    try { updateDynamicIslandRotation(); } catch(e){}
    try { updateAllDialogsRotation(); } catch(e){}
});

/* ---------- 按钮监听器 ---------- */
// 自拍模式没有弹窗

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
async function initAI() {
    setTimeout(async () => {
        try {
            const vision = await FilesetResolver.forVisionTasks("/mediapipe/tasks-vision/wasm");
            state.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath: "/mediapipe/model/pose_landmarker_full.task",
                    delegate: "GPU"
                },
                runningMode: "VIDEO",
                numPoses: 1,
                minPoseDetectionConfidence: 0.5,
                minPosePresenceConfidence: 0.5,
                minTrackingConfidence: 0.5
            });
        } catch (err) {
            console.error("AI Load Failed", err);
        }
    }, 1000);
}

/* ---------- 循环 ---------- */
function loop(ts) {
    requestAnimationFrame(loop);
    try { updateAllDialogsRotation(); } catch(e){}

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
                    showToast("请站在检测框内");
                    if (state.autoRecordState === 'COUNTDOWN') {
                        state.autoRecordState = 'IDLE';
                        console.log("倒计时中断：失去目标");
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
        
        const { inFrame, msg: frameMsg } = checkBodyInFrame(lm);
        // 定义需要监测的关键关节：肘部、肩部、髋部、膝部
        const keyJoints = [
            [11, 13, 15], [12, 14, 16], // 肘部
            [13, 11, 23], [14, 12, 24], // 肩部
            [11, 23, 25], [12, 24, 26], // 髋部
            [23, 25, 27], [24, 26, 28]  // 膝部
        ];

        const currentAngles = keyJoints.map(indices => calcAngle(lm[indices[0]], lm[indices[1]], lm[indices[2]]));
        let isStable = false;

        if (!state.referenceAngles || state.referenceAngles.length !== currentAngles.length) {
            // 初始化
            state.referenceAngles = currentAngles;
            state.stableStartTimestamp = Date.now();
        } else {
            // 检查波动
            let maxFluctuation = 0;
            for (let i = 0; i < currentAngles.length; i++) {
                const diff = Math.abs(currentAngles[i] - state.referenceAngles[i]);
                if (diff > maxFluctuation) maxFluctuation = diff;
            }

            if (maxFluctuation <= 5) {
                // 稳定
                const duration = Date.now() - state.stableStartTimestamp;
                if (duration > CONSTANTS.STABILITY_DURATION) {
                    isStable = true;
                }
            } else {
                // 不稳定 - 重置
                state.referenceAngles = currentAngles;
                state.stableStartTimestamp = Date.now();
            }
        }

        let statusText = "";
        let isReady = false;
        let dynamicIslandMsg = "";
        let shouldShowDynamicIsland = false;

        if (!inFrame) {
            statusText = frameMsg;
            // 如果离开画面，重置稳定性
            state.referenceAngles = null;
        } else if (!isStable) {
            statusText = `请保持姿势${CONSTANTS.STABILITY_DURATION / 1000}秒`;
        } else {
            // 在画面内且稳定超过 3 秒
            isReady = true;
            statusText = "准备就绪";
        }
        
        state.lastFrameLandmarks = lm;

        // 1. 触发逻辑 (空闲 -> 倒计时)
        if (state.autoRecordState === 'IDLE' && isReady) {
             state.autoRecordState = 'COUNTDOWN';
             state.countdownStartTime = Date.now();
        }

        // 2. 倒计时逻辑 (倒计时 -> 录制)
        // 必须保持稳定（与触发逻辑相同）。任何不稳定都会中断。
        if (state.autoRecordState === 'COUNTDOWN') {
             if (!isReady) { // isReady 意味着 (在画面内 && 稳定)
                 // 中断
                 console.log("倒计时中断：不稳定或目标丢失");
                 state.autoRecordState = 'IDLE';
                 // 如果不稳定，referenceAngles 已经在上面重置了。
                 if (!inFrame) state.referenceAngles = null;
             } else {
                 // 继续
                 const elapsed = Date.now() - state.countdownStartTime;
                 const remaining = Math.ceil((CONSTANTS.COUNTDOWN_DURATION - elapsed) / 1000);
                 
                 shouldShowDynamicIsland = true;
                 dynamicIslandMsg = "保持不动";

                 drawCountdown(remaining);

                 if (elapsed >= CONSTANTS.COUNTDOWN_DURATION) {
                     _startMediaRecorder();
                     shouldShowDynamicIsland = false;
                 }
             }
        } else {
            // 空闲状态
             state.autoRecordState = 'IDLE';
        }


        if (shouldShowDynamicIsland && !state.isRecording) {
            showDynamicIsland(dynamicIslandMsg);
        } else {
            hideDynamicIsland();
        }

        // 仅在非倒计时状态下显示状态文本（以避免倒计时期间闪烁“未准备好”）
        if (state.autoRecordState !== 'COUNTDOWN' && !isReady && statusText && !state.isRecording) {
            showToast(statusText);
        } else {
            hideToast();
        }
    } 

    if (state.isRecording) {
        state.poseDataJson[`frame_${state.currentRecordFrameIndex}`] = lm.map(p => [
            Math.round(p.x * 1000) / 1000,
            Math.round(p.y * 1000) / 1000,
            Math.round(p.visibility * 100) / 100
        ]);
        state.currentRecordFrameIndex++;
    }

    drawSkeleton(lm);
}

/* ---------- 导出到 Window ---------- */
window.startRecord = startRecord;
window.pauseRecord = pauseRecord;
window.stopAndUpload = stopAndUpload;

/* ---------- 初始化 ---------- */
async function main() {
    await startCamera();
    requestAnimationFrame(loop);
    setTimeout(initAI, 100);
}

main();
