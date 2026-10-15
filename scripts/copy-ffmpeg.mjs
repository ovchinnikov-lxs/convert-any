// Copies the ffmpeg.wasm cores into public/ so they are served from our own
// origin (no third-party CDN, cacheable for offline use).
//   public/ffmpeg/st — single-threaded core (works everywhere)
//   public/ffmpeg/mt — multi-threaded core (needs a cross-origin isolated page)
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const out = join(process.cwd(), 'public', 'ffmpeg');
rmSync(out, { recursive: true, force: true });

const cores = {
  st: ['core', ['ffmpeg-core.js', 'ffmpeg-core.wasm']],
  mt: ['core-mt', ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js']],
};
for (const [dir, [pkg, files]] of Object.entries(cores)) {
  const src = join(process.cwd(), 'node_modules', '@ffmpeg', pkg, 'dist', 'esm');
  mkdirSync(join(out, dir), { recursive: true });
  for (const f of files) copyFileSync(join(src, f), join(out, dir, f));
}
console.log('ffmpeg cores copied to public/ffmpeg/{st,mt}');
