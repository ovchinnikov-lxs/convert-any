import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { LocalizedError } from '../i18n';

// Многопоточное ядро — если страница изолирована (доступен SharedArrayBuffer).
let useMT = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

export function engineThreads() {
  return useMT ? 'mt' : 'st';
}

let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;
let coreURLs: Promise<{ coreURL: string; wasmURL: string; workerURL?: string }> | null = null;

export type LoadProgress = (loaded: number, total: number) => void;

async function fetchToBlobURL(url: string, mime: string, onProgress?: LoadProgress): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new LocalizedError('err.load', { url, status: res.status });
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  return URL.createObjectURL(new Blob(chunks as BlobPart[], { type: mime }));
}

/** Лениво (один раз) загружает ядро ffmpeg.wasm. */
export function loadFFmpeg(onProgress?: LoadProgress): Promise<FFmpeg> {
  if (instance) return Promise.resolve(instance);
  if (loading) return loading;
  loading = (async () => {
    // Файлы ядра скачиваются один раз и хранятся как blob-ссылки, поэтому
    // пересоздать экземпляр после сбоя или отмены — дёшево.
    coreURLs ??= (async () => {
      const base = `/ffmpeg/${useMT ? 'mt' : 'st'}`;
      return {
        coreURL: await fetchToBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await fetchToBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm', onProgress),
        workerURL: useMT ? await fetchToBlobURL(`${base}/ffmpeg-core.worker.js`, 'text/javascript') : undefined,
      };
    })();
    coreURLs.catch(() => {
      coreURLs = null;
    });
    const ff = new FFmpeg();
    try {
      await ff.load(await coreURLs);
    } catch (e) {
      if (!useMT) throw e;
      // Многопоточное ядро не запустилось — переходим на однопоточное.
      ff.terminate();
      switchToSingleThread();
      instance = null;
      loading = null;
      return loadFFmpeg(onProgress);
    }
    instance = ff;
    return ff;
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

export function isFFmpegLoaded() {
  return instance !== null;
}

let generation = 0;

/** Отменяет текущую задачу. Следующий loadFFmpeg создаст новый экземпляр. */
export function cancelFFmpeg() {
  generation++;
  terminateFFmpeg();
}

function switchToSingleThread() {
  useMT = false;
  coreURLs = null;
}

function terminateFFmpeg() {
  instance?.terminate();
  instance = null;
  loading = null;
}

export interface MediaInfo {
  duration?: number;
  fps?: number;
  /** Общий битрейт, кбит/с. */
  bitrate?: number;
  vcodec?: string;
  width?: number;
  height?: number;
  /** Битрейт видеопотока, кбит/с (оценивается по общему, если контейнер его не сообщает). */
  vbitrate?: number;
  acodec?: string;
  abitrate?: number;
}

export interface RunResult {
  data: Uint8Array;
  info: MediaInfo;
}

export interface RunOptions {
  file: File;
  outName: string;
  /** Сначала проанализировать вход (длительность, битрейты…) и передать в `args`. */
  probe?: boolean;
  /** Собирает аргументы по пути, откуда ffmpeg читает вход. */
  args: (inputPath: string, info: MediaInfo) => string[];
  onProgress?: (ratio: number) => void;
  onLog?: (line: string) => void;
}

let jobCounter = 0;

// Экземпляр ffmpeg умеет делать только одно дело за раз — всё ставим в очередь.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/**
 * Одна конвертация. ffmpeg.wasm иногда «ломается» после предыдущих запусков,
 * поэтому при ошибке повторяем один раз на свежем экземпляре.
 */
export function runFFmpeg(opts: RunOptions): Promise<RunResult> {
  return serial(async () => {
    const gen = generation;
    try {
      return await runOnce(opts);
    } catch (first) {
      if (gen !== generation) throw first;
      terminateFFmpeg();
      // Сбой на многопоточном ядре — повторяем на однопоточном и остаёмся на нём.
      if (useMT) switchToSingleThread();
      try {
        return await runOnce(opts);
      } catch {
        terminateFFmpeg();
        throw first;
      }
    }
  });
}

/** Читает кодек, разрешение и битрейт без конвертации. */
export function probeMedia(file: File): Promise<MediaInfo> {
  return serial(async () => {
    const ff = await loadFFmpeg();
    return withInput(ff, file, async (inputPath) => {
      const logs: string[] = [];
      const onLog = ({ message }: { message: string }) => logs.push(message);
      ff.on('log', onLog);
      try {
        await ff.exec(['-hide_banner', '-i', inputPath]);
      } finally {
        ff.off('log', onLog);
      }
      return parseMediaInfo(logs);
    });
  });
}

async function withInput<T>(ff: FFmpeg, file: File, fn: (inputPath: string) => Promise<T>): Promise<T> {
  const job = ++jobCounter;
  const mountDir = `/in${job}`;
  let inputPath: string;
  let mounted = false;
  // WORKERFS читает файл по мере надобности, не копируя его в память wasm, —
  // для больших видео это критично.
  try {
    await ff.createDir(mountDir);
    await ff.mount(FFFSType.WORKERFS, { files: [file] }, mountDir);
    inputPath = `${mountDir}/${file.name}`;
    mounted = true;
  } catch {
    inputPath = `/in${job}_${sanitize(file.name)}`;
    await ff.writeFile(inputPath, new Uint8Array(await file.arrayBuffer()));
  }
  try {
    return await fn(inputPath);
  } finally {
    if (mounted) {
      await ff.unmount(mountDir).catch(() => {});
      await ff.deleteDir(mountDir).catch(() => {});
    } else {
      await ff.deleteFile(inputPath).catch(() => {});
    }
  }
}

async function runOnce({ file, outName, probe, args, onProgress, onLog }: RunOptions): Promise<RunResult> {
  const ff = await loadFFmpeg();
  const outPath = `/out${++jobCounter}_${outName}`;

  return withInput(ff, file, async (inputPath) => {
    const logs: string[] = [];
    const logHandler = ({ message }: { message: string }) => {
      logs.push(message);
      if (logs.length > 200) logs.shift();
      onLog?.(message);
      if ((globalThis as { __ffdebug?: boolean }).__ffdebug) console.debug('[ffmpeg]', message);
    };
    const progressHandler = ({ progress }: { progress: number }) => {
      if (Number.isFinite(progress)) onProgress?.(Math.min(1, Math.max(0, progress)));
    };
    ff.on('log', logHandler);
    ff.on('progress', progressHandler);

    try {
      let info: MediaInfo = {};
      if (probe) {
        const start = logs.length;
        // Завершится с ошибкой (нет выходного файла), но напечатает сведения о потоках.
        await ff.exec(['-hide_banner', '-i', inputPath]);
        info = parseMediaInfo(logs.slice(start));
      }
      const code = await ff.exec(['-hide_banner', '-y', ...adaptForThreads(args(inputPath, info)), outPath]);
      if (code !== 0) {
        throw new Error(extractError(logs) || new LocalizedError('err.ffmpegCode', { code }).message);
      }
      const data = await ff.readFile(outPath);
      if (typeof data === 'string' || data.length === 0) throw new LocalizedError('err.empty');
      return { data, info };
    } finally {
      ff.off('log', logHandler);
      ff.off('progress', progressHandler);
      await ff.deleteFile(outPath).catch(() => {});
    }
  });
}

/**
 * Многопоточное ядро падает с многопоточным декодером ffmpeg и с x264 больше
 * чем в 4 потока, но стабильно (и ~в 2,3 раза быстрее) с однопоточным декодером
 * и внутренними потоками x264, ограниченными четырьмя.
 */
function adaptForThreads(args: string[]): string[] {
  if (!useMT) return args;
  const out = [...args];
  const firstInput = out.indexOf('-i');
  if (firstInput >= 0) out.splice(firstInput, 0, '-threads', '1');
  if (out.includes('libx264')) {
    const n = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
    const p = out.indexOf('-x264-params');
    if (p >= 0) out[p + 1] += `:threads=${n}`;
    else out.push('-x264-params', `threads=${n}`);
  }
  return out;
}

export function parseMediaInfo(lines: string[]): MediaInfo {
  const info: MediaInfo = {};
  for (const l of lines) {
    let m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(l);
    if (m && info.duration === undefined) info.duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    m = /Duration:.*bitrate:\s*(\d+)\s*kb\/s/.exec(l);
    if (m && info.bitrate === undefined) info.bitrate = Number(m[1]);

    if (/Stream #.*Video:/.test(l) && !info.vcodec && !/attached pic/.test(l)) {
      info.vcodec = /Video:\s*(\w+)/.exec(l)?.[1];
      const size = /,\s*(\d{2,5})x(\d{2,5})/.exec(l);
      if (size) [info.width, info.height] = [Number(size[1]), Number(size[2])];
      const br = /(\d+)\s*kb\/s/.exec(l);
      if (br) info.vbitrate = Number(br[1]);
      const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(l);
      if (fps) info.fps = Number(fps[1]);
    }
    if (/Stream #.*Audio:/.test(l) && !info.acodec) {
      info.acodec = /Audio:\s*(\w+)/.exec(l)?.[1];
      const br = /(\d+)\s*kb\/s/.exec(l);
      if (br) info.abitrate = Number(br[1]);
    }
  }
  if (!info.vbitrate && info.bitrate && info.vcodec) {
    info.vbitrate = Math.max(1, info.bitrate - (info.abitrate ?? (info.acodec ? 128 : 0)));
  }
  return info;
}

function sanitize(name: string) {
  return name.replace(/[^\w.-]+/g, '_');
}

function extractError(logs: string[]): string {
  const interesting = logs.filter((l) =>
    /error|invalid|not supported|unknown|could not|no such|failed|unable/i.test(l),
  );
  return (interesting.length ? interesting : logs).slice(-3).join('\n');
}
