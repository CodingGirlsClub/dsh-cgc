import { defineConfig } from 'tsdown'

/**
 * Host-only bundle: lib/index.js. Every @deepseek-ai/* host package stays
 * unbundled — the host app provides them at runtime. dsh-cgc-core's
 * materialize helper is inlined from its TS source (the package exports its
 * src tree), so the roles bundle has no runtime dependency edge.
 */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  sourcemap: true,
  dts: false,
  fixedExtension: false,
  clean: ['lib/**/*.js', 'lib/**/*.js.map'],
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
