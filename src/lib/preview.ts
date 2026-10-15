import { runFFmpeg } from './ffmpeg';

/** true, если браузер сам умеет показывать это изображение. */
export function canShowImage(url: string): Promise<boolean> {
  const img = new Image();
  img.src = url;
  return img.decode().then(
    () => img.naturalWidth > 0,
    () => false,
  );
}

/** true, если браузер может декодировать хотя бы первый кадр этого видео. */
export function canPlayVideo(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    const done = (ok: boolean) => {
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 6000);
    v.onloadeddata = () => done(v.videoWidth > 0);
    v.onerror = () => done(false);
    v.src = url;
  });
}

function asFile(blob: Blob, name: string) {
  return blob instanceof File ? blob : new File([blob], name, { type: blob.type });
}

/** PNG-копия первого кадра без потерь — для изображений, которые браузер не показывает (TIFF и т.п.). */
export async function imageProxy(blob: Blob, name: string): Promise<string> {
  const { data } = await runFFmpeg({
    file: asFile(blob, name),
    outName: 'preview.png',
    args: (input) => ['-i', input, '-frames:v', '1', '-update', '1', '-c:v', 'png'],
  });
  return URL.createObjectURL(new Blob([data as BlobPart], { type: 'image/png' }));
}

/**
 * Почти без потерь перекодированная копия для видео, которые браузер не играет (AVI, часть MKV, GIF…).
 * H.264, где он поддерживается, иначе VP8 (например, Chromium/Firefox без H.264).
 * Очень низкие квантизаторы — собственные артефакты превью намного меньше сравниваемых.
 */
export async function videoProxy(
  blob: Blob,
  name: string,
  onProgress?: (p: number) => void,
): Promise<string> {
  const h264 = document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"') !== '';
  const codec = h264
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '6', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
    : ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-qmin', '0', '-qmax', '8', '-b:v', '200M'];
  const ext = h264 ? 'mp4' : 'webm';
  const { data } = await runFFmpeg({
    file: asFile(blob, name),
    outName: `preview.${ext}`,
    onProgress,
    args: (input) => [
      '-i', input,
      '-map', '0:v:0',
      '-an',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      ...codec,
    ],
  });
  return URL.createObjectURL(new Blob([data as BlobPart], { type: `video/${ext}` }));
}
