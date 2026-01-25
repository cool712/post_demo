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
    const isLandscape = Math.abs(currentDeviceRotation) === 90;

    // 始终保持与源画布一致的宽高比，这样横屏录制就是横屏视频，竖屏录制就是竖屏视频
    // 避免强制旋转导致的方向错误
    state.recordingCanvas.width = canvas.width;
    state.recordingCanvas.height = canvas.height;
}

export function updateRecordingCanvas() {
    if (!state.isRecording || !state.recordingCanvas || !state.recordingCtx) return;

    const { canvas, recordingCanvas, recordingCtx, currentDeviceRotation } = state;
    const srcW = canvas.width;
    const srcH = canvas.height;
    const destW = recordingCanvas.width;
    const destH = recordingCanvas.height;

    recordingCtx.save();
    
    // 1. 重置变换矩阵并清空画布
    recordingCtx.setTransform(1, 0, 0, 1, 0, 0);
    recordingCtx.clearRect(0, 0, destW, destH);
    
    // 2. 填充黑色背景
    recordingCtx.fillStyle = '#000000';
    recordingCtx.fillRect(0, 0, destW, destH);
    
    // 3. 移动到中心准备绘制
    recordingCtx.translate(destW / 2, destH / 2);

    // 4. 计算旋转角度
    // 只有当源和目标的横竖屏状态不一致时（例如录制过程中旋转了手机），才需要旋转画面
    const isSrcLandscape = srcW > srcH;
    const isDestLandscape = destW > destH;
    let rotation = 0;

    if (isSrcLandscape !== isDestLandscape) {
        // 源和目标方向不一致，需要旋转90度来填充
        // 根据设备旋转方向决定顺时针还是逆时针
        if (currentDeviceRotation === 90 || currentDeviceRotation === -90) {
             // 简单的逻辑：转90度填满
             rotation = Math.PI / 2;
        } else {
             rotation = Math.PI / 2;
        }
    } else {
        // 方向一致，不需要旋转
        rotation = 0;
    }
    
    recordingCtx.rotate(rotation);

    // 5. 计算缩放比例 (Contain模式)
    const isRotated = Math.abs(rotation) > 0.1; 
    const contentWidth = isRotated ? srcH : srcW;
    const contentHeight = isRotated ? srcW : srcH;
    
    const scale = Math.min(destW / contentWidth, destH / contentHeight);
    
    recordingCtx.scale(scale, scale);

    // 6. 绘制
    recordingCtx.drawImage(canvas, -srcW / 2, -srcH / 2);
    
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
