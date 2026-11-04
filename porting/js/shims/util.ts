/**
 * `node:util` 替身。上游当前没有直接使用（`grep` 结果为空），但 `@any-listen/common`
 * 的深依赖里可能有，保留最小可用集，避免运行期才炸。
 */

export function inspect(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function format(fmt: string, ...args: unknown[]): string {
  let index = 0
  const replaced = fmt.replace(/%[sdifjoO%]/g, (token) => {
    if (token === '%%') return '%'
    const value = args[index++]
    return typeof value === 'string' ? value : inspect(value)
  })
  const rest = args.slice(index)
  return rest.length ? `${replaced} ${rest.map(inspect).join(' ')}` : replaced
}

export function promisify<T extends (...args: never[]) => unknown>(fn: T): (...args: unknown[]) => Promise<unknown> {
  return (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      ;(fn as unknown as (...a: unknown[]) => void)(...args, (err: unknown, result: unknown) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)))
        else resolve(result)
      })
    })
}

export const types = {
  isDate: (v: unknown): v is Date => v instanceof Date,
  isRegExp: (v: unknown): v is RegExp => v instanceof RegExp,
  isNativeError: (v: unknown): v is Error => v instanceof Error,
}

export function inherits(ctor: { prototype: object }, superCtor: { prototype: object }): void {
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype)
}

export default { inspect, format, promisify, types, inherits }
