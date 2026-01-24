import {
    PoseLandmarker,
    FilesetResolver
} from "/mediapipe/tasks-vision/tasks-vision@latest.js";

import { state, CONSTANTS } from './state.js';
import { showToast, hideToast, showDynamicIsland, hideDynamicIsland, updateToastRotation, updateDynamicIslandRotation } from './ui.js';
import { calcAngle, getVisibleRect } from './utils.js';
import { checkBodyInFrame, checkIsStatic } from './pose-logic.js';
import { drawSafeZone, drawSkeleton, drawCountdown } from './drawing.js';
import { startRecord, pauseRecord, stopAndUpload, _startMediaRecorder } from './recorder.js';

/* ---------- DOM Initialization ---------- */
state.video = document.getElementById("video");
state.canvas = document.getElementById("canvas");
state.ctx = state.canvas.getContext("2d", { alpha: true });

let dynamicScale = 0.5;
let frameCount = 0;
let lastFpsCheck = 0;

/* ---------- Event Listeners ---------- */
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

    if (!state.running) return;

    if (!state.poseLandmarker) {
        state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        if (!state.isRecording) {
            state.SAFE_ZONE = { x: 0.025, y: 0.025, w: 0.95, h: 0.95 };
            drawSafeZone(ts);
            showDynamicIsland("AI模型加载中");
        }
        return;
    }

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
}

function processAndDraw(lm) {
    if (!state.isRecording && (state.autoRecordState === 'IDLE' || state.autoRecordState === 'COUNTDOWN')) {
        
        const { inFrame, msg: frameMsg } = checkBodyInFrame(lm);
        const { isStatic, msg: staticMsg } = checkIsStatic(lm);

        const leftLegAngle = calcAngle(lm[23], lm[25], lm[27]);
        const rightLegAngle = calcAngle(lm[24], lm[26], lm[28]);
        const isPoseCorrect = leftLegAngle > 170 && rightLegAngle > 170;

        let statusText = "";
        let isReady = false;
        let dynamicIslandMsg = "";
        let shouldShowDynamicIsland = false;

        if (!inFrame) {
            statusText = frameMsg;
        } else if (!isStatic) {
            statusText = "请保持不动";
        } else if (!isPoseCorrect) {
            statusText = "请直立身体";
        } else {
            isReady = true;
            statusText = "准备就绪";
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
                console.log("倒计时中断：条件不再满足");
            }
            state.autoRecordState = 'IDLE';
        }

        if (shouldShowDynamicIsland && !state.isRecording) {
            showDynamicIsland(dynamicIslandMsg);
        } else {
            hideDynamicIsland();
        }

        if (!isReady && statusText) {
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
