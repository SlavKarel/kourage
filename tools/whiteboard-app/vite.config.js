import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 8 * 1024 * 1024,
    rollupOptions: {
      output: {
        codeSplitting: false,
        entryFileNames: 'assets/whiteboard-app.js',
        chunkFileNames: 'assets/whiteboard-[name].js',
        assetFileNames: asset => asset.name?.endsWith('.css') ? 'assets/whiteboard-app.css' : 'assets/whiteboard-[name][extname]'
      }
    }
  }
})
