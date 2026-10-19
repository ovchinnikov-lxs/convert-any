import type { Category, Options } from './types';

/** Lossy formats — they get a quality slider. */
const lossyFormats = ['webp', 'jpg'];

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
      key: 'stripMetadata',
      type: 'checkbox',
      label: 'opt.strip',
    },
  ],
  buildArgs: ({ input, format, options }) => {
    const args = ['-i', input];
    const filters: string[] = [];
    const scale = scaleFilter(options);
    if (scale) filters.push(scale);
    const q = Number(options.quality);

    switch (format.id) {
      case 'webp':
        args.push('-c:v', 'libwebp', '-loop', '0');
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
      case 'png':
        args.push('-c:v', 'png', '-compression_level', '9');
        break;
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
    // Single-frame outputs: take only the first frame for formats without animation.
    if (['jpg', 'png', 'bmp', 'tiff', 'ico'].includes(format.id)) {
      args.push('-frames:v', '1', '-update', '1');
    }
    return args;
  },
};
