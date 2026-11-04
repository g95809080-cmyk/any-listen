/**
 * `@any-listen/nodejs/download` 的 Android 实现 → `HttpPort.downloadTo`。
 *
 * 上游 `Downloader` 是「node:http 流 + 断点续传 + 写入队列」的 220 行实现，
 * 在 WebView 里没有等价物也不该重写一遍：Kotlin 侧 OkHttp 原生下载天然支持
 * Range 续传、进度回调与代理注入。
 *
 * 保留的对外面：`createDownload`（返回可 `stop()` 的句柄）、`simpleDownload`（Promise 版）、
 * `Downloader` 类的同名方法（`start/stop/updateSaveInfo/refreshUrl`），
 * 上游只用到 `simpleDownload`（`extensionService/shared/index.ts:183`、`web-server/src/envPrepare.ts:31`）。
 */

import { EventEmitter } from '@porting/shims/events'
import path from '@porting/shims/path'
import { ports, PortError } from '@porting/ports'

export interface DownloaderRequestOptions {
  method?: string
  headers?: Record<string, string>
  timeout?: number
}

export interface DownloaderOptions {
  forceResume: boolean
  timeout: number
  requestOptions: DownloaderRequestOptions
}

export interface Options {
  url: string
  path: string
  method?: DownloaderRequestOptions['method']
  headers?: DownloaderRequestOptions['headers']
  forceResume?: boolean
  proxy?: { host: string; port: number }
  onCompleted?: () => void
  onError?: (error: Error) => void
  onFail?: (response: { statusMessage: string }) => void
  onStart?: () => void
  onStop?: () => void
  onProgress?: (progress: {
    progress: number
    speed: string
    downloaded: number
    total: number
    writeQueue: number
  }) => void
}

const STATUS = {
  idle: 'IDLE',
  init: 'INIT',
  running: 'RUNNING',
  paused: 'PAUSED',
  stopped: 'STOPPED',
  completed: 'COMPLETED',
  error: 'ERROR',
  failed: 'FAILED',
} as const

export const DOWNLOAD_STATUS = STATUS

export class Downloader extends EventEmitter {
  status: (typeof STATUS)[keyof typeof STATUS] = STATUS.idle
  private savePath: string
  private downloadUrl: string
  private cancelToken = ''

  constructor(
    url: string,
    savePath: string,
    private readonly options: DownloaderOptions
  ) {
    super()
    this.downloadUrl = url
    this.savePath = savePath
  }

  async start(): Promise<void> {
    this.status = STATUS.running
    this.emit('start')
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.cancelToken = token
    try {
      const result = await ports.http.downloadTo(this.downloadUrl, this.savePath, {
        headers: {
          'User-Agent': this.options.requestOptions.headers?.['User-Agent'] ?? 'any-listen-android',
          ...this.options.requestOptions.headers,
        },
        timeoutMs: this.options.timeout,
        onProgress: (p) => {
          this.emit('progress', {
            total: p.total,
            downloaded: p.downloaded,
            progress: p.total ? (p.downloaded / p.total) * 100 : -1,
            speed: p.speed,
            writeQueue: 0,
          })
        },
      })
      this.status = STATUS.completed
      this.emit('completed', result)
    } catch (err) {
      const error = err instanceof Error ? err : new PortError('EUNKNOWN', String(err))
      if ((this.status as string) === STATUS.stopped) {
        this.emit('stop')
        return
      }
      this.status = STATUS.error
      for (const listener of ['error']) this.emit(listener, error)
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.status === STATUS.stopped || this.status === STATUS.completed) return
    this.status = STATUS.stopped
    if (this.cancelToken) await ports.http.cancel(this.cancelToken).catch(() => undefined)
    this.emit('stop')
  }

  refreshUrl(url: string): void {
    this.downloadUrl = url
  }

  updateSaveInfo(filePath: string, fileName: string): void {
    this.savePath = path.join(filePath, fileName)
  }
}

const noop = (): void => {
  /* 默认回调 */
}

export const createDownload = ({
  url,
  path: savePath,
  headers,
  proxy,
  onCompleted = noop,
  onError = noop,
  onStart = noop,
  onStop = noop,
  onProgress = noop,
}: Options): Downloader => {
  const downloader = new Downloader(url, savePath, {
    forceResume: true,
    timeout: 60_000,
    requestOptions: {
      method: 'get',
      headers: { ...headers },
    },
  })
  downloader.on('completed', () => {
    onCompleted()
  })
  downloader.on('error', (err) => {
    onError(err as Error)
  })
  downloader.on('start', () => {
    onStart()
  })
  downloader.on('stop', () => {
    onStop()
  })
  downloader.on('progress', (stats) => {
    const typed = stats as { progress: number; speed: number; downloaded: number; total: number }
    onProgress({
      progress: Math.trunc(typed.progress),
      speed: `${Math.trunc(typed.speed / 1024)}KB/s`,
      downloaded: typed.downloaded,
      total: typed.total,
      writeQueue: 0,
    })
  })
  if (proxy) {
    void ports.http.setProxy({ host: proxy.host, port: String(proxy.port) })
  }
  void downloader.start().catch((err: unknown) => {
    onError(err instanceof Error ? err : new Error(String(err)))
  })
  return downloader
}

export interface SimpleDownloadOptions {
  proxy?: { host: string; port: number }
  onProgress?: Options['onProgress']
  headers?: Options['headers']
}

export const simpleDownload = async (
  url: string,
  savePath: string,
  options: Partial<SimpleDownloadOptions> = {}
): Promise<void> => {
  const previousProxy = options.proxy ? { host: options.proxy.host, port: String(options.proxy.port) } : null
  if (previousProxy) await ports.http.setProxy(previousProxy)
  try {
    await ports.http.downloadTo(url, savePath, {
      headers: options.headers,
      timeoutMs: 0,
      onProgress: (p) => {
        options.onProgress?.({
          progress: p.total ? Math.trunc((p.downloaded / p.total) * 100) : 0,
          speed: `${Math.trunc(p.speed / 1024)}KB/s`,
          downloaded: p.downloaded,
          total: p.total,
          writeQueue: 0,
        })
      },
    })
  } finally {
    if (previousProxy) await ports.http.setProxy(null)
  }
}

export type DownloaderType = Downloader

export default { createDownload, simpleDownload, Downloader, DOWNLOAD_STATUS }
