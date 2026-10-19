import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import { t, useLang, type Key } from '../i18n';
import { canShowImage, imageProxy } from '../lib/preview';

/** Crop rectangle in source-image pixels (after EXIF/HEIC rotation, as the browser displays it). */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  file: File;
  /** Displayable version of the file (e.g. a HEIC photo decoded to PNG), if any. */
  display?: Blob;
  initial?: Crop;
  /** False while conversions run — formats the browser can't show need the ffmpeg engine. */
  engineFree: boolean;
  /** `null` means "no crop" (the whole image). */
  onApply: (crop: Crop | null) => void;
  onClose: () => void;
}

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const ASPECTS: { id: string; label: Key | string; ratio?: number }[] = [
  { id: 'free', label: 'crop.free' },
  { id: 'orig', label: 'crop.original' },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Builds a rectangle from a fixed anchor point towards a pointer, optionally
 * keeping `ratio`, and never leaving the W×H image.
 */
function fromAnchor(ax: number, ay: number, px: number, py: number, W: number, H: number, ratio: number | null): Crop {
  const sx = px >= ax ? 1 : -1;
  const sy = py >= ay ? 1 : -1;
  let w = Math.abs(px - ax);
  let h = Math.abs(py - ay);
  const maxW = sx > 0 ? W - ax : ax;
  const maxH = sy > 0 ? H - ay : ay;
  if (ratio) {
    // Follow whichever side the pointer moved further along, then fit into the image.
    if (w / ratio > h) h = w / ratio;
    else w = h * ratio;
    if (w > maxW) [w, h] = [maxW, maxW / ratio];
    if (h > maxH) [w, h] = [maxH * ratio, maxH];
  } else {
    w = Math.min(w, maxW);
    h = Math.min(h, maxH);
  }
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  return { x: Math.round(sx > 0 ? ax : ax - w), y: Math.round(sy > 0 ? ay : ay - h), w, h };
}

/** Largest rectangle with the given ratio inside `r`, centered on it. */
function fitRatio(r: Crop, ratio: number): Crop {
  let w = r.w;
  let h = Math.round(w / ratio);
  if (h > r.h) {
    h = r.h;
    w = Math.round(h * ratio);
  }
  w = Math.max(1, w);
  h = Math.max(1, h);
  return { x: Math.round(r.x + (r.w - w) / 2), y: Math.round(r.y + (r.h - h) / 2), w, h };
}

/** Image crop editor: a draggable frame with handles plus exact pixel inputs, kept in sync. */
export function CropEditor({ file, display, initial, engineFree, onApply, onClose }: Props) {
  useLang();
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ W: number; H: number } | null>(null);
  const [rect, setRect] = useState<Crop | null>(initial ?? null);
  const [aspect, setAspect] = useState('free');
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const engineFreeAtOpen = useRef(engineFree).current;

  // --- Load a displayable image (through ffmpeg for formats the browser can't show, e.g. TIFF).
  useEffect(() => {
    let alive = true;
    const created: string[] = [];
    (async () => {
      const url = URL.createObjectURL(display ?? file);
      created.push(url);
      if (await canShowImage(url)) return url;
      if (!engineFreeAtOpen) throw new Error(t('cmp.unsupported'));
      const proxied = await imageProxy(display ?? file, file.name);
      created.push(proxied);
      return proxied;
    })().then(
      (u) => alive && setSrc(u),
      (e: Error) => alive && setError(e.message || t('cmp.prepError')),
    );
    return () => {
      alive = false;
      setTimeout(() => created.forEach((u) => URL.revokeObjectURL(u)), 0);
    };
  }, [file, display, engineFreeAtOpen]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = size?.W ?? 1;
  const H = size?.H ?? 1;
  const full: Crop = { x: 0, y: 0, w: W, h: H };
  const r = rect ?? full;
  const ratio = (() => {
    const a = ASPECTS.find((x) => x.id === aspect);
    if (aspect === 'orig') return W / H;
    return a?.ratio ?? null;
  })();

  // Image fitted into the stage with a margin for the handles.
  const pad = 24;
  const scale = size ? Math.min((stage.w - pad * 2) / W, (stage.h - pad * 2) / H, 4) : 1;
  const ox = (stage.w - W * scale) / 2;
  const oy = (stage.h - H * scale) / 2;

  const toImage = useCallback(
    (clientX: number, clientY: number) => {
      const b = stageRef.current!.getBoundingClientRect();
      return { px: clamp((clientX - b.left - ox) / scale, 0, W), py: clamp((clientY - b.top - oy) / scale, 0, H) };
    },
    [ox, oy, scale, W, H],
  );

  // --- Dragging: move the frame, resize by a handle, or draw a new frame outside it.
  const drag = useRef<{ mode: 'move' | 'new' | Handle; px: number; py: number; r0: Crop } | null>(null);

  const onPointerDown = (e: RPointerEvent) => {
    if (e.button !== 0 || !size) return;
    const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined;
    const { px, py } = toImage(e.clientX, e.clientY);
    const inside = px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
    drag.current = { mode: handle ?? (inside ? 'move' : 'new'), px, py, r0: r };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { px, py } = toImage(e.clientX, e.clientY);
    const { r0 } = d;
    // Shift keeps the frame's proportions (unless a fixed aspect is already selected).
    const lock = ratio ?? (e.shiftKey ? r0.w / r0.h : null);

    if (d.mode === 'move') {
      setRect({
        ...r0,
        x: Math.round(clamp(r0.x + px - d.px, 0, W - r0.w)),
        y: Math.round(clamp(r0.y + py - d.py, 0, H - r0.h)),
      });
      return;
    }
    if (d.mode === 'new') {
      if (Math.abs(px - d.px) < 2 && Math.abs(py - d.py) < 2) return;
      setRect(fromAnchor(d.px, d.py, px, py, W, H, e.shiftKey ? lock ?? 1 : ratio));
      return;
    }

    const h = d.mode;
    const right = r0.x + r0.w;
    const bottom = r0.y + r0.h;
    if (h.length === 2) {
      // Corner: the opposite corner stays put.
      const ax = h.includes('w') ? right : r0.x;
      const ay = h.includes('n') ? bottom : r0.y;
      setRect(fromAnchor(ax, ay, px, py, W, H, lock));
      return;
    }
    // Edge: one side moves; with a locked ratio the other dimension follows, centered.
    let { x, y, w, h: hh } = r0;
    if (h === 'e') w = clamp(px - x, 1, W - x);
    if (h === 'w') {
      x = clamp(px, 0, right - 1);
      w = right - x;
    }
    if (h === 's') hh = clamp(py - y, 1, H - y);
    if (h === 'n') {
      y = clamp(py, 0, bottom - 1);
      hh = bottom - y;
    }
    if (lock) {
      if (h === 'e' || h === 'w') {
        const cy = r0.y + r0.h / 2;
        hh = w / lock;
        const maxH = 2 * Math.min(cy, H - cy);
        if (hh > maxH) {
          hh = maxH;
          w = hh * lock;
          if (h === 'w') x = right - w;
        }
        y = cy - hh / 2;
      } else {
        const cx = r0.x + r0.w / 2;
        w = hh * lock;
        const maxW = 2 * Math.min(cx, W - cx);
        if (w > maxW) {
          w = maxW;
          hh = w / lock;
          if (h === 'n') y = bottom - hh;
        }
        x = cx - w / 2;
      }
    }
    setRect({ x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(hh)) });
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  // --- Exact values: typing updates the frame right away (kept inside the image).
  const setField = (key: keyof Crop, raw: string) => {
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v)) return;
    let n = { ...r, [key]: v };
    if (key === 'w') {
      n.w = clamp(v, 1, W - n.x);
      if (ratio) n.h = clamp(Math.round(n.w / ratio), 1, H - n.y);
    } else if (key === 'h') {
      n.h = clamp(v, 1, H - n.y);
      if (ratio) n.w = clamp(Math.round(n.h * ratio), 1, W - n.x);
    } else if (key === 'x') {
      // Moving right shrinks the frame if it no longer fits, so X/Y can be typed before W/H.
      n.x = clamp(v, 0, W - 1);
      n.w = Math.min(n.w, W - n.x);
      if (ratio) n.h = Math.max(1, Math.round(n.w / ratio));
    } else {
      n.y = clamp(v, 0, H - 1);
      n.h = Math.min(n.h, H - n.y);
      if (ratio) n.w = Math.max(1, Math.round(n.h * ratio));
    }
    // Keep the frame inside the image; with a fixed aspect, fit the largest frame of that ratio.
    n.w = clamp(n.w, 1, W - n.x);
    n.h = clamp(n.h, 1, H - n.y);
    if (ratio && Math.abs(n.w / n.h - ratio) > 0.01) n = fitRatio(n, ratio);
    setRect(n);
  };

  const chooseAspect = (id: string) => {
    setAspect(id);
    const a = ASPECTS.find((x) => x.id === id);
    const rr = id === 'orig' ? W / H : a?.ratio;
    if (rr) setRect(fitRatio(r, rr));
  };

  const isFull = r.x === 0 && r.y === 0 && r.w === W && r.h === H;
  const apply = useCallback(() => onApply(isFull ? null : r), [onApply, isFull, r]);

  // --- Keyboard: arrows nudge the frame (Shift — by 10 px), Enter applies, Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      if (e.key === 'Enter') return apply();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      setRect((cur) => {
        const c = cur ?? full;
        return { ...c, x: clamp(c.x + dx, 0, W - c.w), y: clamp(c.y + dy, 0, H - c.h) };
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const box = { left: ox + r.x * scale, top: oy + r.y * scale, width: r.w * scale, height: r.h * scale };

  return (
    <div className="cmp-overlay crop-overlay" role="dialog" aria-modal="true" aria-label={t('crop.title')}>
      <div className="cmp-top">
        <div className="cmp-title" title={file.name}>
          ✂ {t('crop.title')} · {file.name}
        </div>
        <button className="icon-btn cmp-close" onClick={onClose} aria-label={t('cmp.close')}>
          ✕
        </button>
      </div>

      <div
        className="crop-stage"
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {error && <div className="cmp-status cmp-error">{error}</div>}
        {!error && !src && <div className="cmp-status">{t('cmp.preparing')}</div>}
        {src && (
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            className="crop-img"
            style={{ left: ox, top: oy, width: W * scale, height: H * scale, visibility: size ? 'visible' : 'hidden' }}
            onLoad={(e) => {
              const { naturalWidth: nw, naturalHeight: nh } = e.currentTarget;
              setSize({ W: nw, H: nh });
              // Drop a saved crop that no longer fits (shouldn't happen, but stay safe).
              setRect((cur) => (cur && cur.x + cur.w <= nw && cur.y + cur.h <= nh ? cur : null));
            }}
          />
        )}
        {size && (
          <div className="crop-box" style={box}>
            <div className="crop-grid" />
            <div className="crop-size">
              {r.w} × {r.h}
            </div>
            {HANDLES.map((h) => (
              <div key={h} className={`crop-handle h-${h}`} data-handle={h} />
            ))}
          </div>
        )}
      </div>

      <div className="crop-panel">
        <div className="crop-fields">
          {(['x', 'y', 'w', 'h'] as const).map((k) => (
            <label key={k} className="crop-field">
              <span>{t(`crop.${k}` as Key)}</span>
              <input
                type="number"
                min={k === 'w' || k === 'h' ? 1 : 0}
                max={k === 'x' ? W - 1 : k === 'y' ? H - 1 : k === 'w' ? W - r.x : H - r.y}
                value={r[k]}
                disabled={!size}
                onChange={(e) => setField(k, e.target.value)}
              />
              <em>px</em>
            </label>
          ))}
        </div>
        <div className="crop-aspects" role="group" aria-label={t('crop.aspect')}>
          {ASPECTS.map((a) => (
            <button
              key={a.id}
              className={`btn ghost small${aspect === a.id ? ' on' : ''}`}
              onClick={() => chooseAspect(a.id)}
              disabled={!size}
            >
              {a.label.includes('.') ? t(a.label as Key) : a.label}
            </button>
          ))}
        </div>
        <div className="crop-actions">
          <span className="crop-src">{size ? t('crop.source', { w: W, h: H }) : ''}</span>
          <button className="btn ghost small" onClick={() => setRect(null)} disabled={!size || isFull}>
            {t('crop.reset')}
          </button>
          <button className="btn ghost small" onClick={onClose}>
            {t('crop.cancel')}
          </button>
          <button className="btn primary small" onClick={apply} disabled={!size}>
            {t('crop.apply')}
          </button>
        </div>
      </div>
      <div className="cmp-hints">{t('crop.hints')}</div>
    </div>
  );
}
