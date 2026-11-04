/**
 * 冒烟测试入口。
 *
 * 为什么要单独打一个 Node 可执行的 bundle，而不是直接 `node scripts/smoke.mjs` 读 TS：
 * 移植层的正确性**主要取决于 vite 的 alias/覆写表**（`node:fs` → shims、`@any-listen/nodejs/request`
 * → HttpPort 等）。只在 Node 里跑 TS 源码验证不了这层映射；用同一个 vite 配置打出来的 bundle
 * 才是"真的会被 WebView 加载的那份代码"，跑它才有意义。
 *
 * 断言的参照物一律是 **Node 原生实现**（`node:crypto` / `node:path` / `node:zlib`），
 * 逐字节/逐字符比对，避免"看起来跑通了"。
 */

import nodeCrypto from 'node:crypto'
import nodePath from 'node:path'
import nodeZlib from 'node:zlib'

import { BridgeClient, ports, setBridgeClient } from '@porting/ports'
import {
  CALL_TYPE,
  decodeValue,
  encodeValue,
  frameName,
  parseFrame,
  base64ToBytes,
  bytesToBase64,
} from '@porting/ports/m2c-frame'
import { resolveBoundParams } from '@porting/ports/sql-params'
import { PortError } from '@porting/ports/types'
import { createDecipheriv, createCipheriv, createHash, randomBytes, randomUUID } from '@porting/shims/crypto'
import * as pathShim from '@porting/shims/path'
import * as zlibShim from '@porting/shims/zlib'
import { flushAll, getCachedFile, preloadFile } from '@porting/nodejs/SafeFS'
import Store from '@porting/nodejs/Store'

export interface SmokeResult {
  name: string
  ok: boolean
  detail: string
}

const results: SmokeResult[] = []

