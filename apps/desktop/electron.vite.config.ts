import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

/** The workspace core, by path. */
export const CORE = resolve(__dirname, '../../packages/core/src/index.ts')

export default defineConfig({
  main: {
    // Always this repo's own core, never whatever node_modules/@agent/core happens to link to: 0.2.91 was
    // packaged in a copy whose link pointed at an older copy, and shipped that copy's settings defaults.
    resolve: { alias: { '@agent/core': CORE } },
    // The workspace package ships TypeScript source, so bundle it into the main process rather
    // than leaving a require('@agent/core') that Node cannot load at runtime.
    build: {
      // Cordis (mini-apps' host side, main/miniapps/plugin-host.ts) is ESM only: bundled, like the core.
      externalizeDeps: { exclude: ['@agent/core', '@deepseek-ai/cordis', '@deepseek-ai/cosmokit', '@standard-schema/spec'] },
      outDir: 'out/main',
      sourcemap: false,
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.js' },
      },
    },
  },
  preload: {
    resolve: { alias: { '@agent/core': CORE } },
    build: {
      outDir: 'out/preload',
      sourcemap: false,
      rollupOptions: {
        // index: the window's. miniapp-check: the mini-app look check's offscreen pages (main/miniapps/check.ts).
        input: { index: resolve(__dirname, 'src/preload/index.ts'), 'miniapp-check': resolve(__dirname, 'src/preload/miniapp-check.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
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
      // Electron reads the bundle from disk with no gzip: the smaller the file, the sooner the window is up.
      minify: 'esbuild',
      cssMinify: true,
      target: 'chrome130',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
})
