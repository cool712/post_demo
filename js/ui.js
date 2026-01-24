import { state } from './state.js';

const statusToast = document.getElementById("status-toast");
const dynamicIsland = document.getElementById("dynamic-island-prompt");
const dynamicIslandText = document.getElementById("dynamic-island-text");
const dialogUnstable = document.getElementById("dialog-unstable");
const dialogConfirmReady = document.getElementById("dialog-confirm-ready");

export function showToast(msg) {
    if (statusToast.textContent !== msg) {
        statusToast.textContent = msg;
    }
    if (!statusToast.classList.contains("show")) {
        statusToast.classList.remove("hide");
        statusToast.classList.add("show");
    }
    updateToastRotation();
}

export function hideToast() {
    if (statusToast.classList.contains("show")) {
        statusToast.classList.remove("show");
        statusToast.classList.add("hide");
    }
}

export function showDynamicIsland(msg) {
    if (dynamicIslandText.textContent !== msg) {
        dynamicIslandText.textContent = msg;
    }
    if (!dynamicIsland.classList.contains("show")) {
        dynamicIsland.classList.add("show");
    }
    updateDynamicIslandRotation();
}

export function hideDynamicIsland() {
    if (dynamicIsland.classList.contains("show")) {
        dynamicIsland.classList.remove("show");
        // 即使隐藏也要更新位置，保证缩放动画在正确位置
        updateDynamicIslandRotation(); 
    }
}

export function updateDynamicIslandRotation() {
    const scale = dynamicIsland.classList.contains("show") ? 1 : 0;
    
    // 重置定位样式
    dynamicIsland.style.top = "";
    dynamicIsland.style.left = "";
    dynamicIsland.style.right = "";
    dynamicIsland.style.bottom = "";
    dynamicIsland.style.transform = "";

    const margin = 48; // 距离屏幕边缘的距离
    const { currentDeviceRotation } = state;
    
    if (currentDeviceRotation === 90) {
        // 左横屏
        dynamicIsland.style.right = `${margin}px`;
        dynamicIsland.style.top = "50%";
        dynamicIsland.style.transform = `translate(50%, -50%) rotate(90deg) scale(${scale})`;
    } else if (currentDeviceRotation === -90) {
        // 右横屏
        dynamicIsland.style.left = `${margin}px`;
        dynamicIsland.style.top = "50%";
        dynamicIsland.style.transform = `translate(-50%, -50%) rotate(-90deg) scale(${scale})`;
    } else if (currentDeviceRotation === 180) {
        // 倒立
        dynamicIsland.style.bottom = `${margin}px`;
        dynamicIsland.style.left = "50%";
        dynamicIsland.style.transform = `translate(-50%, 0) rotate(180deg) scale(${scale})`;
    } else {
        // 竖屏
        dynamicIsland.style.top = `${margin}px`;
        dynamicIsland.style.left = "50%";
        dynamicIsland.style.transform = `translate(-50%, 0) scale(${scale})`;
    }
}

export function updateToastRotation() {
    let transform = "translate(-50%, -50%)";
    const { currentDeviceRotation } = state;
    
    if (currentDeviceRotation === 90) {
            transform += " rotate(90deg)";
    } else if (currentDeviceRotation === -90) {
            transform += " rotate(-90deg)";
    } else if (currentDeviceRotation === 180) {
            transform += " rotate(180deg)";
    }
    
    if (statusToast.classList.contains("hide")) {
        transform += " scale(0.9)";
    } else {
        transform += " scale(1)";
    }

    statusToast.style.transform = transform;
}

export function showDialog(type) {
    if (type === 'unstable') {
        dialogUnstable.style.display = 'flex';
        updateDialogRotation(dialogUnstable);
    } else if (type === 'confirm-ready') {
        dialogConfirmReady.style.display = 'flex';
        updateDialogRotation(dialogConfirmReady);
    }
}

export function hideDialog(type) {
    if (type === 'unstable') {
        dialogUnstable.style.display = 'none';
    } else if (type === 'confirm-ready') {
        dialogConfirmReady.style.display = 'none';
    }
}

export function updateDialogRotation(dialogElement) {
    if (!dialogElement || dialogElement.style.display === 'none') return;
    
    const content = dialogElement.querySelector('.dialog-content');
    if (!content) return;

    const { currentDeviceRotation } = state;
    
    // 对话框整体是 flex center，我们只需要旋转内部的 content
    let transform = "";
    if (currentDeviceRotation === 90) {
        transform = "rotate(90deg)";
    } else if (currentDeviceRotation === -90) {
        transform = "rotate(-90deg)";
    } else if (currentDeviceRotation === 180) {
        transform = "rotate(180deg)";
    } else {
        transform = "rotate(0deg)";
    }
    
    content.style.transform = transform;
}
