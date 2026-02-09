// 使用本地 UMD 文件，它们会将 FFmpeg 和 FFmpegUtil 挂载到 window 对象上
import './ffmpeg/ffmpeg.js';
import './ffmpeg/util.js';

const { FFmpeg } = window.FFmpegWASM;
const { toBlobURL } = window.FFmpegUtil;

let ffmpeg = null;

export async function convertWebMToMp4(webmBlob, onProgress, durationSec = 0) {
    console.log("开始调用 convertWebMToMp4 函数...");
    try {
        if (!ffmpeg) {
            console.log("初始化 FFmpeg 实例...");
            ffmpeg = new FFmpeg();
        }

        if (!ffmpeg.loaded) {
            console.log("正在加载 FFmpeg 核心文件...");
            // 修改为相对路径，以便 Flutter 端拦截加载本地资源
            // 请确保 Flutter 将这些请求重定向到本地 Assets
            const baseURL = '/js/ffmpeg'; 
            
            await ffmpeg.load({
                coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
                wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
                // workerURL 通常不需要单独加载，除非需要特定的 worker 文件，这里暂时保持简单
            });
            console.log("FFmpeg 加载完成！");
        }

        const inputName = 'input.webm';
        const outputName = 'output.mp4';

        console.log("写入 WebM 文件到虚拟文件系统...");
        // 写入文件
        const arrayBuffer = await webmBlob.arrayBuffer();
        await ffmpeg.writeFile(inputName, new Uint8Array(arrayBuffer));

        // 监听进度
        ffmpeg.on('progress', ({ progress, time }) => {
            let percent = progress * 100;
            
            // 如果 progress 数值异常 (例如负数或 NaN)，尝试使用 time 计算
            if ((percent < 0 || isNaN(percent)) && durationSec > 0 && time !== undefined && time >= 0) {
                // time 是当前转码到的时间点(秒)
                percent = (time / durationSec) * 100;
            }

            // 再次兜底，确保在 0-100 之间
            percent = Math.max(0, Math.min(100, percent));
            
            if (onProgress) onProgress(Math.round(percent));
        });

        console.log("开始执行 FFmpeg 转码命令...");
        // 执行转码 (使用 ultrafast 预设以加快速度)
        // 注意：WebM (VP8/9) -> MP4 (H.264) 必须重编码
        await ffmpeg.exec([
            '-i', inputName,
            '-c:v', 'libx264',
            '-preset', 'ultrafast', // 极速模式，文件会稍大但转换快
            '-c:a', 'aac',          // 音频转 AAC
            outputName
        ]);
        console.log("FFmpeg 转码命令执行完毕！");

        // 读取结果
        const data = await ffmpeg.readFile(outputName);
        console.log("读取输出文件成功，大小:", data.length);
        
        // 清理内存
        await ffmpeg.deleteFile(inputName);
        await ffmpeg.deleteFile(outputName);

        return new Blob([data.buffer], { type: 'video/mp4' });

    } catch (error) {
        console.error("convertWebMToMp4 内部发生错误:", error);
        throw error;
    }
}
