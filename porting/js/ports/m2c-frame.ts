/**
 * message2call v2 的**真实帧格式** —— JS 侧实现。
 *
 * 权威来源：`message2call@2.0.3/dist/message2call.js`（native-engineer 实测）+
 * Kotlin 侧 `porting/android/bridge/src/main/kotlin/com/anylisten/bridge/Message2CallFrames.kt`。
 * **不是**早期设计稿假设的 `{id, name, args}` 对象帧，那份已作废。
 *
 * ```
 * CALL_TYPES = { REQUEST:0, RESPONSE:1, CALLBACK_REQUEST:2, CALLBACK_RESPONSE:3 }
 *
 * 请求        [0, eventName, pathname:[String], args:[Any], callbacks:[Int]]
 * 响应        [1, eventName, error:{code,message,detail?}|null, result?]
 * 回调请求    [2, callbackName, args:[Any]]
 * 回调响应    [3, callbackName, error|null, result?]
 * ```
 *
 * ## 为什么必须严格照抄而不是"自己定一套更干净的"
 * 双向回调（`fs.listTree(onBatch)` / `fs.watch(onEvent, onReady, onError)` /
 * `http.downloadTo(onProgress)` / `lifecycle.onBackground` / `mediaSession.onControl` …）
 * 依赖一个**两端约定一致的约定**：发送端把函数实参替换成 `func_<n>_<rand>` 字符串、
 * 并把下标记进 `callbacks`；接收端之后用 `[2, callbackName, args]` 反向推事件。
 * Kotlin 侧 `BridgeContext.callbackAt(order)` / `callbackArg(index)` 已经按这个规则取名字，
 * 任何一处改动都会让所有流式接口（曲库扫描每 500 条一批）静默失效。
 *
 * ## 二进制
 * `Uint8Array` 直接 `JSON.stringify` 会退化成 `{"0":12,"1":255,...}`（体积膨胀 5–8 倍且类型丢失），
 * 因此帧内统一用 `{"$b64":"<base64>"}` 信封。Kotlin 侧对应 `JsonBinary`。
 */

/** 帧类型（0 起，与 message2call 的 `CALL_TYPES` 一致） */
export const CALL_TYPE = {
  REQUEST: 0,
  RESPONSE: 1,
  CALLBACK_REQUEST: 2,
  CALLBACK_RESPONSE: 3,
} as const

export type CallType = (typeof CALL_TYPE)[keyof typeof CALL_TYPE]

/** 二进制信封的键名。Kotlin 侧 `JsonBinary.KEY` 同值。 */
export const B64_KEY = '$b64'

/** 回调名格式：`func_<n>_<rand>`。`n` 是实参下标（Kotlin 侧只用字符串，不解析） */
const CALLBACK_PREFIX = 'func_'

export type CallbackFn = (...args: unknown[]) => void

/** 一帧请求的编码结果 */
export interface EncodedRequest {
  /** 已把函数实参换成名字、把 Uint8Array 换成 `$b64` 信封的实参表 */
  args: unknown[]
  /** 哪些下标是回调 */
  callbacks: number[]
  /** 本次生成的回调名（用于请求结束后释放） */
  callbackNames: string[]
}

let randSeed = 0

/** 短随机 id。只需要"同进程内不撞"，不要求密码学强度。 */
export function nextRand(): string {
  randSeed += 1
  return `${Date.now().toString(36)}${randSeed.toString(36)}`
}

/* ------------------------------------------------------------------ *
 * base64
 * ------------------------------------------------------------------ */

/**
 * 单次 `String.fromCharCode` 的最大实参个数。
 * 0x8000 是安全值：V8 的实参上限约 65535，留一半余量给 `apply` 的其它开销。
 * 不用 `...spread` 大数组，也不依赖 `Uint8Array.prototype.toBase64`
 * （Chrome 130+ 才有，目标 WebView 版本不确定）。
 */
const B64_CHUNK = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * 判断是否二进制信封。
 * 严格到「只有一个键」——否则 `{ $b64: 'x', extra: 1 }` 这种普通业务对象会被误吞。
 * 与 Kotlin 侧 `if (b64.isNotEmpty() && value.length() == 1)` 对齐。
 */
export function isBinaryEnvelope(value: unknown): value is Record<typeof B64_KEY, string> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  return keys.length === 1 && keys[0] === B64_KEY && typeof record[B64_KEY] === 'string'
}

/** 任意字节视图 → 信封 */
export function toBinaryEnvelope(bytes: Uint8Array): Record<typeof B64_KEY, string> {
  return { [B64_KEY]: bytesToBase64(bytes) }
}

/* ------------------------------------------------------------------ *
 * 值编解码
 * ------------------------------------------------------------------ */

