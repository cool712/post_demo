import {
    PoseLandmarker,
    FilesetResolver
} from "/mediapipe/tasks-vision/tasks-vision@latest.js";

import { state, CONSTANTS } from './state.js';
import { showDynamicIsland, hideDynamicIsland, updateDynamicIslandRotation } from './ui.js';
import { calcAngle, getVisibleRect } from './utils.js';
import { checkBodyInFrame } from './pose-logic.js';
import { drawSafeZone, drawSkeleton, drawCountdown } from './drawing.js';
import { startRecord, pauseRecord, stopAndUpload, _startMediaRecorder, updateRecordingCanvas } from './recorder.js';

/* ---------- Partner Mode Init ---------- */
state.facingMode = "environment";
state.isHandheld = false; // Disable handheld detection for partner mode

/* ---------- DOM Initialization ---------- */
state.video = document.getElementById("video");
state.canvas = document.getElementById("canvas");
state.ctx = state.canvas.getContext("2d", { alpha: true });

let dynamicScale = 0.5;
let frameCount = 0;
let lastFpsCheck = 0;

/* ---------- Event Listeners ---------- */
// No devicemotion listener for Partner Mode as requested

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
    // updateToastRotation(); // REMOVED
    try { updateDynamicIslandRotation(); } catch(e){}
    try { updateAllDialogsRotation(); } catch(e){}
});

/* ---------- Button Listeners ---------- */
// No dialogs, so no button listeners needed.
// Exposed method for external trigger (Replaces standard startRecord behavior)
window.startRecord = () => {
    if (state.isRecording || state.autoRecordState === 'COUNTDOWN') return;

    // Start Countdown
    state.autoRecordState = 'COUNTDOWN';
    state.countdownStartTime = Date.now();
    console.log("Countdown started via manual trigger (startRecord)");
};

/* ---------- Camera ---------- */
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

/* ---------- AI ---------- */
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

/* ---------- Loop ---------- */
function loop(ts) {
    requestAnimationFrame(loop);
    // try { updateAllDialogsRotation(); } catch(e){} // REMOVED

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
                    // showToast("请站在检测框内"); // REMOVED
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
        
        // Pose checks REMOVED as requested.
        // const { inFrame, msg: frameMsg } = checkBodyInFrame(lm);
        // const leftLegAngle = calcAngle(lm[23], lm[25], lm[27]);
        // const rightLegAngle = calcAngle(lm[24], lm[26], lm[28]);
        // const isPoseCorrect = leftLegAngle > 170 && rightLegAngle > 170;

        // Static Check REMOVED - Always stable
        // const isStable = true;
        
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
            Math.round(p.visibility * 100) / 100
        ]);
        state.currentRecordFrameIndex++;
    }

    drawSkeleton(lm);
}

/* ---------- Exports to Window ---------- */
// window.startRecord = startRecord; // Overridden by manual trigger above
window.pauseRecord = pauseRecord;
window.stopAndUpload = stopAndUpload;

/* ---------- Init ---------- */
async function main() {
    await startCamera();
    requestAnimationFrame(loop);
    setTimeout(initAI, 100);
}

main();