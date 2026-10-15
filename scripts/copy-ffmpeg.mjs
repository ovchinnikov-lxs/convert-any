// Copies the single-threaded ffmpeg.wasm core into public/ so it is served
// from our own origin (no third-party CDN, works offline after first load).
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const coreDir = join(process.cwd(), 'node_modules', '@ffmpeg', 'core', 'dist', 'esm');
const outDir = join(process.cwd(), 'public', 'ffmpeg');

mkdirSync(outDir, { recursive: true });
for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  copyFileSync(join(coreDir, file), join(outDir, file));
}
console.log('ffmpeg core copied to public/ffmpeg');
