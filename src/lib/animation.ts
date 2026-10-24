/**
 * Animated images: detection (WebP, APNG, GIF) and decoding of animated WebP.
 *
 * ffmpeg reads APNG and GIF animations itself, but has no decoder for
 * animated WebP. Those are taken apart here: every ANMF frame is wrapped into
 * a standalone still WebP, decoded by the browser and composited on a canvas
 * following the WebP container rules (offsets, alpha blending, disposal).
 * The result is a PNG sequence with per-frame durations for ffmpeg's concat
 * demuxer.
 */

export type AnimationKind = 'webp' | 'apng' | 'gif';

export interface AnimationInfo {
  kind: AnimationKind;
  frames: number;
  /** Duration of the last frame, ms — encoders lose it, so it is written back afterwards. */
  lastDuration: number;
  /** Total duration of one loop, ms. */
  duration: number;
}

/** Browsers show (near-)zero frame durations as 100 ms; do the same. */
const normDuration = (ms: number) => (ms <= 10 ? 100 : Math.round(ms));

const ascii = (b: Uint8Array, at: number, len = 4) => String.fromCharCode(...b.subarray(at, at + len));
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32le = (b: Uint8Array, at: number) => (u24le(b, at) | (b[at + 3] << 24)) >>> 0;
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** Returns animation info for animated WebP / APNG / GIF files, `null` for still images. */
export async function detectAnimation(file: Blob): Promise<AnimationInfo | null> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  try {
    if (ascii(head, 0) === 'RIFF' && ascii(head, 8) === 'WEBP') return webpInfo(new Uint8Array(await file.arrayBuffer()));
    if (head[0] === 0x89 && ascii(head, 1, 3) === 'PNG') return await apngInfo(file);
    if (ascii(head, 0, 3) === 'GIF') return gifInfo(new Uint8Array(await file.arrayBuffer()));
  } catch {
    // A malformed file is treated as a still image; ffmpeg will report real problems.
  }
  return null;
}

function webpInfo(b: Uint8Array): AnimationInfo | null {
  let frames = 0;
  let animatedFlag = false;
  let last = 0;
  let duration = 0;
  forEachChunk(b, 12, b.length, (type, at) => {
    if (type === 'VP8X') animatedFlag = (b[at] & 0x02) !== 0;
    if (type === 'ANMF') {
      frames++;
      last = normDuration(u24le(b, at + 12));
      duration += last;
    }
  });
  return animatedFlag && frames > 1 ? { kind: 'webp', frames, lastDuration: last, duration } : null;
}

/** APNG = a PNG with an `acTL` chunk before the first `IDAT`. */
async function apngInfo(file: Blob): Promise<AnimationInfo | null> {
  // Cheap check first: walk chunk headers up to the first IDAT.
  let at = 8;
  let frames = 0;
  while (at + 8 <= file.size) {
    const h = new Uint8Array(await file.slice(at, at + 16).arrayBuffer());
    const len = u32be(h, 0);
    const type = ascii(h, 4);
    if (type === 'acTL') frames = u32be(h, 8);
    if (type === 'IDAT' || type === 'IEND') break;
    at += 12 + len;
  }
  if (frames < 2) return null;
  // Animated: read the whole file once to get the frame delays.
  const b = new Uint8Array(await file.arrayBuffer());
  let last = 100;
  let duration = 0;
  for (let at = 8; at + 8 <= b.length; at += 12 + u32be(b, at)) {
    if (ascii(b, at + 4) !== 'fcTL') continue;
    const d = at + 8;
    const num = (b[d + 20] << 8) | b[d + 21];
    const den = ((b[d + 22] << 8) | b[d + 23]) || 100;
    last = normDuration((num * 1000) / den);
    duration += last;
  }
  return { kind: 'apng', frames, lastDuration: last, duration };
}

/** Data offset of the last chunk of the given type in a PNG, or -1. */
function lastPngChunk(b: Uint8Array, type: string): number {
  let at = 8;
  let found = -1;
  while (at + 8 <= b.length) {
    const len = u32be(b, at);
    if (ascii(b, at + 4) === type) found = at + 8;
    at += 12 + len;
  }
  return found;
}

/** Counts image descriptors by walking the GIF block structure. */
function gifInfo(b: Uint8Array): AnimationInfo | null {
  const { frames, lastDelayAt, duration } = walkGif(b);
  const last = lastDelayAt >= 0 ? (b[lastDelayAt] | (b[lastDelayAt + 1] << 8)) * 10 : 100;
  return frames > 1 ? { kind: 'gif', frames, lastDuration: normDuration(last), duration } : null;
}

