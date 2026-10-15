import { baseName } from '../lib/utils';
import type { Category, ConvertContext, ConvertOutput, Options } from './types';

const TEXT = ['md', 'markdown', 'txt', 'html', 'htm'];
const SHEETS = ['xlsx', 'xls', 'ods', 'csv', 'json'];
const IMAGES = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];
const HTML_SOURCES = ['docx', ...TEXT, 'xlsx', 'xls', 'ods', 'csv'];

const has = (inputs: Set<string>, list: string[]) => list.some((e) => inputs.has(e));

export function extOf(name: string) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

async function zip(files: { name: string; data: Blob | string }[], name: string): Promise<ConvertOutput> {
  const { zipSync, strToU8 } = await import('fflate');
  const entries: Record<string, Uint8Array> = {};
  for (const f of files)
    entries[f.name] = typeof f.data === 'string' ? strToU8(f.data) : new Uint8Array(await f.data.arrayBuffer());
  const data = zipSync(entries, { level: 6 });
  return { blob: new Blob([data as BlobPart], { type: 'application/zip' }), name };
}

const pdfBlob = (bytes: Uint8Array) => new Blob([bytes as BlobPart], { type: 'application/pdf' });
const textBlob = (text: string, mime: string) => new Blob([text], { type: `${mime};charset=utf-8` });

/** Loads any text-like / office input as HTML. */
async function toHtml(file: File, ext: string, o: Options): Promise<string> {
  const t = await import('../lib/docs/text');
  if (ext === 'docx') return t.docxToHtml(file);
  if (ext === 'md' || ext === 'markdown') return t.markdownToHtml(await t.readText(file));
  if (ext === 'html' || ext === 'htm') return t.readText(file);
  if (ext === 'txt') return t.textToHtml(await t.readText(file));
  if (SHEETS.includes(ext)) {
    const s = await import('../lib/docs/sheets');
    return s.workbookToHtml(await s.readWorkbook(file, ext), Boolean(o.allSheets));
  }
  throw new Error(`Формат .${ext} не поддерживается`);
}

async function convert({ file, format, options: o, onProgress }: ConvertContext): Promise<ConvertOutput> {
  const ext = extOf(file.name);
  const base = baseName(file.name);
  const out = (blob: Blob) => ({ blob, name: `${base}.${format.ext}` });
  const pages = String(o.pages ?? '');

  switch (format.id) {
    case 'pdf': {
      const pdf = await import('../lib/docs/pdf');
      if (ext === 'pdf') {
        const rotate = Number(o.rotate) || 0;
        if (o.pdfMode === 'raster') {
          return out(pdfBlob(await pdf.pdfRasterize(file, { dpi: Number(o.dpi), quality: Number(o.quality), pages, rotate }, onProgress)));
        }
        return out(pdfBlob(await pdf.pdfRewrite(file, { pages, rotate })));
      }
      if (IMAGES.includes(ext)) {
        return out(pdfBlob(await pdf.imageToPdf(file, { pageSize: String(o.pageSize), orientation: String(o.orientation), margin: Number(o.margin) })));
      }
      const t = await import('../lib/docs/text');
      const html = await toHtml(file, ext, o);
      onProgress(0.4);
      return out(
        await t.htmlToPdf(html, {
          pageSize: o.pageSize === 'fit' ? 'a4' : String(o.pageSize),
          orientation: String(o.orientation) === 'landscape' ? 'landscape' : 'portrait',
          margin: Number(o.margin),
          fontSize: Number(o.fontSize),
        }),
      );
    }

    case 'png':
    case 'jpg': {
      const pdf = await import('../lib/docs/pdf');
      const type = format.id === 'png' ? 'image/png' : 'image/jpeg';
      const images = await pdf.pdfToImages(file, { type, dpi: Number(o.dpi), quality: Number(o.quality), pages }, onProgress);
      if (images.length === 1) return { blob: images[0].blob, name: `${base}-${images[0].page}.${format.ext}` };
      const width = String(Math.max(...images.map((i) => i.page))).length;
      return zip(
        images.map((i) => ({ name: `${base}-${String(i.page).padStart(width, '0')}.${format.ext}`, data: i.blob })),
        `${base}-${format.ext}.zip`,
      );
    }

    case 'txt': {
      const t = await import('../lib/docs/text');
      let text: string;
      if (ext === 'pdf') text = await (await import('../lib/docs/pdf')).pdfToText(file, pages, onProgress);
      else if (ext === 'docx') text = await t.docxToText(file);
      else if (SHEETS.includes(ext)) {
        const s = await import('../lib/docs/sheets');
        text = await s.workbookToText(await s.readWorkbook(file, ext), Boolean(o.allSheets));
      } else text = t.htmlToText(await toHtml(file, ext, o));
      return out(textBlob(text, 'text/plain'));
    }

    case 'md': {
      const t = await import('../lib/docs/text');
      if (ext === 'pdf') {
        // No structure in PDF text; keep paragraphs as Markdown paragraphs.
        const text = await (await import('../lib/docs/pdf')).pdfToText(file, pages, onProgress);
        return out(textBlob(text.replace(/\f/g, '---'), 'text/markdown'));
      }
      return out(textBlob(await t.htmlToMarkdown(await toHtml(file, ext, o)), 'text/markdown'));
    }

    case 'html': {
      const t = await import('../lib/docs/text');
      return out(textBlob(t.wrapHtml(t.htmlBody(await toHtml(file, ext, o)), base), 'text/html'));
    }

    case 'docx': {
      const t = await import('../lib/docs/text');
      return out(await t.htmlToDocx(await toHtml(file, ext, o), base));
    }

    case 'xlsx':
    case 'ods': {
      const s = await import('../lib/docs/sheets');
      return out(await s.workbookToFile(await s.readWorkbook(file, ext), format.id));
    }

    case 'csv': {
      const s = await import('../lib/docs/sheets');
      const delimiter = o.delimiter === 'tab' ? '\t' : String(o.delimiter);
      const csvs = await s.workbookToCsv(await s.readWorkbook(file, ext), delimiter, Boolean(o.allSheets), Boolean(o.bom));
      if (csvs.length === 1) return out(textBlob(csvs[0].text, 'text/csv'));
      return zip(
        csvs.map((c) => ({ name: `${base}-${c.sheet.replace(/[\\/:*?"<>|]+/g, '_')}.csv`, data: c.text })),
        `${base}-csv.zip`,
      );
    }

    case 'json': {
      const s = await import('../lib/docs/sheets');
      return out(textBlob(await s.workbookToJson(await s.readWorkbook(file, ext), Boolean(o.allSheets)), 'application/json'));
    }
  }
  throw new Error(`Нет конвертера .${ext} → ${format.label}`);
}

