import { state } from './state.js';
import { hideToast, hideDynamicIsland } from './ui.js';

let mediaRecorder = null;
let recordedChunks = [];
let lastVideoBlob = null;
let lastJsonBlob = null;

function initRecordingCanvas() {
    if (!state.recordingCanvas) {
        state.recordingCanvas = document.createElement('canvas');
        state.recordingCtx = state.recordingCanvas.getContext('2d', { alpha: false });
    }

    const { canvas, currentDeviceRotation } = state;
    // 获取长边和短边，假设 canvas 分辨率通常是固定的（如 1280x720）
    const longSide = Math.max(canvas.width, canvas.height);
    const shortSide = Math.min(canvas.width, canvas.height);
    
    // 根据起始时的设备方向决定录制画布的宽高
    // 如果是横屏 (90/-90)，则宽长高短
    // 如果是竖屏 (0/180)，则宽短高长
    const isLandscape = Math.abs(currentDeviceRotation) === 90;

    if (isLandscape) {
        state.recordingCanvas.width = longSide;
        state.recordingCanvas.height = shortSide;
    } else {
        state.recordingCanvas.width = shortSide;
        state.recordingCanvas.height = longSide;
    }
}

export function updateRecordingCanvas() {
    if (!state.isRecording || !state.recordingCanvas || !state.recordingCtx) return;

    const { canvas, recordingCanvas, recordingCtx, currentDeviceRotation } = state;
    const srcW = canvas.width;
    const srcH = canvas.height;
    const destW = recordingCanvas.width;
    const destH = recordingCanvas.height;

    // 1. 清除上一帧，防止画面残留
    recordingCtx.clearRect(0, 0, destW, destH);
    // 可选：填充黑色背景
    // recordingCtx.fillStyle = '#000';
    // recordingCtx.fillRect(0, 0, destW, destH);

    recordingCtx.save();
    
    // 移动到画布中心
    recordingCtx.translate(destW / 2, destH / 2);

    // 计算旋转角度
    // 目标是让源画面填满录制画布。
    // 如果录制画布是竖的 (destW < destH)，而当前设备是横屏 (currentDeviceRotation=90)，
    // 我们需要旋转画面，使其变竖。
    
    // 这里简化逻辑：根据当前设备角度进行绝对旋转补偿
    // 注意：initRecordingCanvas 决定了 destW/destH 的基准
    // 如果录制中途旋转了，destW/destH 不会变，但 currentDeviceRotation 变了。
    
    let rotation = 0;
    if (currentDeviceRotation === 90) {
        rotation = -Math.PI / 2;
    } else if (currentDeviceRotation === -90) {
        rotation = Math.PI / 2;
    } else if (currentDeviceRotation === 180) {
        rotation = Math.PI;
    }
    
    recordingCtx.rotate(rotation);

    // 绘制源画布
    // 注意：旋转后坐标系也变了。
    // 如果旋转了 90 度，X轴变Y轴。
    // 我们需要判断绘制的宽高是否需要交换，或者简单地绘制在中心。
    // 为了确保填满，我们可以比较旋转后的源宽高与目标宽高。
    
    // 简单处理：始终以源画布的尺寸绘制，依靠旋转来对齐
    recordingCtx.drawImage(canvas, -srcW / 2, -srcH / 2, srcW, srcH);
    
    recordingCtx.restore();
}

function _startMediaRecorder() {
    recordedChunks = [];
    state.poseDataJson = {};
    state.currentRecordFrameIndex = 0;

    // 初始化录制专用 Canvas
    initRecordingCanvas();

    const stream = state.recordingCanvas.captureStream(25);
    let options = {
        mimeType: 'video/mp4;codecs=avc1'
    };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        console.warn("MP4 不支持，回退到 WebM");
        options = {
            mimeType: 'video/webm;codecs=vp8'
        };
    }
    mediaRecorder = new MediaRecorder(stream, options);

    mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.start();
    state.isRecording = true;
    state.autoRecordState = 'RECORDING';
    
    hideDynamicIsland();
    hideToast();

    console.log("Recording started...");
    if (window.flutter_inappwebview) {
        window.flutter_inappwebview.callHandler("onRecordStarted");
    }
}

