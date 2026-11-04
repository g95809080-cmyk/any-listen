/**
 * `node:vm` 兼容替身 → QuickJS（WASM）沙箱。
 *
 * 覆盖上游的 3 个调用点（源码零改动）：
 * - `extensionService/vm/index.ts`：`vm.createContext` / `vm.runInContext`
 * - `extensionService/vm/hostContext/index.ts`：`vm.createContext` + `vmContext.__ext_preload__(...)`
 * - `extensionService/vm/hostContext/apis/isolateContext.ts`：多上下文 + `vm.runInContext`
 *
 * 关键设计取舍（详见 docs/phase2-architecture.md §3.2）：
 * 1. **同步**：`createContext` / `runInContext` 必须同步，因此 WASM 模块在 ext-worker 启动时
 *    由 `initVmShim()` 预加载（`getQuickJS()` 是 async）。
 * 2. **超时**：`timeout` 用 `runtime.setInterruptHandler` 实现（QuickJS 无 V8 的任意指令中止能力，
 *    但中断处理器在字节码边界生效，实测可中断死循环）。
 * 3. **值编解码**：跨边界只允许 primitive / Uint8Array（Phase 2 实测 14 个 host 函数全部如此）。
 *    实现用 QuickJS 侧的一小段 base64 编解码器做 marshal，避免依赖 `getArrayBuffer` 的
 *    内部布局（已实测 `dump()` 会把 Uint8Array 摊平成普通对象，不可用）。
 */

