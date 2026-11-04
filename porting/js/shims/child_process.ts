/**
 * `node:child_process` 替身。
 *
 * 上游唯一使用者是 `@any-listen/nodejs/logs.ts`（`exec` 读日志尾部），而该文件已被
 * `nodejs/logs.ts` 覆写为走 `LogPort`，因此这里的 `exec` 正常情况下不会被调用。
 * 保留可诊断的抛错而不是静默 no-op：真的被调到说明有漏网的桌面路径。
 */

import { PortError } from '@porting/ports/types'

export interface ExecError extends Error {
  code?: number | string
  killed?: boolean
}

export function exec(command: string, callback: (err: ExecError | null, stdout: string, stderr: string) => void): void {
  callback(
    new PortError('EUNSUPPORTED', `child_process.exec("${command}") 在 WebView 中不可用，日志读取请走 LogPort`),
    '',
    '',
  )
}

export function execSync(command: string): never {
  throw new PortError('EUNSUPPORTED', `child_process.execSync("${command}") 在 WebView 中不可用`)
}

export function spawn(): never {
  throw new PortError('EUNSUPPORTED', 'child_process.spawn 在 WebView 中不可用')
}

export default { exec, execSync, spawn }
