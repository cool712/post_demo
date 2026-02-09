export const state = {
    running: false,
    facingMode: "user",
    isRecording: false,
    autoRecordState: 'DISABLED', // 'DISABLED' | 'IDLE' | 'COUNTDOWN' | 'RECORDING'
    poseLandmarker: null,
    currentDeviceRotation: 0,
    SAFE_ZONE: { x: 0.2, y: 0.15, w: 0.6, h: 0.7 },
    lastFrameLandmarks: null,
    poseDataJson: {},
    currentRecordFrameIndex: 0,
    recordingStartTime: 0,
    countdownStartTime: 0,
    
    // DOM Elements (will be set in main.js)
    video: null,
    canvas: null,
    ctx: null,
    
    // Recording Canvas (Off-screen)
    recordingCanvas: null,
    recordingCtx: null,

    // Unstable Detection State
    unstableStartTime: 0,
    isUnstableCheckActive: false,
    ignoreUnstable: false,
    consecutiveStaticFrames: 0,
    lastPoseCorrectTime: 0,

    // Handheld Detection
    isHandheld: true, // 默认为手持
    motionScore: 0
};

export const CONSTANTS = {
    // 移除 0(鼻), 27(左踝), 28(右踝)，只检测躯干和四肢主要关节
    KEY_LANDMARKS: [11, 12, 13, 14, 15, 16, 23, 24, 25, 26],
    // 自拍模式不检测膝盖 (25, 26)，只检测上半身
    KEY_LANDMARKS_SELFIE: [11, 12, 13, 14, 15, 16, 23, 24],
    STABILITY_DURATION: 2000, // 保持姿势稳定的时间 2000毫秒 = 2秒
    COUNTDOWN_DURATION: 3000, // 倒计时时间 3000毫秒 = 3秒
    STATIC_CHECK_POINTS: [11, 12, 23, 24, 25, 26],
    MOVEMENT_THRESHOLD: 0.002, // 调高灵敏度（原0.005），更微小的晃动也会被检测出来
    VISIBILITY_THRESHOLD: 0.5,
    UNSTABLE_TIMEOUT: 1000 // 不稳定超时判定 1000毫秒 = 1秒
};
