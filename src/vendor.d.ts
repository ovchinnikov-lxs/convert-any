declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export const gfm: TurndownService.Plugin;
}

declare module 'html-to-pdfmake' {
  export default function htmlToPdfmake(html: string, options?: Record<string, unknown>): unknown;
}
