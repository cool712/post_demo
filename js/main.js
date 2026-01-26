import {
    PoseLandmarker,
    FilesetResolver
} from "/mediapipe/tasks-vision/tasks-vision@latest.js";

import { state, CONSTANTS } from './state.js';
import { showToast, hideToast, showDynamicIsland, hideDynamicIsland, updateToastRotation, updateDynamicIslandRotation, showDialog, hideDialog, updateAllDialogsRotation } from './ui.js';
import { calcAngle, getVisibleRect } from './utils.js';
import { checkBodyInFrame, checkIsStatic } from './pose-logic.js';
import { drawSafeZone, drawSkeleton, drawCountdown } from './drawing.js';
import { startRecord, pauseRecord, stopAndUpload, _startMediaRecorder, updateRecordingCanvas } from './recorder.js';

/* ---------- DOM Initialization ---------- */
state.video = document.getElementById("video");
state.canvas = document.getElementById("canvas");
state.ctx = state.canvas.getContext("2d", { alpha: true });

let dynamicScale = 0.5;
let frameCount = 0;
let lastFpsCheck = 0;

/* ---------- Event Listeners ---------- */
// Handheld Detection
const motionBuffer = [];
const MOTION_SAMPLE_SIZE = 20;
const HANDHELD_THRESHOLD = 0.15; // m/s^2

window.addEventListener('devicemotion', (event) => {
    const acc = event.acceleration;
    if (!acc) return;

    const x = acc.x || 0;
    const y = acc.y || 0;
    const z = acc.z || 0;
    const magnitude = Math.sqrt(x*x + y*y + z*z);

    motionBuffer.push(magnitude);
    if (motionBuffer.length > MOTION_SAMPLE_SIZE) {
        motionBuffer.shift();
        
        // Analyze
        const sum = motionBuffer.reduce((a, b) => a + b, 0);
        const average = sum / motionBuffer.length;
        
        state.motionScore = average;
        
        // Simple logic: if consistent motion > threshold, likely handheld or moving
        // < 0.05 is likely stand
        if (average < 0.05) {
            state.isHandheld = false;
        } else {
            state.isHandheld = true;
        }
    }
});

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

/* ---------- Button Listeners ---------- */
document.getElementById('btn-ignore-unstable').addEventListener('click', () => {
    state.ignoreUnstable = true;
    state.isUnstableCheckActive = false;
    hideDialog('unstable');
    
    // 如果是手持模式 (或者用户点击了忽略)，直接开始倒计时/录制
    // 原逻辑是弹出 confirm-ready
    // 新逻辑：跳过 confirm-ready，直接进入 COUNTDOWN
    
    state.autoRecordState = 'COUNTDOWN';
    state.countdownStartTime = Date.now();
});

document.getElementById('btn-confirm-ready').addEventListener('click', () => {
    hideDialog('confirm-ready');
    
    // 用户确认准备好了，直接开始倒计时
    state.autoRecordState = 'COUNTDOWN';
    state.countdownStartTime = Date.now();
    
    // 强制跳过静止检测
    state.ignoreUnstable = true;
});

document.getElementById('btn-cancel-ready').addEventListener('click', () => {
    hideDialog('confirm-ready');
    
    // 取消准备，重新开始检测
    state.ignoreUnstable = false;
    state.isUnstableCheckActive = false;
    state.unstableStartTime = 0;
});

/* ---------- Camera ---------- */
async function startCamera() {
    if (state.video.srcObject) state.video.srcObject.getTracks().forEach(t => t.stop());
    
    state.video.style.transform = state.facingMode === "user" ? "scaleX(-1)" : "none";

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: state.facingMode,
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        });
        state.video.srcObject = stream;
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
                numPoses: 1
            });
        } catch (err) {
            console.error("AI Load Failed", err);
        }
    }, 1000);
}

