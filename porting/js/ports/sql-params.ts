/**
 * SQL 参数归一化：把 better-sqlite3 的绑参风格翻译成 sql.js 能接受的**位置参数数组**。
 *
 * 单独成文件（而不是留在 `sqlite.ts` 里）有两个原因：
 * 1. 这里是纯字符串处理，不依赖 wasm —— 冒烟测试可以直接 import 它做断言，
 *    不用为了测一个解析函数把 sql.js 的 emscripten 胶水打进 Node bundle；
 * 2. ERR-007 的根因就在这里（同名命名参数被当成多个参数），把边界摊开更好维护。
 */

export interface ParamSlot {
  /** 命名参数名；`null` 表示位置参数（`?` / `?NNN`） */
  name: string | null
  /** SQLite 的 1-based 参数序号 */
  index: number
}

/**
 * 把 `?`、`?NNN`、`:name` / `@name` / `$name` 解析成「参数序号 → 名字」的槽位列表。
 *
 * ## 必须按**序号**而不是按「出现次数」展开（ERR-007）
 * SQLite 对**同名**命名参数只分配**一个**序号：`WHERE a=@p OR b=@p` 是 1 个参数而不是 2 个。
 * 早期实现把每次出现都当成一个新参数，于是同一条 SQL 里重复出现的 `@list_id`
 * 被展开成两个值，`bind` 时第二个落到不存在的序号上，SQLite 抛 `SQLITE_RANGE`，
 * 错误文本是 `column index out of range` —— 而 better-sqlite3 那边完全正常，
 * 于是表现为「桌面一切正常、Android 查询必炸」，且错误不带任何 SQL 上下文。
 */
export function parseParams(sql: string): ParamSlot[] {
  const slots: ParamSlot[] = []
  const namedIndexes = new Map<string, number>()
  /** 已分配的最大序号；`?` 取它 +1，`?NNN` 可以直接把游标推到 NNN */
  let auto = 0
  let index = 0
  while (index < sql.length) {
    const char = sql[index]!
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      index++
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) index += 2
          else break
        } else index++
      }
      index++
      continue
    }
    if (char === '-' && sql[index + 1] === '-') {
      while (index < sql.length && sql[index] !== '\n') index++
      continue
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      index = end < 0 ? sql.length : end + 2
      continue
    }
    if (char === '?') {
      let digits = ''
      let cursor = index + 1
      while (cursor < sql.length && sql[cursor]! >= '0' && sql[cursor]! <= '9') {
        digits += sql[cursor]!
        cursor++
      }
      const slot = digits ? Number.parseInt(digits, 10) : auto + 1
      auto = Math.max(auto, slot)
      slots.push({ name: null, index: slot })
      index = cursor
      continue
    }
    if (char === ':' || char === '@' || char === '$') {
      let cursor = index + 1
      let name = ''
      while (cursor < sql.length && /[A-Za-z0-9_]/.test(sql[cursor]!)) {
        name += sql[cursor]!
        cursor++
      }
      if (name) {
        const existing = namedIndexes.get(name)
        if (existing != null) {
          // 同名重复出现：复用同一个序号，**不再新增参数**
          slots.push({ name, index: existing })
        } else {
          auto += 1
          namedIndexes.set(name, auto)
          slots.push({ name, index: auto })
        }
        index = cursor
        continue
      }
    }
    index++
  }
  return slots
}

function isPlainObjectParams(params: unknown[]): boolean {
  if (params.length !== 1) return false
  const only = params[0]
  return only != null && typeof only === 'object' && !Array.isArray(only) && !(only instanceof Uint8Array)
}

/**
 * 对象绑参 → 位置参数数组。数组绑参原样返回（调用方已按序号排好）。
 *
 * 对象模式下允许 `list_id` / `:list_id` / `@list_id` / `$list_id` 四种键，与 better-sqlite3 一致。
 */
export function resolveBoundParams(sql: string, params: unknown[]): unknown[] {
  if (!isPlainObjectParams(params)) return params

  const source = params[0] as Record<string, unknown>
  const slots = parseParams(sql)
  const out: unknown[] = []
  let max = 0
  for (const slot of slots) {
    if (slot.name == null) {
      // 对象绑参模式下不该出现位置参数；只推进序号，避免后面的命名参数错位
      max = Math.max(max, slot.index)
      continue
    }
    const value = source[slot.name] ?? source[`:${slot.name}`] ?? source[`@${slot.name}`] ?? source[`$${slot.name}`]
    out[slot.index - 1] = value === undefined ? null : value
    max = Math.max(max, slot.index)
  }
  // `out` 可能是稀疏数组（`?` 占位留下的空洞），sql.js 会把空洞当 `undefined` 绑定而报错
  for (let i = 0; i < max; i++) {
    if (out[i] === undefined) out[i] = null
  }
  out.length = max
  return out
}