/**
 * 出向值编码：`Uint8Array` / `ArrayBuffer` / `DataView` → `$b64` 信封，其它递归。
 *
 * 函数**不在这里处理**——函数只在顶层实参位置出现（message2call 的 `callbacks` 记的是实参下标），
 * 由 [encodeRequest] 负责。嵌套对象里的函数直接丢弃（与 JSON.stringify 行为一致）。
 *
 * 签名必须保持**单参**：调用方常写成 `arr.map(encodeValue)`，
 * 多一个位置参数会被 `Array.map` 的 `index` 顶掉（踩过一次，`seen.has is not a function`）。
 */
export function encodeValue(value: unknown): unknown {
  return encodeInner(value, new WeakSet())
}

function encodeInner(value: unknown, seen: WeakSet<object>): unknown {
  if (value == null) return null

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      // JSON 不支持 NaN / Infinity，统一降级成 null（Kotlin 侧再按默认值兜底）
      return Number.isFinite(value) ? value : null
    case 'bigint':
      // 超过 2^53 的整数在 JSON 里必然丢精度，显式转字符串而不是静默变 double
      return value.toString()
    case 'function':
    case 'undefined':
    case 'symbol':
      return null
    default:
      break
  }

  if (value instanceof Uint8Array) return toBinaryEnvelope(value)
  if (value instanceof ArrayBuffer) return toBinaryEnvelope(new Uint8Array(value))
  if (ArrayBuffer.isView(value)) {
    return toBinaryEnvelope(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: (value as { code?: string }).code ?? null }
  }
  if (value instanceof Map) {
    return encodeInner(Object.fromEntries(value), seen)
  }
  if (value instanceof Set) {
    return encodeInner([...value], seen)
  }

  if (seen.has(value)) {
    // 环引用：JSON.stringify 会直接抛错，这里降级成 null 并告警，避免整条 RPC 通道被打断
    console.error('[m2c] circular reference in port args, degraded to null')
    return null
  }
  seen.add(value)

  if (Array.isArray(value)) return value.map((item) => encodeInner(item, seen))

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = encodeInner(item, seen)
  }
  return out
}

/** 入向值解码：`$b64` 信封 → `Uint8Array`，其它递归 */
export function decodeValue(value: unknown): unknown {
  if (value == null) return value

  if (isBinaryEnvelope(value)) return base64ToBytes(value[B64_KEY])

  if (Array.isArray(value)) return value.map(decodeValue)

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = decodeValue(item)
    }
    return out
  }

  return value
}

/* ------------------------------------------------------------------ *
 * 帧构造 / 解析
 * ------------------------------------------------------------------ */

/**
 * 编码一帧请求的实参表。
 *
 * @param args     业务实参（顶层若有 function 会被替换成名字）
 * @param register 回调名 → 真实函数的登记回调（由 `BridgeClient` 提供）
 */
export function encodeRequest(
  args: readonly unknown[],
  register: (name: string, fn: CallbackFn) => void
): EncodedRequest {
  const callbacks: number[] = []
  const callbackNames: string[] = []
  const rand = nextRand()

  const encoded = args.map((arg, index) => {
    if (typeof arg === 'function') {
      const name = `${CALLBACK_PREFIX}${index}_${rand}`
      register(name, arg as CallbackFn)
      callbacks.push(index)
      callbackNames.push(name)
      return name
    }
    return encodeValue(arg)
  })

  return { args: encoded, callbacks, callbackNames }
}

/** 构造请求帧（可直接 `JSON.stringify`） */
export function buildRequestFrame(
  eventName: string,
  pathname: readonly string[],
  encoded: EncodedRequest
): unknown[] {
  return [CALL_TYPE.REQUEST, eventName, [...pathname], encoded.args, encoded.callbacks]
}

/**
 * 解析入向帧。任何结构异常都返回 `null`（并告警），绝不让一帧脏数据把桥打死。
 * 返回的 `args` 仍是**未解码**的原始 JSON 值，由调用方决定是否 `decodeValue`。
 */
export function parseFrame(frameJson: string): unknown[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(frameJson) as unknown
  } catch (err) {
    console.error('[m2c] frame is not valid JSON', err, frameJson.slice(0, 200))
    return null
  }
  if (!Array.isArray(parsed) || parsed.length < 2) {
    console.error('[m2c] frame is not an array', frameJson.slice(0, 200))
    return null
  }
  const type = parsed[0]
  if (typeof type !== 'number') {
    console.error('[m2c] frame type is not a number', frameJson.slice(0, 200))
    return null
  }
  return parsed
}

/** 从帧里取 eventName / callbackName（第 2 个元素） */
export function frameName(frame: readonly unknown[]): string {
  const name = frame[1]
  return typeof name === 'string' ? name : ''
}
