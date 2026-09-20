import { defineConfig } from 'tsdown'

/**
 * Self-contained build for a git/tarball install: transpiles `src/` directly so
 * pnpm's post-install `prepare` script produces `lib/` on a clean checkout.
 * Harness packages stay external — a real dsh installation already ships them.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: true,
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^node:/, /^ws$/],
    // The QR encoder is small, MIT, and only used by the control page, so it
    // rides inside the bundle instead of becoming a runtime dependency of the
    // profile. `ws` is the one thing that must stay external.
    alwaysBundle: [/^qrcode-generator$/],
    // ...and nothing else from node_modules may sneak in.
    onlyBundle: [/^qrcode-generator$/],
  },
})
