/**
 * `node:fs` 替身。
 *
 * 上游 `@shared/app` 对 `node:fs` 的使用**全部**走 `fs.promises.*`（Phase 2 §1.2 实测：
 * `grep -rn "Sync("` 仅命中业务函数名 `runSync`）。因此这里只提供异步实现，
 * 任何同步 API 一律抛 `EUNSUPPORTED`——**不静默返回假数据**，避免"看起来能跑其实没生效"。
 */

import { PortError } from '@porting/ports'
import { Buffer } from '@porting/shims/buffer'
import { EventEmitter } from '@porting/shims/events'
import * as fsp from '@porting/shims/fs-promises'

export * from '@porting/shims/fs-promises'
export { fsp as promises }

function notSupported(name: string): never {
  throw new PortError(
    'EUNSUPPORTED',
    `fs.${name} is not available on Android: synchronous IO is forbidden in the porting layer, use fs.promises instead`
  )
}

export const existsSync = (): boolean => notSupported('existsSync')
export const readFileSync = (): never => notSupported('readFileSync')
export const writeFileSync = (): never => notSupported('writeFileSync')
export const appendFileSync = (): never => notSupported('appendFileSync')
export const mkdirSync = (): never => notSupported('mkdirSync')
export const renameSync = (): never => notSupported('renameSync')
export const rmSync = (): never => notSupported('rmSync')
export const unlinkSync = (): never => notSupported('unlinkSync')
export const readdirSync = (): never => notSupported('readdirSync')
export const statSync = (): never => notSupported('statSync')
export const createWriteStream = (): never => notSupported('createWriteStream')
export const open = (): never => notSupported('open')

/**
 * `fs.createReadStream` 的最小实现。
 *
 * 为什么需要：上游 `dbService/backupTask/storage.ts:33` 用 `createReadStream` 算 sha256，
 * 直接抛 EUNSUPPORTED 会让**每次启动的自动备份静默失败**（真机 2/2 复现，见验收报告 §11 D-29）。
 *
 * 语义取舍：原生侧没有可增量拉取的句柄，这里一次性读取整文件再分片 emit。
 * 对本项目唯一的消费者（算哈希、`start/end` 切片读）行为等价；**不适用于大文件流式转发**，
 * 所以 proxyServer / Downloader 这类用法在 Android 上仍然不该走这里。
 */
export interface ReadStreamOptions {
  start?: number
  end?: number
  encoding?: string
}

export class FsReadStream extends EventEmitter {
  destroyed = false
  readonly path: string
  private readonly options: ReadStreamOptions

  constructor(filePath: string, options: ReadStreamOptions = {}) {
    super()
    this.path = filePath
    this.options = options
    // 异步启动：保证调用方先 on('data'|'error') 再收到事件（上游就是同步挂监听的）
    void Promise.resolve().then(() => this.run())
  }

  private async run(): Promise<void> {
    try {
      const data = await fsp.readFile(this.path)
      if (this.destroyed) return
      const buf = typeof data === 'string' ? Buffer.from(data) : data
      const start = Math.max(0, this.options.start ?? 0)
      const end = Math.min(this.options.end ?? buf.length - 1, buf.length - 1)
      const slice = end >= start ? buf.subarray(start, end + 1) : buf.subarray(0, 0)
      this.emit('data', slice)
      this.emit('end')
      this.emit('close')
    } catch (err) {
      if (!this.destroyed) this.emit('error', err)
    }
  }

  pipe<T extends { write?: (chunk: unknown) => unknown; end?: () => unknown }>(dest: T): T {
    this.on('data', (chunk) => dest.write?.(chunk))
    this.on('end', () => dest.end?.())
    return dest
  }

  destroy(err?: Error): void {
    this.destroyed = true
    if (err) this.emit('error', err)
  }
}

export const createReadStream = (filePath: string, options?: ReadStreamOptions): FsReadStream =>
  new FsReadStream(filePath, options)

export default {
  promises: fsp,
  constants: fsp.constants,
  access: fsp.access,
  stat: fsp.stat,
  lstat: fsp.lstat,
  readdir: fsp.readdir,
  readFile: fsp.readFile,
  writeFile: fsp.writeFile,
  appendFile: fsp.appendFile,
  mkdir: fsp.mkdir,
  rm: fsp.rm,
  unlink: fsp.unlink,
  rename: fsp.rename,
  cp: fsp.cp,
  realpath: fsp.realpath,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  readdirSync,
  statSync,
  createReadStream,
  createWriteStream,
  open,
}
