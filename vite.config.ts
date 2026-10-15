import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Cross-origin isolation enables SharedArrayBuffer → multi-threaded ffmpeg.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
  plugins: [
    react(),
    VitePWA({
      // The page asks before switching to a new version, so a running conversion isn't interrupted.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Convert Any — конвертер файлов',
        short_name: 'Convert Any',
        description: 'Конвертация изображений, видео и документов прямо на устройстве, без загрузки на сервер.',
        lang: 'ru',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f1117',
        theme_color: '#6d5efc',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The whole app (incl. lazily loaded document libraries) is precached for offline use…
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,webmanifest}'],
        // …except the ~31 MB ffmpeg cores: those are cached on first use (or via "Скачать для офлайна").
        globIgnores: ['ffmpeg/**'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/ffmpeg/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'ffmpeg-core',
              expiration: { maxEntries: 10 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    // pdf.js, pdfmake and SheetJS are big but loaded lazily, only for documents.
    chunkSizeWarningLimit: 1500,
  },
  worker: {
    format: 'es',
  },
});