/**
 * Walks GIF blocks: image count, total duration and the offset of the last
 * Graphic Control Extension's delay field.
 */
function walkGif(b: Uint8Array): { frames: number; lastDelayAt: number; duration: number } {
  let at = 13;
  if (b[10] & 0x80) at += 3 * (1 << ((b[10] & 0x07) + 1)); // global color table
  const skipSubBlocks = () => {
    while (at < b.length && b[at] !== 0) at += b[at] + 1;
    at++;
  };
  let frames = 0;
  let lastDelayAt = -1;
  let delayAt = -1; // GCE of the image that comes next
  let duration = 0;
  while (at < b.length) {
    const block = b[at++];
    if (block === 0x21) {
      if (b[at] === 0xf9) lastDelayAt = delayAt = at + 3; // label, block size, flags → delay (LE, centiseconds)
      at++; // extension label
      skipSubBlocks();
    } else if (block === 0x2c) {
      frames++;
      duration += normDuration(delayAt >= 0 ? (b[delayAt] | (b[delayAt + 1] << 8)) * 10 : 0);
      delayAt = -1;
      const flags = b[at + 8];
      at += 9;
      if (flags & 0x80) at += 3 * (1 << ((flags & 0x07) + 1)); // local color table
      at++; // LZW minimum code size
      skipSubBlocks();
    } else break; // trailer (0x3b) or garbage
  }
  return { frames, lastDelayAt, duration };
}

/**
 * Writes the last frame's duration into an encoded animated WebP / APNG / GIF.
 * ffmpeg's muxers only guess it (they reuse the previous frame's delay), so the
 * real value from the source is patched in afterwards. With `total`, the last
 * frame instead gets whatever makes one loop last `total` ms.
 */
export function setLastFrameDuration(data: Uint8Array, ms: number, total?: number): Uint8Array {
  const b = data.slice();
  if (total) {
    // The last frame fills up the loop to `total` (resampled animations: the
    // encoder may have merged the last frames into one).
    const info = ascii(b, 0, 3) === 'GIF' ? gifInfo(b) : ascii(b, 0) === 'RIFF' ? webpInfo(b) : null;
    if (info && total - (info.duration - info.lastDuration) > ms / 2) ms = total - (info.duration - info.lastDuration);
  }
  ms = Math.max(10, Math.round(ms));
  if (ascii(b, 0) === 'RIFF' && ascii(b, 8) === 'WEBP') {
    let lastAnmf = -1;
    forEachChunk(b, 12, b.length, (type, at) => {
      if (type === 'ANMF') lastAnmf = at;
    });
    if (lastAnmf >= 0) b.set([ms & 0xff, (ms >> 8) & 0xff, (ms >> 16) & 0xff], lastAnmf + 12);
  } else if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') {
    const at = lastPngChunk(b, 'fcTL');
    if (at >= 0) {
      const num = Math.min(ms, 65535);
      b.set([num >> 8, num & 0xff, 1000 >> 8, 1000 & 0xff], at + 20); // delay_num / delay_den (ms)
      const crc = crc32(b.subarray(at - 4, at + 26)); // type + 26-byte fcTL data
      new DataView(b.buffer, b.byteOffset).setUint32(at + 26, crc);
    }
  } else if (ascii(b, 0, 3) === 'GIF') {
    const { lastDelayAt } = walkGif(b);
    const cs = Math.round(ms / 10);
    if (lastDelayAt >= 0) b.set([cs & 0xff, (cs >> 8) & 0xff], lastDelayAt);
  }
  return b;
}

