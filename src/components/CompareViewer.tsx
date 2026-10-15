import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as RPointerEvent, RefObject, WheelEvent as RWheelEvent } from 'react';
import { t, useLang, type Key } from '../i18n';
import { canPlayVideo, canShowImage, imageProxy, videoProxy } from '../lib/preview';
import { formatBytes } from '../lib/utils';

/** Что сравниваем: исходный файл и результат конвертации. */
export interface CompareItem {
  kind: 'image' | 'video';
  original: File;
  result: Blob;
  resultUrl: string;
  resultName: string;
  /** На сколько секунд результат сдвинут относительно оригинала (начало обрезки). */
  offset: number;
  /** Частота кадров результата — для покадрового шага. */
  fps: number;
}

type Mode = 'split' | 'toggle' | 'side';

/** Сообщения храним ключом словаря, чтобы они переводились при смене языка. */
type Message = { key: Key; params?: Record<string, string>; text?: string };

type Prepared =
  | { status: 'preparing'; message: Message; progress?: number }
  | { status: 'ready'; before: string; after: string }
  | { status: 'error'; message: Message };

interface Props {
  item: CompareItem;
  /** false, пока идёт конвертация, — для превью нужен свободный движок ffmpeg. */
  engineFree: boolean;
  onClose: () => void;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;

/** Полноэкранное сравнение «до/после»: шторка, переключение, рядом; зум; покадровое видео. */
export function CompareViewer({ item, engineFree, onClose }: Props) {
  useLang();
  const [prepared, setPrepared] = useState<Prepared>({ status: 'preparing', message: { key: 'cmp.preparing' } });
  const [mode, setMode] = useState<Mode>('split');
  const [split, setSplit] = useState(50);
  const [showAfter, setShowAfter] = useState(true);
  const [zoom, setZoom] = useState<number | null>(null); // null — «вписать»
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [dims, setDims] = useState<{ before?: string; after?: string }>({});
  const [vp, setVp] = useState({ w: 0, h: 0 });

  const viewportRef = useRef<HTMLDivElement>(null);
  const engineFreeAtOpen = useRef(engineFree).current;
  const beforeVideo = useRef<HTMLVideoElement>(null);
  const afterVideo = useRef<HTMLVideoElement>(null);

  // --- Готовим источники для показа (через ffmpeg, если браузер не умеет показывать формат).
  useEffect(() => {
    let alive = true;
    const created: string[] = [];
    const originalUrl = URL.createObjectURL(item.original);
    created.push(originalUrl);

    (async () => {
      const isVideo = item.kind === 'video';
      const check = isVideo ? canPlayVideo : canShowImage;
      const [beforeOk, afterOk] = await Promise.all([
        check(originalUrl),
        // GIF из видео не синхронизировать покадрово как <img>, поэтому он всегда идёт через превью.
        isVideo && item.result.type === 'image/gif' ? Promise.resolve(false) : check(item.resultUrl),
      ]);
      if ((!beforeOk || !afterOk) && !engineFreeAtOpen) {
        if (alive)
          setPrepared({
            status: 'error',
            message: { key: 'cmp.unsupported' },
          });
        return;
      }
      const make = async (ok: boolean, blob: Blob, url: string, name: string, label: Key) => {
        if (ok) return url;
        const message: Message = { key: 'cmp.preparingPreview', params: { what: t(label) } };
        if (alive) setPrepared({ status: 'preparing', message, progress: 0 });
        const proxied = isVideo
          ? await videoProxy(blob, name, (p) => alive && setPrepared({ status: 'preparing', message, progress: p }))
          : await imageProxy(blob, name);
        created.push(proxied);
        return proxied;
      };
      const before = await make(beforeOk, item.original, originalUrl, item.original.name, 'cmp.original');
      const after = await make(afterOk, item.result, item.resultUrl, item.resultName, 'cmp.result');
      if (alive) setPrepared({ status: 'ready', before, after });
    })().catch(
      (e: Error) => alive && setPrepared({ status: 'error', message: { key: 'cmp.prepError', text: e.message } }),
    );

    return () => {
      alive = false;
      // С задержкой — чтобы медиа-элементы сначала отпустили ссылки.
      setTimeout(() => created.forEach((u) => URL.revokeObjectURL(u)), 0);
    };
  }, [item, engineFreeAtOpen]);

  // --- Размер области просмотра.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [prepared.status]);

  const paneW = mode === 'side' ? vp.w / 2 : vp.w;
  const paneH = vp.h;
  const fitScale = box ? Math.min(paneW / box.w, paneH / box.h) : 1;
  const scale = zoom ?? fitScale;

  const transformFor = () => {
    if (!box) return undefined;
    const tx = (paneW - box.w * scale) / 2 + pan.x;
    const ty = (paneH - box.h * scale) / 2 + pan.y;
    return {
      width: box.w,
      height: box.h,
      transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
      imageRendering: scale >= 2 ? ('pixelated' as const) : undefined,
    };
  };

  const zoomAt = useCallback(
    (next: number, px = paneW / 2, py = paneH / 2) => {
      if (!box) return;
      const s0 = zoom ?? fitScale;
      const s1 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
      const tx0 = (paneW - box.w * s0) / 2 + pan.x;
      const ty0 = (paneH - box.h * s0) / 2 + pan.y;
      const mx = (px - tx0) / s0;
      const my = (py - ty0) / s0;
      setPan({ x: px - mx * s1 - (paneW - box.w * s1) / 2, y: py - my * s1 - (paneH - box.h * s1) / 2 });
      setZoom(s1);
    },
    [box, zoom, fitScale, pan, paneW, paneH],
  );

  const fit = () => {
    setZoom(null);
    setPan({ x: 0, y: 0 });
  };

  // --- Указатель: перетаскивание — сдвиг, ручка — шторка, колесо — зум.
  const drag = useRef<{ kind: 'pan' | 'split'; x: number; y: number; px: number; py: number } | null>(null);

  const paneOrigin = (clientX: number) => {
    const rect = viewportRef.current!.getBoundingClientRect();
    const inRight = mode === 'side' && clientX - rect.left > rect.width / 2;
    return { left: rect.left + (inRight ? rect.width / 2 : 0), top: rect.top, rect };
  };

  const onWheel = (e: RWheelEvent) => {
    const { left, top } = paneOrigin(e.clientX);
    zoomAt(scale * Math.exp(-e.deltaY * 0.0015), e.clientX - left, e.clientY - top);
  };

  // Активные касания для зума двумя пальцами.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);

  const onPointerDown = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(p1.x - p2.x, p1.y - p2.y), scale };
      drag.current = null;
      return;
    }
    const isHandle = (e.target as HTMLElement).closest('.cmp-divider');
    drag.current = { kind: isHandle ? 'split' : 'pan', x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (isHandle) moveSplit(e.clientX);
  };

  const moveSplit = (clientX: number) => {
    const rect = viewportRef.current!.getBoundingClientRect();
    setSplit(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)));
  };

  const onPointerMove = (e: RPointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()];
      const cx = (p1.x + p2.x) / 2;
      const { left, top } = paneOrigin(cx);
      zoomAt((pinch.current.scale * Math.hypot(p1.x - p2.x, p1.y - p2.y)) / pinch.current.dist, cx - left, (p1.y + p2.y) / 2 - top);
      return;
    }
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'split') moveSplit(e.clientX);
    else setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
  };

  const onPointerUp = (e: RPointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    drag.current = null;
  };

  // Колесо зумирует, а не прокручивает страницу.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  }, [prepared.status]);

  // --- Синхронизация видео.
  const video = useVideoSync(item, beforeVideo, afterVideo, prepared.status === 'ready');

  const flip = useCallback(() => {
    setMode('toggle');
    setShowAfter((v) => !v);
  }, []);

  // --- Клавиатура.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'SELECT') return;
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 's':
        case 'S':
        // «ы» — та же клавиша S в русской раскладке.
        case 'ы':
        case 'Ы':
          flip();
          break;
        case ' ':
          e.preventDefault();
          if (item.kind === 'video') video.toggle();
          else flip();
          break;
        case 'ArrowLeft':
        case ',':
          if (item.kind === 'video') {
            e.preventDefault();
            video.step(e.shiftKey ? -10 : -1);
          }
          break;
        case 'ArrowRight':
        case '.':
          if (item.kind === 'video') {
            e.preventDefault();
            video.step(e.shiftKey ? 10 : 1);
          }
          break;
        case '+':
        case '=':
          zoomAt(scale * 1.5);
          break;
        case '-':
          zoomAt(scale / 1.5);
          break;
        case '0':
          fit();
          break;
        case '1':
          zoomAt(1);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item.kind, video, flip, zoomAt, scale, onClose]);

  const media = (which: 'before' | 'after') => {
    if (prepared.status !== 'ready') return null;
    const src = which === 'before' ? prepared.before : prepared.after;
    const style = transformFor() ?? { visibility: 'hidden' as const };
    const report = (w: number, h: number) => {
      setDims((d) => ({ ...d, [which]: `${w}×${h}` }));
      // Холст задаёт оригинал; результат растягивается поверх, чтобы пиксели совпали.
      if (which === 'before') setBox({ w, h });
    };
    if (item.kind === 'video') {
      return (
        <video
          ref={which === 'before' ? beforeVideo : afterVideo}
          className="cmp-media"
          src={src}
          style={style}
          muted
          playsInline
          preload="auto"
          onLoadedMetadata={(e) => {
            report(e.currentTarget.videoWidth, e.currentTarget.videoHeight);
            video.onLoaded();
          }}
        />
      );
    }
    return (
      <img
        className="cmp-media"
        src={src}
        style={style}
        alt=""
        draggable={false}
        onLoad={(e) => report(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
      />
    );
  };

  const paneStyle = (which: 'before' | 'after'): CSSProperties => {
    if (mode === 'side') return { left: which === 'before' ? 0 : '50%', width: '50%' };
    if (mode === 'toggle') return { opacity: (which === 'after') === showAfter ? 1 : 0 };
    return which === 'after' ? { clipPath: `inset(0 0 0 ${split}%)` } : {};
  };

  const zoomLabel = `${Math.round(scale * 100)}%`;

  return (
    <div className="cmp-overlay" role="dialog" aria-modal="true" aria-label={t('cmp.dialog')}>
      <div className="cmp-top">
        <div className="cmp-title" title={item.original.name}>
          {item.original.name}
        </div>
        <div className="seg" role="tablist" aria-label={t('cmp.modes')}>
          {(
            [
              ['split', 'cmp.split'],
              ['toggle', 'cmp.toggle'],
              ['side', 'cmp.side'],
            ] as const
          ).map(([m, label]) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
              {t(label)}
            </button>
          ))}
        </div>
        <button className="icon-btn cmp-close" onClick={onClose} aria-label={t('cmp.close')}>
          ✕
        </button>
      </div>

      <div
        className={`cmp-viewport mode-${mode}`}
        ref={viewportRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => (zoom === null ? zoomAt(1) : fit())}
      >
        {prepared.status !== 'ready' ? (
          <div className="cmp-status">
            {prepared.status === 'error' ? (
              <span className="cmp-error">{messageText(prepared.message)}</span>
            ) : (
              <>
                <span>{messageText(prepared.message)}</span>
                {prepared.progress !== undefined && (
                  <div className="bar">
                    <div style={{ width: `${prepared.progress * 100}%` }} />
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <>
            <div className="cmp-pane" style={paneStyle('before')}>
              {media('before')}
            </div>
            <div className="cmp-pane" style={paneStyle('after')}>
              {media('after')}
            </div>
            {mode === 'split' && (
              <div className="cmp-divider" style={{ left: `${split}%` }}>
                <div className="cmp-grip">⟷</div>
              </div>
            )}
            {mode === 'toggle' ? (
              <div className={`cmp-badge big ${showAfter ? 'after' : 'before'}`}>{showAfter ? t('cmp.after') : t('cmp.before')}</div>
            ) : (
              <>
                <div className="cmp-badge left">{t('cmp.before')}</div>
                <div className="cmp-badge right">{t('cmp.after')}</div>
              </>
            )}
          </>
        )}
      </div>

      {item.kind === 'video' && prepared.status === 'ready' && <VideoControls video={video} fps={item.fps} />}

      <div className="cmp-bottom">
        <div className="cmp-info">
          <span>
            <b>{t('cmp.before')}:</b> {dims.before ?? '…'} · {formatBytes(item.original.size)}
          </span>
          <span>
            <b>{t('cmp.after')}:</b> {dims.after ?? '…'} · {formatBytes(item.result.size)}
          </span>
        </div>
        <div className="cmp-tools">
          {mode === 'toggle' && (
            <button className="btn ghost small" onClick={() => setShowAfter((v) => !v)}>
              {showAfter ? t('cmp.showOriginal') : t('cmp.showResult')} <kbd>S</kbd>
            </button>
          )}
          <button className="btn ghost small" onClick={() => zoomAt(scale / 1.5)} aria-label={t('cmp.zoomOut')}>
            −
          </button>
          <span className="cmp-zoom">{zoomLabel}</span>
          <button className="btn ghost small" onClick={() => zoomAt(scale * 1.5)} aria-label={t('cmp.zoomIn')}>
            +
          </button>
          <button className={`btn ghost small${zoom === null ? ' on' : ''}`} onClick={fit}>
            {t('cmp.fit')}
          </button>
          <button className={`btn ghost small${zoom === 1 ? ' on' : ''}`} onClick={() => zoomAt(1)}>
            1:1
          </button>
          <button className="btn ghost small" onClick={() => zoomAt(4)}>
            400%
          </button>
        </div>
      </div>
      <div className="cmp-hints">{withKeys(t(item.kind === 'video' ? 'cmp.hintsVideo' : 'cmp.hintsImage'))}</div>
    </div>
  );
}

/** Текст сообщения на текущем языке (с подробностями ошибки, если есть). */
function messageText(m: Message) {
  return m.text ? `${t(m.key, m.params)}: ${m.text}` : t(m.key, m.params);
}

/** Превращает «[Esc]» в подсказке в изображение клавиши. */
function withKeys(text: string) {
  return text.split(/\[([^\]]+)\]/).map((part, i) => (i % 2 ? <kbd key={i}>{part}</kbd> : part));
}

// ---------------------------------------------------------------------------

interface VideoSync {
  time: number;
  duration: number;
  playing: boolean;
  rate: number;
  toggle: () => void;
  seek: (t: number) => void;
  step: (frames: number) => void;
  setRate: (r: number) => void;
  onLoaded: () => void;
}

/** Держит оригинал на шкале времени результата (со сдвигом на начало обрезки). */
function useVideoSync(
  item: CompareItem,
  beforeRef: RefObject<HTMLVideoElement | null>,
  afterRef: RefObject<HTMLVideoElement | null>,
  ready: boolean,
): VideoSync {
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(1);
  const fps = item.fps || 30;
  const timeRef = useRef(0);

  const pause = useCallback(() => {
    const a = afterRef.current;
    const b = beforeRef.current;
    if (!a || !b) return;
    const wasPlaying = !a.paused;
    a.pause();
    b.pause();
    // Точно выравниваем: при воспроизведении два элемента немного расходятся.
    if (wasPlaying) b.currentTime = a.currentTime + item.offset;
    setPlaying(false);
  }, [beforeRef, afterRef, item.offset]);

  const seek = useCallback(
    (t: number) => {
      const a = afterRef.current;
      const b = beforeRef.current;
      if (!a || !b) return;
      pause();
      const max = Number.isFinite(a.duration) ? a.duration : t;
      const clamped = Math.min(Math.max(0, t), max);
      a.currentTime = clamped;
      b.currentTime = clamped + item.offset;
      timeRef.current = clamped;
      setTime(clamped);
    },
    [afterRef, beforeRef, item.offset, pause],
  );

  const step = useCallback(
    (frames: number) => {
      const a = afterRef.current;
      if (!a) return;
      const total = Math.max(1, Math.floor((a.duration || 0) * fps));
      const frame = Math.min(total - 1, Math.max(0, Math.floor(timeRef.current * fps + 1e-3) + frames));
      // Середина кадра: на границе браузер может показать предыдущий кадр.
      seek((frame + 0.5) / fps);
    },
    [afterRef, fps, seek],
  );

  const toggle = useCallback(() => {
    const a = afterRef.current;
    const b = beforeRef.current;
    if (!a || !b) return;
    if (!a.paused) return pause();
    if (a.ended || a.currentTime >= a.duration - 0.01) seek(0);
    b.currentTime = a.currentTime + item.offset;
    void a.play();
    void b.play().catch(() => {});
    setPlaying(true);
  }, [afterRef, beforeRef, item.offset, pause, seek]);

  const setRate = useCallback(
    (r: number) => {
      setRateState(r);
      if (afterRef.current) afterRef.current.playbackRate = r;
      if (beforeRef.current) beforeRef.current.playbackRate = r;
    },
    [afterRef, beforeRef],
  );

  const onLoaded = useCallback(() => {
    const a = afterRef.current;
    const b = beforeRef.current;
    if (!a || !b || !a.duration || !b.duration) return;
    setDuration(a.duration);
    // Показываем первый кадр обоих, выровненный.
    seek(0.5 / fps);
  }, [afterRef, beforeRef, fps, seek]);

  useEffect(() => {
    if (!ready || !playing) return;
    let raf = 0;
    const tick = () => {
      const a = afterRef.current;
      const b = beforeRef.current;
      if (a && b) {
        timeRef.current = a.currentTime;
        setTime(a.currentTime);
        const target = a.currentTime + item.offset;
        if (Math.abs(b.currentTime - target) > 0.08 && target < b.duration) b.currentTime = target;
        if (a.ended) {
          b.pause();
          setPlaying(false);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, playing, afterRef, beforeRef, item.offset]);

  return { time, duration, playing, rate, toggle, seek, step, setRate, onLoaded };
}

function fmtTime(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function VideoControls({ video, fps }: { video: VideoSync; fps: number }) {
  const f = fps || 30;
  const frame = Math.floor(video.time * f + 1e-3);
  const total = Math.max(1, Math.floor(video.duration * f));
  return (
    <div className="cmp-video">
      <button className="btn ghost small" onClick={() => video.step(-1)} aria-label={t('cmp.prevFrame')} title={t('cmp.prevFrame')}>
        ◀︎|
      </button>
      <button className="btn primary small cmp-play" onClick={video.toggle} aria-label={video.playing ? t('cmp.pause') : t('cmp.play')}>
        {video.playing ? '❚❚' : '▶'}
      </button>
      <button className="btn ghost small" onClick={() => video.step(1)} aria-label={t('cmp.nextFrame')} title={t('cmp.nextFrame')}>
        |▶︎
      </button>
      <input
        className="cmp-timeline"
        type="range"
        min={0}
        max={total - 1}
        step={1}
        value={Math.min(frame, total - 1)}
        onChange={(e) => video.seek((Number(e.target.value) + 0.5) / f)}
        aria-label={t('cmp.frame')}
      />
      <span className="cmp-time">
        {fmtTime(video.time)} · {t('cmp.frameN', { n: Math.min(frame, total - 1) + 1, total })}
      </span>
      <select value={video.rate} onChange={(e) => video.setRate(Number(e.target.value))} aria-label={t('cmp.speed')}>
        {[0.1, 0.25, 0.5, 1, 2].map((r) => (
          <option key={r} value={r}>
            {r}×
          </option>
        ))}
      </select>
    </div>
  );
}
