# Convert Any

An image, video and document converter that runs **entirely in the browser**.
Nothing is uploaded: all processing is done by [ffmpeg.wasm](https://ffmpegwasm.netlify.app/)
and JavaScript libraries right on the user's device. The site can be installed as an app
and used offline.

Site: https://convert-any-one.vercel.app

## Features

### Images
- PNG, JPG, WebP, GIF, BMP, TIFF, ICO.
- Quality, lossless WebP, resizing (percent / fit into a box / exact size).
- Metadata removal (EXIF, GPS). Animated GIF → animated WebP.
- Formats ffmpeg can't read (e.g. HEIC/AVIF in Safari) are decoded by the browser.

### Video
- MP4 (H.264), WebM (VP8), MOV, MKV, AVI, GIF and audio extraction (MP3, M4A, OGG, WAV).
- “By quality” or “target file size” compression, resolution, FPS, trimming, audio removal.
- **Smart compression:** shows the source codec, resolution and bitrate; never raises video or
  audio bitrate above the source (files don't get inflated); warns when the source is already
  heavily compressed.
- Multi-threaded ffmpeg (≈2× faster) when the browser supports cross-origin isolation.

### Documents
- DOCX / Markdown / HTML / TXT / spreadsheets / images → **PDF** with real, selectable text.
- PDF → PNG / JPG (per page, several — in a ZIP), TXT, Markdown.
- PDF → PDF: page selection, rotation, lossless or rasterizing (JPEG) compression.
- Merging several files into one PDF.
- DOCX → Markdown / HTML / TXT; Markdown / HTML / TXT → DOCX.
- XLSX / XLS / ODS / CSV / JSON — to each other (CSV with delimiter choice and BOM for Excel).

### General
- **Before/after comparison** for images and video: slider, quick toggle, side by side;
  pixel-level zoom; frame-by-frame video.
- **Offline mode (PWA):** after “Download for offline” everything works without a network.
- **English and Russian UI**: detected from the browser language, switchable (RU / EN),
  the choice is remembered.

## How it works

```
src/
  App.tsx                — UI: tabs, file queue, settings
  categories/            — converter sections (formats and settings)
    types.ts             — shared types: Category, FormatDef, FieldDef…
    image.ts, video.ts   — ffmpeg-based sections (build ffmpeg arguments)
    document.ts          — documents section (own JS converter)
  components/            — drop zone, settings panel, comparison, offline status
  lib/
    ffmpeg.ts            — ffmpeg.wasm loading, task queue, media probing
    preview.ts           — previews for formats the browser can't display
    docs/                — pdf.js, pdf-lib, pdfmake, mammoth, SheetJS
  i18n/                  — localization: ru.ts (main dictionary), en.ts
scripts/copy-ffmpeg.mjs  — copies ffmpeg.wasm cores into public/ at build time
vercel.json              — COOP/COEP headers (multi-threading) and caching
```

- **ffmpeg.wasm** is loaded lazily on the first photo/video conversion (≈31 MB, once), served
  from our own origin. With cross-origin isolation (`Cross-Origin-Opener-Policy` /
  `Cross-Origin-Embedder-Policy` headers) the multi-threaded core is used, otherwise the
  single-threaded one; if the multi-threaded core fails, it falls back automatically.
- **Document libraries** (pdf.js, pdfmake, SheetJS, …) are loaded on demand too, so the page
  itself stays light.
- A **service worker** (vite-plugin-pwa) caches the app for offline use; the ffmpeg core is
  cached on first use.

## Development

```bash
npm install
npm run dev       # copies ffmpeg cores into public/ffmpeg and starts Vite
npm run build     # type check and build into dist/
npm run preview   # serve the build locally (with isolation headers)
```

Requires Node.js 22+.

### Adding a section or a format

1. Describe a `Category` object (see `src/categories/image.ts` and `document.ts`):
   - `formats` — output formats; `from` — which input extensions can produce a format;
   - `fields` — settings (sliders, selects, checkboxes, inputs are rendered automatically);
   - `buildArgs` (ffmpeg arguments) **or** `convert` (own JS converter).
2. Add it to `src/categories/index.ts`.
3. All labels are dictionary keys: add them to `src/i18n/ru.ts` and `src/i18n/en.ts`.

### Localization

- `src/i18n/ru.ts` is the main dictionary; `en.ts` is typed against it, so the build fails if
  an English key is missing.
- In components: `t('key', { param })` and `useLang()` to re-render on language change.
- Converter errors: `throw new LocalizedError('err.key', { … })`.
- The language is detected from `navigator.languages` (Russian for ru, uk, be, kk, …); a manual
  choice is stored in `localStorage`.

## Deployment

Deployed to Vercel as a static site (`vercel.json`). Keep the COOP/COEP headers: without them
there is no multi-threaded ffmpeg (the site still works on the single-threaded core).

## Limitations

- ffmpeg.wasm is slower than native ffmpeg, even multi-threaded.
- WebAssembly memory is limited (~2 GB): very large videos may fail.
- WebM is encoded as VP8 — VP9 crashes in the current ffmpeg.wasm build.
- PDF → DOCX is not supported (only server-side tools do it well). Complex DOCX layout
  (headers/footers, columns, text wrapping) is simplified when converting to PDF.
- Scans without a text layer yield empty text (no OCR yet).
