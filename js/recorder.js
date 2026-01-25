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
    // 获取长边和短边
    const longSide = Math.max(canvas.width, canvas.height);
    const shortSide = Math.min(canvas.width, canvas.height);
    
    // 根据起始时的设备方向决定录制画布的宽高
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
    // const srcW = canvas.width;
    // const srcH = canvas.height;
    const destW = recordingCanvas.width;
    const destH = recordingCanvas.height;

    // 1. 清除上一帧
    recordingCtx.clearRect(0, 0, destW, destH);

    recordingCtx.save();
    recordingCtx.translate(destW / 2, destH / 2);

    // 核心逻辑：
    // 目标是让画面始终充满 recordingCanvas (Cover 模式)
    // 且方向正确。
    
    // 1. 计算需要的旋转角度
    // 如果 recordingCanvas 是竖屏 (destW < destH)
    //    - 设备竖屏 (0/180): 不旋转 (或180)，直接画
    //    - 设备横屏 (90/-90): 旋转90度，让横屏画面立起来填满竖屏画布
    // 如果 recordingCanvas 是横屏 (destW > destH)
    //    - 设备横屏 (90/-90): 不旋转 (或180)，直接画
    //    - 设备竖屏 (0/180): 旋转-90度，让竖屏画面躺下来填满横屏画布
    
    const isDestPortrait = destW < destH;
    let rotation = 0;

    if (isDestPortrait) {
        // 录制画布是竖的
        if (currentDeviceRotation === 90) rotation = -Math.PI / 2;
        else if (currentDeviceRotation === -90) rotation = Math.PI / 2;
        else if (currentDeviceRotation === 180) rotation = Math.PI;
        else rotation = 0;
    } else {
        // 录制画布是横的
        if (currentDeviceRotation === 0) rotation = -Math.PI / 2; // 竖转横
        else if (currentDeviceRotation === 180) rotation = Math.PI / 2;
        else if (currentDeviceRotation === 90) rotation = 0; // 横对横，通常不需要转（或者看前置摄像头镜像）
        else if (currentDeviceRotation === -90) rotation = Math.PI; // 可能需要翻转180
        // 注意：这里的 rotation 是相对于“标准正向”的修正。
        // 简单处理：
        // 如果当前是 90 (左横)，录制也是横，则不转。
        // 如果当前是 -90 (右横)，录制也是横，可能要转180保持头朝上？
        // 暂时假设 0 和 90 是基准。
        if (currentDeviceRotation === -90) rotation = Math.PI; 
    }

    recordingCtx.rotate(rotation);

    // 2. 绘制
    // 旋转后，坐标系变了。
    // 我们始终绘制 canvas (源)，让其中心对齐。
    // 由于我们旋转的目的就是为了让宽高匹配 (竖对竖，横对横)，
    // 所以直接绘制 canvas.width/height 对应的矩形即可。
    // 稍微放大一点点以防白边 (Cover)
    const scale = 1.0; 
    recordingCtx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
    
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