/* ---------- Loop ---------- */
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
        const { isStatic, msg: staticMsg } = checkIsStatic(lm);

        const leftLegAngle = calcAngle(lm[23], lm[25], lm[27]);
        const rightLegAngle = calcAngle(lm[24], lm[26], lm[28]);
        const isPoseCorrect = leftLegAngle > 170 && rightLegAngle > 170;

        // Update Static Frames Counter
        if (isStatic) {
            state.consecutiveStaticFrames = (state.consecutiveStaticFrames || 0) + 1;
        } else {
            state.consecutiveStaticFrames = 0;
        }
        
        // Define "Stable" as having been static for a few consecutive frames
        // This prevents single-frame "static" glitches from resetting the unstable timer
        const isStable = state.consecutiveStaticFrames > 5;

        let statusText = "";
        let isReady = false;
        let dynamicIslandMsg = "";
        let shouldShowDynamicIsland = false;

        if (!inFrame) {
            statusText = frameMsg;
            state.isUnstableCheckActive = false; // 不在框内，重置不稳检测
        } else if (!isPoseCorrect) {
            statusText = "请直立身体";
            // 姿势不正确，但也属于"未准备好"的一种，如果一直在框内，我们应该继续计时
            // 但为了避免因为刚进框就触发，我们只在"非致命错误"（如手抖引起的姿势微偏）时计时？
            // 简单起见，只要在框内，就开始计时。如果2秒都没Ready，就询问是否忽略。
        } else if (!isStable && !state.ignoreUnstable) {
            statusText = "请保持不动";
        } else {
            // In Frame, Pose Correct, and (Stable OR IgnoreUnstable)
            isReady = true;
            statusText = "准备就绪";
        }
        
        // 统一的不稳/未准备好检测逻辑
        if (inFrame && !isReady && !state.ignoreUnstable) {
             if (!state.isUnstableCheckActive) {
                state.isUnstableCheckActive = true;
                state.unstableStartTime = Date.now();
            } else {
                const unstableDuration = Date.now() - state.unstableStartTime;
                if (unstableDuration > CONSTANTS.UNSTABLE_TIMEOUT) {
                    // 如果是手持状态，或者只是普通的静止检测超时
                    // 用户要求：如果是手持的情况下就弹出忽略弹框
                    // 现在的逻辑是超时就弹出 dialog-unstable，且该对话框有忽略按钮
                    // 修改后的按钮逻辑已经支持"直接开始"
                    // 这里只需要确保对话框正常弹出即可
                    // 也可以根据 isHandheld 动态修改对话框的文本？(可选)
                    showDialog('unstable');
                }
            }
        } else {
            // 如果 Ready 了，或者不在框内，或者已经忽略了，就重置计时器
            // 注意：如果用户已经在 COUNTDOWN 状态，我们不应该重置这个逻辑，
            // 但这里是 processAndDraw，每帧都跑。如果 isReady，当然不需要检测不稳。
            if (isReady || !inFrame) {
                 state.isUnstableCheckActive = false;
            }
        }
        
        // Check already handled above
        
        // 如果对话框显示中，不更新 Toast 和 Dynamic Island，避免冲突
        const isDialogVisible = document.getElementById('dialog-unstable').style.display !== 'none' || 
                                document.getElementById('dialog-confirm-ready').style.display !== 'none';

        if (isDialogVisible) {
            state.lastFrameLandmarks = lm;
            drawSkeleton(lm);
            return; // 早期返回，不更新状态机
        }

        state.lastFrameLandmarks = lm;

        if (isReady) {
            if (state.autoRecordState === 'IDLE') {
                state.autoRecordState = 'COUNTDOWN';
                state.countdownStartTime = Date.now();
                shouldShowDynamicIsland = true;
                dynamicIslandMsg = "保持不动";
            } else if (state.autoRecordState === 'COUNTDOWN') {
                const elapsed = Date.now() - state.countdownStartTime;
                const remaining = Math.ceil((CONSTANTS.COUNTDOWN_DURATION - elapsed) / 1000);

                shouldShowDynamicIsland = true;
                dynamicIslandMsg = "保持不动";

                drawCountdown(remaining);

                if (elapsed >= CONSTANTS.COUNTDOWN_DURATION) {
                    _startMediaRecorder();
                    shouldShowDynamicIsland = false; // 确保录制开始后不显示
                }
            }
        } else {
            if (state.autoRecordState === 'COUNTDOWN') {
                // 如果是在忽略静止的情况下，轻微晃动不应该打断倒计时
                // 修正：只有在 ignoreUnstable 为 true 时，才允许在不 Ready 的情况下继续（只要还在框内）。
                // 如果是正常模式（!ignoreUnstable），进入此 else 分支意味着 !isReady（可能是动了，也可能是姿势不对），必须中断。
                const shouldContinue = state.ignoreUnstable && inFrame;

                if (shouldContinue) {
                     // 继续倒计时
                     const elapsed = Date.now() - state.countdownStartTime;
                     const remaining = Math.ceil((CONSTANTS.COUNTDOWN_DURATION - elapsed) / 1000);
                     shouldShowDynamicIsland = true;
                     dynamicIslandMsg = "保持不动";
                     drawCountdown(remaining);
                     if (elapsed >= CONSTANTS.COUNTDOWN_DURATION) {
                         _startMediaRecorder();
                         shouldShowDynamicIsland = false;
                     }
                } else {
                    console.log("倒计时中断：条件不再满足");
                    state.autoRecordState = 'IDLE';
                }
            } else {
                state.autoRecordState = 'IDLE';
            }
        }


        if (shouldShowDynamicIsland && !state.isRecording) {
            showDynamicIsland(dynamicIslandMsg);
        } else {
            hideDynamicIsland();
        }

        if (!isReady && statusText && !state.isRecording) {
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

/* ---------- Exports to Window ---------- */
window.startRecord = startRecord;
window.pauseRecord = pauseRecord;
window.stopAndUpload = stopAndUpload;

/* ---------- Init ---------- */
async function main() {
    await startCamera();
    requestAnimationFrame(loop);
    setTimeout(initAI, 100);
}

main();