let crcTable: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const x of bytes) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Walks RIFF chunks in b[from, to): calls fn(type, dataOffset, dataSize). */
function forEachChunk(b: Uint8Array, from: number, to: number, fn: (type: string, at: number, size: number) => void) {
  let at = from;
  while (at + 8 <= to) {
    const type = ascii(b, at);
    const size = u32le(b, at + 4);
    if (at + 8 + size > to) break;
    fn(type, at + 8, size);
    at += 8 + size + (size & 1);
  }
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const pad = data.length & 1;
  const out = new Uint8Array(8 + data.length + pad);
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

function riffWebp(chunks: Uint8Array[]): Uint8Array {
  const body = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + body);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  new DataView(out.buffer).setUint32(4, 4 + body, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  let at = 12;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

interface RawFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  duration: number;
  blend: boolean;
  dispose: boolean;
  still: Uint8Array;
}

function parseAnimatedWebp(b: Uint8Array) {
  let width = 0;
  let height = 0;
  const frames: RawFrame[] = [];
  forEachChunk(b, 12, b.length, (type, at, size) => {
    if (type === 'VP8X') {
      width = u24le(b, at + 4) + 1;
      height = u24le(b, at + 7) + 1;
    } else if (type === 'ANMF') {
      const w = u24le(b, at + 6) + 1;
      const h = u24le(b, at + 9) + 1;
      const flags = b[at + 15];
      let alph: Uint8Array | null = null;
      let image: { type: string; data: Uint8Array } | null = null;
      forEachChunk(b, at + 16, at + size, (t, a, s) => {
        if (t === 'ALPH') alph = b.subarray(a, a + s);
        else if (t === 'VP8 ' || t === 'VP8L') image ??= { type: t, data: b.subarray(a, a + s) };
      });
      if (!image) return;
      const img = image as { type: string; data: Uint8Array };
      let still: Uint8Array;
      if (img.type === 'VP8 ' && alph) {
        // Lossy frame with a separate alpha plane needs the extended (VP8X) container.
        const vp8x = new Uint8Array(10);
        vp8x[0] = 0x10; // alpha flag
        vp8x.set([(w - 1) & 0xff, ((w - 1) >> 8) & 0xff, ((w - 1) >> 16) & 0xff], 4);
        vp8x.set([(h - 1) & 0xff, ((h - 1) >> 8) & 0xff, ((h - 1) >> 16) & 0xff], 7);
        still = riffWebp([chunk('VP8X', vp8x), chunk('ALPH', alph), chunk(img.type, img.data)]);
      } else {
        still = riffWebp([chunk(img.type, img.data)]);
      }
      frames.push({
        x: u24le(b, at) * 2,
        y: u24le(b, at + 3) * 2,
        w,
        h,
        duration: u24le(b, at + 12),
        blend: (flags & 0x02) === 0,
        dispose: (flags & 0x01) !== 0,
        still,
      });
    }
  });
  return { width, height, frames };
}

export interface FrameSequence {
  /** ffconcat list file plus the PNG frames it references, all to be placed in one folder. */
  list: File;
  /** Duration of the last frame, ms (see `setLastFrameDuration`). */
  lastDuration: number;
  frames: File[];
  width: number;
  height: number;
}

/**
 * Decodes an animated WebP into fully composited PNG frames and an ffconcat
 * list with their durations — ready for `ffmpeg -f concat -i list`.
 */
export async function animatedWebpToSequence(file: Blob, onProgress?: (p: number) => void): Promise<FrameSequence> {
  const { width, height, frames } = parseAnimatedWebp(new Uint8Array(await file.arrayBuffer()));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const out: File[] = [];
  const lines = ['ffconcat version 1.0'];
  let lastDuration = 100;
  let prev: RawFrame | null = null;

  for (const [i, f] of frames.entries()) {
    // Disposal of the previous frame happens before the next one is drawn.
    if (prev?.dispose) ctx.clearRect(prev.x, prev.y, prev.w, prev.h);
    const bitmap = await createImageBitmap(new Blob([f.still as BlobPart], { type: 'image/webp' }));
    if (!f.blend) ctx.clearRect(f.x, f.y, f.w, f.h);
    ctx.drawImage(bitmap, f.x, f.y);
    bitmap.close();

    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
    );
    const name = `f${String(i).padStart(5, '0')}.png`;
    out.push(new File([png], name, { type: 'image/png' }));
    const ms = normDuration(f.duration);
    lastDuration = ms;
    // A millisecond time base keeps durations exact (the default 25 fps would round them to 40 ms).
    lines.push(`file ${name}`, 'option framerate 1000', `duration ${(ms / 1000).toFixed(3)}`);
    prev = f;
    onProgress?.((i + 1) / frames.length);
  }
  // The last frame's duration is lost by the encoders anyway; it is patched in afterwards.
  return {
    list: new File([lines.join('\n') + '\n'], 'frames.ffconcat', { type: 'text/plain' }),
    lastDuration,
    frames: out,
    width,
    height,
  };
}
