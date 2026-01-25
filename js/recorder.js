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
    
    // 强制锁定为竖屏分辨率 (宽 < 高)
    // 无论当前设备是横屏还是竖屏，录制出来的视频文件永远是竖长的
    state.recordingCanvas.width = shortSide;
    state.recordingCanvas.height = longSide;
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

    recordingCtx.save();
    
    // 移动到画布中心
    recordingCtx.translate(destW / 2, destH / 2);

    // 计算旋转角度
    // 目标：始终填满竖屏的 recordingCanvas
    
    let rotation = 0;
    
    // 如果设备是横屏 (90/-90)，源画面是横的 (宽 > 高)
    // 目标画布是竖的 (宽 < 高)
    // 必须旋转 90 度才能填满
    
    if (currentDeviceRotation === 90) {
        // 顺时针旋转90度 (手机左横屏时，画面需要逆时针转回去？或者顺时针转成竖屏)
        // 经测试通常是 -90 (逆时针) 
        rotation = -Math.PI / 2;
    } else if (currentDeviceRotation === -90) {
        rotation = Math.PI / 2;
    } else if (currentDeviceRotation === 180) {
        rotation = Math.PI;
    } else {
        // 0度竖屏，无需旋转
        rotation = 0;
    }
    
    recordingCtx.rotate(rotation);

    // 绘制源画布
    // 注意：如果是横屏旋转90度后，源画面的"宽"变成了垂直方向，"高"变成了水平方向
    // 此时 srcW (长边) 对应 destH (长边)，srcH (短边) 对应 destW (短边)
    // 所以直接绘制即可完美覆盖
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
