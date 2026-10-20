import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    // The workspace package ships TypeScript source, so bundle it into the main process rather
    // than leaving a require('@agent/core') that Node cannot load at runtime.
    build: {
      externalizeDeps: { exclude: ['@agent/core'] },
      outDir: 'out/main',
      sourcemap: false,
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.js' },
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      sourcemap: false,
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.js' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    base: './',
    plugins: [react()],
    resolve: {
      // The renderer gets the browser-safe contract, never the Node-side runtime behind index.ts.
      alias: { '@agent/core': resolve(__dirname, '../../packages/core/src/browser.ts') },
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
})
