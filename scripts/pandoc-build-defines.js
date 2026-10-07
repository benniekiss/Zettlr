// Shared by the main and renderer builds so preferences and downloads agree.
function getPandocBuildDefines (env = process.env) {
  const url = env.PANDOC_WASM_URL?.trim() ?? ''
  const sha256 = env.PANDOC_WASM_SHA256?.trim().toLowerCase() ?? ''
  if (url !== '' && url !== 'none' && ![ 'https:', 'file:' ].includes(new URL(url).protocol)) {
    throw new Error('PANDOC_WASM_URL must use HTTPS or file.')
  }
  if (env.PANDOC_WASM_SHA256 !== undefined && sha256 !== 'none' && !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('PANDOC_WASM_SHA256 must contain exactly 64 hexadecimal characters.')
  }
  return {
    __PANDOC_WASM_URL__: JSON.stringify(url),
    __PANDOC_WASM_SHA256__: JSON.stringify(sha256)
  }
}

module.exports = { getPandocBuildDefines }
