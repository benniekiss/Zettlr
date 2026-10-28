import { utilityProcess } from 'electron'
import { fork, type ChildProcess } from 'child_process'

/** Run one WASM job in a process whose native resources can always be reclaimed. */
export function runIsolatedTask<T> (entry: string, payload: unknown, { name, timeoutMs }: { name: string, timeoutMs: number }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = utilityProcess !== undefined
      ? utilityProcess.fork(entry, [], { stdio: 'ignore', serviceName: name })
      : fork(entry, [], { execArgv: [], stdio: [ 'ignore', 'ignore', 'ignore', 'ipc' ] })
    const events: NodeJS.EventEmitter = child
    let result: T|undefined
    let failure: Error|undefined
    let finished = false
    const send = (message: unknown) => {
      try {
        if ('postMessage' in child) {
          child.postMessage(message)
        } else {
          child.send(message as Parameters<ChildProcess['send']>[0], error => {
            if (error !== null) {
              failure ??= error
              child.kill()
            }
          })
        }
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error))
        child.kill()
      }
    }
    const finish = (code: number|null) => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timeout)
      if (failure !== undefined) {
        reject(failure)
      } else if (result === undefined || code !== 0) {
        reject(new Error(`${name} process exited without a result (code ${code}).`))
      } else {
        resolve(result)
      }
    }
    const timeout = setTimeout(() => {
      failure = new Error(`${name} timed out.`)
      child.kill()
    }, timeoutMs)
    events.on('message', (message: T) => {
      result = message
      send({ acknowledgement: true })
    })
    events.on('error', (error: Error|string) => {
      failure ??= error instanceof Error ? error : new Error(error)
      child.kill()
      // Failed Node spawns emit error/close but do not emit exit.
      if (child.pid === undefined) {
        finish(null)
      }
    })
    events.on('exit', finish)
    events.once('spawn', () => {
      if (failure !== undefined) {
        child.kill()
      } else {
        send(payload)
      }
    })
  })
}
