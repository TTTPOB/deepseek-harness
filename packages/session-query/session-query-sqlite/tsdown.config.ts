import { defineConfig } from 'tsdown'

/** Keep the worker entry adjacent to the published plugin entry. */
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [] : [
  {
    entry: { index: 'lib/types/index.js' },
    outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
  },
  {
    entry: { 'search-worker': 'lib/types/worker.js' },
    outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
  },
])
