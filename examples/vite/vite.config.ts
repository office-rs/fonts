// Vite config for the rword-fonts example (spec 6.7.1): the plugin emits the
// selected families' slice assets at build time and serves them from
// node_modules in dev, so the example never touches the CDN.
import { defineConfig } from 'vite';
import rwordFonts from '@office-rs/font-runtime/vite';

export default defineConfig({
  plugins: [rwordFonts({ families: ['notosans', 'notosanscjksc'] })],
  // font-runtime's FontWorker lazily dynamic-imports the woff2 decoder, which
  // splits the worker bundle — vite's default 'iife' worker format cannot
  // code-split, so bundle workers as ES modules.
  worker: { format: 'es' },
  // main.ts uses top-level await; the default build target (firefox78) predates it.
  build: { target: 'es2022' },
});
