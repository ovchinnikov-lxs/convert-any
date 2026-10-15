import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
