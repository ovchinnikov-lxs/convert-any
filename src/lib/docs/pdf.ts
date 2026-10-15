import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { LocalizedError } from '../../i18n';

type OpenDoc = PDFDocumentProxy & { destroy: () => Promise<void> };

type Progress = (ratio: number) => void;

async function openWithPdfjs(file: Blob): Promise<OpenDoc> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), enableXfa: false });
  const doc = await task.promise;
  return Object.assign(doc, { destroy: () => task.destroy() });
}

/** Разбирает «1-3, 5, 8-» в отсортированные номера страниц (с 1). Пусто — все страницы. */
export function parsePageRange(spec: string, count: number): number[] {
  const s = spec.trim();
  if (!s) return Array.from({ length: count }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (m) {
      const a = m[1] ? Number(m[1]) : 1;
      const b = m[2] ? Number(m[2]) : count;
      for (let i = Math.max(1, a); i <= Math.min(count, b); i++) pages.add(i);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n >= 1 && n <= count) pages.add(n);
    } else {
      throw new LocalizedError('err.pageRange', { part });
    }
  }
  if (!pages.size) throw new LocalizedError('err.pageRangeEmpty', { count, spec });
  return [...pages].sort((a, b) => a - b);
}

async function renderPage(doc: PDFDocumentProxy, n: number, dpi: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext('2d')!;
  // Белая бумага вместо прозрачного фона.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new LocalizedError('err.encodeImage'))), type, quality),
  );
}

export async function pdfToImages(
  file: Blob,
  opts: { type: 'image/png' | 'image/jpeg'; dpi: number; quality: number; pages: string },
  onProgress: Progress,
): Promise<{ page: number; blob: Blob }[]> {
  const doc = await openWithPdfjs(file);
  try {
    const pages = parsePageRange(opts.pages, doc.numPages);
    const out: { page: number; blob: Blob }[] = [];
    for (const [i, n] of pages.entries()) {
      const canvas = await renderPage(doc, n, opts.dpi);
      out.push({ page: n, blob: await canvasToBlob(canvas, opts.type, opts.quality / 100) });
      canvas.width = canvas.height = 0;
      onProgress((i + 1) / pages.length);
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

export async function pdfToText(file: Blob, pagesSpec: string, onProgress: Progress): Promise<string> {
  const doc = await openWithPdfjs(file);
  try {
    const pages = parsePageRange(pagesSpec, doc.numPages);
    const chunks: string[] = [];
    for (const [i, n] of pages.entries()) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      let lastY: number | null = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
        text += item.str;
        if (item.hasEOL) text += '\n';
        lastY = y;
      }
      chunks.push(text.replace(/[ \t]+\n/g, '\n').trim());
      onProgress((i + 1) / pages.length);
    }
    return chunks.join('\n\n\f\n\n').trim() + '\n';
  } finally {
    await doc.destroy();
  }
}

/** Сильное сжатие: каждая страница становится JPEG с заданным DPI (текст больше не выделяется). */
export async function pdfRasterize(
  file: Blob,
  opts: { dpi: number; quality: number; pages: string; rotate: number },
  onProgress: Progress,
): Promise<Uint8Array> {
  const { PDFDocument, degrees } = await import('pdf-lib');
  const doc = await openWithPdfjs(file);
  try {
    const pages = parsePageRange(opts.pages, doc.numPages);
    const out = await PDFDocument.create();
    for (const [i, n] of pages.entries()) {
      const page = await doc.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 });
      const canvas = await renderPage(doc, n, opts.dpi);
      const jpg = await canvasToBlob(canvas, 'image/jpeg', opts.quality / 100);
      canvas.width = canvas.height = 0;
      const img = await out.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
      const p = out.addPage([width, height]);
      p.drawImage(img, { x: 0, y: 0, width, height });
      if (opts.rotate) p.setRotation(degrees(opts.rotate));
      onProgress((i + 1) / pages.length);
    }
    return out.save({ useObjectStreams: true });
  } finally {
    await doc.destroy();
  }
}

/** Без потерь: оставляет выбранные страницы, поворачивает, убирает метаданные, переупаковывает объекты. */
export async function pdfRewrite(file: Blob, opts: { pages: string; rotate: number }): Promise<Uint8Array> {
  const { PDFDocument, degrees } = await import('pdf-lib');
  const src = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
  const pages = parsePageRange(opts.pages, src.getPageCount());
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pages.map((n) => n - 1));
  for (const p of copied) {
    if (opts.rotate) p.setRotation(degrees((p.getRotation().angle + opts.rotate) % 360));
    out.addPage(p);
  }
  out.setProducer('');
  out.setCreator('');
  return out.save({ useObjectStreams: true });
}

export async function mergePdfs(files: Blob[]): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.create();
  for (const f of files) {
    const src = await PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return out.save({ useObjectStreams: true });
}

const PAGE_SIZES: Record<string, [number, number]> = {
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
};

/** Кладёт картинку на страницу PDF. JPEG/PNG встраиваются как есть, остальное — через canvas (PNG без потерь). */
export async function imageToPdf(
  file: File,
  opts: { pageSize: string; orientation: string; margin: number },
): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.create();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  let img;
  if (isJpg) img = await out.embedJpg(bytes);
  else if (isPng) img = await out.embedPng(bytes);
  else {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const png = await canvasToBlob(canvas, 'image/png');
    img = await out.embedPng(new Uint8Array(await png.arrayBuffer()));
  }

  const marginPt = (opts.margin / 25.4) * 72;
  let pageW: number;
  let pageH: number;
  if (opts.pageSize === 'fit') {
    // Страница ровно по размеру картинки (1 px = 1 pt) плюс поля.
    pageW = img.width + marginPt * 2;
    pageH = img.height + marginPt * 2;
  } else {
    [pageW, pageH] = PAGE_SIZES[opts.pageSize] ?? PAGE_SIZES.a4;
    const landscape = opts.orientation === 'landscape' || (opts.orientation === 'auto' && img.width > img.height);
    if (landscape) [pageW, pageH] = [pageH, pageW];
  }
  const boxW = pageW - marginPt * 2;
  const boxH = pageH - marginPt * 2;
  const scale = Math.min(boxW / img.width, boxH / img.height, opts.pageSize === 'fit' ? 1 : Infinity);
  const w = img.width * scale;
  const h = img.height * scale;
  const page = out.addPage([pageW, pageH]);
  page.drawImage(img, { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h });
  return out.save();
}
