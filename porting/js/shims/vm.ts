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
 * 3. **值编解码**：message2call 使用嵌套数组与对象，二进制使用 base64 保留类型。
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
  objects: Map<string, { handle: QuickJSHandle; proxy: object }>
  disposed: boolean
  timeoutDeadline: number
  executionDepth: number
  drainingJobs: boolean
  jobTimer: ReturnType<typeof setTimeout> | null
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
  function replaceBinary(key, value) {
    var original = this[key]
    return original instanceof Uint8Array ? { __anylisten_vm_bytes__: encode(original) } : value
  }
  function reviveBinary(key, value) {
    if (value && typeof value === 'object' && Object.keys(value).length === 1 &&
        typeof value.__anylisten_vm_bytes__ === 'string') return decode(value.__anylisten_vm_bytes__)
    return value
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
      try { return ['j', JSON.stringify(v, replaceBinary)] } catch (e) { return ['s', String(v)] }
    },
    fromHost: function (tag, payload) {
      switch (tag) {
        case 'u': return undefined
        case 'n': return null
        case 's': return payload
        case 'd': return payload
        case 'b': return payload
        case 'y': return decode(payload)
        case 'j': return JSON.parse(payload, reviveBinary)
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

function drainPendingJobs(state: VmContextState): void {
  if (state.disposed || state.drainingJobs || state.executionDepth > 0) return
  state.drainingJobs = true
  const deadline = Date.now() + 5_000
  state.runtime.setInterruptHandler(() => Date.now() > deadline)
  try {
    const result = state.runtime.executePendingJobs(1_000)
    if (result.error) {
      const error = state.context.dump(result.error)
      result.error.dispose()
      throw new Error(`vm: pending job failed: ${JSON.stringify(error)}`)
    }
    if (state.runtime.hasPendingJob() && !state.jobTimer) {
      state.jobTimer = setTimeout(() => {
        state.jobTimer = null
        try { drainPendingJobs(state) } catch (error) { console.error(error) }
      }, 0)
    }
  } finally {
    state.runtime.setInterruptHandler(() => false)
    state.drainingJobs = false
  }
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

function handleToJs(state: VmContextState, handle: QuickJSHandle): unknown {
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
      return JSON.parse(String(payload), (_key, value: unknown) => {
        if (value && typeof value === 'object' && Object.keys(value).length === 1 &&
            typeof (value as Record<string, unknown>).__anylisten_vm_bytes__ === 'string') {
          return Buffer.from((value as { __anylisten_vm_bytes__: string }).__anylisten_vm_bytes__, 'base64')
        }
        return value
      }) as unknown
    default:
      return undefined
  }
}

function primitiveToSandbox(state: VmContextState, value: unknown): QuickJSHandle {
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
            : value instanceof Uint8Array
              ? 'y'
              : 'j'
  const payload = tag === 'y'
    ? Buffer.from((value as Uint8Array).buffer, (value as Uint8Array).byteOffset, (value as Uint8Array).byteLength).toString('base64')
    : tag === 'j'
      ? JSON.stringify(value, function (this: Record<string, unknown>, key, item: unknown) {
          const original = this[key]
          return original instanceof Uint8Array
            ? { __anylisten_vm_bytes__: Buffer.from(original.buffer, original.byteOffset, original.byteLength).toString('base64') }
            : item
        })
      : value

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

function hostFunction(state: VmContextState, name: string, fn: (...args: unknown[]) => unknown): QuickJSHandle {
  const { context } = state
  return context.newFunction(name, (...argHandles) => {
    const args = argHandles.map((handle) => handleToJs(state, handle))
    try {
      const output = fn(...args)
      return output === undefined ? undefined : primitiveToSandbox(state, output)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      return context.newString(`__host_error__:${error.name}:${error.message}`)
    }
  })
}

function callSandbox(state: VmContextState, fn: QuickJSHandle, receiver: QuickJSHandle, args: unknown[], name: string): unknown {
  const handles: QuickJSHandle[] = []
  state.executionDepth += 1
  try {
    for (const arg of args) handles.push(primitiveToSandbox(state, arg))
    const result = state.context.callFunction(fn, receiver, handles)
    if (!('value' in result)) {
      const message = state.context.dump(result.error)
      result.error.dispose()
      throw new Error(`vm: ${name}() failed: ${JSON.stringify(message)}`)
    }
    try { return handleToJs(state, result.value) } finally { result.value.dispose() }
  } finally {
    for (const handle of handles) handle.dispose()
    state.executionDepth -= 1
    drainPendingJobs(state)
  }
}

function sandboxObject(state: VmContextState, object: QuickJSHandle): object {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string' || state.disposed) return undefined
      const value = state.context.getProp(object, prop)
      const isFunction = state.context.typeof(value) === 'function'
      if (!isFunction) {
        try { return handleToJs(state, value) } finally { value.dispose() }
      }
      value.dispose()
      return (...args: unknown[]) => {
        if (state.disposed) throw new Error('vm: context has been disposed')
        const fn = state.context.getProp(object, prop)
        try { return callSandbox(state, fn, object, args, prop) } finally { fn.dispose() }
      }
    },
  })
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
    objects: new Map(),
    disposed: false,
    timeoutDeadline: 0,
    executionDepth: 0,
    drainingJobs: false,
    jobTimer: null,
  }

  for (const [name, value] of Object.entries(sandbox)) {
    if (typeof value === 'function') {
      const fn = hostFunction(state, name, value as (...args: unknown[]) => unknown)
      context.setProp(context.global, name, fn)
      fn.dispose()
      continue
    }
    let handle: QuickJSHandle
    if (value && typeof value === 'object' && Object.values(value).some((item) => typeof item === 'function')) {
      handle = context.newObject()
      for (const [key, item] of Object.entries(value)) {
        const child = typeof item === 'function'
          ? hostFunction(state, key, item.bind(value) as (...args: unknown[]) => unknown)
          : primitiveToSandbox(state, item)
        context.setProp(handle, key, child)
        child.dispose()
      }
    } else handle = primitiveToSandbox(state, value)
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
        const object = state.objects.get(prop)
        if (object) return object.proxy
        const cached = state.globals.get(prop)
        if (cached) {
          if (state.disposed) return undefined
          return (...args: unknown[]) => callSandbox(state, cached, state.context.undefined, args, prop)
        }
        const handle = state.context.getProp(state.context.global, prop)
        const type = state.context.typeof(handle)
        if (type === 'object' && state.context.dump(handle) !== null) {
          const names = state.context.unwrapResult(state.context.getOwnPropertyNames(handle))
          const hasMethods = names.some((key) => {
            const child = state.context.getProp(handle, key)
            try { return state.context.typeof(child) === 'function' } finally { child.dispose() }
          })
          names.dispose()
          if (hasMethods) {
            const objectProxy = sandboxObject(state, handle)
            state.objects.set(prop, { handle, proxy: objectProxy })
            return objectProxy
          }
        }
        if (type !== 'function') {
          try { return handleToJs(state, handle) } finally { handle.dispose() }
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
  state.executionDepth += 1
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
    state.executionDepth -= 1
    drainPendingJobs(state)
  }
}

export function isContext(value: unknown): value is VmContext {
  return typeof value === 'object' && value !== null && CONTEXT_TAG in (value as object)
}

export function destroyContext(context: VmContext): void {
  const state = (context as unknown as Record<symbol, VmContextState | undefined>)[CONTEXT_TAG]
  if (!state || state.disposed) return
  state.disposed = true
  if (state.jobTimer) clearTimeout(state.jobTimer)
  for (const handle of state.globals.values()) handle.dispose()
  state.globals.clear()
  for (const object of state.objects.values()) object.handle.dispose()
  state.objects.clear()
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
