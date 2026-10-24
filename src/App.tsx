import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { categories } from './categories';
import { extOf } from './categories/document';
import { parseTime } from './categories/video';
import type { Category, Options, OptionValue } from './categories/types';
import { CompareViewer, type CompareItem } from './components/CompareViewer';
import { CropEditor, type Crop } from './components/CropEditor';
import { Dropzone } from './components/Dropzone';
import { OfflineStatus } from './components/OfflineStatus';
import { ABOUT } from './about';
import { OptionsPanel } from './components/OptionsPanel';
import { LocalizedError, setLang, t, useLang, type Key, type Lang } from './i18n';
import { isFFmpegLoaded, loadFFmpeg, runFFmpeg, cancelFFmpeg, probeMedia, type MediaInfo } from './lib/ffmpeg';
import { animatedWebpToSequence, detectAnimation, type AnimationInfo } from './lib/animation';
import { heicToPng, isHeic } from './lib/heic';
import { baseName, browserDecodeToPng, downloadBlob, formatBytes } from './lib/utils';

type JobStatus = 'queued' | 'running' | 'done' | 'error';

/** One file in the queue and its result. */
interface Job {
  id: number;
  categoryId: string;
  file: File;
  status: JobStatus;
  progress: number;
  error?: string;
  result?: {
    blob: Blob;
    url: string;
    name: string;
    format: string;
    /** For before/after: trim start of the result and its frame rate. */
    offset: number;
    fps: number;
  };
  previewUrl?: string;
  /** The source is a HEIC/HEIF photo (decoded to PNG before converting). */
  heic?: boolean;
  /** A combined output (e.g. merged PDF), not a source file. */
  merged?: boolean;
  /** Probed source info (video). */
  media?: MediaInfo;
  /** Non-fatal note about the result (e.g. it didn't get smaller). */
  warning?: Key;
  /** Crop rectangle (images), in source pixels. */
  crop?: Crop;
  /** Set for animated WebP / APNG / GIF sources. */
  animation?: AnimationInfo;
}

type EngineState = { state: 'idle' | 'loading' | 'ready' | 'error'; progress: number; error?: string };

let nextId = 1;

/** Default settings for every category. */
function initialSettings() {
  return Object.fromEntries(
    categories.map((c) => [c.id, { format: c.defaultFormat, options: { ...c.defaultOptions } }]),
  ) as Record<string, { format: string; options: Options }>;
}