const isPdfOp = (f: string, i: Set<string>) => f === 'pdf' && i.has('pdf');
const makesPdfFromOther = (f: string, i: Set<string>) => f === 'pdf' && [...i].some((e) => e !== 'pdf');
const fromPdfPages = (f: string, i: Set<string>) => i.has('pdf') && ['pdf', 'png', 'jpg', 'txt', 'md'].includes(f);

export const documentCategory: Category = {
  id: 'docs',
  title: 'Документы',
  icon: '📄',
  description: 'PDF, DOCX, Markdown, HTML, TXT, таблицы XLSX/ODS/CSV — конвертация, сжатие и объединение PDF',
  status: 'ready',
  accept: [...new Set(['pdf', 'docx', ...TEXT, ...SHEETS, ...IMAGES])].map((e) => `.${e}`).join(','),
  formats: [
    { id: 'pdf', label: 'PDF', ext: 'pdf', mime: 'application/pdf', hint: 'Из документов, таблиц и картинок; сжатие и объединение PDF', from: ['pdf', 'docx', ...TEXT, 'xlsx', 'xls', 'ods', 'csv', ...IMAGES] },
    { id: 'docx', label: 'DOCX', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', hint: 'Word из Markdown, HTML или текста', from: TEXT },
    { id: 'md', label: 'Markdown', ext: 'md', mime: 'text/markdown', hint: 'Разметка из Word, HTML или PDF', from: ['docx', 'html', 'htm', 'pdf'] },
    { id: 'html', label: 'HTML', ext: 'html', mime: 'text/html', hint: 'Веб-страница', from: HTML_SOURCES.filter((e) => e !== 'html' && e !== 'htm') },
    { id: 'txt', label: 'TXT', ext: 'txt', mime: 'text/plain', hint: 'Только текст', from: ['pdf', 'docx', 'md', 'markdown', 'html', 'htm', 'xlsx', 'xls', 'ods', 'csv'] },
    { id: 'png', label: 'PNG', ext: 'png', mime: 'image/png', hint: 'Страницы PDF картинками (несколько — в ZIP)', from: ['pdf'] },
    { id: 'jpg', label: 'JPG', ext: 'jpg', mime: 'image/jpeg', hint: 'Страницы PDF картинками (несколько — в ZIP)', from: ['pdf'] },
    { id: 'xlsx', label: 'XLSX', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hint: 'Таблица Excel', from: ['xls', 'ods', 'csv', 'json'] },
    { id: 'ods', label: 'ODS', ext: 'ods', mime: 'application/vnd.oasis.opendocument.spreadsheet', hint: 'Таблица LibreOffice', from: ['xlsx', 'xls', 'csv', 'json'] },
    { id: 'csv', label: 'CSV', ext: 'csv', mime: 'text/csv', hint: 'Таблица текстом', from: ['xlsx', 'xls', 'ods', 'json'] },
    { id: 'json', label: 'JSON', ext: 'json', mime: 'application/json', hint: 'Строки таблицы как объекты', from: ['xlsx', 'xls', 'ods', 'csv'] },
  ],
  defaultFormat: 'pdf',
  defaultOptions: {
    pdfMode: 'optimize',
    pages: '',
    dpi: 150,
    quality: 75,
    rotate: '0',
    pageSize: 'a4',
    orientation: 'auto',
    margin: 15,
    fontSize: 11,
    merge: false,
    allSheets: true,
    delimiter: ',',
    bom: true,
  },
  formatDefaults: {
    png: { dpi: 150 },
    jpg: { dpi: 150 },
  },
  fields: [
    {
      key: 'pdfMode',
      type: 'select',
      label: 'Что сделать с PDF',
      choices: [
        { value: 'optimize', label: 'Пересохранить без потерь' },
        { value: 'raster', label: 'Сильно сжать (страницы → JPEG)' },
      ],
      hint: 'Сильное сжатие превращает текст в картинку — его нельзя будет выделить',
      visible: (_o, f, i) => isPdfOp(f, i),
    },
    {
      key: 'pages',
      type: 'text',
      label: 'Страницы PDF',
      placeholder: 'все, напр. 1-3, 5, 8-',
      visible: (_o, f, i) => fromPdfPages(f, i),
    },
    {
      key: 'dpi',
      type: 'slider',
      label: 'Разрешение',
      min: 50,
      max: 300,
      step: 10,
      unit: ' dpi',
      hint: '72 — экран, 150 — чтение, 300 — печать',
      visible: (o, f, i) => f === 'png' || f === 'jpg' || (isPdfOp(f, i) && o.pdfMode === 'raster'),
    },
    {
      key: 'quality',
      type: 'slider',
      label: 'Качество JPEG',
      min: 10,
      max: 100,
      unit: '%',
      visible: (o, f, i) => f === 'jpg' || (isPdfOp(f, i) && o.pdfMode === 'raster'),
    },
    {
      key: 'rotate',
      type: 'select',
      label: 'Повернуть страницы',
      choices: [
        { value: '0', label: 'Не поворачивать' },
        { value: '90', label: 'На 90° по часовой' },
        { value: '180', label: 'На 180°' },
        { value: '270', label: 'На 90° против часовой' },
      ],
      visible: (_o, f, i) => isPdfOp(f, i),
    },
    {
      key: 'pageSize',
      type: 'select',
      label: 'Размер страницы',
      choices: [
        { value: 'a4', label: 'A4' },
        { value: 'a5', label: 'A5' },
        { value: 'letter', label: 'Letter' },
        { value: 'fit', label: 'По размеру картинки' },
      ],
      hint: '«По размеру картинки» — только для изображений',
      visible: (_o, f, i) => makesPdfFromOther(f, i),
    },
    {
      key: 'orientation',
      type: 'select',
      label: 'Ориентация',
      choices: [
        { value: 'auto', label: 'Авто' },
        { value: 'portrait', label: 'Книжная' },
        { value: 'landscape', label: 'Альбомная' },
      ],
      visible: (o, f, i) => makesPdfFromOther(f, i) && o.pageSize !== 'fit',
    },
    {
      key: 'margin',
      type: 'number',
      label: 'Поля',
      min: 0,
      max: 50,
      unit: 'мм',
      visible: (_o, f, i) => makesPdfFromOther(f, i),
    },
    {
      key: 'fontSize',
      type: 'slider',
      label: 'Размер шрифта',
      min: 7,
      max: 18,
      unit: ' pt',
      visible: (_o, f, i) => f === 'pdf' && has(i, ['docx', ...TEXT, ...SHEETS]),
    },
    {
      key: 'allSheets',
      type: 'checkbox',
      label: 'Все листы таблицы (иначе только первый)',
      visible: (_o, f, i) => has(i, ['xlsx', 'xls', 'ods']) && !['xlsx', 'ods'].includes(f),
    },
    {
      key: 'delimiter',
      type: 'select',
      label: 'Разделитель CSV',
      choices: [
        { value: ',', label: 'Запятая ,' },
        { value: ';', label: 'Точка с запятой ; (Excel RU)' },
        { value: 'tab', label: 'Табуляция' },
      ],
      visible: (_o, f) => f === 'csv',
    },
    {
      key: 'bom',
      type: 'checkbox',
      label: 'UTF-8 с BOM (для кириллицы в Excel)',
      visible: (_o, f) => f === 'csv',
    },
    {
      key: 'merge',
      type: 'checkbox',
      label: 'Объединить всё в один PDF',
      hint: 'В порядке списка файлов',
      visible: (_o, f) => f === 'pdf',
    },
  ],
  convert,
  canMerge: (format, o) => format === 'pdf' && Boolean(o.merge),
  merge: async (outputs) => {
    const { mergePdfs } = await import('../lib/docs/pdf');
    return { blob: pdfBlob(await mergePdfs(outputs.map((o) => o.blob))), name: 'объединённый.pdf' };
  },
};
