import assert from 'assert'
import { downloadPandocHttp } from '../source/app/util/pandoc-download-http'

describe('Pandoc HTTP transport', function () {
  const originalFetch = globalThis.fetch
  afterEach(function () { globalThis.fetch = originalFetch })

  function respond (handler: (request: Request) => Response|Promise<Response>) {
    globalThis.fetch = async (input, init) => await handler(input instanceof Request ? input : new Request(input, init))
  }

  it('streams the response', async function () {
    respond(request => {
      assert.strictEqual(request.method, 'GET')
      assert.strictEqual(request.redirect, 'manual')
      return new Response(new ReadableStream({
        start (controller) {
          controller.enqueue(Buffer.from('first'))
          controller.enqueue(Buffer.from('second'))
          controller.close()
        }
      }))
    })
    const result = await downloadPandocHttp(new URL('https://example.org/pandoc.wasm'))
    assert.strictEqual(result.toString(), 'firstsecond')
  })

  it('follows relative HTTPS redirects and cancels their unused bodies', async function () {
    const urls: string[] = []
    let cancelled = false
    respond(request => {
      urls.push(request.url)
      if (urls.length === 1) {
        return new Response(new ReadableStream({ cancel () { cancelled = true } }), {
          status: 302, headers: { location: '/release/pandoc.wasm' }
        })
      }
      return new Response('module')
    })
    await downloadPandocHttp(new URL('https://example.org/latest'))
    assert.deepStrictEqual(urls, ['https://example.org/latest', 'https://example.org/release/pandoc.wasm'])
    assert.strictEqual(cancelled, true)
  })

  it('rejects insecure redirect targets before sending another request', async function () {
    let requests = 0
    respond(() => {
      requests++
      return new Response(null, { status: 302, headers: { location: 'http://example.org/pandoc.wasm' } })
    })
    await assert.rejects(downloadPandocHttp(new URL('https://example.org/latest')), /non-HTTPS/)
    assert.strictEqual(requests, 1)
  })

  it('bounds redirect loops and reports missing destinations', async function () {
    let requests = 0
    respond(() => {
      requests++
      return new Response(null, { status: 302, headers: { location: '/latest' } })
    })
    await assert.rejects(downloadPandocHttp(new URL('https://example.org/latest')), /too many redirects/)
    assert.strictEqual(requests, 11)
    respond(() => new Response(null, { status: 302 }))
    await assert.rejects(downloadPandocHttp(new URL('https://example.org/latest')), /no destination/)
  })

  it('preserves URL Basic authentication on the same origin and strips it across origins', async function () {
    const seen: Array<string|null> = []
    respond(request => {
      assert.ok(!request.url.includes('secret'))
      seen.push(request.headers.get('authorization'))
      if (seen.length === 1) return new Response(null, { status: 302, headers: { location: '/asset' } })
      if (seen.length === 2) return new Response(null, { status: 302, headers: { location: 'https://cdn.example.org/asset' } })
      return new Response('module')
    })
    await downloadPandocHttp(new URL('https://user:secret@example.org/latest'))
    const expected = `Basic ${Buffer.from('user:secret').toString('base64')}`
    assert.deepStrictEqual(seen, [expected, expected, null])
  })

  it('cancels oversized bodies, including when Content-Length understates the data', async function () {
    for (const length of ['6', '1']) {
      let cancelled = false
      respond(() => new Response(new ReadableStream({
        start (controller) { controller.enqueue(Buffer.from('123456')) },
        cancel () { cancelled = true }
      }), { headers: { 'content-length': length } }))
      await assert.rejects(downloadPandocHttp(new URL('https://example.org/module'), { maximumBytes: 5 }), /safety limit/)
      assert.strictEqual(cancelled, true)
    }
  })

  it('applies the deadline to stalled response bodies after headers arrive', async function () {
    let signal: AbortSignal|undefined
    respond(request => {
      signal = request.signal
      return new Response(new ReadableStream({
        start (controller) {
          request.signal.addEventListener('abort', () => controller.error(new Error('Body aborted')), { once: true })
        }
      }))
    })
    await assert.rejects(downloadPandocHttp(new URL('https://example.org/module'), { timeoutMs: 30 }), /download timed out/)
    assert.strictEqual(signal?.aborted, true)
  })

  it('retries a transient GET failure once', async function () {
    let requests = 0
    respond(() => {
      requests++
      return new Response(requests === 1 ? 'Temporary failure' : 'module', { status: requests === 1 ? 503 : 200 })
    })
    assert.strictEqual((await downloadPandocHttp(new URL('https://example.org/module'))).toString(), 'module')
    assert.strictEqual(requests, 2)

  })

  it('reports HTTP download errors instead of treating an error page as a module', async function () {
    respond(() => new Response('Missing', { status: 404 }))
    await assert.rejects(downloadPandocHttp(new URL('https://example.org/module')), /404/)
  })
})
