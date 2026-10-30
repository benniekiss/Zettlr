import assert from 'assert'
import type { PandocProfileMetadata } from '../source/app/service-providers/assets'
import getImportProfiles from '../source/app/service-providers/commands/importer/get-import-profiles'

describe('Import profile selection', function () {
  it('matches formats with extensions and preserves the original profile', function () {
    const profile: PandocProfileMetadata = {
      name: 'Custom import.yaml', reader: 'html+raw_html', writer: 'markdown-smart+pipe_tables',
      outputFile: '', isInvalid: false
    }
    assert.deepStrictEqual(getImportProfiles([profile], ['html']), [profile])
    assert.strictEqual(profile.reader, 'html+raw_html')
    assert.strictEqual(profile.writer, 'markdown-smart+pipe_tables')
  })

  it('excludes invalid profiles, unavailable readers, and unsupported destination formats', function () {
    const profile: PandocProfileMetadata = {
      name: 'Import.yaml', reader: 'docx', writer: 'markdown', outputFile: '', isInvalid: false
    }
    assert.deepStrictEqual(getImportProfiles([
      { ...profile, isInvalid: true },
      { ...profile, reader: 'html' },
      { ...profile, writer: 'html' },
      profile
    ], ['docx']), [profile])
  })
})
