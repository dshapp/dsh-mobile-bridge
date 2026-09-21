import { defineConfig } from 'tsdown'

/** Bundle the mini-program client driver. */
export default defineConfig({
  entry: ['test/e2e-miniapp.ts'],
  outDir: 'test/dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { neverBundle: [/^@deepseek-ai\//, /^node:/, /^ws$/] },
})
