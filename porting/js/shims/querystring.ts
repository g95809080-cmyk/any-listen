/** `node:querystring` 替身。上游 `shared/nodejs/request.ts:1` 只用 `stringify`（表单请求体）。 */

export type ParsedUrlQueryInput = Record<string, string | number | boolean | null | undefined>

const SEPARATOR = '&'
const EQ = '='

function escape(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+')
}

export function stringify(
  obj: ParsedUrlQueryInput,
  _sep?: string,
  _eq?: string,
  options?: { encodeURIComponent?: (str: string) => string }
): string {
  const encode = options?.encodeURIComponent ?? escape
  const parts: string[] = []
  for (const key of Object.keys(obj)) {
    const value = obj[key]
    if (value === null || value === undefined) continue
    parts.push(`${encode(key)}${EQ}${encode(String(value))}`)
  }
  return parts.join(SEPARATOR)
}

export function parse(input: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  if (!input) return result
  for (const pair of input.split(SEPARATOR)) {
    if (!pair) continue
    const index = pair.indexOf(EQ)
    const key = decodeURIComponent((index < 0 ? pair : pair.slice(0, index)).replace(/\+/g, ' '))
    const value = index < 0 ? '' : decodeURIComponent(pair.slice(index + 1).replace(/\+/g, ' '))
    const existing = result[key]
    if (existing === undefined) result[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else result[key] = [existing, value]
  }
  return result
}

export default { stringify, parse }
