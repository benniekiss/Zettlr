import defaults from './pandoc-wasm-defaults.json'

// Webpack supplies resolved build settings. Unbundled tools and tests use the
// checked-in defaults, independently of their runtime environment.
export const DEFAULT_PANDOC_WASM_URL = typeof __PANDOC_WASM_URL__ !== 'undefined' ? __PANDOC_WASM_URL__ : defaults.url
export const DEFAULT_PANDOC_WASM_SHA256 = typeof __PANDOC_WASM_SHA256__ !== 'undefined' ? __PANDOC_WASM_SHA256__ : defaults.sha256
