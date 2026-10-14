import { strictEqual, rejects } from 'assert'
import SaveQueue from 'source/app/service-providers/documents/save-queue'

function deferred<T> (): { promise: Promise<T>, resolve: (value: T) => void, reject: (reason: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('Document save queue', () => {
  it('coalesces repeated requests for the same version into one write', async () => {
    const queue = new SaveQueue()
    const write = deferred<boolean>()
    let calls = 0
    const save = (): Promise<boolean> => queue.save('file.md', 0, async () => { calls++; return await write.promise })
    const first = save()
    await Promise.resolve()
    const others = Array.from({ length: 50 }, save)
    strictEqual(calls, 1)
    strictEqual(others[0], first)
    write.resolve(true)
    strictEqual(await first, true)
    await Promise.all(others)
    strictEqual(calls, 1)
  })

  it('writes the latest requested contents after an in-flight write finishes', async () => {
    const queue = new SaveQueue()
    const firstWrite = deferred<boolean>()
    const secondWrite = deferred<boolean>()
    let calls = 0
    const write = async (): Promise<boolean> => ++calls === 1 ? await firstWrite.promise : await secondWrite.promise
    const first = queue.save('file.md', 0, write)
    await Promise.resolve()
    const latest = queue.save('file.md', 1, write)
    queue.save('file.md', 2, write)
    strictEqual(calls, 1)
    firstWrite.resolve(true)
    await new Promise(resolve => setImmediate(resolve))
    strictEqual(calls, 2)
    secondWrite.resolve(true)
    strictEqual(await latest, true)
    strictEqual(await first, true)
    strictEqual(calls, 2)
  })

  it('allows different files to save independently', async () => {
    const queue = new SaveQueue()
    const write = deferred<boolean>()
    const first = queue.save('first.md', 0, async () => await write.promise)
    strictEqual(await queue.save('second.md', 0, async () => true), true)
    write.resolve(true)
    await first
  })

  it('propagates failures to waiting callers and allows retrying', async () => {
    const queue = new SaveQueue()
    const write = deferred<boolean>()
    const first = queue.save('file.md', 0, async () => await write.promise)
    await Promise.resolve()
    const latest = queue.save('file.md', 1, async () => true)
    const rejected = rejects(first, /disk failure/)
    const alsoRejected = rejects(latest, /disk failure/)
    write.reject(new Error('disk failure'))
    await Promise.all([rejected, alsoRejected])
    strictEqual(await queue.save('file.md', 1, async () => true), true)
  })
})
