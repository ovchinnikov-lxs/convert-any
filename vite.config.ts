import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Изоляция страницы (COOP/COEP) включает SharedArrayBuffer → многопоточный ffmpeg.
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
      // Страница спрашивает перед переходом на новую версию — чтобы не прервать конвертацию.
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
        // Всё приложение (включая лениво загружаемые библиотеки документов) кэшируется для офлайна…
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,webmanifest}'],
        // …кроме ядер ffmpeg (~31 МБ): они кэшируются при первом использовании или по кнопке «Скачать для офлайна».
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
    // pdf.js, pdfmake и SheetJS большие, но грузятся лениво — только для документов.
    chunkSizeWarningLimit: 1500,
  },
  worker: {
    format: 'es',
  },
});
