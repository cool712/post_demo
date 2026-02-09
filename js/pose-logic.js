import { state, CONSTANTS } from './state.js';
import { getSafeZoneRect, toCanvas } from './utils.js';

export function checkBodyInFrame(lm) {
    // 1. 检查可见性 (Visibility)
    for (let i of CONSTANTS.KEY_LANDMARKS) {
        if (!lm[i] || lm[i].visibility < CONSTANTS.VISIBILITY_THRESHOLD) {
            return { inFrame: false, msg: "关键点未被捕捉" };
        }
    }

    // 2. 检查是否在红框内 (Boundary)
    const rect = getSafeZoneRect();
    
    for (let i of CONSTANTS.KEY_LANDMARKS) {
        const p = toCanvas(lm[i]);
        
        if (p.x < rect.x || p.x > rect.x + rect.w || 
            p.y < rect.y || p.y > rect.y + rect.h) {
            return { inFrame: false, msg: "请移动到检测区域内" };
        }
    }

    return { inFrame: true, msg: "位置正确" };
}

export function checkIsStatic(currentLm) {
    if (!state.lastFrameLandmarks) return { isStatic: false, msg: "初始化..." };

    let totalMovement = 0;
    let count = 0;
    
    for (let i of CONSTANTS.STATIC_CHECK_POINTS) {
        const curr = currentLm[i];
        const last = state.lastFrameLandmarks[i];
        
        const dist = Math.hypot(curr.x - last.x, curr.y - last.y);
        totalMovement += dist;
        count++;
    }

    const avgMovement = totalMovement / count;
    
    if (avgMovement > CONSTANTS.MOVEMENT_THRESHOLD) {
        return { isStatic: false, msg: "身体晃动过大" };
    }

    return { isStatic: true, msg: "静止" };
}
