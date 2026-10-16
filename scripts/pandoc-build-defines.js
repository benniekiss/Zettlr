const defaults = require('../source/common/pandoc-util/pandoc-wasm-defaults.json')

// Resolve ordinary settings before deriving Webpack's serialized constants.
function getPandocBuildSettings (env = process.env) {
  const url = env.PANDOC_WASM_URL?.trim() ?? ''
  const sha256 = env.PANDOC_WASM_SHA256?.trim().toLowerCase() ?? ''
  if (url !== '' && url !== 'none' && ![ 'https:', 'file:' ].includes(new URL(url).protocol)) {
    throw new Error('PANDOC_WASM_URL must use HTTPS or file.')
  }
  if (env.PANDOC_WASM_SHA256 !== undefined && sha256 !== 'none' && !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('PANDOC_WASM_SHA256 must contain exactly 64 hexadecimal characters.')
  }
  return {
    url: url === 'none' ? '' : url || defaults.url,
    sha256: url === 'none' || sha256 === 'none' ? undefined : sha256 || defaults.sha256
  }
}

function getPandocBuildDefines (env = process.env) {
  const settings = getPandocBuildSettings(env)
  return {
    __PANDOC_WASM_URL__: JSON.stringify(settings.url),
    __PANDOC_WASM_SHA256__: JSON.stringify(settings.sha256 ?? '')
  }
}

module.exports = { getPandocBuildSettings, getPandocBuildDefines }
