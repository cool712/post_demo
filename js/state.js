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
    KEY_LANDMARKS: [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28],
    COUNTDOWN_DURATION: 3000,
    STATIC_CHECK_POINTS: [11, 12, 23, 24, 25, 26],
    MOVEMENT_THRESHOLD: 0.005,
    VISIBILITY_THRESHOLD: 0.5,
    UNSTABLE_TIMEOUT: 2000 // 2 seconds
};
