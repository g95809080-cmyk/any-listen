/**
 * `@/shared/log4js` 的 Android 替身。
 *
 * 上游用 log4js（Node 专属：文件 appender + 轮转）。Android 上日志分两路：
 * - `LogPort.write()` → Kotlin 同时写应用私有目录日志文件与 `android.util.Log`（logcat 可按 tag 过滤）
 * - UI 的「日志」页读文件尾部（`LogPort.readLastLines`）
 *
 * 这里的 logger 对象保持与 log4js 相同的 4 个方法（debug/info/warn/error），
 * 让 `@shared/app` 里所有 `logger.xxx()` 调用零改动。
 */

import { ports } from '@porting/ports'

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

let logFilePath = ''

export function setLogFilePath(path: string): void {
  logFilePath = path
}

export function getLogFilePath(): string {
  return logFilePath
}

function format(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return arg.stack ?? arg.message
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
}

function createLogger(tag: string): Logger {
  return {
    debug(...args) {
      ports.log.write('debug', tag, format(args))
    },
    info(...args) {
      ports.log.write('info', tag, format(args))
    },
    warn(...args) {
      ports.log.write('warn', tag, format(args))
    },
    error(...args) {
      ports.log.write('error', tag, format(args))
    },
  }
}

export const logger = createLogger('app')
export const appLog = createLogger('app')
export const extensionLog = createLogger('extension')
export const workerLog = createLogger('worker')

export const startupLog = (): void => {
  appLog.info('any-listen android bootstrap')
}

export const initLogger = (path: string): void => {
  setLogFilePath(path)
}

export default { logger, appLog, extensionLog, workerLog, initLogger, startupLog }