import { getQuickJS, getQuickJSSync, type QuickJSRuntime, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten'

import { Buffer } from '@porting/shims/buffer'

export type VmPrimitive = string | number | boolean | null | undefined | Uint8Array

const CONTEXT_TAG = Symbol.for('anylisten.vm.context')

interface Marshal {
  toHost(args: VmPrimitive[]): [string, unknown]
  fromHost(tag: string, payload: unknown): VmPrimitive
}

interface VmContextState {
  runtime: QuickJSRuntime
  context: QuickJSContext
  toHost: QuickJSHandle
  fromHost: QuickJSHandle
  globals: Map<string, QuickJSHandle>
  disposed: boolean
  timeoutDeadline: number
}

export interface VmContext {
  readonly [CONTEXT_TAG]: VmContextState
}

export interface CreateContextOptions {
  codeGeneration?: { strings?: boolean; wasm?: boolean }
}

export interface RunInContextOptions {
  filename?: string
  timeout?: number
}

const MARSHAL_SOURCE = String.raw`
(function () {
  var CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  function encode(u8) {
    var out = ''
    var i = 0
    for (; i + 2 < u8.length; i += 3) {
      var n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2]
      out += CHARS[(n >> 18) & 63] + CHARS[(n >> 12) & 63] + CHARS[(n >> 6) & 63] + CHARS[n & 63]
    }
    if (i < u8.length) {
      var rem = u8.length - i
      var m = (u8[i] << 16) | ((rem > 1 ? u8[i + 1] : 0) << 8)
      out += CHARS[(m >> 18) & 63] + CHARS[(m >> 12) & 63]
      out += rem > 1 ? CHARS[(m >> 6) & 63] : '='
      out += '='
    }
    return out
  }
  function decode(str) {
    var lookup = {}
    for (var c = 0; c < CHARS.length; c++) lookup[CHARS[c]] = c
    var len = str.length
    var pad = 0
    if (len && str.charAt(len - 1) === '=') pad++
    if (len > 1 && str.charAt(len - 2) === '=') pad++
    var bytes = new Uint8Array(((len / 4) | 0) * 3 - pad)
    var p = 0
    for (var i = 0; i < len; i += 4) {
      var n1 = lookup[str.charAt(i)] || 0
      var n2 = lookup[str.charAt(i + 1)] || 0
      var n3 = lookup[str.charAt(i + 2)] || 0
      var n4 = lookup[str.charAt(i + 3)] || 0
      var n = (n1 << 18) | (n2 << 12) | (n3 << 6) | n4
      if (p < bytes.length) bytes[p++] = (n >> 16) & 255
      if (p < bytes.length) bytes[p++] = (n >> 8) & 255
      if (p < bytes.length) bytes[p++] = n & 255
    }
    return bytes
  }
  return {
    toHost: function (v) {
      if (v === undefined) return ['u', null]
      if (v === null) return ['n', null]
      var t = typeof v
      if (t === 'string') return ['s', v]
      if (t === 'number') return ['d', v]
      if (t === 'boolean') return ['b', v]
      if (v instanceof Uint8Array) return ['y', encode(v)]
      try { return ['j', JSON.stringify(v)] } catch (e) { return ['s', String(v)] }
    },
    fromHost: function (tag, payload) {
      switch (tag) {
        case 'u': return undefined
        case 'n': return null
        case 's': return payload
        case 'd': return payload
        case 'b': return payload
        case 'y': return decode(payload)
        default: return payload
      }
    }
  }
})()
`

let moduleReady = false

/**
 * ext-worker 启动时必须先 await 本函数；在此之前的 createContext 会明确抛错。
 *
 * **必须有人调用它。** 这里踩过一次：`initVmShim()` 全仓零调用点时，`getQuickJS()` 成了
 * 不可达代码被 tree-shaking 删掉，连带 `newQuickJSWASMModule(variant = import_…)` 默认参数
 * 引用的 4 个变体模块整片被摇掉 —— 但模块 transform 阶段的 `new URL('emscripten-module.wasm',
 * import.meta.url)` 已经 `emitFile` 出 4 个 wasm 资产，于是产物里出现「9.84 MB 资产在、
 * 引用串一个都没有」的孤儿，真机表现为扩展沙箱起不来。调用点在 `entries/ext.worker.ts`
 * 的暴露前钩子里。
 *
 * 两行日志是给真机取证用的：卡在 wasm 请求时只会看到「开始加载」而没有「ready」，
 * 与「加载完但后面别的地方炸」能一眼区分开。
 */
export async function initVmShim(): Promise<void> {
  if (moduleReady) return
  console.log('[shims/vm] 开始加载 quickjs wasm…')
  await getQuickJS()
  moduleReady = true
  console.log('[shims/vm] quickjs ready')
}

function stateOf(context: VmContext): VmContextState {
  const state = (context as unknown as Record<symbol, VmContextState | undefined>)[CONTEXT_TAG]
  if (!state) throw new Error('vm: invalid context object')
  if (state.disposed) throw new Error('vm: context has been disposed')
  return state
}

function jsToHandle(ctx: QuickJSContext, value: VmPrimitive): QuickJSHandle {
  if (value === undefined) return ctx.undefined
  if (value === null) return ctx.null
  if (typeof value === 'string') return ctx.newString(value)
  if (typeof value === 'number') return ctx.newNumber(value)
  if (typeof value === 'boolean') return value ? ctx.true : ctx.false
  const copy = new Uint8Array(value.length)
  copy.set(value)
  return ctx.newArrayBuffer(copy.buffer)
}

function handleToJs(state: VmContextState, handle: QuickJSHandle): VmPrimitive {
  const { context } = state
  const result = context.callFunction(state.toHost, context.undefined, [handle])
  if (!('value' in result)) {
    const err = result.error
    const message = context.dump(err)
    err.dispose()
    throw new Error(`vm: marshal failed: ${JSON.stringify(message)}`)
  }
  const dumped = context.dump(result.value) as [string, unknown]
  result.value.dispose()
  const [tag, payload] = dumped
  switch (tag) {
    case 'u':
      return undefined
    case 'n':
      return null
    case 's':
    case 'd':
    case 'b':
      return payload as VmPrimitive
    case 'y':
      return Buffer.from(String(payload), 'base64')
    case 'j':
      return payload as VmPrimitive
    default:
      return undefined
  }
}

function primitiveToSandbox(state: VmContextState, value: VmPrimitive): QuickJSHandle {
  const { context } = state
  const tag =
    value === undefined
      ? 'u'
      : value === null
        ? 'n'
        : typeof value === 'string'
          ? 's'
          : typeof value === 'number'
            ? 'd'
            : typeof value === 'boolean'
              ? 'b'
              : 'y'
  const payload =
    tag === 'y' ? Buffer.from((value as Uint8Array).buffer, (value as Uint8Array).byteOffset, (value as Uint8Array).byteLength).toString('base64') : value

  const args = [
    tag === 'u' || tag === 'n' ? context.newString(tag) : jsToHandle(context, tag as VmPrimitive),
    tag === 'u' || tag === 'n' ? context.null : jsToHandle(context, payload as VmPrimitive),
  ]
  const result = context.callFunction(state.fromHost, context.undefined, args)
  for (const arg of args) arg.dispose()
  if (!('value' in result)) {
    const err = result.error
    const message = context.dump(err)
    err.dispose()
    throw new Error(`vm: unmarshal failed: ${JSON.stringify(message)}`)
  }
  return result.value
}

export function createContext(sandbox: Record<string, unknown> = {}, options: CreateContextOptions = {}): VmContext {
  if (!moduleReady) {
    throw new Error('vm: QuickJS module is not initialized, call initVmShim() at worker startup')
  }
  const QuickJS = getQuickJSSync()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(64 * 1024 * 1024)
  runtime.setMaxStackSize(1024 * 1024)
  const context = runtime.newContext()

  const toHost = context.unwrapResult(context.evalCode(`(${MARSHAL_SOURCE}).toHost`))
  const fromHost = context.unwrapResult(context.evalCode(`(${MARSHAL_SOURCE}).fromHost`))

  const state: VmContextState = {
    runtime,
    context,
    toHost,
    fromHost,
    globals: new Map(),
    disposed: false,
    timeoutDeadline: 0,
  }

  for (const [name, value] of Object.entries(sandbox)) {
    if (typeof value === 'function') {
      const fn = context.newFunction(name, (...argHandles) => {
        const args: VmPrimitive[] = argHandles.map((handle) => handleToJs(state, handle))
        let output: unknown
        try {
          output = (value as (...a: VmPrimitive[]) => unknown)(...args)
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          return context.newString(`__host_error__:${error.name}:${error.message}`)
        }
        if (output === undefined) return undefined
        return primitiveToSandbox(state, output as VmPrimitive)
      })
      context.setProp(context.global, name, fn)
      fn.dispose()
      continue
    }
    const handle = jsToHandle(context, value as VmPrimitive)
    context.setProp(context.global, name, handle)
    handle.dispose()
  }

  if (options.codeGeneration?.strings === false) {
    // QuickJS 编译期仍支持 eval；这里做 API 级禁用（与 node:vm 的限制同级别，非硬隔离）
    const result = context.evalCode(
      'globalThis.eval = function(){ throw new Error("Code generation from strings is disallowed") };' +
        'globalThis.Function = function(){ throw new Error("Code generation from strings is disallowed") };'
    )
    if (result.error) result.error.dispose()
    else result.value.dispose()
  }

  const proxy = new Proxy(
    {},
    {
      get(_target, prop, receiver) {
        if (prop === CONTEXT_TAG) return state
        if (typeof prop !== 'string') return Reflect.get(_target, prop, receiver)
        const cached = state.globals.get(prop)
        if (cached) {
          if (state.disposed) return undefined
          return (...args: VmPrimitive[]) => {
            const handles = args.map((arg) => (arg instanceof Uint8Array ? primitiveToSandbox(state, arg) : jsToHandle(state.context, arg)))
            const result = state.context.callFunction(cached, state.context.undefined, handles)
            for (const handle of handles) handle.dispose()
            if (!('value' in result)) {
              const message = state.context.dump(result.error)
              result.error.dispose()
              throw new Error(`vm: ${prop}() failed: ${JSON.stringify(message)}`)
            }
            const value = handleToJs(state, result.value)
            result.value.dispose()
            return value
          }
        }
        const handle = state.context.getProp(state.context.global, prop)
        if (state.context.typeof(handle) !== 'function') {
          const value = state.context.dump(handle)
          handle.dispose()
          return value
        }
        state.globals.set(prop, handle)
        return proxy[prop as never]
      },
    }
  ) as VmContext

  return proxy
}

export function runInContext(code: string, context: VmContext, options: RunInContextOptions = {}): unknown {
  const state = stateOf(context)
  const timeout = options.timeout ?? 0
  if (timeout > 0) {
    state.timeoutDeadline = Date.now() + timeout
    state.runtime.setInterruptHandler(() => Date.now() > state.timeoutDeadline)
  } else {
    state.runtime.setInterruptHandler(() => false)
  }
  try {
    const result = state.context.evalCode(code, options.filename ?? 'eval.js')
    if (result.error) {
      const dumped = state.context.dump(result.error) as { message?: string; stack?: string; name?: string } | string
      result.error.dispose()
      const message = typeof dumped === 'string' ? dumped : (dumped.message ?? 'quickjs error')
      const error = new Error(message)
      error.name = typeof dumped === 'string' ? 'Error' : (dumped.name ?? 'Error')
      if (typeof dumped !== 'string' && dumped.stack) error.stack = dumped.stack
      throw error
    }
    const value = state.context.dump(result.value)
    result.value.dispose()
    return value
  } finally {
    state.runtime.setInterruptHandler(() => false)
  }
}

export function isContext(value: unknown): value is VmContext {
  return typeof value === 'object' && value !== null && CONTEXT_TAG in (value as object)
}

export function destroyContext(context: VmContext): void {
  const state = (context as unknown as Record<symbol, VmContextState | undefined>)[CONTEXT_TAG]
  if (!state || state.disposed) return
  state.disposed = true
  for (const handle of state.globals.values()) handle.dispose()
  state.globals.clear()
  state.toHost.dispose()
  state.fromHost.dispose()
  state.context.dispose()
  state.runtime.dispose()
}

export default {
  createContext,
  runInContext,
  isContext,
  destroyContext,
}
