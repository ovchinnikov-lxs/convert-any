import { setLastFrameDuration } from '../lib/animation';
import { framesFromShowinfo, rgbaToApng } from '../lib/apng';
import type { Category, Options } from './types';

/** Lossy formats — they get a quality slider. */
const lossyFormats = ['webp', 'jpg'];

/** Formats that keep an animation (others take the first frame). */
export const ANIMATED_OUTPUTS = ['webp', 'png', 'gif'];

/**
 * APNG is assembled from raw RGBA frames by our own writer (lib/apng.ts):
 * ffmpeg's APNG encoder corrupts frames — semi-transparent pixels and, after
 * palette reduction, whole areas drift further from the source every frame.
 */
const apngFromRaw = (format: string, keepAnimation: boolean) => keepAnimation && format === 'png';

/** Palette reduction (like pngquant): far smaller PNG / APNG, transparency kept. */
function paletteFilter(colors: number) {
  return (
    `split[pa][pb];[pa]palettegen=max_colors=${colors}:reserve_transparent=1:stats_mode=full[pal];` +
    '[pb][pal]paletteuse=dither=sierra2_4a:alpha_threshold=128'
  );
}

/** ffmpeg resize filter for the chosen mode (null = keep size). */
function scaleFilter(o: Options): string | null {
  const mode = o.resize as string;
  const w = Number(o.width) || 0;
  const h = Number(o.height) || 0;
  switch (mode) {
    case 'percent': {
      const p = Math.max(1, Number(o.percent) || 100) / 100;
      if (p === 1) return null;
      return `scale=max(1\\,round(iw*${p})):max(1\\,round(ih*${p})):flags=lanczos`;
    }
    case 'fit': {
      if (!w && !h) return null;
      const W = w || 100000;
      const H = h || 100000;
      // Shrink only, keep aspect ratio.
      return `scale=w='min(iw,${W})':h='min(ih,${H})':force_original_aspect_ratio=decrease:flags=lanczos`;
    }
    case 'exact': {
      if (!w && !h) return null;
      return `scale=${w || -1}:${h || -1}:flags=lanczos`;
    }
    default:
      return null;
  }
}

