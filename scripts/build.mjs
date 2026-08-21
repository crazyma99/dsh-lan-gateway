/**
 * Build script for the standalone dsh-lan-gateway plugin.
 * - Host half: ESM bundle for Node, every @deepseek-ai/* peer external.
 * - Browser half: CJS factory bundle registered through
 *   `window.__ModuleLoader__.load(...)`, with the DSH platform module table
 *   left external (resolved by the loader's injected require) and everything
 *   else inlined.
 * Mirrors the wrapping contract of packages/client/tsdown.client.ts.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_ID = 'dsh-lan-gateway'

// The DSH platform module table (packages/client/web/src/platform.ts) plus the
// documented runtime exemption — externals answered by the loader's require.
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

mkdirSync(resolve(ROOT, 'lib'), { recursive: true })

// ── Host half ────────────────────────────────────────────────────────────────
await build({
  entryPoints: [resolve(ROOT, 'src/index.ts')],
  outfile: resolve(ROOT, 'lib/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  // Peers and node builtins resolve from the composed profile at runtime.
  external: ['@deepseek-ai/*'],
  packages: 'external',
  logLevel: 'info',
})

// ── Browser half ─────────────────────────────────────────────────────────────
await build({
  entryPoints: [resolve(ROOT, 'src/client/index.ts')],
  outfile: resolve(ROOT, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  sourcemap: 'external',
  external: CLIENT_EXTERNALS,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  banner: {
    // esbuild has no `intro` option; the module/exports prelude folds into the
    // banner, which runs before the bundled factory code.
    js: 'var module = { exports: {} }; var exports = module.exports;\n'
      + `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})

console.log(`dsh-lan-gateway: built lib/index.js and lib/client.js`)

// ── Type declarations ────────────────────────────────────────────────────────
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '-p', 'tsconfig.build.json'], {
  cwd: ROOT,
  stdio: 'inherit',
})
console.log('dsh-lan-gateway: emitted lib/types')