function check(name: string, fn: () => void | Promise<void>): void {
  // 同步收集，异步的放到下面单独 await（保持报告顺序稳定）
  try {
    const ret = fn()
    if (ret instanceof Promise) throw new Error('async check 必须用 checkAsync 注册')
    results.push({ name, ok: true, detail: 'ok' })
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) })
  }
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    results.push({ name, ok: true, detail: 'ok' })
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) })
  }
}

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${what} 不一致: 期望 ${e}, 实际 ${a}`)
}

function assertTrue(cond: boolean, message: string): void {
  if (!cond) throw new Error(message)
}

/* ------------------------------------------------------------------ *
 * 1. path —— 必须是 posix 语义（Android 路径）
 * ------------------------------------------------------------------ */
function testPath(): void {
  const cases: Array<[string[], string]> = [
    [['/storage/emulated/0', 'Music', 'a.mp3'], '/storage/emulated/0/Music/a.mp3'],
    [['/a/b/../c', './d'], '/a/c/d'],
    [['/a//b///c'], '/a/b/c'],
  ]
  for (const [args, expected] of cases) {
    assertEqual(pathShim.join(...args), expected, `path.join(${args.join(', ')})`)
  }
  assertEqual(pathShim.dirname('/a/b/c.mp3'), '/a/b', 'path.dirname')
  assertEqual(pathShim.basename('/a/b/c.mp3'), 'c.mp3', 'path.basename')
  assertEqual(pathShim.extname('/a/b/c.MP3'), '.MP3', 'path.extname')
  assertEqual(pathShim.sep, '/', 'path.sep')
  // 与 Node 的 posix 实现比对
  assertEqual(pathShim.normalize('/a/b/../c//d/'), nodePath.posix.normalize('/a/b/../c//d/'), 'path.normalize vs node')
}

/* ------------------------------------------------------------------ *
 * 2. crypto hash —— 与 node:crypto 逐字符比对
 * ------------------------------------------------------------------ */
function testHash(): void {
  const samples = ['', 'any-listen', '中文与 emoji 🎵', 'x'.repeat(1000)]
  for (const algo of ['md5', 'sha1', 'sha256', 'sha512'] as const) {
    for (const sample of samples) {
      const mine = createHash(algo).update(sample).digest('hex')
      const node = nodeCrypto.createHash(algo).update(sample).digest('hex')
      if (mine !== node) throw new Error(`${algo}("${sample.slice(0, 12)}") 与 Node 不一致`)
    }
  }
  // 增量 update 必须一致
  const inc = createHash('sha256').update('abc').update('def').digest('hex')
  const oneShot = nodeCrypto.createHash('sha256').update('abcdef').digest('hex')
  assertEqual(inc, oneShot, 'sha256 增量 update')
}

/* ------------------------------------------------------------------ *
 * 3. AES —— 同步实现与 node:crypto 逐字节比对
 * ------------------------------------------------------------------ */
function testAes(): void {
  const key = new Uint8Array(16).map((_, i) => i + 1)
  const iv = new Uint8Array(16).map((_, i) => 255 - i)
  const plaintext = new TextEncoder().encode('Any Listen Android 移植层 AES 自检 —— 含中文')

  for (const [mode, nodeAlgo, useIv] of [
    ['aes-128-ecb', 'aes-128-ecb', false],
    ['aes-128-cbc', 'aes-128-cbc', true],
  ] as const) {
    const mine = createCipheriv(mode, key, useIv ? iv : undefined)
    const sealed = new Uint8Array([...mine.update(plaintext), ...mine.final()])

    const nodeCipher = nodeCrypto.createCipheriv(
      nodeAlgo,
      Buffer.from(key),
      useIv ? Buffer.from(iv) : null,
    )
    const expected = new Uint8Array([...nodeCipher.update(plaintext), ...nodeCipher.final()])

    assertEqual(Array.from(sealed), Array.from(expected), `${mode} 密文`)

    const decipher = createDecipheriv(mode, key, useIv ? iv : undefined)
    const opened = new Uint8Array([...decipher.update(sealed), ...decipher.final()])
    assertEqual(Array.from(opened), Array.from(plaintext), `${mode} 解密回原文`)
  }
}

/* ------------------------------------------------------------------ *
 * 4. zlib —— gzip/deflate roundtrip，且与 Node 互通
 * ------------------------------------------------------------------ */
function testZlib(): void {
  const text = 'Any Listen '.repeat(200)

  const gz = zlibShim.gzipSync(text)
  assertEqual(nodeZlib.gunzipSync(Buffer.from(gz)).toString(), text, 'gzipSync 能被 Node gunzip 解开')
  assertEqual(zlibShim.gunzipSync(nodeZlib.gzipSync(text)).toString(), text, 'Node gzip 能被本 shim 解开')

  const deflated = zlibShim.deflateSync(text)
  assertEqual(nodeZlib.inflateSync(Buffer.from(deflated)).toString(), text, 'deflateSync 能被 Node inflate 解开')
  assertEqual(zlibShim.constants.Z_FINISH, nodeZlib.constants.Z_FINISH, 'zlib.constants.Z_FINISH')
}

/* ------------------------------------------------------------------ *
 * 5. Store / SafeFS —— 内存同步读 + 异步落盘（经 Ports RPC 回环）
 * ------------------------------------------------------------------ */

/**
 * 用内存 Map 模拟 Kotlin 侧的 `:bridge`，把**真实帧协议**跑通：
 * `ports.fs.writeFile()` → `[0, eventName, ['fs','writeFile'], args, callbacks]`
 * → 这里的 handler → 内存 → `[1, eventName, null, result]` → Promise resolve。
 *
 * 刻意不 mock `BridgeClient` 内部：编码、回调替换、`$b64` 信封、错误回传
 * 全走真实代码，否则「冒烟通过但真机上全挂」是必然结局。
 */
function installFakeNativeBridge(): { files: Map<string, Uint8Array>; calls: string[]; client: BridgeClient } {
  const files = new Map<string, Uint8Array>()
  const calls: string[] = []

  const client = new BridgeClient((frameJson) => {
    const frame = parseFrame(frameJson)
    if (!frame || frame[0] !== CALL_TYPE.REQUEST) return

    const eventName = frameName(frame)
    const pathname = Array.isArray(frame[2]) ? (frame[2] as string[]) : []
    const name = pathname.join('.')
    const args = (Array.isArray(frame[3]) ? frame[3] : []).map(decodeValue)
    calls.push(name)

    const reply = (error: unknown, result?: unknown): void => {
      const encodedError = error == null ? null : (error as object)
      setImmediate(() => {
        client.handleFrame(
          JSON.stringify([CALL_TYPE.RESPONSE, eventName, encodedError, encodeValue(result ?? null)])
        )
      })
    }
    /** 模拟 Kotlin 侧 `ctx.emit(callbackName, args)` */
    const emit = (callbackName: string, ...payload: unknown[]): void => {
      setImmediate(() => {
        client.handleFrame(
          JSON.stringify([CALL_TYPE.CALLBACK_REQUEST, callbackName, payload.map(encodeValue)])
        )
      })
    }

    const [first, second] = args as [string, Uint8Array]
    const callbackName = (index: number): string | null => {
      const indexes = Array.isArray(frame[4]) ? (frame[4] as number[]) : []
      if (!indexes.includes(index)) return null
      const value = (frame[3] as unknown[])[index]
      return typeof value === 'string' ? value : null
    }

    switch (name) {
      case 'fs.getEnv':
        reply(null, {
          dataPath: '/data/user/0/com.anylisten/files',
          cachePath: '/data/user/0/com.anylisten/cache',
          tempPath: '/data/user/0/com.anylisten/cache/tmp',
          externalRoot: '/storage/emulated/0',
          platform: 'android',
          arch: 'arm64',
          osVersion: '15',
          hasAllFilesAccess: true,
        })
        return
      case 'fs.writeFile':
      case 'fs.writeFileAtomic':
        files.set(first, second ?? new Uint8Array())
        reply(null, null)
        return
      case 'fs.readFile':
        if (!files.has(first)) {
          reply({ code: 'ENOENT', message: `no such file: ${first}` })
          return
        }
        reply(null, files.get(first))
        return
      case 'fs.exists':
        reply(null, files.has(first))
        return
      case 'fs.listTree': {
        // 契约：listTree(root, opts, onBatch) -> { total, canceled, id }
        const onBatch = callbackName(2)
        if (!onBatch) {
          reply({ code: 'EUNKNOWN', message: 'fs.listTree 缺少 onBatch 回调' })
          return
        }
        emit(onBatch, [
          { path: `${first}/a.mp3`, name: 'a.mp3', isFile: true, isDirectory: false, size: 1, mtimeMs: 1 },
        ])
        emit(onBatch, [
          { path: `${first}/b.flac`, name: 'b.flac', isFile: true, isDirectory: false, size: 2, mtimeMs: 2 },
        ])
        reply(null, { total: 2, canceled: false, id: 'scan-fake' })
        return
      }
      default:
        reply({ code: 'EUNSUPPORTED', message: `unhandled: ${name}` })
    }
  })

  setBridgeClient(client)
  return { files, calls, client }
}

async function testStore(native: { files: Map<string, Uint8Array> }): Promise<void> {
  await preloadFile('/data/user/0/com.anylisten/files/app/config.json')

  const store = new Store('/data/user/0/com.anylisten/files/app/config.json', false)
  store.set('common.langId', 'zh-CN')
  store.set('player.volume', 0.8)
  assertEqual(store.get('common.langId'), 'zh-CN', 'Store.get 同步读到刚写的值')
  assertEqual((store.getAll() as Record<string, unknown>)['player.volume'], 0.8, 'Store.getAll')

  await flushAll()
  assertTrue(
    native.files.has('/data/user/0/com.anylisten/files/app/config.json'),
    'flushAll 之后必须真的经 Ports 落到文件系统',
  )
  const cached = getCachedFile('/data/user/0/com.anylisten/files/app/config.json')
  assertTrue(cached != null && cached.length > 0, '落盘内容非空')
  const parsed = JSON.parse(Buffer.from(cached!).toString('utf8')) as Record<string, unknown>
  assertEqual(parsed['common.langId'], 'zh-CN', '落盘 JSON 内容')
}

/* ------------------------------------------------------------------ *
 * 6. 随机数 / UUID
 * ------------------------------------------------------------------ */
function testRandom(): void {
  const uuid = randomUUID()
  assertTrue(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid), `UUID 格式不合法: ${uuid}`)
  const bytes = randomBytes(32)
  assertEqual(bytes.length, 32, 'randomBytes 长度')
  assertTrue(bytes.some((b) => b !== 0), 'randomBytes 全零（熵源异常）')
}

/* ------------------------------------------------------------------ *
 * 7. 二进制信封（`{"$b64": ...}`）
 * ------------------------------------------------------------------ */
function testBinaryEnvelope(): void {
  // 200_003 字节：跨过 0x8000 的分块边界，且长度不是 3 的倍数（base64 padding 分支）
  const bytes = new Uint8Array(200_003)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) & 0xff

  const b64 = bytesToBase64(bytes)
  assertEqual(b64, Buffer.from(bytes).toString('base64'), '$b64 编码与 Node Buffer 一致')
  const back = base64ToBytes(b64)
  assertEqual(back.length, bytes.length, '$b64 往返长度')
  for (let i = 0; i < bytes.length; i += 1) {
    if (back[i] !== bytes[i]) throw new Error(`$b64 往返第 ${i} 字节不一致`)
  }

  // 嵌套结构：数组 / 普通对象里的二进制都要被识别
  const decoded = decodeValue({ list: [{ $b64: b64 }], keep: 1, text: 'x' }) as {
    list: Uint8Array[]
    keep: number
    text: string
  }
  assertEqual(decoded.list[0].length, bytes.length, '嵌套 $b64 解码长度')
  assertEqual(decoded.keep, 1, '嵌套普通字段不被误吞')
  assertEqual(decoded.text, 'x', '嵌套字符串不被误吞')

  // 多键对象不能当信封（否则 `{$b64:'x', extra:1}` 这种业务对象会被吃掉）
  const notEnvelope = decodeValue({ $b64: b64, extra: 1 }) as Record<string, unknown>
  assertEqual(typeof notEnvelope.extra, 'number', '多键对象不按信封处理')
}

/* ------------------------------------------------------------------ *
 * 8. 流式回调 —— `[2, callbackName, args]` 反推 + 请求结束后释放
 * ------------------------------------------------------------------ */
async function testStreamingListTree(client: BridgeClient): Promise<void> {
  const batches: Array<Array<{ path: string; name: string }>> = []
  const result = await ports.fs.listTree('/music', { maxDepth: 1 }, (entries) => {
    batches.push(entries as Array<{ path: string; name: string }>)
  })

  assertEqual(result.total, 2, 'listTree 返回 total')
  assertEqual(result.canceled, false, 'listTree 返回 canceled')
  assertEqual(batches.length, 2, 'listTree 分批回调次数')
  assertEqual(batches[0][0].name, 'a.mp3', '第一批内容')
  assertEqual(batches[1][0].name, 'b.flac', '第二批内容')

  // 一次性回调必须在请求结束后释放，否则长跑进程会一直涨
  await new Promise((resolve) => setImmediate(resolve))
  assertEqual(client.callbackCount, 0, 'listTree 结束后回调注册已释放')
}

/* ------------------------------------------------------------------ *
 * 9. PortError 跨边界回传
 * ------------------------------------------------------------------ */
async function testPortErrorPropagation(): Promise<void> {
  try {
    await ports.fs.readFile('/nope')
    throw new Error('期望 readFile 抛错，实际成功')
  } catch (err) {
    assertTrue(err instanceof PortError, `错误类型应为 PortError，实际 ${String(err)}`)
    const portError = err as PortError
    assertEqual(portError.code, 'ENOENT', 'Kotlin 的 error.code 必须原样还原')
    assertTrue(portError.message.includes('/nope'), `错误消息应包含路径，实际: ${portError.message}`)
  }
}

/* ------------------------------------------------------------------ *
 * 10. PortError 序列化
 * ------------------------------------------------------------------ */
function testPortError(): void {
  const err = new PortError('ENOENT', 'missing', '/x')
  const payload = err.toPayload()
  assertEqual(payload.code, 'ENOENT', 'PortError.code')
  assertEqual(payload.detail, '/x', 'PortError.detail')
  const restored = PortError.from(payload)
  assertEqual(restored.message, 'missing', 'PortError.from().message')
  assertEqual(restored.code, 'ENOENT', 'PortError.from().code')
}

/* ------------------------------------------------------------------ *
 * 12. SQL 参数归一化（ERR-007）
 * ------------------------------------------------------------------ */

/**
 * 这条 SQL 是 `music_library/statements.ts` 的原文（`queryMusicList`）。
 * 它把 `@list_id` 写了**两次**，而 SQLite 认为这是**同一个参数**。
 * 早期实现按「出现次数」展开 → bind 到不存在的序号 → `SQLITE_RANGE`
 * （错误文本 `column index out of range`），曲库列表因此在真机上永远加载不出来。
 */
const UPSTREAM_DUP_NAMED_SQL = `
  SELECT mInfo."id", O."order"
  FROM my_list_music_info mInfo
  LEFT JOIN my_list_music_info_order O ON mInfo.id=O.music_id AND O.list_id=@list_id
  WHERE mInfo.list_id=@list_id
  ORDER BY O."order" ASC
