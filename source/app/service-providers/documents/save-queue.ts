/** Coalesce requests for a file while ensuring its latest requested version is saved. */
export default class SaveQueue {
  private readonly pending = new Map<string, { version: number, promise: Promise<boolean> }>()

  save (filePath: string, version: number, write: () => Promise<boolean>): Promise<boolean> {
    const existing = this.pending.get(filePath)
    if (existing !== undefined) {
      existing.version = version
      return existing.promise
    }
    const task = { version, promise: Promise.resolve(false) }
    task.promise = Promise.resolve().then(async () => {
      let result: boolean
      let savedVersion: number
      do {
        savedVersion = task.version
        result = await write()
      } while (result && savedVersion !== task.version)
      return result
    }).finally(() => { this.pending.delete(filePath) })
    this.pending.set(filePath, task)
    return task.promise
  }
}
