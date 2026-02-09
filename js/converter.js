import { FFmpeg } from 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
import { toBlobURL } from 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js';

let ffmpeg = null;

export async function convertWebMToMp4(webmBlob, onProgress) {
    try {
        if (!ffmpeg) {
            ffmpeg = new FFmpeg();
        }

        if (!ffmpeg.loaded) {
            // 使用 unpkg 加载 ffmpeg-core
            const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
            await ffmpeg.load({
                coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
                wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
            });
        }

        const inputName = 'input.webm';
        const outputName = 'output.mp4';

        // 写入文件
        const arrayBuffer = await webmBlob.arrayBuffer();
        await ffmpeg.writeFile(inputName, new Uint8Array(arrayBuffer));

        // 监听进度
        ffmpeg.on('progress', ({ progress }) => {
            if (onProgress) onProgress(Math.round(progress * 100));
        });

        // 执行转码 (使用 ultrafast 预设以加快速度)
        // 注意：WebM (VP8/9) -> MP4 (H.264) 必须重编码
        await ffmpeg.exec([
            '-i', inputName,
            '-c:v', 'libx264',
            '-preset', 'ultrafast', // 极速模式，文件会稍大但转换快
            '-c:a', 'aac',          // 音频转 AAC
            outputName
        ]);

        // 读取结果
        const data = await ffmpeg.readFile(outputName);
        
        // 清理内存
        await ffmpeg.deleteFile(inputName);
        await ffmpeg.deleteFile(outputName);

        return new Blob([data.buffer], { type: 'video/mp4' });

    } catch (error) {
        console.error("转码失败:", error);
        throw error;
    }
}
