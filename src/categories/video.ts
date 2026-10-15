import type { BuildContext, Category, Options } from './types';

const AUDIO_ONLY = ['mp3', 'm4a', 'ogg', 'wav'];

function parseTime(v: unknown): number | null {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function videoFilters(format: string, o: Options): string[] {
  const filters: string[] = [];
  const fps = Number(o.fps) || 0;
  if (fps) filters.push(`fps=${fps}`);
  const height = Number(o.resolution) || 0;
  if (format === 'gif') {
    const w = Number(o.gifWidth) || 480;
    filters.push(`scale='min(iw,${w})':-2:flags=lanczos`);
  } else if (height) {
    // Only downscale; keep dimensions even for yuv420p.
    filters.push(`scale=-2:'min(ih,${height})':flags=bicubic`);
  } else {
    filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  }
  return filters;
}

/** Maps 1..100 quality to an encoder CRF range (higher quality → lower CRF). */
function crf(quality: number, best: number, worst: number) {
  return String(Math.round(worst - ((quality - 1) / 99) * (worst - best)));
}

function targetBitrate(ctx: BuildContext): number | null {
  const { options, duration } = ctx;
  if (options.mode !== 'size' || !duration) return null;
  const effective = clipDuration(options, duration);
  const totalKbits = (Number(options.targetMB) || 10) * 8 * 1024 * 0.93;
  const audioKbps = options.removeAudio ? 0 : Number(options.audioBitrate) || 128;
  return Math.max(50, Math.floor(totalKbits / effective - audioKbps));
}

function clipDuration(o: Options, duration: number) {
  const start = parseTime(o.start) ?? 0;
  const end = parseTime(o.end) ?? duration;
  return Math.max(0.1, Math.min(end, duration) - start);
}

const speedPresets: Record<string, { x264: string; vpx: string }> = {
  fast: { x264: 'ultrafast', vpx: '8' },
  balanced: { x264: 'veryfast', vpx: '5' },
  small: { x264: 'medium', vpx: '2' },
};

export const videoCategory: Category = {
  id: 'video',
  title: 'Видео',
  icon: '🎬',
  description: 'MP4, WebM, MOV, MKV, AVI, GIF, извлечение звука — сжатие, обрезка, смена разрешения',
  status: 'ready',
  accept: 'video/*,.mkv,.mov,.avi,.flv,.wmv,.m4v,.3gp,.ts,.mts',
  needsDuration: true,
  formats: [
    { id: 'mp4', label: 'MP4', ext: 'mp4', mime: 'video/mp4', hint: 'H.264 + AAC, открывается везде' },
    { id: 'webm', label: 'WebM', ext: 'webm', mime: 'video/webm', hint: 'VP8 + Opus, для веба (кодируется медленнее MP4)' },
    { id: 'mov', label: 'MOV', ext: 'mov', mime: 'video/quicktime', hint: 'H.264 + AAC' },
    { id: 'mkv', label: 'MKV', ext: 'mkv', mime: 'video/x-matroska', hint: 'H.264 + AAC' },
    { id: 'avi', label: 'AVI', ext: 'avi', mime: 'video/x-msvideo', hint: 'MPEG-4 + MP3' },
    { id: 'gif', label: 'GIF', ext: 'gif', mime: 'image/gif', hint: 'Анимация без звука' },
    { id: 'mp3', label: 'MP3', ext: 'mp3', mime: 'audio/mpeg', hint: 'Только звук' },
    { id: 'm4a', label: 'M4A', ext: 'm4a', mime: 'audio/mp4', hint: 'Только звук (AAC)' },
    { id: 'ogg', label: 'OGG', ext: 'ogg', mime: 'audio/ogg', hint: 'Только звук (Opus)' },
    { id: 'wav', label: 'WAV', ext: 'wav', mime: 'audio/wav', hint: 'Только звук, без сжатия' },
  ],
  defaultFormat: 'mp4',
  defaultOptions: {
    mode: 'quality',
    quality: 60,
    targetMB: 10,
    resolution: '0',
    fps: '0',
    speed: 'balanced',
    start: '',
    end: '',
    removeAudio: false,
    audioBitrate: '128',
    gifWidth: 480,
  },
  formatDefaults: {
    gif: { fps: '12' },
  },
  fields: [
    {
      key: 'mode',
      type: 'select',
      label: 'Режим сжатия',
      choices: [
        { value: 'quality', label: 'По качеству' },
        { value: 'size', label: 'До размера файла' },
      ],
      visible: (_o, f) => !AUDIO_ONLY.includes(f) && f !== 'gif',
    },
    {
      key: 'quality',
      type: 'slider',
      label: 'Качество',
      min: 1,
      max: 100,
      unit: '%',
      hint: 'Меньше — легче файл',
      visible: (o, f) => !AUDIO_ONLY.includes(f) && f !== 'gif' && o.mode !== 'size',
    },
    {
      key: 'targetMB',
      type: 'number',
      label: 'Целевой размер',
      min: 0.1,
      step: 0.5,
      unit: 'МБ',
      hint: 'Битрейт подбирается автоматически',
      visible: (o, f) => !AUDIO_ONLY.includes(f) && f !== 'gif' && o.mode === 'size',
    },
    {
      key: 'resolution',
      type: 'select',
      label: 'Разрешение',
      choices: [
        { value: '0', label: 'Оригинальное' },
        { value: '2160', label: '4K (2160p)' },
        { value: '1440', label: '1440p' },
        { value: '1080', label: '1080p' },
        { value: '720', label: '720p' },
        { value: '480', label: '480p' },
        { value: '360', label: '360p' },
        { value: '240', label: '240p' },
      ],
      hint: 'Видео только уменьшается, не растягивается',
      visible: (_o, f) => !AUDIO_ONLY.includes(f) && f !== 'gif',
    },
    {
      key: 'gifWidth',
      type: 'slider',
      label: 'Ширина GIF',
      min: 120,
      max: 1280,
      step: 20,
      unit: 'px',
      visible: (_o, f) => f === 'gif',
    },
    {
      key: 'fps',
      type: 'select',
      label: 'Кадров в секунду',
      choices: [
        { value: '0', label: 'Как в оригинале' },
        { value: '60', label: '60' },
        { value: '30', label: '30' },
        { value: '24', label: '24' },
        { value: '15', label: '15' },
        { value: '12', label: '12' },
        { value: '10', label: '10' },
      ],
      visible: (_o, f) => !AUDIO_ONLY.includes(f),
    },
    {
      key: 'speed',
      type: 'select',
      label: 'Скорость кодирования',
      choices: [
        { value: 'fast', label: 'Быстро (файл больше)' },
        { value: 'balanced', label: 'Сбалансировано' },
        { value: 'small', label: 'Медленно (файл меньше)' },
      ],
      visible: (_o, f) => ['mp4', 'webm', 'mov', 'mkv'].includes(f),
    },
    { key: 'start', type: 'text', label: 'Начало', placeholder: '0:00', hint: 'Секунды или мм:сс' },
    { key: 'end', type: 'text', label: 'Конец', placeholder: 'до конца' },
    {
      key: 'removeAudio',
      type: 'checkbox',
      label: 'Убрать звук',
      visible: (_o, f) => !AUDIO_ONLY.includes(f) && f !== 'gif',
    },
    {
      key: 'audioBitrate',
      type: 'select',
      label: 'Битрейт звука',
      choices: [
        { value: '64', label: '64 кбит/с' },
        { value: '96', label: '96 кбит/с' },
        { value: '128', label: '128 кбит/с' },
        { value: '192', label: '192 кбит/с' },
        { value: '256', label: '256 кбит/с' },
        { value: '320', label: '320 кбит/с' },
      ],
      visible: (o, f) => f !== 'gif' && f !== 'wav' && !o.removeAudio,
    },
  ],
  buildArgs: (ctx) => {
    const { input, format, options: o } = ctx;
    const args: string[] = [];
    const start = parseTime(o.start);
    const end = parseTime(o.end);
    if (start) args.push('-ss', String(start));
    args.push('-i', input);
    if (end != null) args.push('-t', String(Math.max(0.1, end - (start ?? 0))));
    args.push('-map_metadata', '-1');

    const ab = `${o.audioBitrate || 128}k`;

    if (AUDIO_ONLY.includes(format.id)) {
      args.push('-vn');
      if (format.id === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', ab);
      if (format.id === 'm4a') args.push('-c:a', 'aac', '-b:a', ab);
      if (format.id === 'ogg') args.push('-c:a', 'libopus', '-b:a', ab);
      if (format.id === 'wav') args.push('-c:a', 'pcm_s16le');
      return args;
    }

    if (format.id === 'gif') {
      const f = videoFilters('gif', o).join(',');
      args.push(
        '-filter_complex',
        `[0:v]${f},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
        '-loop',
        '0',
        '-an',
      );
      return args;
    }

    args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn');
    args.push('-vf', videoFilters(format.id, o).join(','));
    const speed = speedPresets[String(o.speed)] ?? speedPresets.balanced;
    const q = Number(o.quality) || 60;
    const kbps = targetBitrate(ctx);

    switch (format.id) {
      case 'webm':
        // VP8: libvpx-vp9 crashes in the current single-threaded ffmpeg.wasm build.
        args.push('-c:v', 'libvpx', '-deadline', 'good', '-cpu-used', speed.vpx, '-auto-alt-ref', '0');
        if (kbps) args.push('-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`);
        // In libvpx, CRF only works together with a bitrate cap.
        else args.push('-crf', crf(q, 6, 60), '-b:v', '20M');
        args.push('-pix_fmt', 'yuv420p');
        if (!o.removeAudio) args.push('-c:a', 'libopus', '-b:a', ab);
        break;
      case 'avi':
        args.push('-c:v', 'mpeg4', '-vtag', 'xvid');
        if (kbps) args.push('-b:v', `${kbps}k`);
        else args.push('-q:v', String(Math.round(2 + ((100 - q) / 99) * 20)));
        if (!o.removeAudio) args.push('-c:a', 'libmp3lame', '-b:a', ab);
        break;
      default: // mp4, mov, mkv
        args.push('-c:v', 'libx264', '-preset', speed.x264, '-pix_fmt', 'yuv420p');
        if (kbps) args.push('-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`);
        else args.push('-crf', crf(q, 18, 38));
        if (!o.removeAudio) args.push('-c:a', 'aac', '-b:a', ab);
        if (format.id !== 'mkv') args.push('-movflags', '+faststart');
    }
    if (o.removeAudio) args.push('-an');
    return args;
  },
};
