/** `node:url` 替身。上游只用 `pathToFileURL`（`shared/nodejs/index.ts:26` 的 `encodePath`）。 */

export const URL = globalThis.URL
export const URLSearchParams = globalThis.URLSearchParams

/**
 * 注意：Android 上不存在 `file://` 可用路径（R-06：`file://` 下 AudioWorklet / createMediaElementSource 均不可用）。
 * 因此这里产出的 URL **只用于「标识」而非「读取」**，真正给 WebView 播放的地址必须走
 * `FileSystemPort.toPlayableUrl()`（`http://127.0.0.1:17930/stream/<sha256>`）。
 */
export function pathToFileURL(path: string): URL {
  const normalized = path.replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return new URL(`file://${encodeURI(withLeadingSlash).replace(/#/g, '%23').replace(/\?/g, '%3F')}`)
}

export function fileURLToPath(url: string | URL): string {
  const href = typeof url === 'string' ? url : url.href
  if (!href.startsWith('file://')) throw new Error(`not a file URL: ${href}`)
  return decodeURI(href.slice('file://'.length))
}

export default { URL, URLSearchParams, pathToFileURL, fileURLToPath }
