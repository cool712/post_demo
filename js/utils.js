import { state } from './state.js';

export function getVisibleRect() {
    const { canvas } = state;
    const videoRatio = canvas.width / canvas.height;
    const screenRatio = window.innerWidth / window.innerHeight;
    
    let visibleW, visibleH, visibleX, visibleY;

    if (screenRatio > videoRatio) {
        // 屏幕更宽，视频上下被裁剪
        visibleW = canvas.width;
        visibleH = canvas.width / screenRatio;
        visibleX = 0;
        visibleY = (canvas.height - visibleH) / 2;
    } else {
        // 屏幕更窄，视频左右被裁剪
        visibleW = canvas.height * screenRatio;
        visibleH = canvas.height;
        visibleX = (canvas.width - visibleW) / 2;
        visibleY = 0;
    }
    
    return { x: visibleX, y: visibleY, w: visibleW, h: visibleH };
}

export function getSafeZoneRect() {
    const visible = getVisibleRect();
    const { SAFE_ZONE } = state;
    return {
        x: visible.x + visible.w * SAFE_ZONE.x,
        y: visible.y + visible.h * SAFE_ZONE.y,
        w: visible.w * SAFE_ZONE.w,
        h: visible.h * SAFE_ZONE.h
    };
}

export function toCanvas(p) {
    const { canvas, facingMode } = state;
    let x = (facingMode === "user") ? (1 - p.x) : p.x;
    return {
        x: x * canvas.width,
        y: p.y * canvas.height
    };
}

export function calcAngle(a, b, c) {
    const ab = { x: a.x - b.x, y: a.y - b.y };
    const cb = { x: c.x - b.x, y: c.y - b.y };
    const dot = ab.x * cb.x + ab.y * cb.y;
    const mag1 = Math.hypot(ab.x, ab.y);
    const mag2 = Math.hypot(cb.x, cb.y);
    if (mag1 === 0 || mag2 === 0) return 0;
    const cosine = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
    return Math.acos(cosine) * 180 / Math.PI;
}
