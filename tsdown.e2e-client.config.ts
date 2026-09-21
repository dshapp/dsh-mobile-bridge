import { defineConfig } from 'tsdown'

/** Bundle the client driver, which reaches into the mini-program's sources. */
export default defineConfig({
  entry: ['test/e2e-client.ts'],
  outDir: 'test/dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^node:/, /^ws$/],
  },
})
