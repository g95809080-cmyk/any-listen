/** `node:timers/promises` 替身。上游 `shared/nodejs/index.ts:228` 用它实现 `sleep`。 */

export function setTimeout<T = void>(delay = 0, value?: T): Promise<T> {
  return new Promise<T>((resolve) => {
    globalThis.setTimeout(() => {
      resolve(value as T)
    }, delay)
  })
}

export function setImmediate<T = void>(value?: T): Promise<T> {
  return new Promise<T>((resolve) => {
    globalThis.setTimeout(() => {
      resolve(value as T)
    }, 0)
  })
}

export default { setTimeout, setImmediate }
