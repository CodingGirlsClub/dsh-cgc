import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { defineConfig, type UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/**
 * Bundle layout mirrors the package exports: lib/index.js (host half),
 * lib/client.js (browser half), lib/invariant.js. Every @deepseek-ai/* host
 * package stays unbundled — the host app provides them at runtime and several
 * boundaries (HarnessError instanceof, cordis services) are identity-based.
 * Types are emitted separately by `tsc -p tsconfig.build.json` into lib/types
 * (the lib configs only clean the js bundles, so the two outputs coexist).
 */
const NEVER_BUNDLE = [/^@deepseek-ai\//, 'react', 'react-dom', '@modelcontextprotocol/sdk', 'schemastery']

/** Package id stamped into the __ModuleLoader__ handoff and style tags. */
const CLIENT_ID = 'dsh-cgc-core'

/**
 * Externals resolved from the GUI's frozen loader module table: the platform
 * seed entries (packages/client/web/src/platform.ts) plus the documented
 * runtime-store exemption (dsh-client-runtime/client is answered natively by
 * the lazy CJS table — runtime is an immediately-tier row).
 */
const CLIENT_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
 * (which requires @tsdown/css). The suffix matters: tsdown's guard matches
 * ids ending in `.css`, so the virtual id must not.
 * (Verbatim from packages/client/tsdown.client.ts — the harness preset.)
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** The browser client bundle: a closure-factory artifact the GUI's ModuleLoader executes. */
function clientConfig(): UserConfig {
  return {
    name: `${CLIENT_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    // Browser bundle lands next to the node half (single lib/ artifact dir;
    // the entryFileNames pin keeps it exactly lib/client.js). clean must stay
    // off — a default clean would wipe the node-half output emitted above.
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // Types ship from lib/types (tsc); dts here would wrap the banner/footer
    // into .d.cts and break parsing.
    dts: false,
    // Plugin code is fetched outside Vite's module graph, so its own bundle
    // must carry the TS/TSX mapping consumed by browser profiling tools.
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    // Browser bundles inline node-idiom deps that read process.env.NODE_ENV;
    // a CJS output cannot carry import.meta.env, so both keys are substituted
    // here or the factory throws ReferenceError at boot.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    // Anything NOT in the loader module table must inline (wire/type layers
    // and relative modules); a require() the table cannot answer is a
    // guaranteed runtime throw.
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [{
      // Bundle purity gate (build-time mirror of the module-edge rules):
      // platform seed entries stay external; every other @deepseek-ai value
      // import is a build error — a cross-plugin value import either inlines
      // a duplicate runtime instance or requires a specifier the frozen
      // module table cannot answer. Cross-plugin collaboration goes through
      // cordis services instead. (Type-only imports never reach this gate.)
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) — `
          + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
        )
      },
    }, {
      // CSS Modules compiled by lightningcss inside the bundle: importing
      // `x.module.css` yields the hashed class map, and the css text
      // auto-injects a <style data-plugin="<id>"> tag at factory execution
      // (the loader removes plugin-owned tags on unload).
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        // The virtual id otherwise hides the physical stylesheet from Rolldown's watch graph.
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
        // One <style data-plugin> per module file; idempotent under re-evaluation.
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(`${CLIENT_ID}/${basename(fileId)}`)};`,
          'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
          '  const tag = document.createElement(\'style\');',
          `  tag.dataset.plugin = ${JSON.stringify(CLIENT_ID)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    sourcemap: true,
    dts: false,
    fixedExtension: false,
    clean: ['lib/**/*.js', 'lib/**/*.js.map'],
    deps: { neverBundle: NEVER_BUNDLE },
  },
  clientConfig(),
  {
    entry: { invariant: 'src/invariant.ts' },
    outDir: 'lib',
    format: ['esm'],
    sourcemap: true,
    dts: false,
    fixedExtension: false,
    clean: false,
    deps: { neverBundle: NEVER_BUNDLE },
  },
])
