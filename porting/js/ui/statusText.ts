import { i18n } from '@ui/plugins/i18n'

import { tm } from './i18n'

const SOURCE_MISSING_PREFIXES = [
  'source not found',
  'get url failed, no source',
]
const SOURCE_NO_SCRIPT_PREFIX = 'no script found to handle this request'
const SOURCE_FAILURE_PREFIXES = ['get url failed', 'get music url failed']
const CLEARTEXT_ERROR_PREFIX = 'cleartext communication'

export const formatPlayerStatus = (text: string): string => {
  const normalized = text.trim()
  const lower = normalized.toLowerCase()
  if (lower === 'find music timeout') return tm('mobile__online_source_timeout')
  if (lower.startsWith(CLEARTEXT_ERROR_PREFIX)) {
    return tm('mobile__online_source_cleartext')
  }
  if (lower.startsWith(SOURCE_NO_SCRIPT_PREFIX)) {
    return tm('mobile__online_source_no_script')
  }
  if (SOURCE_MISSING_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return tm('mobile__online_source_missing')
  }
  if (SOURCE_FAILURE_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return tm('mobile__online_source_unavailable')
  }
  if (normalized === i18n.t('lyric__load_error')) return ''
  return text
}