// Exported for internal use if needed, but mainly triggered by logic
export { _startMediaRecorder };

export function startRecord() {
    console.log("进入姿势检测模式...");
    state.autoRecordState = 'IDLE'; 
    state.countdownStartTime = 0;
    hideToast();
}

export function pauseRecord() {
    // 场景1：准备/倒计时阶段取消
    if (!state.isRecording && (state.autoRecordState === 'IDLE' || state.autoRecordState === 'COUNTDOWN')) {
        state.autoRecordState = 'DISABLED'; 
        hideToast();
        hideDynamicIsland();
        console.log("已取消准备/倒计时");
        if (window.flutter_inappwebview) {
                window.flutter_inappwebview.callHandler("onRecordPaused");
        }
        return;
    }

    // 场景2：恢复
    if (!state.isRecording && state.autoRecordState === 'DISABLED') {
        console.log("从暂停状态恢复，重新开始检测...");
        startRecord();
        if (window.flutter_inappwebview) {
                window.flutter_inappwebview.callHandler("onRecordResumed");
        }
        return;
    }

    // 场景3：录制中暂停/恢复
    if (!mediaRecorder) return;
    if (mediaRecorder.state === "recording") {
        mediaRecorder.pause();
    } else if (mediaRecorder.state === "paused") {
        mediaRecorder.resume();
    }
}

export async function stopAndUpload(uploadUrl, token, analyzeUrl, logId) {
    state.autoRecordState = 'DISABLED';
    hideToast();

    if (mediaRecorder && mediaRecorder.state === "inactive") {
        if (lastVideoBlob) {
            console.log("检测到已停止录制，正在进行重试上传...");
            return await performUploadAction(uploadUrl, token, analyzeUrl, logId);
        }
    }

    state.isRecording = false;
    // We need to wrap the onstop in a promise if we want to await it here, 
    // but the original code assigned onstop and called stop().
    // However, stopAndUpload is async.
    
    return new Promise((resolve, reject) => {
        mediaRecorder.onstop = async () => {
            lastVideoBlob = new Blob(recordedChunks, { type: "video/mp4" });
            lastJsonBlob = new Blob([JSON.stringify(state.poseDataJson)], { type: "application/json" });
            try {
                await performUploadAction(uploadUrl, token, analyzeUrl, logId);
                resolve();
            } catch (e) {
                // error handled in performUploadAction but we resolve to finish function
                resolve();
            }
        };
        mediaRecorder.stop();
    });
}

async function performUploadAction(uploadUrl, token, analyzeUrl, logId) {
    const formData = new FormData();
    formData.append("file", lastVideoBlob, "video.mp4");
    
    try {
        const response = await fetch(uploadUrl, { method: "POST", body: formData, headers: { 'Authorization': `Bearer ${token}` }});
        const resData = await response.json();
        if (resData.code === 200) {
            const videoUrl = resData.data.url;
            const analyzeRes = await fetch(analyzeUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                body: JSON.stringify({
                    "log_id": logId,
                    "video_url": videoUrl,
                    "data_json": state.poseDataJson
                })
            });
            const analyzeData = await analyzeRes.json();
            if (analyzeData.code === 200) {
                window.flutter_inappwebview.callHandler("onUploadComplete", {
                    success: true,
                    videoUrl: videoUrl,
                    analyzeData: analyzeData.data
                });
            } else {
                throw new Error(analyzeData.msg || "动作分析失败，请稍后重试");
            }
        } else {
            throw new Error(resData.msg || "上传视频失败");
        }
    } catch (err) {
        console.error("详细错误信息:", err);
        window.flutter_inappwebview.callHandler("onUploadComplete", {
            success: false,
            error: err.toString()
        });
    }
}
