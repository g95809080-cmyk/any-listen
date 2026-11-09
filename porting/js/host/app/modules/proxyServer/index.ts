import { createProxy as createUpstreamProxy, proxyServerState } from '@porting-uplink/proxy-server'
import type { Options } from '@any-listen/nodejs/request'
import { ports } from '@porting/ports'

export * from '@porting-uplink/proxy-server'

/** 上游校验并创建虚拟路径后，同步登记 Kotlin 服务使用的目标地址。 */
export async function createProxy(url: string, options: Options = {}, enabledCache?: boolean): Promise<string> {
  const virtualPath = await createUpstreamProxy(url, options, enabledCache)
  const name = virtualPath.slice(virtualPath.lastIndexOf('/') + 1)
  const headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([key, value]) => [
    key, Array.isArray(value) ? value.join(', ') : value,
  ]))
  let targetUrl = url
  if (options.query) {
    const parsed = new URL(url)
    for (const [key, value] of Object.entries(options.query)) {
      if (value != null) parsed.searchParams.append(key, String(value))
    }
    targetUrl = parsed.toString()
  }
  try {
    await ports.http.registerProxyTarget(name, targetUrl, headers, enabledCache === true)
  } catch (error) {
    proxyServerState.proxyMap.delete(name)
    throw error
  }
  return virtualPath
}
