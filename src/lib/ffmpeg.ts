import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';

const CORE_BASE = '/ffmpeg';

let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;
let coreURLs: Promise<{ coreURL: string; wasmURL: string }> | null = null;

export type LoadProgress = (loaded: number, total: number) => void;

async function fetchToBlobURL(url: string, mime: string, onProgress?: LoadProgress): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Не удалось загрузить ${url}: ${res.status}`);
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
    coreURLs ??= (async () => ({
      coreURL: await fetchToBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await fetchToBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm', onProgress),
    }))();
    coreURLs.catch(() => {
      coreURLs = null;
    });
    const ff = new FFmpeg();
    await ff.load(await coreURLs);
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

function terminateFFmpeg() {
  instance?.terminate();
  instance = null;
  loading = null;
}

export interface MediaInfo {
  duration?: number;
}

export interface RunOptions {
  file: File;
  outName: string;
  /** Probe the input first (duration etc.) and pass it to `args`. */
  probe?: boolean;
  /** Builds the argument list given the path ffmpeg should read the input from. */
  args: (inputPath: string, info: MediaInfo) => string[];
  onProgress?: (ratio: number) => void;
  onLog?: (line: string) => void;
}

let jobCounter = 0;

/**
 * Runs one conversion. ffmpeg.wasm occasionally ends up in a broken state
 * after earlier runs, so on failure we retry once on a fresh instance.
 */
export async function runFFmpeg(opts: RunOptions): Promise<Uint8Array> {
  const gen = generation;
  try {
    return await runOnce(opts);
  } catch (first) {
    if (gen !== generation) throw first;
    terminateFFmpeg();
    try {
      return await runOnce(opts);
    } catch {
      terminateFFmpeg();
      throw first;
    }
  }
}

async function runOnce({ file, outName, probe, args, onProgress, onLog }: RunOptions): Promise<Uint8Array> {
  const ff = await loadFFmpeg();
  const job = ++jobCounter;
  const mountDir = `/in${job}`;
  const outPath = `/out${job}_${outName}`;
  let inputPath: string;
  let mounted = false;

  // WORKERFS reads the file lazily instead of copying it into wasm memory,
  // which matters a lot for big videos.
  try {
    await ff.createDir(mountDir);
    await ff.mount(FFFSType.WORKERFS, { files: [file] }, mountDir);
    inputPath = `${mountDir}/${file.name}`;
    mounted = true;
  } catch {
    inputPath = `/in${job}_${sanitize(file.name)}`;
    await ff.writeFile(inputPath, new Uint8Array(await file.arrayBuffer()));
  }

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
    const info: MediaInfo = {};
    if (probe) {
      const start = logs.length;
      // Exits with an error (no output given) but prints the stream info.
      await ff.exec(['-hide_banner', '-i', inputPath]);
      info.duration = parseDuration(logs.slice(start));
    }
    const code = await ff.exec(['-hide_banner', '-y', ...args(inputPath, info), outPath]);
    if (code !== 0) {
      throw new Error(extractError(logs) || `ffmpeg завершился с кодом ${code}`);
    }
    const data = await ff.readFile(outPath);
    if (typeof data === 'string' || data.length === 0) throw new Error('Пустой результат');
    return data;
  } finally {
    ff.off('log', logHandler);
    ff.off('progress', progressHandler);
    await ff.deleteFile(outPath).catch(() => {});
    if (mounted) {
      await ff.unmount(mountDir).catch(() => {});
      await ff.deleteDir(mountDir).catch(() => {});
    } else {
      await ff.deleteFile(inputPath).catch(() => {});
    }
  }
}

function parseDuration(lines: string[]): number | undefined {
  for (const l of lines) {
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(l);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return undefined;
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
