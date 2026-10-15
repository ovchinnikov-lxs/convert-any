import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { categories } from './categories';
import { extOf } from './categories/document';
import { parseTime } from './categories/video';
import type { Category, Options, OptionValue } from './categories/types';
import { CompareViewer, type CompareItem } from './components/CompareViewer';
import { Dropzone } from './components/Dropzone';
import { OptionsPanel } from './components/OptionsPanel';
import { isFFmpegLoaded, loadFFmpeg, runFFmpeg, cancelFFmpeg } from './lib/ffmpeg';
import { baseName, browserDecodeToPng, downloadBlob, formatBytes } from './lib/utils';

type JobStatus = 'queued' | 'running' | 'done' | 'error';

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
  /** A combined output (e.g. merged PDF), not a source file. */
  merged?: boolean;
}

type EngineState = { state: 'idle' | 'loading' | 'ready' | 'error'; progress: number; error?: string };

let nextId = 1;

function initialSettings() {
  return Object.fromEntries(
    categories.map((c) => [c.id, { format: c.defaultFormat, options: { ...c.defaultOptions } }]),
  ) as Record<string, { format: string; options: Options }>;
}

export default function App() {
  const [categoryId, setCategoryId] = useState(categories[0].id);
  const [settings, setSettings] = useState(initialSettings);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [engine, setEngine] = useState<EngineState>({ state: 'idle', progress: 0 });
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState<CompareItem | null>(null);
  const cancelled = useRef(false);

  const category = categories.find((c) => c.id === categoryId)!;
  const { format, options } = settings[categoryId];
  const categoryJobs = useMemo(() => jobs.filter((j) => j.categoryId === categoryId), [jobs, categoryId]);
  const sourceJobs = useMemo(() => categoryJobs.filter((j) => !j.merged), [categoryJobs]);
  const inputs = useMemo(() => new Set(sourceJobs.map((j) => extOf(j.file.name))), [sourceJobs]);
  const usesFFmpeg = Boolean(category.buildArgs && !category.convert);
  const compatible = (fmtId: string, ext: string) => {
    const from = category.formats.find((f) => f.id === fmtId)?.from;
    return !from || from.includes(ext);
  };
  const formatAvailable = (fmtId: string) => !inputs.size || [...inputs].some((e) => compatible(fmtId, e));

  const patchJob = useCallback((id: number, patch: Partial<Job>) => {
    setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

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
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
    }));
    setJobs((js) => [...js, ...added]);
    // Start fetching the engine in the background while the user picks settings.
    if (usesFFmpeg) ensureEngine().catch(() => {});
  };

  // When the chosen format can't be made from any of the added files, switch to one that can.
  useEffect(() => {
    if (!inputs.size || formatAvailable(format)) return;
    const next = category.formats.find((f) => formatAvailable(f.id));
    if (next) setFormat(next.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs, format, categoryId]);

  const removeJob = (id: number) => {
    setJobs((js) => {
      const job = js.find((j) => j.id === id);
      if (job?.previewUrl) URL.revokeObjectURL(job.previewUrl);
      if (job?.result) URL.revokeObjectURL(job.result.url);
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
      throw new Error(`${ext ? '.' + ext.toUpperCase() : 'Этот файл'} нельзя сконвертировать в ${fmt.label}`);
    }
    patchJob(job.id, { status: 'running', progress: 0, error: undefined });

    if (cat.convert) {
      const out = await cat.convert({ file: job.file, format: fmt, options: opts, onProgress: (p) => patchJob(job.id, { progress: p }) });
      if (cancelled.current) throw new Error('cancelled');
      setResult(job, out.blob, out.name, fmt.label);
      return out;
    }

    const outName = `${baseName(job.file.name)}.${fmt.ext}`;

    const run = (file: File) =>
      runFFmpeg({
        file,
        outName: `result.${fmt.ext}`,
        probe: cat.needsDuration,
        args: (input, info) => cat.buildArgs!({ input, file, format: fmt, options: opts, duration: info.duration }),
        onProgress: (p) => patchJob(job.id, { progress: p }),
      });

    let data: Uint8Array;
    let fps: number | undefined;
    try {
      ({ data, info: { fps } } = await run(job.file));
    } catch (err) {
      // ffmpeg.wasm can't decode some image formats (AVIF, HEIC…) — let the browser decode them.
      if (cat.id !== 'image' || cancelled.current) throw err;
      const decoded = await browserDecodeToPng(job.file).catch(() => null);
      if (!decoded) throw err;
      ({ data } = await run(decoded).catch(() => Promise.reject(err)));
    }

    const blob = new Blob([data as BlobPart], { type: fmt.mime });
    setResult(job, blob, outName, fmt.label, {
      offset: cat.id === 'video' ? (parseTime(opts.start) ?? 0) : 0,
      fps: Number(opts.fps) || fps || 30,
    });
    return { blob, name: outName };
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
    queue.forEach((j) => patchJob(j.id, { status: 'queued', progress: 0, error: undefined }));
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
          patchJob(job.id, { status: 'error', error: (e as Error).message || 'Ошибка конвертации' });
        }
      }
      if (!only && !cancelled.current && cat.merge && cat.canMerge?.(fmt, opts) && outputs.length > 1) {
        await addMerged(cat, await cat.merge(outputs, opts));
      }
    } catch {
      // engine failed to load; state already reflects it
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
            <p>Конвертер файлов прямо в браузере</p>
          </div>
        </div>
        <div className="privacy" title="Конвертация выполняется в вашем браузере (WebAssembly и JavaScript) — без загрузки на сервер">
          🔒 Файлы не покидают ваше устройство
        </div>
      </header>

      <nav className="tabs" aria-label="Категории">
        {categories.map((c) => (
          <button
            key={c.id}
            className={`tab${c.id === categoryId ? ' active' : ''}`}
            disabled={c.status === 'soon' || busy}
            onClick={() => setCategoryId(c.id)}
            title={c.description}
          >
            <span className="tab-icon">{c.icon}</span>
            {c.title}
            {c.status === 'soon' && <span className="soon">скоро</span>}
          </button>
        ))}
      </nav>

      <main className="layout">
        <section className="panel files-panel">
          <p className="cat-desc">{category.description}</p>
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
                  onCompare={() => {
                    const r = job.result!;
                    setCompare({
                      kind: job.categoryId === 'video' ? 'video' : 'image',
                      original: job.file,
                      result: r.blob,
                      resultUrl: r.url,
                      resultName: r.name,
                      offset: r.offset,
                      fps: r.fps,
                    });
                  }}
                />
              ))}
            </ul>
          )}

          {doneJobs.length > 1 && (
            <div className="summary">
              <span>
                Итого: {formatBytes(totals.before)} → <strong>{formatBytes(totals.after)}</strong>{' '}
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
                Скачать все
              </button>
            </div>
          )}
        </section>

        <aside className="panel settings-panel">
          <h2>Конвертировать в</h2>
          <div className="formats">
            {category.formats.map((f) => (
              <button
                key={f.id}
                className={`format${f.id === format ? ' active' : ''}`}
                onClick={() => setFormat(f.id)}
                title={formatAvailable(f.id) ? f.hint : `Недоступно для добавленных файлов. ${f.hint ?? ''}`}
                disabled={busy || !formatAvailable(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {category.formats.find((f) => f.id === format)?.hint && (
            <p className="format-hint">{category.formats.find((f) => f.id === format)!.hint}</p>
          )}

          <h2>Настройки</h2>
          <fieldset disabled={busy}>
            <OptionsPanel category={category} format={format} options={options} inputs={inputs} onChange={setOption} />
          </fieldset>

          <EngineStatus engine={engine} />

          {busy ? (
            <button className="btn danger big" onClick={cancel}>
              Остановить
            </button>
          ) : (
            <button className="btn primary big" disabled={!sourceJobs.length} onClick={() => convertAll()}>
              Конвертировать{sourceJobs.length ? ` (${sourceJobs.length})` : ''}
            </button>
          )}
        </aside>
      </main>

      {compare && <CompareViewer item={compare} engineFree={!busy} onClose={() => setCompare(null)} />}

      <footer className="footer">
        Работает на <a href="https://ffmpegwasm.netlify.app/" target="_blank" rel="noreferrer">ffmpeg.wasm</a>, pdf.js,
        pdf-lib, SheetJS и mammoth.
        Вся обработка выполняется локально — без серверов и загрузок.
      </footer>
    </div>
  );
}

function EngineStatus({ engine }: { engine: EngineState }) {
  if (engine.state === 'loading')
    return (
      <div className="engine">
        <span>Загрузка движка ffmpeg (≈31 МБ, один раз)… {Math.round(engine.progress * 100)}%</span>
        <div className="bar">
          <div style={{ width: `${engine.progress * 100}%` }} />
        </div>
      </div>
    );
  if (engine.state === 'error')
    return <div className="engine error">Не удалось загрузить движок: {engine.error}</div>;
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
}: {
  job: Job;
  busy: boolean;
  onRemove: () => void;
  onRetry: () => void;
  onCompare: () => void;
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
          {job.file.name}
        </div>
        <div className="job-meta">
          {job.merged ? (
            <>
              <strong>{formatBytes(job.file.size)}</strong> · объединённый результат
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
          {job.status === 'queued' && busy && <> · в очереди</>}
        </div>
        {job.status === 'running' && (
          <div className="bar">
            <div style={{ width: `${Math.max(2, job.progress * 100)}%` }} />
          </div>
        )}
        {job.error && <div className="job-error">{job.error}</div>}
      </div>
      <div className="job-actions">
        {comparable && (
          <button className="btn ghost small" onClick={onCompare} title="Сравнить до и после">
            Сравнить
          </button>
        )}
        {job.result && (
          <a className="btn primary small" href={job.result.url} download={job.result.name}>
            Скачать
          </a>
        )}
        {job.status === 'error' && !busy && (
          <button className="btn ghost small" onClick={onRetry}>
            Повторить
          </button>
        )}
        {job.status !== 'running' && (
          <button className="icon-btn" onClick={onRemove} disabled={busy} aria-label="Убрать файл">
            ✕
          </button>
        )}
      </div>
    </li>
  );
}
