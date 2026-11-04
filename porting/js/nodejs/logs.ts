/**
 * `@any-listen/nodejs/logs` 的 Android 实现 → `LogPort`。
 *
 * 上游实现用 `fs.appendFile` 写日志文件 + `child_process.exec('tail')` 读日志尾部；
 * Android 上 `exec` 不存在，改为：
 * - 写：`LogPort.write`（Kotlin 同时落文件与 logcat，见 §4.8）
 * - 读：`LogPort.readLastLines`
 */

import { ports } from '@porting/ports'

const logcat = {
  path: '',
  log(message: string) {
    // 扩展沙箱的日志统一打 ext tag，便于 logcat 过滤
    ports.log.write('info', 'ext', `${this.path}: ${message}`)
  },
}

export const createSimpleLogcat = async (path: string, name: string): Promise<(message: string) => void> => {
  const instance = Object.create(logcat) as typeof logcat
  await ports.fs.mkdirp(path)
  instance.path = `${path}/${name}`
  return (message: string) => {
    instance.log(message)
  }
}

export const readLastLines = async (filePath: string, lineCount = 100): Promise<string> => {
  try {
    const lines = await ports.log.readLastLines(filePath, lineCount)
    return lines.join('\n')
  } catch (err) {
    // 日志页是只读诊断视图：读不到文件必须降级成空日志，不能让整页抛未捕获异常
    // （原生侧已按「文件不存在返回空列表」实现，这里是桥接层失败时的兜底）
    ports.log.write('warn', 'logs', `readLastLines failed: ${String(err)}`)
    return ''
  }
}

export const openLogFolder = (): Promise<void> => ports.log.openLogFolder()

export default { createSimpleLogcat, readLastLines, openLogFolder }
