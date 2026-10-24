/**
 * APNG writer for full-color animations.
 *
 * ffmpeg's own APNG encoder blends frames OVER the previous one to save space,
 * which is wrong for semi-transparent pixels: they get blended again on every
 * frame and the animation turns more and more opaque. This writer stores, for
 * each frame, only the rectangle that changed since the previous frame and
 * draws it with the SOURCE blend op (pixels are replaced, alpha included), so
 * the result is exact for any transparency.
 */
import { crc32 } from './animation';

export interface RawFrames {
  /** Concatenated RGBA frames, width × height × 4 bytes each. */
  data: Uint8Array;
  width: number;
  height: number;
  /** Per-frame durations, ms. */
  durations: number[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bounding box of the pixels that differ between two RGBA frames (null if identical). */
function changedRect(prev: Uint32Array, cur: Uint32Array, width: number, height: number): Rect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (prev[row + x] !== cur[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Copies a rectangle of an RGBA frame into packed RGB(A) scanlines. */
function extract(frame: Uint8Array, width: number, r: Rect, bpp: 3 | 4): Uint8Array {
  const out = new Uint8Array(r.w * r.h * bpp);
  let o = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    let i = (y * width + r.x) * 4;
    for (let x = 0; x < r.w; x++, i += 4) {
      out[o++] = frame[i];
      out[o++] = frame[i + 1];
      out[o++] = frame[i + 2];
      if (bpp === 4) out[o++] = frame[i + 3];
    }
  }
  return out;
}

/** Same for an indexed image: palette index per pixel. */
function extractIndexed(frame: Uint32Array, width: number, r: Rect, index: Map<number, number>): Uint8Array {
  const out = new Uint8Array(r.w * r.h);
  let o = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x, i = y * width + r.x; x < r.x + r.w; x++, i++) out[o++] = index.get(frame[i])!;
  }
  return out;
}

/** Map color → palette index, or null if there are more than 256 distinct colors. */
function buildPalette(frames: Uint32Array[]): Map<number, number> | null {
  const index = new Map<number, number>();
  for (const f of frames) {
    for (let i = 0; i < f.length; i++) {
      if (index.has(f[i])) continue;
      if (index.size === 256) return null;
      index.set(f[i], index.size);
    }
  }
  return index;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * PNG row filtering: for every scanline picks the filter (none/sub/up/avg/paeth)
 * with the smallest sum of absolute values — the usual heuristic, as in libpng.
 * `noFilter` stores rows as is (filter type 0).
 */
function filterRows(pixels: Uint8Array, w: number, h: number, bpp: number, noFilter = false): Uint8Array {
  const stride = w * bpp;
  const out = new Uint8Array(h * (stride + 1));
  if (noFilter) {
    for (let y = 0; y < h; y++) out.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    return out;
  }
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < h; y++) {
    const cur = y * stride;
    const up = cur - stride;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const row = cand[f];
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const raw = pixels[cur + x];
        const a = x >= bpp ? pixels[cur + x - bpp] : 0;
        const b = y > 0 ? pixels[up + x] : 0;
        const c = x >= bpp && y > 0 ? pixels[up + x - bpp] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (raw - pred) & 0xff;
        row[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    out[y * (stride + 1)] = best;
    out.set(cand[best], y * (stride + 1) + 1);
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export async function rgbaToApng({ data, width, height, durations }: RawFrames): Promise<Uint8Array> {
  const { deflate } = await import('pako');
  const size = width * height * 4;
  const frames = durations.map((_, i) => data.subarray(i * size, (i + 1) * size));
  const pixels32 = frames.map((f) => new Uint32Array(f.buffer, f.byteOffset, width * height));

  // ≤256 colors → indexed; otherwise opaque animations are stored as RGB
  // (a quarter less data), others as RGBA.
  const palette = buildPalette(pixels32);
  let opaque = true;
  for (const f of frames) {
    for (let i = 3; i < f.length && opaque; i += 4) if (f[i] !== 255) opaque = false;
    if (!opaque) break;
  }
  const bpp: 3 | 4 = opaque ? 3 : 4;

  // Identical consecutive frames are merged (their durations add up).
  const plan: { index: number; rect: Rect; delay: number }[] = [];
  for (let i = 0; i < frames.length; i++) {
    const delay = Math.max(10, Math.round(durations[i]));
    if (i === 0) {
      plan.push({ index: 0, rect: { x: 0, y: 0, w: width, h: height }, delay });
      continue;
    }
    const rect = changedRect(pixels32[i - 1], pixels32[i], width, height);
    if (rect) plan.push({ index: i, rect, delay });
    else plan[plan.length - 1].delay += delay;
  }

  const parts: Uint8Array[] = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = palette ? 3 : opaque ? 2 : 6; // indexed / RGB / RGBA
  parts.push(pngChunk('IHDR', ihdr));
  if (palette) {
    const plte = new Uint8Array(palette.size * 3);
    const trns = new Uint8Array(palette.size);
    const rgba = new Uint8Array(4);
    const rgba32 = new Uint32Array(rgba.buffer);
    for (const [color, i] of palette) {
      rgba32[0] = color;
      plte.set(rgba.subarray(0, 3), i * 3);
      trns[i] = rgba[3];
    }
    parts.push(pngChunk('PLTE', plte));
    if (!opaque) parts.push(pngChunk('tRNS', trns));
  }
  const actl = new Uint8Array(8);
  new DataView(actl.buffer).setUint32(0, plan.length); // num_frames; num_plays = 0 → loop forever
  parts.push(pngChunk('acTL', actl));

  let seq = 0;
  for (const [n, p] of plan.entries()) {
    const fctl = new Uint8Array(26);
    const fv = new DataView(fctl.buffer);
    fv.setUint32(0, seq++);
    fv.setUint32(4, p.rect.w);
    fv.setUint32(8, p.rect.h);
    fv.setUint32(12, p.rect.x);
    fv.setUint32(16, p.rect.y);
    fv.setUint16(20, Math.min(p.delay, 65535));
    fv.setUint16(22, 1000); // delay in ms
    fctl[24] = 0; // dispose: none
    fctl[25] = 0; // blend: source (replace, alpha included)
    parts.push(pngChunk('fcTL', fctl));

    // Indexed rows compress best unfiltered (as libpng does).
    const z = palette
      ? deflate(filterRows(extractIndexed(pixels32[p.index], width, p.rect, palette), p.rect.w, p.rect.h, 1, true), {
          level: 9,
        })
      : deflate(filterRows(extract(frames[p.index], width, p.rect, bpp), p.rect.w, p.rect.h, bpp), { level: 9 });
    if (n === 0) parts.push(pngChunk('IDAT', z));
    else {
      const fdat = new Uint8Array(4 + z.length);
      new DataView(fdat.buffer).setUint32(0, seq++);
      fdat.set(z, 4);
      parts.push(pngChunk('fdAT', fdat));
    }
  }
  parts.push(pngChunk('IEND', new Uint8Array(0)));

  const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let at = 0;
  for (const x of parts) {
    out.set(x, at);
    at += x.length;
  }
  return out;
}

/**
 * Frame sizes and timestamps from ffmpeg's `showinfo` filter log lines, as
 * durations in ms (the last frame gets `lastMs`).
 */
export function framesFromShowinfo(logs: string[], lastMs: number) {
  const pts: number[] = [];
  let width = 0;
  let height = 0;
  for (const l of logs) {
    if (!l.includes('Parsed_showinfo')) continue;
    const t = /pts_time:\s*(-?[\d.]+)/.exec(l);
    if (!t) continue;
    // Frame 0 again = ffmpeg was restarted (watchdog retry): keep only the last run.
    if (/\bn:\s*0\s/.test(l)) pts.length = 0;
    pts.push(Number(t[1]) * 1000);
    const s = /\ss:(\d+)x(\d+)/.exec(l);
    if (s) [width, height] = [Number(s[1]), Number(s[2])];
  }
  const durations = pts.map((p, i) => (i + 1 < pts.length ? pts[i + 1] - p : lastMs));
  return { width, height, durations };
}