export default function App() {
  useLang();
  const [categoryId, setCategoryId] = useState(categories[0].id);
  const [settings, setSettings] = useState(initialSettings);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [engine, setEngine] = useState<EngineState>({ state: 'idle', progress: 0 });
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState<CompareItem | null>(null);
  const [cropping, setCropping] = useState<{ job: Job; display?: Blob } | null>(null);
  const cancelled = useRef(false);
  /** HEIC sources decoded to PNG once, on add — reused for the thumbnail, conversion and comparison. */
  const heicDecodes = useRef(new Map<number, Promise<File>>());

  const category = categories.find((c) => c.id === categoryId)!;
  const { format, options } = settings[categoryId];
  const categoryJobs = useMemo(() => jobs.filter((j) => j.categoryId === categoryId), [jobs, categoryId]);
  const sourceJobs = useMemo(() => categoryJobs.filter((j) => !j.merged), [categoryJobs]);
  /** Extensions of the added files, plus 'anim' when any of them is an animation. */
  const inputs = useMemo(() => {
    const set = new Set(sourceJobs.map((j) => extOf(j.file.name)));
    if (sourceJobs.some((j) => j.animation)) set.add('anim');
    return set;
  }, [sourceJobs]);
  const usesFFmpeg = Boolean(category.buildArgs && !category.convert);
  /** Whether the format can be produced from a file with this extension. */
  const compatible = (fmtId: string, ext: string) => {
    const from = category.formats.find((f) => f.id === fmtId)?.from;
    return !from || from.includes(ext);
  };
  const formatAvailable = (fmtId: string) => !inputs.size || [...inputs].some((e) => compatible(fmtId, e));

  const patchJob = useCallback((id: number, patch: Partial<Job>) => {
    setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  /** Loads the ffmpeg engine (once), reporting progress. */
  const ensureEngine = useCallback(async () => {
    if (isFFmpegLoaded()) return;
    setEngine({ state: 'loading', progress: 0 });
    try {
      await loadFFmpeg((loaded, total) => setEngine({ state: 'loading', progress: total ? loaded / total : 0 }));
      setEngine({ state: 'ready', progress: 1 });
    } catch (e) {
      setEngine({ state: 'error', progress: 0, error: (e as Error).message });
      throw e;
    }
  }, []);

  const addFiles = (files: File[]) => {
    const added: Job[] = files.map((file) => ({
      id: nextId++,
      categoryId,
      file,
      status: 'queued',
      progress: 0,
      previewUrl:
        file.type.startsWith('image/') && file.type !== 'image/heic' && file.type !== 'image/heif'
          ? URL.createObjectURL(file)
          : undefined,
    }));
    setJobs((js) => [...js, ...added]);
    // Animated WebP / APNG / GIF: mark them, so the animation options show up.
    if (categoryId === 'image') {
      for (const job of added)
        void detectAnimation(job.file).then((animation) => animation && patchJob(job.id, { animation }));
    }
    // HEIC (iPhone photos): browsers other than Safari can't read it, so decode it right away.
    if (categoryId === 'image' || categoryId === 'docs') {
      for (const job of added) {
        void isHeic(job.file).then((heic) => {
          if (!heic) return;
          const decoded = heicToPng(job.file);
          decoded.catch(() => {}); // the error is reported when the file is converted
          heicDecodes.current.set(job.id, decoded);
          if (job.previewUrl) URL.revokeObjectURL(job.previewUrl);
          patchJob(job.id, { heic: true, previewUrl: undefined });
          void decoded.then((png) => patchJob(job.id, { previewUrl: URL.createObjectURL(png) }));
        });
      }
    }
    // Start fetching the engine in the background while the user picks settings.
    if (usesFFmpeg) {
      const engineReady = ensureEngine();
      if (category.needsDuration) {
        // Show codec / resolution / bitrate right away, so it's clear how compressible a file is.
        for (const job of added)
          engineReady
            .then(() => probeMedia(job.file))
            .then((media) => patchJob(job.id, { media }))
            .catch(() => {});
      }
    }
  };

  // When the chosen format can't be made from any of the added files, switch to one that can.
  useEffect(() => {
    if (!inputs.size || formatAvailable(format)) return;
    const next = category.formats.find((f) => formatAvailable(f.id));
    if (next) setFormat(next.id);
  }, [inputs, format, categoryId]);

  const removeJob = (id: number) => {
    setJobs((js) => {
      const job = js.find((j) => j.id === id);
      if (job?.previewUrl) URL.revokeObjectURL(job.previewUrl);
      if (job?.result) URL.revokeObjectURL(job.result.url);
      heicDecodes.current.delete(id);
      return js.filter((j) => j.id !== id);
    });
  };

  const setFormat = (f: string) => {
    setSettings((s) => ({
      ...s,
      [categoryId]: {
        format: f,
        options: { ...s[categoryId].options, ...(category.formatDefaults?.[f] ?? {}) },
      },
    }));
  };

  const setOption = (key: string, value: OptionValue) => {
    setSettings((s) => ({
      ...s,
      [categoryId]: { ...s[categoryId], options: { ...s[categoryId].options, [key]: value } },
    }));
  };

  const convertJob = async (job: Job, cat: Category, fmtId: string, opts: Options) => {
    const fmt = cat.formats.find((f) => f.id === fmtId)!;
    const ext = extOf(job.file.name);
    if (fmt.from && !fmt.from.includes(ext)) {
      throw new LocalizedError('job.errIncompatible', {
        what: ext ? '.' + ext.toUpperCase() : t('job.thisFile'),
        format: fmt.label,
      });
    }
    patchJob(job.id, { status: 'running', progress: 0, error: undefined });
    // A HEIC source is converted from its decoded PNG (lossless); other files as they are.
    const source = await sourceFor(job);

    if (cat.convert) {
      const out = await cat.convert({ file: source, format: fmt, options: opts, onProgress: (p) => patchJob(job.id, { progress: p }) });
      if (cancelled.current) throw new Error('cancelled');
      setResult(job, out.blob, out.name, fmt.label);
      return out;
    }

    const outName = `${baseName(job.file.name)}.${fmt.ext}`;

    // Animations: APNG needs its demuxer named explicitly; animated WebP (which ffmpeg
    // can't decode) is turned into a PNG frame sequence first.
    const animation = cat.id === 'image' ? (job.animation ?? (await detectAnimation(source))) : null;
    let input: { file: File; extraFiles?: File[]; inputArgs?: string[] } = { file: source };
    if (animation?.kind === 'webp') {
      const seq = await animatedWebpToSequence(source, (p) => patchJob(job.id, { progress: p * 0.3 }));
      input = { file: seq.list, extraFiles: seq.frames, inputArgs: ['-f', 'concat', '-safe', '0'] };
    } else if (animation?.kind === 'apng') {
      input = { file: source, inputArgs: ['-f', 'apng'] };
    }

    const logs: string[] = [];
    const run = ({ file, extraFiles, inputArgs }: typeof input) =>
      runFFmpeg({
        file,
        extraFiles,
        // Kept for the category's post-processing (progress lines aren't needed).
        onLog: cat.postProcess ? (l) => !l.startsWith('frame=') && logs.push(l) : undefined,
        outName: `result.${fmt.ext}`,
        probe: cat.needsDuration,
        args: (input, info) =>
          cat.buildArgs!({
            input,
            file,
            format: fmt,
            options: opts,
            duration: info.duration,
            media: info,
            crop: job.crop,
            inputArgs,
            animated: Boolean(animation),
            lastFrameMs: animation?.lastDuration,
            animDuration: animation?.duration,
          }),
        onProgress: (p) => patchJob(job.id, { progress: p }),
      });

    let data: Uint8Array;
    let info: MediaInfo = {};
    try {
      ({ data, info } = await run(input));
    } catch (err) {
      // ffmpeg.wasm can't decode some image formats (e.g. AVIF) — let the browser decode them.
      if (cat.id !== 'image' || cancelled.current || source !== job.file) throw err;
      const decoded = await browserDecodeToPng(job.file).catch(() => null);
      if (!decoded) throw err;
      ({ data } = await run({ file: decoded }).catch(() => Promise.reject(err)));
    }
    if (cat.postProcess) {
      data = await cat.postProcess({
        data,
        logs,
        format: fmt,
        options: opts,
        animated: Boolean(animation),
        lastFrameMs: animation?.lastDuration,
        animDuration: animation?.duration,
      });
    }

    const blob = new Blob([data as BlobPart], { type: fmt.mime });
    setResult(job, blob, outName, fmt.label, {
      offset: cat.id === 'video' ? (parseTime(opts.start) ?? 0) : 0,
      fps: Number(opts.fps) || info.fps || 30,
    });
    if (cat.id === 'video') {
      const warning =
        ['mp4', 'mov', 'mkv', 'webm'].includes(fmt.id) && blob.size >= job.file.size * 0.9
          ? 'job.warnNotSmaller'
          : undefined;
      patchJob(job.id, { media: info.vcodec ? info : job.media, warning });
    }
    return { blob, name: outName };
  };

  /** The file to feed into the converter: the decoded PNG for HEIC, otherwise the original. */
  const sourceFor = async (job: Job): Promise<File> => {
    if (!heicDecodes.current.has(job.id) && (job.categoryId === 'image' || job.categoryId === 'docs')) {
      // The file was added a moment ago and the HEIC check hasn't finished yet.
      if (await isHeic(job.file)) heicDecodes.current.set(job.id, heicToPng(job.file));
    }
    return (await heicDecodes.current.get(job.id)) ?? job.file;
  };

  const setResult = (job: Job, blob: Blob, name: string, label: string, extra = { offset: 0, fps: 30 }) => {
    if (job.result) URL.revokeObjectURL(job.result.url);
    patchJob(job.id, {
      status: 'done',
      progress: 1,
      result: { blob, url: URL.createObjectURL(blob), name, format: label, ...extra },
    });
  };

  const convertAll = async (only?: number) => {
    const pending = sourceJobs.filter((j) => (only ? j.id === only : j.status !== 'running'));
    const queue = only ? pending : pending.some((j) => j.status !== 'done') ? pending.filter((j) => j.status !== 'done') : pending;
    if (!queue.length) return;
    const cat = category;
    const fmt = format;
    const opts = { ...options };
    setBusy(true);
    cancelled.current = false;
    queue.forEach((j) => patchJob(j.id, { status: 'queued', progress: 0, error: undefined, warning: undefined }));
    const outputs: { blob: Blob; name: string }[] = [];
    try {
      if (cat.buildArgs && !cat.convert) await ensureEngine();
      for (const job of queue) {
        if (cancelled.current) break;
        try {
          outputs.push(await convertJob(job, cat, fmt, opts));
        } catch (e) {
          if (cancelled.current) {
            patchJob(job.id, { status: 'queued', progress: 0 });
            break;
          }
          patchJob(job.id, { status: 'error', error: (e as Error).message || t('job.errGeneric') });
        }
      }
      if (!only && !cancelled.current && cat.merge && cat.canMerge?.(fmt, opts) && outputs.length > 1) {
        await addMerged(cat, await cat.merge(outputs, opts));
      }
    } catch {
      // engine failed to load; the UI already shows it
    } finally {
      setBusy(false);
    }
  };

  const addMerged = async (cat: Category, out: { blob: Blob; name: string }) => {
    const file = new File([out.blob], out.name, { type: out.blob.type });
    const label = cat.formats.find((f) => f.ext === extOf(out.name))?.label ?? '';
    setJobs((js) => [
      // Replace a previous merged result of this category.
      ...js.filter((j) => !(j.merged && j.categoryId === cat.id)),
      {
        id: nextId++,
        categoryId: cat.id,
        file,
        status: 'done',
        progress: 1,
        merged: true,
        result: { blob: out.blob, url: URL.createObjectURL(out.blob), name: out.name, format: label, offset: 0, fps: 30 },
      },
    ]);
  };

  const cancel = () => {
    cancelled.current = true;
    cancelFFmpeg();
    setEngine({ state: 'idle', progress: 0 });
    setJobs((js) => js.map((j) => (j.status === 'running' ? { ...j, status: 'queued', progress: 0 } : j)));
  };

  const doneJobs = sourceJobs.filter((j) => j.result);
  const totals = doneJobs.reduce(
    (acc, j) => ({ before: acc.before + j.file.size, after: acc.after + j.result!.blob.size }),
    { before: 0, after: 0 },
  );

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (busy) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [busy]);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <div>
            <h1>Convert Any</h1>
            <p>{t('app.subtitle')}</p>
          </div>
        </div>
        <div className="header-badges">
          <div className="privacy" title={t('app.privacyTitle')}>
            {t('app.privacy')}
          </div>
          <OfflineStatus onDownloadEngine={ensureEngine} engineState={engine.state} busy={busy} />
          <LangSwitch />
          <a
            className="gh-link"
            href={ABOUT.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={t('app.repoTitle')}
            aria-label={t('app.repoTitle')}
          >
            <GitHubIcon />
          </a>
        </div>
      </header>

      <nav className="tabs" aria-label={t('app.categories')}>
        {categories.map((c) => (
          <button
            key={c.id}
            className={`tab${c.id === categoryId ? ' active' : ''}`}
            disabled={c.status === 'soon' || busy}
            onClick={() => setCategoryId(c.id)}
            title={t(c.description)}
          >
            <span className="tab-icon">{c.icon}</span>
            {t(c.title)}
            {c.status === 'soon' && <span className="soon">{t('app.soon')}</span>}
          </button>
        ))}
      </nav>

      <main className="layout">
        <section className="panel files-panel">
          <p className="cat-desc">{t(category.description)}</p>
          {category.note && <p className="cat-note">{t(category.note)}</p>}
          <Dropzone accept={category.accept} onFiles={addFiles} compact={categoryJobs.length > 0} />

          {categoryJobs.length > 0 && (
            <ul className="jobs">
              {categoryJobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  busy={busy}
                  onRemove={() => removeJob(job.id)}
                  onRetry={() => convertAll(job.id)}
                  onCompare={async () => {
                    const r = job.result!;
                    setCompare({
                      kind: job.categoryId === 'video' ? 'video' : 'image',
                      original: job.file,
                      originalDisplay: job.heic ? await heicDecodes.current.get(job.id)?.catch(() => undefined) : undefined,
                      result: r.blob,
                      resultUrl: r.url,
                      resultName: r.name,
                      offset: r.offset,
                      fps: r.fps,
                      crop: job.crop,
                    });
                  }}
                  onCrop={
                    job.categoryId === 'image'
                      ? async () =>
                          setCropping({
                            job,
                            display: job.heic ? await heicDecodes.current.get(job.id)?.catch(() => undefined) : undefined,
                          })
                      : undefined
                  }
                />
              ))}
            </ul>
          )}

          {doneJobs.length > 1 && (
            <div className="summary">
              <span>
                {t('app.total')} {formatBytes(totals.before)} → <strong>{formatBytes(totals.after)}</strong>{' '}
                <SizeDelta before={totals.before} after={totals.after} />
              </span>
              <button
                className="btn ghost"
                onClick={async () => {
                  for (const j of categoryJobs.filter((x) => x.result)) {
                    downloadBlob(j.result!.blob, j.result!.name);
                    await new Promise((r) => setTimeout(r, 300));
                  }
                }}
              >
                {t('app.downloadAll')}
              </button>
            </div>
          )}
        </section>

        <aside className="panel settings-panel">
          <h2>{t('app.convertTo')}</h2>
          <div className="formats">
            {category.formats.map((f) => (
              <button
                key={f.id}
                className={`format${f.id === format ? ' active' : ''}`}
                onClick={() => setFormat(f.id)}
                title={
                  formatAvailable(f.id)
                    ? f.hint && t(f.hint)
                    : `${t('app.unavailableFormat')} ${f.hint ? t(f.hint) : ''}`
                }
                disabled={busy || !formatAvailable(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {category.formats.find((f) => f.id === format)?.hint && (
            <p className="format-hint">{t(category.formats.find((f) => f.id === format)!.hint!)}</p>
          )}

          <h2>{t('app.settings')}</h2>
          <fieldset disabled={busy}>
            <OptionsPanel category={category} format={format} options={options} inputs={inputs} onChange={setOption} />
          </fieldset>

          <EngineStatus engine={engine} />

          {busy ? (
            <button className="btn danger big" onClick={cancel}>
              {t('app.stop')}
            </button>
          ) : (
            <button className="btn primary big" disabled={!sourceJobs.length} onClick={() => convertAll()}>
              {t('app.convert')}
              {sourceJobs.length ? ` (${sourceJobs.length})` : ''}
            </button>
          )}
        </aside>
      </main>

      {compare && <CompareViewer item={compare} engineFree={!busy} onClose={() => setCompare(null)} />}
      {cropping && (
        <CropEditor
          file={cropping.job.file}
          display={cropping.display}
          initial={cropping.job.crop}
          engineFree={!busy}
          onClose={() => setCropping(null)}
          onApply={(crop) => {
            const job = cropping.job;
            // The old result no longer matches: the file goes back to the queue.
            if (job.result) URL.revokeObjectURL(job.result.url);
            patchJob(job.id, { crop: crop ?? undefined, status: 'queued', result: undefined, error: undefined });
            setCropping(null);
          }}
        />
      )}

      <footer className="footer">
        {t('app.footerPowered')}{' '}
        <a href="https://ffmpegwasm.netlify.app/" target="_blank" rel="noreferrer">
          ffmpeg.wasm
        </a>
        , libheif, pdf.js, pdf-lib, SheetJS {t('app.footerAnd')} mammoth. {t('app.footerLocal')}
        <div className="footer-author">
          {t('app.author')}{' '}
          <a href={ABOUT.siteUrl} target="_blank" rel="noopener noreferrer" title={t('app.authorSite')}>
            {t('app.authorName')}
          </a>
          <span className="dot">·</span>
          <a href={ABOUT.githubUrl} target="_blank" rel="noopener noreferrer">
            <GitHubIcon /> GitHub
          </a>
          <span className="dot">·</span>
          <a href={ABOUT.repoUrl} target="_blank" rel="noopener noreferrer">
            {t('app.sourceCode')}
          </a>
        </div>
      </footer>
    </div>
  );
}

function EngineStatus({ engine }: { engine: EngineState }) {
  if (engine.state === 'loading')
    return (
      <div className="engine">
        <span>{t('app.engineLoading', { pct: Math.round(engine.progress * 100) })}</span>
        <div className="bar">
          <div style={{ width: `${engine.progress * 100}%` }} />
        </div>
      </div>
    );
  if (engine.state === 'error')
    return <div className="engine error">{t('app.engineError', { error: engine.error ?? '' })}</div>;
  return null;
}

function SizeDelta({ before, after }: { before: number; after: number }) {
  const pct = Math.round(((after - before) / before) * 100);
  return <span className={`delta ${pct <= 0 ? 'good' : 'bad'}`}>{pct > 0 ? `+${pct}` : pct}%</span>;
}

function JobRow({
  job,
  busy,
  onRemove,
  onRetry,
  onCompare,
  onCrop,
}: {
  job: Job;
  busy: boolean;
  onRemove: () => void;
  onRetry: () => void;
  onCompare: () => void;
  /** Present for images: opens the crop editor. */
  onCrop?: () => void;
}) {
  const comparable =
    job.result && ['image', 'video'].includes(job.categoryId) && !job.result.blob.type.startsWith('audio/');
  const thumb = job.result?.blob.type.startsWith('image/') ? job.result.url : job.previewUrl;
  const ext = extOf(job.file.name);
  return (
    <li className={`job ${job.status}`}>
      <div className="thumb">
        {thumb ? (
          <img src={thumb} alt="" />
        ) : job.file.type.startsWith('video') ? (
          <span>🎬</span>
        ) : (
          <span className="ext">{ext.slice(0, 4).toUpperCase() || '📄'}</span>
        )}
      </div>
      <div className="job-main">
        <div className="job-name" title={job.file.name}>
          {job.heic && (
            <span className="tag-heic" title={t('job.heicTitle')}>
              HEIC
            </span>
          )}
          {job.file.name}
        </div>
        <div className="job-meta">
          {job.merged ? (
            <>
              <strong>{formatBytes(job.file.size)}</strong> · {t('job.merged')}
            </>
          ) : (
            formatBytes(job.file.size)
          )}
          {job.result && !job.merged && (
            <>
              {' → '}
              <strong>{formatBytes(job.result.blob.size)}</strong>{' '}
              {job.categoryId === 'docs' ? job.result.name : job.result.format}{' '}
              <SizeDelta before={job.file.size} after={job.result.blob.size} />
            </>
          )}
          {job.status === 'running' && <> · {Math.round(job.progress * 100)}%</>}
          {job.status === 'queued' && busy && <> · {t('job.queued')}</>}
          {job.animation && (
            <span className="tag-anim" title={t('job.animTitle')}>
              {' '}
              ▶ {t('job.anim', { n: job.animation.frames })}
            </span>
          )}
          {job.crop && <span className="tag-crop"> ✂ {t('job.cropped', { w: job.crop.w, h: job.crop.h })}</span>}
        </div>
        {job.status === 'running' && (
          <div className="bar">
            <div style={{ width: `${Math.max(2, job.progress * 100)}%` }} />
          </div>
        )}
        {job.media?.vcodec && <MediaLine media={job.media} />}
        {job.warning && <div className="job-warning">{t(job.warning)}</div>}
        {job.error && <div className="job-error">{job.error}</div>}
      </div>
      <div className="job-actions">
        {onCrop && job.status !== 'running' && (
          <button
            className={`btn ghost small${job.crop ? ' on' : ''}`}
            onClick={onCrop}
            disabled={busy}
            title={t('job.cropTitle')}
          >
            ✂ {t('job.crop')}
          </button>
        )}
        {comparable && (
          <button className="btn ghost small" onClick={onCompare} title={t('job.compareTitle')}>
            {t('job.compare')}
          </button>
        )}
        {job.result && (
          <a className="btn primary small" href={job.result.url} download={job.result.name}>
            {t('job.download')}
          </a>
        )}
        {job.status === 'error' && !busy && (
          <button className="btn ghost small" onClick={onRetry}>
            {t('job.retry')}
          </button>
        )}
        {job.status !== 'running' && (
          <button className="icon-btn" onClick={onRemove} disabled={busy} aria-label={t('job.remove')}>
            ✕
          </button>
        )}
      </div>
    </li>
  );
}

const CODEC_NAMES: Record<string, string> = {
  h264: 'H.264',
  hevc: 'H.265',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  mpeg4: 'MPEG-4',
  prores: 'ProRes',
};

function MediaLine({ media: m }: { media: MediaInfo }) {
  const parts = [
    CODEC_NAMES[m.vcodec!] ?? m.vcodec!.toUpperCase(),
    m.width && m.height ? `${m.width}×${m.height}` : '',
    m.fps ? `${Math.round(m.fps * 100) / 100} ${t('unit.fps')}` : '',
    m.vbitrate
      ? m.vbitrate >= 1000
        ? `${(m.vbitrate / 1000).toFixed(1)} ${t('unit.mbps')}`
        : `${m.vbitrate} ${t('unit.kbps')}`
      : '',
  ].filter(Boolean);
  // Bits per pixel per frame: phones record ~0.15–0.3; below ~0.07 the video is already heavily compressed.
  const bpp = m.vbitrate && m.width && m.height ? (m.vbitrate * 1000) / (m.width * m.height * (m.fps || 30)) : 0;
  const tight = bpp > 0 && bpp < 0.07;
  return (
    <div className="job-media">
      {parts.join(' · ')}
      {tight && (
        <span
          className="tag"
          title={t('job.tightTitle')}
        >
          {t('job.tight')}
        </span>
      )}
    </div>
  );
}

/** RU / EN interface language switch. */
function LangSwitch() {
  const lang = useLang();
  return (
    <div className="lang-switch" role="group" aria-label={t('app.language')}>
      {(['ru', 'en'] as Lang[]).map((l) => (
        <button key={l} className={l === lang ? 'active' : ''} aria-pressed={l === lang} onClick={() => setLang(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

/** GitHub mark (inline SVG: external images are blocked by the page's cross-origin isolation). */
function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
