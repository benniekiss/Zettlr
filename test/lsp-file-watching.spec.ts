import assert from 'assert'
import { matchesWatcher } from '../source/common/lsp/file-watching'

describe('LSP file-watcher patterns', () => {
  const root = 'file:///workspace'
  it('matches hidden configuration files, braces, and event masks', () => {
    const watcher = { globPattern: '**/{panache,.panache}.toml', kind: 3 }
    assert(matchesWatcher({ uri: root + '/.panache.toml', type: 2 }, watcher, root))
    assert(matchesWatcher({ uri: root + '/nested/panache.toml', type: 1 }, watcher, root))
    assert(!matchesWatcher({ uri: root + '/panache.toml', type: 3 }, watcher, root))
    assert(!matchesWatcher({ uri: 'file:///workspace-other/panache.toml', type: 2 }, watcher, root))
  })

  it('supports relative base URIs, encoded paths, and absolute globs', () => {
    const event = { uri: root + '/my%20project/.config/panache.toml', type: 3 }
    assert(matchesWatcher(event, { globPattern: { baseUri: { uri: root + '/my%20project' }, pattern: '.config/*.toml' } }, root))
    assert(matchesWatcher(event, { globPattern: '/workspace/my project/**/*.toml' }, root))
    assert(!matchesWatcher(event, { globPattern: { baseUri: root + '/another', pattern: '**/*.toml' } }, root))
    assert(matchesWatcher({ uri: 'file:///C:/project/.codebook.toml', type: 2 }, { globPattern: 'C:/project/**/*.toml' }, 'file:///C:/project'))
  })
})
