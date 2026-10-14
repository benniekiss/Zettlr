import ky from 'ky'

export const MAX_PANDOC_DOWNLOAD_BYTES = 512 * 1024 * 1024

export interface SourceMetadata {
  etag?: string
  lastModified?: string
}

function metadata (headers: Headers): SourceMetadata {
  const etag = headers.get('etag')?.trim()
  const lastModified = headers.get('last-modified')?.trim()
  return { etag: etag === '' ? undefined : etag, lastModified: lastModified === '' ? undefined : lastModified }
}

/** Fetch redirects manually so an HTTPS source cannot downgrade to HTTP. */
async function request (source: URL, method: 'GET'|'HEAD', signal: AbortSignal): Promise<Response> {
  let url = new URL(source)
  let authorization: string|undefined
  for (let redirects = 0; ; redirects++) {
    if (url.protocol !== 'https:') {
      throw new Error('The Pandoc download cannot redirect to a non-HTTPS URL.')
    }
    // Fetch rejects credential-bearing URLs; retain native download support
    // for Basic authentication without forwarding it to another origin.
    if (url.username !== '' || url.password !== '') {
      authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`
      url.username = ''
      url.password = ''
    }
    const response = await ky(url, {
      method,
      redirect: 'manual',
      signal,
      timeout: false, // The caller's deadline also covers redirects and body reads.
      retry: { limit: method === 'HEAD' ? 0 : 1 },
      throwHttpErrors: method === 'HEAD' ? false : status => status >= 400,
      headers: authorization === undefined ? undefined : { authorization }
    })
    if (![ 301, 302, 303, 307, 308 ].includes(response.status)) {
      return response
    }
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (location === null) {
      throw new Error('The Pandoc download redirect has no destination.')
    }
    if (redirects === 10) {
      throw new Error('The Pandoc download has too many redirects.')
    }
    const next = new URL(location, url)
    if (next.origin !== url.origin) {
      authorization = undefined
    }
    url = next
  }
}

export async function inspectPandocHttp (url: URL, timeoutMs = 10000): Promise<SourceMetadata> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response|undefined
  try {
    response = await request(url, 'HEAD', controller.signal)
    if ([ 405, 501 ].includes(response.status)) {
      return {}
    }
    if (response.status !== 200) {
      throw new Error(`The Pandoc update check failed (HTTP ${response.status}).`)
    }
    return metadata(response.headers)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('The Pandoc update check timed out.')
    }
    throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
    await response?.body?.cancel().catch(() => {})
  }
}

export async function downloadPandocHttp (
  url: URL,
  { maximumBytes = MAX_PANDOC_DOWNLOAD_BYTES, timeoutMs = 60000 }: { maximumBytes?: number, timeoutMs?: number } = {}
): Promise<SourceMetadata & { bytes: Buffer }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response|undefined
  let reader: ReadableStreamDefaultReader<Uint8Array>|undefined
  const oversized = () => new Error('The Pandoc download is larger than the 512 MiB safety limit.')
  try {
    response = await request(url, 'GET', controller.signal)
    if (!response.ok) {
      throw new Error(`The Pandoc download failed (HTTP ${response.status}).`)
    }
    if (Number(response.headers.get('content-length')) > maximumBytes) {
      throw oversized()
    }
    if (response.body === null) {
      throw new Error('The Pandoc download response has no body.')
    }
    reader = response.body.getReader()
    const chunks: Buffer[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > maximumBytes) {
        throw oversized()
      }
      chunks.push(Buffer.from(value))
    }
    return { ...metadata(response.headers), bytes: Buffer.concat(chunks, size) }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('The Pandoc download timed out.')
    }
    throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (reader !== undefined) {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    } else {
      await response?.body?.cancel().catch(() => {})
    }
  }
}
