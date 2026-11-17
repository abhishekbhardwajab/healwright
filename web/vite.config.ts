import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@model': path.resolve(__dirname, '../src/model') } },
  build: { outDir: path.resolve(__dirname, 'dist'), emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    port: 5173,
    fs: { allow: [path.resolve(__dirname, '..')] },
    proxy: {
      '/api': 'http://localhost:3000',
      '/artifacts': 'http://localhost:3000',
      '/fixtures': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
