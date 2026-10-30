import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'

describe('LSP process provider', () => {
  it('launches configured processes, handles configuration, enforces ownership, and stops on window destruction', async function () {
    this.timeout(15000)
    await promisify(execFile)(process.execPath, [ '--import=tsx', path.join(__dirname, 'fixtures/lsp-provider-smoke.cjs') ])
  })
})
