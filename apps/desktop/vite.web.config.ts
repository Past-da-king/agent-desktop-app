import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@agent/core': resolve(__dirname, '../../packages/core/src/browser.ts') },
  },
  build: { minify: 'esbuild', cssMinify: true, target: 'chrome130' },
  server: {
    port: 5173,
    strictPort: true,
  },
})
