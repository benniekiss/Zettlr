/** Decode the byte-oriented LSP stdio framing, including split UTF-8 messages. */
export class LSPMessageReader {
  private buffer = Buffer.alloc(0)
  private length: number|undefined

  constructor (private readonly receive: (message: string) => void) {}

  push (chunk: Buffer): void {
    this.buffer = Buffer.concat([ this.buffer, chunk ])
    while (true) {
      if (this.length === undefined) {
        const end = this.buffer.indexOf('\r\n\r\n')
        if (end === -1) {
          if (this.buffer.length > 8192) {
            throw new Error('LSP header too large')
          }
          return
        }
        if (end > 8192) {
          throw new Error('LSP header too large')
        }
        const match = /^Content-Length:\s*(\d+)\s*$/im.exec(this.buffer.subarray(0, end).toString('ascii'))
        if (match === null) {
          throw new Error('Missing LSP Content-Length')
        }
        this.length = Number(match[1])
        if (this.length > 32 * 1024 * 1024) {
          throw new Error('LSP message too large')
        }
        this.buffer = this.buffer.subarray(end + 4)
      }
      if (this.buffer.length < this.length) {
        return
      }
      const message = this.buffer.subarray(0, this.length).toString('utf8')
      this.buffer = this.buffer.subarray(this.length)
      this.length = undefined
      this.receive(message)
    }
  }
}

export function frameLSPMessage (message: string): string {
  return `Content-Length: ${Buffer.byteLength(message, 'utf8')}\r\n\r\n${message}`
}
