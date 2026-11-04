/**
 * Buffer 的浏览器实现。
 *
 * 上游 `@shared/app` 与 `@shared/nodejs` 共 49 处 `Buffer.*` 调用，WebView 里没有这个全局。
 * 全局注入统一由 `shims/globals.ts` 完成（那里走 `globalThis` 赋值 + 宽类型别名，
 * 不用 `declare global`，避免与 `@types/node` 已有的 `var Buffer` 声明冲突）。
 */
import { Buffer } from 'buffer'

export { Buffer }

export default Buffer
