import type { BuildContext, Category, Options } from './types';

/** Audio-only formats — video settings are hidden for them. */
const AUDIO_ONLY = ['mp3', 'm4a', 'ogg', 'wav'];

/** Parses "90", "1:30", "1:02:03" or "12,5" into seconds. */
export function parseTime(v: unknown): number | null {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Frame filters: frame rate and size. */
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

/** Video bitrate for the target-size mode, kbit/s. */
function targetBitrate(ctx: BuildContext): number | null {
  const { options, duration } = ctx;
  if (options.mode !== 'size' || !duration) return null;
  const effective = clipDuration(options, duration);
  const totalKbits = (Number(options.targetMB) || 10) * 8 * 1024 * 0.93;
  const audioKbps = options.removeAudio ? 0 : audioKbit(ctx);
  const kbps = Math.max(50, Math.floor(totalKbits / effective - audioKbps));
  // A target above the source's size would only inflate the file.
  const cap = videoCap(ctx);
  return cap ? Math.min(kbps, cap) : kbps;
}

/**
 * Audio bitrate: the chosen one, but never above the source's — re-encoding
 * 64 kbit/s audio at 128 only makes the file bigger.
 */
function audioKbit(ctx: BuildContext): number {
  const chosen = Number(ctx.options.audioBitrate) || 128;
  const src = ctx.media?.abitrate;
  return src ? Math.min(chosen, Math.max(32, Math.ceil(src / 8) * 8)) : chosen;
}

/**
 * Upper bound for video bitrate in quality mode: a bit below the source's own,
 * so re-encoding never makes a file bigger.
 */
function videoCap(ctx: BuildContext): number | null {
  const v = ctx.media?.vbitrate;
  return v && v > 50 ? Math.round(v * 0.9) : null;
}

/** Clip duration after trimming. */
function clipDuration(o: Options, duration: number) {
  const start = parseTime(o.start) ?? 0;
  const end = parseTime(o.end) ?? duration;
  return Math.max(0.1, Math.min(end, duration) - start);
}

/** Encoding speed presets for x264 and libvpx. */
const speedPresets: Record<string, { x264: string; vpx: string }> = {
  fast: { x264: 'ultrafast', vpx: '8' },
  balanced: { x264: 'veryfast', vpx: '5' },
  small: { x264: 'medium', vpx: '2' },
};

export const videoCategory: Category = {
  id: 'video',
  title: 'cat.video.title',
  icon: '🎬',
  description: 'cat.video.desc',
  status: 'ready',
  accept: 'video/*,.mkv,.mov,.avi,.flv,.wmv,.m4v,.3gp,.ts,.mts',
  needsDuration: true,
  formats: [
    { id: 'mp4', label: 'MP4', ext: 'mp4', mime: 'video/mp4', hint: 'hint.mp4' },
    { id: 'webm', label: 'WebM', ext: 'webm', mime: 'video/webm', hint: 'hint.webm' },
    { id: 'mov', label: 'MOV', ext: 'mov', mime: 'video/quicktime' },
    { id: 'mkv', label: 'MKV', ext: 'mkv', mime: 'video/x-matroska' },
    { id: 'avi', label: 'AVI', ext: 'avi', mime: 'video/x-msvideo' },
    { id: 'gif', label: 'GIF', ext: 'gif', mime: 'image/gif', hint: 'hint.vgif' },
    { id: 'mp3', label: 'MP3', ext: 'mp3', mime: 'audio/mpeg', hint: 'hint.mp3' },
    { id: 'm4a', label: 'M4A', ext: 'm4a', mime: 'audio/mp4', hint: 'hint.m4a' },
    { id: 'ogg', label: 'OGG', ext: 'ogg', mime: 'audio/ogg', hint: 'hint.ogg' },
    { id: 'wav', label: 'WAV', ext: 'wav', mime: 'audio/wav', hint: 'hint.wav' },
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
      label: 'opt.mode',
      choices: [
        { value: 'quality', label: 'opt.mode.quality' },
        { value: 'size', label: 'opt.mode.size' },
      ],
      visible: (_o, f) => !AUDIO_ONLY.includes(f) && f !== 'gif',
    },
    {
      key: 'quality',
      type: 'slider',
      label: 'opt.quality',
      min: 1,
      max: 100,
      unit: '%',
      hint: 'opt.quality.hint',
      visible: (o, f) => !AUDIO_ONLY.includes(f) && f !== 'gif' && o.mode !== 'size',
    },
    {
      key: 'targetMB',
      type: 'number',
      label: 'opt.target',
      min: 0.1,
      step: 0.5,
      unit: 'unit.MB',
      hint: 'opt.target.hint',
      visible: (o, f) => !AUDIO_ONLY.includes(f) && f !== 'gif' && o.mode === 'size',
    },
    {
      key: 'resolution',
      type: 'select',
      label: 'opt.res',
      choices: [
        { value: '0', label: 'opt.res.orig' },
        { value: '2160', label: '4K (2160p)' },
        { value: '1440', label: '1440p' },
        { value: '1080', label: '1080p' },
        { value: '720', label: '720p' },
        { value: '480', label: '480p' },
        { value: '360', label: '360p' },
        { value: '240', label: '240p' },
      ],
      hint: 'opt.res.hint',
      visible: (_o, f) => !AUDIO_ONLY.includes(f) && f !== 'gif',
    },
    {
      key: 'gifWidth',
      type: 'slider',
      label: 'opt.gifWidth',
      min: 120,
      max: 1280,
      step: 20,
      unit: 'px',
      visible: (_o, f) => f === 'gif',
    },
    {
      key: 'fps',
      type: 'select',
      label: 'opt.fps',
      choices: [
        { value: '0', label: 'opt.fps.orig' },
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
      label: 'opt.speed',
      choices: [
        { value: 'fast', label: 'opt.speed.fast' },
        { value: 'balanced', label: 'opt.speed.balanced' },
        { value: 'small', label: 'opt.speed.small' },
      ],
      visible: (_o, f) => ['mp4', 'webm', 'mov', 'mkv'].includes(f),
    },
    { key: 'start', type: 'text', label: 'opt.start', placeholder: '0:00', hint: 'opt.start.hint' },
    { key: 'end', type: 'text', label: 'opt.end', placeholder: 'opt.end.ph' },
    {
      key: 'removeAudio',
      type: 'checkbox',
      label: 'opt.mute',
      visible: (_o, f) => !AUDIO_ONLY.includes(f) && f !== 'gif',
    },
    {
      key: 'audioBitrate',
      type: 'select',
      label: 'opt.abitrate',
      choices: [
        { value: '64', label: 'unit.kbpsN', params: { n: 64 } },
        { value: '96', label: 'unit.kbpsN', params: { n: 96 } },
        { value: '128', label: 'unit.kbpsN', params: { n: 128 } },
        { value: '192', label: 'unit.kbpsN', params: { n: 192 } },
        { value: '256', label: 'unit.kbpsN', params: { n: 256 } },
        { value: '320', label: 'unit.kbpsN', params: { n: 320 } },
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

    const ab = `${audioKbit(ctx)}k`;

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
        // VP8: libvpx-vp9 crashes in the current ffmpeg.wasm build.
        args.push('-c:v', 'libvpx', '-deadline', 'good', '-cpu-used', speed.vpx, '-auto-alt-ref', '0');
        if (kbps) args.push('-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`);
        // In libvpx, CRF only works together with a bitrate cap.
        else args.push('-crf', crf(q, 6, 60), '-b:v', `${Math.min(20000, videoCap(ctx) ?? 20000)}k`);
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
        else {
          args.push('-crf', crf(q, 18, 38));
          // Capped CRF: the result never needs more bits than the source had.
          const cap = videoCap(ctx);
          if (cap) args.push('-maxrate', `${cap}k`, '-bufsize', `${cap}k`);
        }
        if (!o.removeAudio) args.push('-c:a', 'aac', '-b:a', ab);
        if (format.id !== 'mkv') args.push('-movflags', '+faststart');
    }
    if (o.removeAudio) args.push('-an');
    return args;
  },
};
