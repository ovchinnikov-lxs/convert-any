# Convert Any

An image, video and document converter that runs **entirely in the browser**.
Nothing is uploaded: all processing is done by [ffmpeg.wasm](https://ffmpegwasm.netlify.app/)
and JavaScript libraries right on the user's device. The site can be installed as an app
and used offline.

Site: https://convert-any-one.vercel.app

> 📱 **iPhone photos (HEIC/HEIF) → JPG, PNG, WebP, GIF and more — in any browser**, not just Safari.
> The photo is decoded locally with libheif (WebAssembly); nothing is uploaded.

## Features

### Images
- PNG, JPG, WebP, GIF, BMP, TIFF, ICO.
- **HEIC / HEIF (iPhone photos) as input** → any of the formats above, with all the usual settings
  (quality, resize, metadata removal). Works in every browser: the photo is decoded with libheif
  compiled to WebAssembly. Rotation stored in the file is applied. HEIC is detected by content too,
  so a HEIC file saved under a `.jpg` name still converts.
- Quality, lossless WebP, resizing (percent / fit into a box / exact size).
- **Cropping** per photo: drag a frame with handles like in an image editor (Shift keeps the
  proportions), or type exact X / Y / width / height in pixels — the frame and the numbers stay in
  sync. Aspect presets: free, original, 1:1, 4:3, 3:4, 3:2, 16:9, 9:16. Arrow keys nudge the frame.
  The crop is applied before resizing and also shown in the before/after view.
- Metadata removal (EXIF, GPS).
- **Animated WebP, APNG and GIF**: compress and convert between each other with the animation kept —
  every frame keeps its exact duration. Options: quality, palette reduction (PNG/APNG, 256…16
  colors, like pngquant), lower frame rate. Converting an animation to JPG/BMP/… takes the first frame.
- Other formats ffmpeg can't read (e.g. AVIF) fall back to the browser's own decoder.

### Video
- MP4 (H.264), WebM (VP8), MOV, MKV, AVI, GIF and audio extraction (MP3, M4A, OGG, WAV).
- “By quality” or “target file size” compression, resolution, FPS, trimming, audio removal.
- **Smart compression:** shows the source codec, resolution and bitrate; never raises video or
  audio bitrate above the source (files don't get inflated); warns when the source is already
  heavily compressed.
- Multi-threaded ffmpeg (≈2× faster) when the browser supports cross-origin isolation.

### Documents
- DOCX / Markdown / HTML / TXT / spreadsheets / images (incl. HEIC) → **PDF** with real, selectable text.
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
  components/            — drop zone, settings panel, comparison, crop editor, offline status
  lib/
    ffmpeg.ts            — ffmpeg.wasm loading, task queue, media probing
    heic.ts              — HEIC/HEIF detection and decoding (libheif via heic-to)
    animation.ts         — animated WebP/APNG/GIF detection, animated WebP decoding
    apng.ts              — APNG writer (indexed / RGB / RGBA, changed-rectangle frames)
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
- **Document libraries** (pdf.js, pdfmake, SheetJS, …) and the **HEIC decoder** (~3 MB) are
  loaded on demand too, so the page itself stays light. A HEIC file is decoded once, when it is
  added: the PNG result feeds the thumbnail, the conversion and the before/after view.
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
- ffmpeg.wasm has no animated WebP decoder, so those are decoded frame by frame in JavaScript
  (browser WebP decoder + canvas compositing) before ffmpeg gets them.
- From multi-image HEIC files (bursts, Live Photos) only the main still image is converted;
  HDR / 10-bit photos are converted to regular 8-bit color.

## Author

Made by **Aleksandr Ovchinnikov** — [ovchinnikov-lxs.github.io](https://ovchinnikov-lxs.github.io) ·
[GitHub](https://github.com/ovchinnikov-lxs)
