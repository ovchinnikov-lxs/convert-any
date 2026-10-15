import { runFFmpeg } from './ffmpeg';

/** Resolves true if the browser can show this image natively. */
export function canShowImage(url: string): Promise<boolean> {
  const img = new Image();
  img.src = url;
  return img.decode().then(
    () => img.naturalWidth > 0,
    () => false,
  );
}

/** Resolves true if the browser can decode at least the first frame of this video. */
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

/** Lossless PNG copy of the first frame, for images the browser can't display (TIFF etc.). */
export async function imageProxy(blob: Blob, name: string): Promise<string> {
  const { data } = await runFFmpeg({
    file: asFile(blob, name),
    outName: 'preview.png',
    args: (input) => ['-i', input, '-frames:v', '1', '-update', '1', '-c:v', 'png'],
  });
  return URL.createObjectURL(new Blob([data as BlobPart], { type: 'image/png' }));
}

/**
 * Near-lossless copy for videos the browser can't play (AVI, some MKV, GIF…).
 * H.264 where supported, VP8 otherwise (e.g. Chromium/Firefox builds without H.264).
 * Very low quantizers keep the proxy's own artifacts far below what's being compared.
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
