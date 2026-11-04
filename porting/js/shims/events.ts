/** `node:events` 最小替身。上游 `@shared/app` 不直接用，但第三方纯 JS 依赖可能引用。 */

export type Listener = (...args: unknown[]) => void

export class EventEmitter {
  private readonly listeners = new Map<string | symbol, Listener[]>()

  on(event: string | symbol, listener: Listener): this {
    const list = this.listeners.get(event)
    if (list) list.push(listener)
    else this.listeners.set(event, [listener])
    return this
  }

  addListener(event: string | symbol, listener: Listener): this {
    return this.on(event, listener)
  }

  once(event: string | symbol, listener: Listener): this {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper)
      listener(...args)
    }
    return this.on(event, wrapper)
  }

  off(event: string | symbol, listener: Listener): this {
    const list = this.listeners.get(event)
    if (!list) return this
    const index = list.indexOf(listener)
    if (index >= 0) list.splice(index, 1)
    if (!list.length) this.listeners.delete(event)
    return this
  }

  removeListener(event: string | symbol, listener: Listener): this {
    return this.off(event, listener)
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.listeners.clear()
    else this.listeners.delete(event)
    return this
  }

  listenerCount(event: string | symbol): number {
    return this.listeners.get(event)?.length ?? 0
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const list = this.listeners.get(event)
    if (!list || !list.length) return false
    for (const listener of [...list]) {
      try {
        listener(...args)
      } catch (err) {
        console.error(`[events] listener for "${String(event)}" failed`, err)
      }
    }
    return true
  }
}

export default EventEmitter