export const imageCategory: Category = {
  id: 'image',
  title: 'cat.image.title',
  icon: '🖼️',
  description: 'cat.image.desc',
  note: 'cat.image.note',
  status: 'ready',
  accept: 'image/*,.heic,.heif,.hif,.ico,.tif,.tiff,.bmp,.tga',
  formats: [
    { id: 'webp', label: 'WebP', ext: 'webp', mime: 'image/webp', hint: 'hint.webp' },
    { id: 'png', label: 'PNG', ext: 'png', mime: 'image/png', hint: 'hint.png' },
    { id: 'jpg', label: 'JPG', ext: 'jpg', mime: 'image/jpeg', hint: 'hint.jpg' },
    { id: 'gif', label: 'GIF', ext: 'gif', mime: 'image/gif', hint: 'hint.gif' },
    { id: 'bmp', label: 'BMP', ext: 'bmp', mime: 'image/bmp' },
    { id: 'tiff', label: 'TIFF', ext: 'tiff', mime: 'image/tiff' },
    { id: 'ico', label: 'ICO', ext: 'ico', mime: 'image/x-icon', hint: 'hint.ico' },
  ],
  defaultFormat: 'webp',
  defaultOptions: {
    quality: 80,
    lossless: false,
    resize: 'none',
    percent: 50,
    width: 0,
    height: 0,
    stripMetadata: true,
    colors: 'full',
    animFps: '0',
  },
  fields: [
    {
      key: 'quality',
      type: 'slider',
      label: 'opt.quality',
      min: 1,
      max: 100,
      unit: '%',
      hint: 'opt.quality.hint',
      visible: (o, f) => lossyFormats.includes(f) && !(f === 'webp' && o.lossless),
    },
    {
      key: 'lossless',
      type: 'checkbox',
      label: 'opt.lossless',
      visible: (_o, f) => f === 'webp',
    },
    {
      key: 'resize',
      type: 'select',
      label: 'opt.size',
      choices: [
        { value: 'none', label: 'opt.size.none' },
        { value: 'percent', label: 'opt.size.percent' },
        { value: 'fit', label: 'opt.size.fit' },
        { value: 'exact', label: 'opt.size.exact' },
      ],
    },
    {
      key: 'percent',
      type: 'slider',
      label: 'opt.scale',
      min: 5,
      max: 200,
      step: 5,
      unit: '%',
      visible: (o) => o.resize === 'percent',
    },
    {
      key: 'width',
      type: 'number',
      label: 'opt.width',
      min: 0,
      unit: 'px',
      placeholder: 'opt.auto',
      visible: (o) => o.resize === 'fit' || o.resize === 'exact',
    },
    {
      key: 'height',
      type: 'number',
      label: 'opt.height',
      min: 0,
      unit: 'px',
      placeholder: 'opt.auto',
      visible: (o) => o.resize === 'fit' || o.resize === 'exact',
    },
    {
      key: 'colors',
      type: 'select',
      label: 'opt.colors',
      choices: [
        { value: 'full', label: 'opt.colors.full' },
        { value: '256', label: 'opt.colors.n', params: { n: 256 } },
        { value: '128', label: 'opt.colors.n', params: { n: 128 } },
        { value: '64', label: 'opt.colors.n', params: { n: 64 } },
        { value: '32', label: 'opt.colors.n', params: { n: 32 } },
        { value: '16', label: 'opt.colors.n', params: { n: 16 } },
      ],
      hint: 'opt.colors.hint',
      visible: (_o, f) => f === 'png',
    },
    {
      key: 'animFps',
      type: 'select',
      label: 'opt.animFps',
      choices: [
        { value: '0', label: 'opt.fps.orig' },
        { value: '30', label: '30' },
        { value: '25', label: '25' },
        { value: '20', label: '20' },
        { value: '15', label: '15' },
        { value: '12', label: '12' },
        { value: '10', label: '10' },
      ],
      hint: 'opt.animFps.hint',
      visible: (_o, f, i) => i.has('anim') && ANIMATED_OUTPUTS.includes(f),
    },
    {
      key: 'stripMetadata',
      type: 'checkbox',
      label: 'opt.strip',
    },
  ],
  buildArgs: ({ input, format, options, crop, inputArgs, animated, lastFrameMs, animDuration }) => {
    const args = [...(inputArgs ?? []), '-i', input];
    const filters: string[] = [];
    const keepAnimation = Boolean(animated) && ANIMATED_OUTPUTS.includes(format.id);
    // Fewer frames per second = a smaller animation. The last frame is held for its
    // own duration first, otherwise resampling would cut it (and the loop) short.
    const fps = Number(options.animFps) || 0;
    if (keepAnimation && fps) {
      filters.push(`tpad=stop_mode=clone:stop_duration=${((lastFrameMs ?? 100) / 1000).toFixed(3)}`, `fps=${fps}`);
    }
    // Crop first, so resizing applies to the cropped area.
    if (crop) filters.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
    const scale = scaleFilter(options);
    if (scale) filters.push(scale);
    const q = Number(options.quality);

    switch (format.id) {
      case 'webp':
        // libwebp_anim encodes only what changes between frames — much smaller animations.
        args.push('-c:v', keepAnimation ? 'libwebp_anim' : 'libwebp', '-loop', '0');
        if (options.lossless) args.push('-lossless', '1', '-compression_level', '6');
        else args.push('-quality', String(q), '-compression_level', '4');
        break;
      case 'jpg':
        // Flatten transparency onto white; JPEG has no alpha.
        filters.push(
          'format=rgba,split[fg][bg];[bg]drawbox=c=white@1:t=fill[w];[w][fg]overlay=format=auto,format=yuvj444p',
        );
        args.push('-c:v', 'mjpeg', '-q:v', String(Math.round(2 + ((100 - q) / 99) * 29)));
        break;
      case 'png': {
        const colors = Number(options.colors) || 0;
        if (colors) filters.push(paletteFilter(colors));
        // An animation becomes an APNG (plays in all modern browsers); a still image a regular PNG.
        if (apngFromRaw(format.id, keepAnimation)) {
          // Raw RGBA frames + their timestamps (showinfo) → assembled in postProcess.
          filters.push('showinfo');
          args.push('-f', 'rawvideo', '-pix_fmt', 'rgba');
        } else args.push('-c:v', 'png', '-compression_level', '9');
        break;
      }
      case 'gif':
        filters.push('split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse');
        args.push('-loop', '0');
        break;
      case 'ico':
        filters.push(
          "scale=w='min(iw,256)':h='min(ih,256)':force_original_aspect_ratio=decrease",
        );
        args.push('-c:v', 'png');
        break;
      case 'tiff':
        args.push('-c:v', 'tiff', '-compression_algo', 'deflate');
        break;
      case 'bmp':
        args.push('-c:v', 'bmp');
        break;
    }

    if (filters.length) args.push('-vf', filters.join(','));
    if (options.stripMetadata) args.push('-map_metadata', '-1');
    if (keepAnimation) {
      // Keep each frame's own duration (no constant-frame-rate resampling).
      args.push('-fps_mode', 'passthrough');
      // Resampling rounds the end up to a whole frame — keep the loop as long as the source.
      if (fps && animDuration) args.push('-t', (animDuration / 1000).toFixed(3));
    } else if (['jpg', 'png', 'bmp', 'tiff', 'ico'].includes(format.id)) {
      // Single-frame outputs: take only the first frame.
      args.push('-frames:v', '1', '-update', '1');
    }
    return args;
  },
  postProcess: async ({ data, logs, format, options, animated, lastFrameMs, animDuration }) => {
    if (!animated || !ANIMATED_OUTPUTS.includes(format.id)) return data;
    const fps = Number(options.animFps) || 0;
    // Encoders only guess the last frame's duration — use the real one.
    const lastMs = fps ? 1000 / fps : (lastFrameMs ?? 100);
    // Resampled: the last frame fills the loop up to the source's length.
    const total = fps ? animDuration : undefined;
    if (apngFromRaw(format.id, true)) {
      const { width, height, durations } = framesFromShowinfo(logs, lastMs);
      const n = Math.min(durations.length, Math.floor(data.length / (width * height * 4)));
      const frames = durations.slice(0, n);
      if (total && n) {
        const rest = total - frames.slice(0, -1).reduce((a, d) => a + d, 0);
        if (rest > lastMs / 2) frames[n - 1] = rest;
      }
      return rgbaToApng({ data, width, height, durations: frames });
    }
    return setLastFrameDuration(data, lastMs, total);
  },
};
