import { DEFAULT_PANDOC_WASM_URL, DEFAULT_PANDOC_WASM_SHA256 } from './pandoc-wasm-url'

export interface PandocModuleSource {
  url: string
  sha256?: string
  bundledPath?: string
}

/** Resolve preferences once for both normal use and manual updates. */
export function resolvePandocModuleSource (
  preferences: { pandocWasmUrl: string, pandocWasmSha256: string },
  bundledPath?: string
): PandocModuleSource {
  const configuredUrl = preferences.pandocWasmUrl.trim()
  const url = configuredUrl || DEFAULT_PANDOC_WASM_URL
  const configuredHash = configuredUrl === '' ? '' : preferences.pandocWasmSha256.trim().toLowerCase()
  const sha256 = configuredHash || (url === DEFAULT_PANDOC_WASM_URL ? DEFAULT_PANDOC_WASM_SHA256 : '') || undefined
  return {
    url,
    sha256,
    bundledPath: url !== '' && url === DEFAULT_PANDOC_WASM_URL && sha256 === (DEFAULT_PANDOC_WASM_SHA256 || undefined)
      ? bundledPath : undefined
  }
}
