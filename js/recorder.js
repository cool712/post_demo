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

    const { canvas } = state;
    
    // 强制录制画布始终为竖屏比例 (Height > Width)
    // 这样无论横着录还是竖着录，生成的视频文件都是竖屏的，方便在 App 播放
    if (canvas.width > canvas.height) {
        // 如果当前源是横屏，则交换宽高作为录制尺寸
        state.recordingCanvas.width = canvas.height;
        state.recordingCanvas.height = canvas.width;
    } else {
        // 如果当前源是竖屏，直接使用
        state.recordingCanvas.width = canvas.width;
        state.recordingCanvas.height = canvas.height;
    }
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

    // 4. 计算旋转
    let rotation = 0;
    
    // 获取设备旋转角度，优先使用 state，如果为0则尝试 window.orientation
    let deviceRot = currentDeviceRotation;
    if (deviceRot === 0 && window.orientation !== undefined) {
        // window.orientation: 90 (Home右, 对应我们的 -90), -90 (Home左, 对应我们的 90)
        if (window.orientation === 90) deviceRot = -90;
        if (window.orientation === -90) deviceRot = 90;
    }

    // 如果源是横屏 (W > H)，但录制目标是竖屏 (W < H)，说明必须旋转
    if (srcW > srcH) {
        // 横屏转竖屏
        const isUserFacing = state.facingMode === "user";
        
        if (isUserFacing) {
            // 前置摄像头 (镜像)
            // 逆时针转手机(-90) -> 头在3点 -> 需逆时针转(-90)扶正
            // 顺时针转手机(90) -> 头在9点 -> 需顺时针转(90)扶正
            if (deviceRot === -90) {
                rotation = -Math.PI / 2; 
            } else {
                rotation = Math.PI / 2;
            }
        } else {
            // 后置摄像头 (正常)
            // 逆时针转手机(-90) -> 头在9点 -> 需顺时针转(90)扶正
            // 顺时针转手机(90) -> 头在3点 -> 需逆时针转(-90)扶正
            if (deviceRot === -90) {
                rotation = Math.PI / 2;
            } else {
                rotation = -Math.PI / 2;
            }
        }
    } else {
        // 源是竖屏，可能倒置（180度）
        if (deviceRot === 180) {
            rotation = Math.PI;
        }
    }

    recordingCtx.rotate(rotation);

    // 5. 计算缩放 (Cover模式：填满屏幕)
    // 注意：因为我们已经旋转了坐标系，所以要用旋转后的逻辑宽高来计算
    const isRotated = Math.abs(rotation) > 0.1;
    const contentWidth = isRotated ? srcH : srcW;
    const contentHeight = isRotated ? srcW : srcH;
    
    // 使用 Math.max 来实现 Cover 效果（填满，可能裁剪），或者 Math.min 实现 Contain（黑边）
    // 用户之前的需求似乎是填满且不留黑边，所以尝试接近 1 的缩放
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
