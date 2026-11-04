/**
 * `node:module` 替身 —— WebView 里没有 CommonJS 模块系统。
 * 上游只用 `createRequire` 处理少数可选依赖的场景，这里直接抛错，避免"看起来加载成功"。
 */

import { PortError } from '@porting/ports/types'

export function createRequire(): never {
  throw new PortError('EUNSUPPORTED', 'module.createRequire 在 WebView 中不可用')
}

export const builtinModules: string[] = []

export function isBuiltin(): boolean {
  return false
}

export default { createRequire, builtinModules, isBuiltin }
