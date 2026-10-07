// The default can be replaced in Preferences → Import/Export.
const BUILTIN_PANDOC_WASM_URL = 'https://github.com/jgm/pandoc/releases/download/3.12/pandoc-3.12.wasm.zip'
// Hash of pandoc.wasm inside the official release archive.
const BUILTIN_PANDOC_WASM_SHA256 = '1c69902d11b31711d510f2e317263fb4a5954601117b41038121ea2979110bf8'

// Webpack replaces these constants at build time. Unbundled tools and tests use
// the checked-in defaults, independently of their runtime environment.
const buildUrl = typeof __PANDOC_WASM_URL__ !== 'undefined' ? __PANDOC_WASM_URL__ : ''
const buildSha256 = typeof __PANDOC_WASM_SHA256__ !== 'undefined' ? __PANDOC_WASM_SHA256__ : ''
export const DEFAULT_PANDOC_WASM_URL = buildUrl === 'none' ? '' : buildUrl || BUILTIN_PANDOC_WASM_URL
export const DEFAULT_PANDOC_WASM_SHA256 = buildSha256 === 'none' || DEFAULT_PANDOC_WASM_URL === ''
  ? '' : buildSha256 || BUILTIN_PANDOC_WASM_SHA256
