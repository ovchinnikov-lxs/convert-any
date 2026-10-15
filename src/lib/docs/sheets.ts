import { escapeHtml, readText } from './text';

type XLSXLib = typeof import('@e965/xlsx');
type WorkBook = import('@e965/xlsx').WorkBook;

async function lib(): Promise<XLSXLib> {
  return import('@e965/xlsx');
}

export async function readWorkbook(file: File, ext: string): Promise<WorkBook> {
  const X = await lib();
  if (ext === 'json') {
    const data = JSON.parse(await readText(file));
    const rows = Array.isArray(data) ? data : [data];
    const wb = X.utils.book_new();
    if (rows.every((r) => Array.isArray(r))) X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(rows), 'Sheet1');
    else X.utils.book_append_sheet(wb, X.utils.json_to_sheet(rows), 'Sheet1');
    return wb;
  }
  if (ext === 'csv') {
    // Декодируем сами, чтобы CSV из Excel в Windows-1251 не потеряли кириллицу.
    return X.read(await readText(file), { type: 'string', raw: true });
  }
  return X.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: true });
}

function sheetNames(wb: WorkBook, all: boolean) {
  return all ? wb.SheetNames : wb.SheetNames.slice(0, 1);
}

export async function workbookToFile(wb: WorkBook, bookType: 'xlsx' | 'ods'): Promise<Blob> {
  const X = await lib();
  const data: ArrayBuffer = X.write(wb, { bookType, type: 'array', compression: true });
  const mime =
    bookType === 'xlsx'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/vnd.oasis.opendocument.spreadsheet';
  return new Blob([data], { type: mime });
}

/** По одному CSV на лист. BOM в UTF-8 помогает Excel правильно открыть кириллицу. */
export async function workbookToCsv(wb: WorkBook, delimiter: string, all: boolean, bom: boolean) {
  const X = await lib();
  return sheetNames(wb, all).map((name) => ({
    sheet: name,
    text: (bom ? '\ufeff' : '') + X.utils.sheet_to_csv(wb.Sheets[name], { FS: delimiter, blankrows: false }),
  }));
}

export async function workbookToJson(wb: WorkBook, all: boolean): Promise<string> {
  const X = await lib();
  const names = sheetNames(wb, all);
  const data = names.map((n) => X.utils.sheet_to_json(wb.Sheets[n], { defval: null, raw: false }));
  return JSON.stringify(all && names.length > 1 ? Object.fromEntries(names.map((n, i) => [n, data[i]])) : data[0], null, 2) + '\n';
}

/** HTML-таблицы (по одной на лист, с названиями листов в заголовках). */
export async function workbookToHtml(wb: WorkBook, all: boolean): Promise<string> {
  const X = await lib();
  const names = sheetNames(wb, all);
  return names
    .map((n) => {
      const doc = new DOMParser().parseFromString(X.utils.sheet_to_html(wb.Sheets[n]), 'text/html');
      const table = doc.querySelector('table');
      table?.querySelectorAll('[id], [data-t], [data-v]').forEach((el) => {
        el.removeAttribute('id');
        el.removeAttribute('data-t');
        el.removeAttribute('data-v');
      });
      return `${names.length > 1 ? `<h2>${escapeHtml(n)}</h2>\n` : ''}${table?.outerHTML ?? ''}`;
    })
    .join('\n');
}

export async function workbookToText(wb: WorkBook, all: boolean): Promise<string> {
  const X = await lib();
  const names = sheetNames(wb, all);
  return names
    .map((n) => (names.length > 1 ? `== ${n} ==\n` : '') + X.utils.sheet_to_csv(wb.Sheets[n], { FS: '\t', blankrows: false }))
    .join('\n\n');
}
