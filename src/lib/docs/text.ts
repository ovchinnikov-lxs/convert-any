/**
 * Text-document conversions. Everything goes through HTML as the common format:
 * DOCX / Markdown / TXT / spreadsheets → HTML → PDF / DOCX / Markdown / TXT.
 */

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export async function readText(file: Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Old Russian text files are often Windows-1251.
    return new TextDecoder('windows-1251').decode(buf);
  }
}

// ---------- → HTML

export async function docxToHtml(file: Blob): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  return value;
}

export async function docxToText(file: Blob): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return value;
}

export async function markdownToHtml(md: string): Promise<string> {
  const { marked } = await import('marked');
  return marked.parse(md, { gfm: true, breaks: false });
}

export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/** Body content of an HTML document (or the fragment itself). Scripts and styles are dropped. */
export function htmlBody(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, iframe, object, embed').forEach((n) => n.remove());
  return doc.body.innerHTML;
}

export function wrapHtml(body: string, title: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { max-width: 860px; margin: 40px auto; padding: 0 16px; font: 16px/1.6 system-ui, sans-serif; color: #1a1a1a; }
  table { border-collapse: collapse; margin: 1em 0; }
  td, th { border: 1px solid #ccc; padding: 4px 8px; text-align: left; vertical-align: top; }
  img { max-width: 100%; }
  pre { background: #f5f5f5; padding: 12px; overflow: auto; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// ---------- HTML →

export async function htmlToMarkdown(html: string): Promise<string> {
  const [{ default: TurndownService }, gfm] = await Promise.all([import('turndown'), import('turndown-plugin-gfm')]);
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.use(gfm.gfm);
  // Embedded base64 images would bloat the Markdown beyond usefulness.
  td.addRule('dataImages', {
    filter: (node) => node.nodeName === 'IMG' && (node.getAttribute('src') ?? '').startsWith('data:'),
    replacement: (_c, node) => `![${(node as HTMLElement).getAttribute('alt') ?? ''}](embedded-image)`,
  });
  // Markdown table cells can't hold blocks: flatten paragraphs inside cells (Word puts <p> in every cell).
  const doc = new DOMParser().parseFromString(htmlBody(html), 'text/html');
  doc.querySelectorAll('td, th').forEach((cell) => {
    const parts = Array.from(cell.querySelectorAll('p, div, li')).map((b) => b.innerHTML.trim()).filter(Boolean);
    if (parts.length) cell.innerHTML = parts.join('<br>');
  });
  // Tables without <th> get their first row promoted, otherwise GFM falls back to raw HTML.
  doc.querySelectorAll('table').forEach((t) => {
    if (t.querySelector('th')) return;
    const first = t.querySelector('tr');
    first?.querySelectorAll('td').forEach((td) => {
      const th = doc.createElement('th');
      th.innerHTML = td.innerHTML;
      td.replaceWith(th);
    });
  });
  return td.turndown(doc.body.innerHTML).trim() + '\n';
}

/** Plain text with the browser's own layout rules (block elements → line breaks). */
export function htmlToText(html: string): string {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:800px;white-space:normal';
  host.innerHTML = htmlBody(html);
  host.querySelectorAll('img').forEach((i) => i.remove());
  document.body.appendChild(host);
  const text = host.innerText;
  host.remove();
  return text.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export interface PdfLayout {
  pageSize: string;
  orientation: string;
  margin: number;
  fontSize: number;
}

/** Real text PDF (selectable, Cyrillic-capable Roboto font) via pdfmake. */
export async function htmlToPdf(html: string, layout: PdfLayout): Promise<Blob> {
  const [{ default: pdfMake }, { default: vfs }, { default: htmlToPdfmake }] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
    import('html-to-pdfmake'),
  ]);
  pdfMake.addVirtualFileSystem(vfs);
  // Never fetch anything from the network: all content is local.
  pdfMake.setUrlAccessPolicy(() => false);

  const content = htmlToPdfmake(htmlBody(html), {
    window,
    tableAutoSize: true,
    defaultStyles: {
      h1: { fontSize: layout.fontSize * 2, bold: true, marginBottom: 6 },
      h2: { fontSize: layout.fontSize * 1.6, bold: true, marginBottom: 5 },
      h3: { fontSize: layout.fontSize * 1.3, bold: true, marginBottom: 4 },
      a: { color: '#1a56db', decoration: 'underline' },
      pre: { font: 'Roboto', preserveLeadingSpaces: true, background: '#f3f3f3' },
      code: { background: '#f3f3f3' },
      th: { bold: true, fillColor: '#eeeeee' },
      blockquote: { italics: true, color: '#555555', marginLeft: 14 },
    },
  });
  const marginPt = (layout.margin / 25.4) * 72;
  const doc = pdfMake.createPdf({
    content,
    pageSize: layout.pageSize.toUpperCase(),
    pageOrientation: layout.orientation === 'landscape' ? 'landscape' : 'portrait',
    pageMargins: [marginPt, marginPt, marginPt, marginPt],
    defaultStyle: { font: 'Roboto', fontSize: layout.fontSize, lineHeight: 1.25 },
  } as never);
  const buffer: Uint8Array = await doc.getBuffer();
  return new Blob([buffer as BlobPart], { type: 'application/pdf' });
}

/** HTML → DOCX: headings, paragraphs, inline styles, links, lists, tables, code, embedded PNG/JPEG images. */
export async function htmlToDocx(html: string, title: string): Promise<Blob> {
  const d = await import('docx');
  const root = new DOMParser().parseFromString(htmlBody(html), 'text/html').body;

  type Style = { bold?: boolean; italics?: boolean; underline?: boolean; strike?: boolean; code?: boolean; link?: string };
  type Inline = InstanceType<typeof d.TextRun> | InstanceType<typeof d.ExternalHyperlink> | InstanceType<typeof d.ImageRun>;

  const headings = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5, d.HeadingLevel.HEADING_6];

  const imageRun = async (img: HTMLImageElement): Promise<Inline | null> => {
    const m = /^data:image\/(png|jpe?g|gif|bmp);base64,(.*)$/i.exec(img.getAttribute('src') ?? '');
    if (!m) return null;
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const scale = Math.min(1, 600 / bitmap.width);
    const type = m[1].toLowerCase().replace('jpeg', 'jpg') as 'png' | 'jpg' | 'gif' | 'bmp';
    const run = new d.ImageRun({ type, data: bytes, transformation: { width: bitmap.width * scale, height: bitmap.height * scale } });
    bitmap.close();
    return run;
  };

  const inlines = async (node: Node, style: Style = {}): Promise<Inline[]> => {
    const out: Inline[] = [];
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? '').replace(/\s+/g, ' ');
        if (!text) continue;
        const run = new d.TextRun({
          text,
          bold: style.bold,
          italics: style.italics,
          strike: style.strike,
          underline: style.underline || style.link ? {} : undefined,
          color: style.link ? '1A56DB' : undefined,
          font: style.code ? 'Courier New' : undefined,
        });
        out.push(style.link ? new d.ExternalHyperlink({ link: style.link, children: [run] }) : run);
        continue;
      }
      if (!(child instanceof HTMLElement)) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === 'br') out.push(new d.TextRun({ text: '', break: 1 }));
      else if (tag === 'img') {
        const img = await imageRun(child as HTMLImageElement);
        if (img) out.push(img);
      } else {
        const next: Style = { ...style };
        if (tag === 'b' || tag === 'strong') next.bold = true;
        if (tag === 'i' || tag === 'em') next.italics = true;
        if (tag === 'u' || tag === 'ins') next.underline = true;
        if (tag === 's' || tag === 'del' || tag === 'strike') next.strike = true;
        if (tag === 'code' || tag === 'kbd' || tag === 'samp') next.code = true;
        if (tag === 'a' && child.getAttribute('href')) next.link = child.getAttribute('href')!;
        out.push(...(await inlines(child, next)));
      }
    }
    return out;
  };

  const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'pre', 'blockquote', 'hr', 'section', 'article', 'header', 'footer', 'main', 'figure', 'dl', 'dt', 'dd']);

  type Block = InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>;

  const blocks = async (node: Node, ctx: { list?: { ordered: boolean; level: number }; quote?: boolean } = {}): Promise<Block[]> => {
    const out: Block[] = [];
    let pending: Node[] = [];
    const flushInline = async () => {
      if (!pending.length) return;
      const frag = document.createElement('span');
      pending.forEach((n) => frag.appendChild(n.cloneNode(true)));
      pending = [];
      const children = await inlines(frag);
      if (children.length && (frag.textContent?.trim() || frag.querySelector('img')))
        out.push(new d.Paragraph({ children, indent: ctx.quote ? { left: 720 } : undefined }));
    };

    for (const child of Array.from(node.childNodes)) {
      const tag = child instanceof HTMLElement ? child.tagName.toLowerCase() : '';
      if (!BLOCK.has(tag)) {
        pending.push(child);
        continue;
      }
      await flushInline();
      const el = child as HTMLElement;
      if (/^h[1-6]$/.test(tag)) {
        out.push(new d.Paragraph({ heading: headings[Number(tag[1]) - 1], children: await inlines(el) }));
      } else if (tag === 'p') {
        const children = await inlines(el);
        out.push(new d.Paragraph({ children, indent: ctx.quote ? { left: 720 } : undefined }));
      } else if (tag === 'ul' || tag === 'ol') {
        const level = ctx.list ? ctx.list.level + 1 : 0;
        for (const li of Array.from(el.children).filter((c) => c.tagName === 'LI')) {
          const nested = Array.from(li.children).filter((c) => c.tagName === 'UL' || c.tagName === 'OL');
          const textPart = li.cloneNode(true) as HTMLElement;
          textPart.querySelectorAll(':scope > ul, :scope > ol').forEach((n) => n.remove());
          out.push(
            new d.Paragraph({
              children: await inlines(textPart),
              ...(tag === 'ol' ? { numbering: { reference: 'ol', level: Math.min(level, 8) } } : { bullet: { level: Math.min(level, 8) } }),
            }),
          );
          for (const n of nested) out.push(...(await blocks({ childNodes: [n] } as unknown as Node, { list: { ordered: n.tagName === 'OL', level } })));
        }
      } else if (tag === 'pre') {
        for (const line of (el.textContent ?? '').replace(/\n$/, '').split('\n'))
          out.push(new d.Paragraph({ children: [new d.TextRun({ text: line, font: 'Courier New', size: 19 })], shading: { fill: 'F3F3F3' } }));
      } else if (tag === 'blockquote') {
        out.push(...(await blocks(el, { ...ctx, quote: true })));
      } else if (tag === 'hr') {
        out.push(new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: 'AAAAAA', space: 1 } } }));
      } else if (tag === 'table') {
        const rows = Array.from(el.querySelectorAll('tr'));
        if (!rows.length) continue;
        const cols = Math.max(...rows.map((r) => r.children.length));
        out.push(
          new d.Table({
            width: { size: 100, type: d.WidthType.PERCENTAGE },
            rows: await Promise.all(
              rows.map(async (r) => {
                const cells = Array.from(r.children) as HTMLElement[];
                while (cells.length < cols) cells.push(document.createElement('td'));
                return new d.TableRow({
                  children: await Promise.all(
                    cells.map(async (c) => {
                      const isHead = c.tagName === 'TH';
                      const content = await blocks(c);
                      return new d.TableCell({
                        children: content.length ? content : [new d.Paragraph('')],
                        shading: isHead ? { fill: 'EEEEEE' } : undefined,
                        columnSpan: Number(c.getAttribute('colspan')) || undefined,
                      });
                    }),
                  ),
                });
              }),
            ),
          }),
        );
        out.push(new d.Paragraph(''));
      } else {
        out.push(...(await blocks(el, ctx)));
      }
    }
    await flushInline();
    return out;
  };

  const children = await blocks(root);
  const doc = new d.Document({
    title,
    creator: '',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: {
      config: [
        {
          reference: 'ol',
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: d.LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: d.AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: children.length ? children : [new d.Paragraph('')] }],
  });
  return d.Packer.toBlob(doc);
}
