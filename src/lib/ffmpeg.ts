import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { LocalizedError } from '../i18n';

// Multi-threaded core when the page is cross-origin isolated (SharedArrayBuffer available).
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

/** Lazily loads the ffmpeg.wasm core (once). */
export function loadFFmpeg(onProgress?: LoadProgress): Promise<FFmpeg> {
  if (instance) return Promise.resolve(instance);
  if (loading) return loading;
  loading = (async () => {
    // Core files are downloaded once and kept as blob URLs, so re-creating
    // the instance after a crash/cancel is cheap.
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
      // Multi-threaded core didn't start — fall back to the single-threaded one.
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

/** Cancels the running job. The next call to loadFFmpeg creates a fresh instance. */
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
  /** Overall bitrate, kbit/s. */
  bitrate?: number;
  vcodec?: string;
  width?: number;
  height?: number;
  /** Video stream bitrate, kbit/s (estimated from the total when the container doesn't say). */
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
  /** Files placed in the same folder as `file` (e.g. the frames an ffconcat list refers to). */
  extraFiles?: File[];
  outName: string;
  /** Probe the input first (duration, bitrates…) and pass it to `args`. */
  probe?: boolean;
  /** Builds the argument list given the path ffmpeg should read the input from. */
  args: (inputPath: string, info: MediaInfo) => string[];
  onProgress?: (ratio: number) => void;
  onLog?: (line: string) => void;
}

let jobCounter = 0;

// One ffmpeg instance can only do one thing at a time; queue everything.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/**
 * Runs one conversion. ffmpeg.wasm occasionally ends up in a broken state
 * after earlier runs, so on failure we retry once on a fresh instance.
 */
export function runFFmpeg(opts: RunOptions): Promise<RunResult> {
  return serial(async () => {
    const gen = generation;
    try {
      return await runOnce(opts);
    } catch (first) {
      if (gen !== generation) throw first;
      terminateFFmpeg();
      // A failure on the multi-threaded core: retry (and stay) on the single-threaded one.
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

/** Reads codec / resolution / bitrate info without converting. */
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

async function withInput<T>(
  ff: FFmpeg,
  file: File,
  fn: (inputPath: string) => Promise<T>,
  extraFiles: File[] = [],
): Promise<T> {
  const job = ++jobCounter;
  const mountDir = `/in${job}`;
  const all = [file, ...extraFiles];
  await ff.createDir(mountDir);
  let mounted = false;
  let written: string[] = [];
  // WORKERFS reads the files lazily instead of copying them into wasm memory,
  // which matters a lot for big videos.
  try {
    await ff.mount(FFFSType.WORKERFS, { files: all }, mountDir);
    mounted = true;
  } catch {
    written = all.map((f) => `${mountDir}/${f === file ? sanitize(f.name) : f.name}`);
    for (const [i, f] of all.entries()) await ff.writeFile(written[i], new Uint8Array(await f.arrayBuffer()));
  }
  const inputPath = mounted ? `${mountDir}/${file.name}` : written[0];
  try {
    return await fn(inputPath);
  } finally {
    if (mounted) await ff.unmount(mountDir).catch(() => {});
    else for (const p of written) await ff.deleteFile(p).catch(() => {});
    await ff.deleteDir(mountDir).catch(() => {});
  }
}

/**
 * Safety net: ffmpeg prints progress several times a second while it works,
 * so this long a silence means it is stuck. The instance is then killed and
 * `runFFmpeg` retries on the single-threaded core.
 */
const STALL_MS = 60_000;

async function runOnce({ file, extraFiles, outName, probe, args, onProgress, onLog }: RunOptions): Promise<RunResult> {
  const ff = await loadFFmpeg();
  const outPath = `/out${++jobCounter}_${outName}`;
  let lastActivity = Date.now();
  let stalled = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > STALL_MS) {
      stalled = true;
      terminateFFmpeg();
    }
  }, 2000);

  return withInput(ff, file, async (inputPath) => {
    const logs: string[] = [];
    const logHandler = ({ message }: { message: string }) => {
      lastActivity = Date.now();
      logs.push(message);
      if (logs.length > 200) logs.shift();
      onLog?.(message);
      if ((globalThis as { __ffdebug?: boolean }).__ffdebug) console.debug('[ffmpeg]', message);
    };
    const progressHandler = ({ progress }: { progress: number }) => {
      lastActivity = Date.now();
      if (Number.isFinite(progress)) onProgress?.(Math.min(1, Math.max(0, progress)));
    };
    ff.on('log', logHandler);
    ff.on('progress', progressHandler);

    try {
      let info: MediaInfo = {};
      if (probe) {
        const start = logs.length;
        // Exits with an error (no output given) but prints the stream info.
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
    } catch (e) {
      if (stalled) throw new LocalizedError('err.stalled');
      throw e;
    } finally {
      clearInterval(watchdog);
      ff.off('log', logHandler);
      ff.off('progress', progressHandler);
      await ff.deleteFile(outPath).catch(() => {});
    }
  }, extraFiles);
}

/**
 * Thread limits for the multi-threaded core. Its pthread pool has a fixed size,
 * while ffmpeg sizes its own thread counts from the CPU count: on machines with
 * many cores (e.g. 8–16 on a Mac) the scaler, filters or encoder ask for more
 * threads than the pool has and ffmpeg waits forever ("stuck at 100%").
 * So every kind of threading is capped explicitly:
 * - the decoder runs single-threaded (its frame threading also crashes the core);
 * - filters / scaling and the encoder use at most 4 threads;
 * - x264 uses its internal threads, capped at 4 (≈2.3× faster than single-threaded).
 */
const MAX_THREADS = 4;

function adaptForThreads(args: string[]): string[] {
  if (!useMT) return args;
  const n = String(Math.max(1, Math.min(MAX_THREADS, navigator.hardwareConcurrency || 2)));
  const out = [...args];
  const firstInput = out.indexOf('-i');
  if (firstInput >= 0) out.splice(firstInput, 0, '-threads', '1');
  // Global options go before the inputs.
  out.unshift('-filter_threads', n, '-filter_complex_threads', n);
  if (out.includes('libx264')) {
    const p = out.indexOf('-x264-params');
    if (p >= 0) out[p + 1] += `:threads=${n}`;
    else out.push('-x264-params', `threads=${n}`);
  }
  // Output option (applies to the encoder): must come after the last input.
  out.push('-threads', n);
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
