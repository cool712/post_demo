import { state } from './state.js';
import { getSafeZoneRect, toCanvas, calcAngle } from './utils.js';

/**
 * 绘制安全区域（流光边框）
 * @param {number} ts - 时间戳，用于驱动动画
 */
export function drawSafeZone(ts) {
    const { ctx, canvas } = state;
    const rect = getSafeZoneRect();
    const { x, y, w, h } = rect;

    ctx.save();

    // 计算流光动画的角度
    const angle = (ts / 2000) % (Math.PI * 2);
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.sqrt(w * w + h * h) / 1.5; 
    
    // 计算渐变的起点和终点
    const x1 = cx + Math.cos(angle) * r;
    const y1 = cy + Math.sin(angle) * r;
    const x2 = cx + Math.cos(angle + Math.PI) * r;
    const y2 = cy + Math.sin(angle + Math.PI) * r;

    // 创建线性渐变
    const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
    gradient.addColorStop(0, "#4FACFE");
    gradient.addColorStop(0.33, "#00F2FE");
    gradient.addColorStop(0.66, "#A18CD1");
    gradient.addColorStop(1, "#FBC2EB");

    // 定义路径（圆角矩形）
    ctx.save();
    ctx.beginPath();
    
    const cornerRadius = 40;
    ctx.moveTo(x + cornerRadius, y);
    ctx.arcTo(x + w, y, x + w, y + h, cornerRadius);
    ctx.arcTo(x + w, y + h, x, y + h, cornerRadius);
    ctx.arcTo(x, y + h, x, y, cornerRadius);
    ctx.arcTo(x, y, x + w, y, cornerRadius);
    ctx.closePath();

    // 绘制遮罩层（安全区域外变暗）
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height); // 整个画布
    // 减去中间的安全区域
    ctx.moveTo(x + cornerRadius, y);
    ctx.arcTo(x + w, y, x + w, y + h, cornerRadius);
    ctx.arcTo(x + w, y + h, x, y + h, cornerRadius);
    ctx.arcTo(x, y + h, x, y, cornerRadius);
    ctx.arcTo(x, y, x + w, y, cornerRadius);
    ctx.closePath();

    ctx.fillStyle = gradient;
    ctx.globalAlpha = 0.3; 
    ctx.shadowBlur = 0; 
    ctx.fill("evenodd"); // 奇偶填充规则，实现镂空效果
    
    ctx.restore();
    ctx.restore();
}

/**
 * 绘制关节角度
 * @param {object} a - 第一个点
 * @param {object} b - 顶点（角度所在的点）
 * @param {object} c - 第三个点
 */
export function drawAngle(a, b, c) {
    const { ctx } = state;
    const angle = Math.round(calcAngle(a, b, c));
    const p = toCanvas(b);
    ctx.font = "bold 14px monospace";
    ctx.fillStyle = "#ff0000";
    ctx.fillText(`${angle}°`, p.x + 8, p.y - 8);
}

/**
 * 绘制人体骨架和关键点
 * @param {Array} lm - 姿势关键点数组
 */
export function drawSkeleton(lm) {
    const { ctx } = state;
    ctx.save();
    ctx.strokeStyle = "#00ff7f"; // 骨架颜色：春绿色
    ctx.fillStyle = "#ffffff";    // 关键点颜色：白色
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // 定义需要连接的骨骼索引对
    const bones = [
        [11, 13], [13, 15], [12, 14], [14, 16], // 手臂
        [23, 25], [25, 27], [24, 26], [26, 28], // 腿部
        [11, 12], [23, 24], [11, 23], [12, 24]  // 躯干
    ];

    // 绘制骨骼线条
    bones.forEach(([a, b]) => {
        const pA = toCanvas(lm[a]);
        const pB = toCanvas(lm[b]);
        ctx.beginPath();
        ctx.moveTo(pA.x, pA.y);
        ctx.lineTo(pB.x, pB.y);
        ctx.stroke();
    });

    // 绘制关键点圆点
    lm.forEach(p => {
        const cp = toCanvas(p);
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, 4, 0, Math.PI * 2);
        ctx.fill();
    });

    // 绘制关键部位的角度数值
    drawAngle(lm[11], lm[13], lm[15]); // 左肘
    drawAngle(lm[12], lm[14], lm[16]); // 右肘
    drawAngle(lm[23], lm[25], lm[27]); // 左膝
    drawAngle(lm[24], lm[26], lm[28]); // 右膝

    ctx.restore();
}

/**
 * 绘制倒计时数字
 * @param {number} remaining - 剩余秒数
 */
export function drawCountdown(remaining) {
    const { ctx, canvas, currentDeviceRotation } = state;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                 (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    ctx.save();
    // 半透明绿色背景覆盖层
    ctx.fillStyle = "rgba(0, 255, 0, 0.4)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    // 移动坐标系到画布中心
    ctx.translate(canvas.width / 2, canvas.height / 2);
    
    // 根据设备旋转角度旋转文字，确保文字方向正确
    let rotationAngle = 0;
    if (currentDeviceRotation === 0) {
        rotationAngle = 0;
    } else if (currentDeviceRotation === 90) {
        rotationAngle = Math.PI / 2;
    } else if (currentDeviceRotation === -90) {
        rotationAngle = -Math.PI / 2;
    } else if (currentDeviceRotation === 180) {
        rotationAngle = Math.PI;
    }
    
    // 对于 iOS 设备，调整旋转方向以匹配其他 UI 元素
    if (isIOS) {
        if (currentDeviceRotation === 90) {
            rotationAngle = -Math.PI / 2;
        } else if (currentDeviceRotation === -90) {
            rotationAngle = Math.PI / 2;
        }
    }
    
    ctx.rotate(rotationAngle);
    // const offset = 0; 
    // if (currentDeviceRotation === 0) {
    //     ctx.rotate(0 + offset); 
    // } else if (currentDeviceRotation === 90) {
    //     ctx.rotate(Math.PI / 2 + offset);
    // } else if (currentDeviceRotation === -90) {
    //     ctx.rotate(-Math.PI / 2 + offset);
    // } else if (currentDeviceRotation === 180) {
    //     ctx.rotate(Math.PI + offset);
    // }
    
    // 绘制巨大的倒计时数字
    ctx.fillStyle = "white";
    ctx.strokeStyle = "black";
    ctx.lineWidth = 4;
    ctx.font = "bold 150px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeText(remaining.toString(), 0, 0); // 描边
    ctx.fillText(remaining.toString(), 0, 0);   // 填充
    
    ctx.restore(); 
    ctx.restore();
}
