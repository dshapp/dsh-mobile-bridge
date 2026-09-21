import { defineConfig } from 'tsdown'

/**
 * Bundle the end-to-end driver.
 *
 * The bridge's own sources use TypeScript parameter properties, which Node's
 * strip-only loader refuses, so the driver cannot simply import them. This
 * builds it the same way the package itself is built: local sources bundled,
 * harness packages and `ws` left external.
 */
export default defineConfig({
  entry: ['test/e2e-bridge.ts'],
  outDir: 'test/dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^node:/, /^ws$/],
    alwaysBundle: [/^qrcode-generator$/],
    onlyBundle: [/^qrcode-generator$/],
  },
})
