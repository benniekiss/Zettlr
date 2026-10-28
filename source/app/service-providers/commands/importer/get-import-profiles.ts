import type { PandocProfileMetadata } from '@providers/assets'
import { SUPPORTED_READERS } from '@common/pandoc-util/pandoc-maps'
import { parseReaderWriter } from '@common/pandoc-util/parse-reader-writer'

/** Match base formats while preserving the selected profile's extensions. */
export default function getImportProfiles (profiles: PandocProfileMetadata[], availableReaders: string[]): PandocProfileMetadata[] {
  return profiles.filter(profile => !profile.isInvalid &&
    SUPPORTED_READERS.includes(parseReaderWriter(profile.writer).name) &&
    availableReaders.includes(parseReaderWriter(profile.reader).name))
}