`

function testSqlParams(): void {
  assertEqual(resolveBoundParams(UPSTREAM_DUP_NAMED_SQL, [{ list_id: 'love' }]), ['love'], '同名命名参数只占 1 个序号')

  // 四种键前缀都要认（better-sqlite3 的约定）
  for (const key of ['p', ':p', '@p', '$p']) {
    assertEqual(resolveBoundParams('SELECT 1 WHERE a=@p', [{ [key]: 7 }]), [7], `对象键 ${key}`)
  }

  // 不同名参数按出现顺序占号
  assertEqual(resolveBoundParams('SELECT 1 WHERE a=@a AND b=@b', [{ a: 1, b: 2 }]), [1, 2], '不同名参数顺序')

  // `?` / `?NNN` 只推进序号，不能让后面的命名参数错位
  assertEqual(resolveBoundParams('SELECT 1 WHERE a=? AND b=@b', [{ b: 2 }]), [null, 2], '? 占位不打乱命名参数序号')
  // `?2` 显式占掉 2 号位后，后面的新命名参数按 SQLite 规则落到 3 号，而不是复用 2 号
  assertEqual(resolveBoundParams('SELECT 1 WHERE a=?2 AND b=@b', [{ b: 2 }]), [null, null, 2], '?NNN 按显式序号推进游标')

  // 引号 / 注释里的 `?` `@x` 不能被当参数
  assertEqual(resolveBoundParams("SELECT '?' AS a, \"@x\" AS b", [{ x: 1 }]), [], '引号内不算参数')
  assertEqual(resolveBoundParams('SELECT 1 -- @nope\nWHERE a=@a', [{ a: 1 }]), [1], '行注释内不算参数')
  assertEqual(resolveBoundParams('SELECT 1 /* @nope */ WHERE a=@a', [{ a: 1 }]), [1], '块注释内不算参数')

  // 数组绑参原样透传（调用方已按序号排好，含 Uint8Array 单值这种合法入参）
  assertEqual(resolveBoundParams('SELECT 1 WHERE a=? AND b=?', [1, 2]), [1, 2], '数组绑参透传')
  const blob = new Uint8Array([1, 2, 3])
  assertEqual(resolveBoundParams('SELECT 1 WHERE a=?', [blob])[0], blob, '单个 Uint8Array 不被当成对象绑参')
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */
export async function runSmoke(): Promise<{ results: SmokeResult[]; nativeCalls: number }> {
  check('path（posix 语义）', testPath)
  check('crypto hash（对标 node:crypto）', testHash)
  check('crypto AES（对标 node:crypto）', testAes)
  check('zlib（与 node:zlib 互通）', testZlib)
  check('randomUUID / randomBytes', testRandom)
  check('二进制信封 $b64', testBinaryEnvelope)
  check('PortError 序列化', testPortError)
  check('SQL 参数归一化（同名命名参数去重）', testSqlParams)

  const native = installFakeNativeBridge()
  await checkAsync('Store + SafeFS（经 Ports RPC 落盘）', () => testStore(native))
  await checkAsync('listTree 流式回调（[2,…] 反推 + 回调释放）', () =>
    testStreamingListTree(native.client)
  )
  await checkAsync('PortError 跨边界回传', testPortErrorPropagation)

  return { results, nativeCalls: native.calls.length }
}
