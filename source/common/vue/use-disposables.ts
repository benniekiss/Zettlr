import { onScopeDispose } from 'vue'

/** Collect destructors for resources registered after component or store setup. */
export function useDisposables (): (destructor: () => void) => () => void {
  const destructors = new Set<() => void>()
  let disposed = false

  onScopeDispose(() => {
    disposed = true
    for (const destructor of destructors) {
      destructor()
    }
    destructors.clear()
  })

  return destructor => {
    let active = true
    const dispose = (): void => {
      if (!active) {
        return
      }
      active = false
      destructors.delete(dispose)
      try {
        destructor()
      } catch (err: unknown) {
        // One failed destructor must not prevent the remaining resources
        // from being released, including those registered after disposal.
        console.error('Could not dispose resource', err)
      }
    }
    if (disposed) {
      dispose()
    } else {
      destructors.add(dispose)
    }
    return dispose
  }
}
