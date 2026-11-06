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
import { createMessage2Call, type ReadObj } from 'message2call'
import { CANCELED_ERROR_MSG } from '@any-listen/common/constants'

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
import Database, { initSqlite, preloadDatabase, registerSqliteLifecycle } from '@porting/ports/sqlite'
import { PortError } from '@porting/ports/types'
import { createDecipheriv, createCipheriv, createHash, randomBytes, randomUUID } from '@porting/shims/crypto'
import * as pathShim from '@porting/shims/path'
import * as zlibShim from '@porting/shims/zlib'
import { evictFile, flushAll, getCachedFile, preloadFile } from '@porting/nodejs/SafeFS'
import Store from '@porting/nodejs/Store'
import { request } from '@porting/nodejs/request'
import * as vmShim from '@porting/shims/vm'
import { withIpcCallbacks } from '../ui/ipc/callback-client'
import { openExtensionFileDialog, saveExtensionFileDialog } from '../ui/ipc/extensionFileDialogs'
import { createIsolateFuncs } from '../host/app/modules/worker/extensionService/vm/hostContext/apis/isolateContext'
import { contextState } from '../../../source/packages/shared/app/modules/worker/extensionService/vm/hostContext/state'
import { createProxy, proxyServerState } from '@any-listen/app/modules/proxyServer'
import {
  getConfig as getExtensionConfig,
  saveConfig as saveExtensionConfig,
  unloadConfig as unloadExtensionConfig,
} from '../host/app/modules/worker/extensionService/shared/configStore'
import { updateExtensionSettings } from '../host/app/modules/worker/extensionService/shared/index'
import {
  createSettingsBackupData,
  pickRestorableSettings,
  SETTINGS_BACKUP_VERSION,
} from '../host/app/modules/backup/settings'
import { filterLyricMetadata } from '../ui/lyric/filterMetadata'
import { initDeviceId } from '../../../source/packages/shared/app/common/deviceId'
import defaultSetting from '../../../source/packages/shared/common/defaultSetting'
import { extensionState } from '../../../source/packages/shared/app/modules/worker/extensionService/state'
import { mergeFullData } from '../../../source/packages/shared/app/modules/sync/shared/list/merge'
import { mergeFullDataFromSnapshot } from '../../../source/packages/shared/app/modules/sync/shared/list/mergeFromSnapshot'
import { mergeFullDataFromSnapshot as mergeDislikeFromSnapshot } from '../../../source/packages/shared/app/modules/sync/shared/dislike/mergeFromSnapshot'

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
function installFakeNativeBridge(): {
  files: Map<string, Uint8Array>
  calls: string[]
  client: BridgeClient
  emitLifecycle: (name: string, ...args: unknown[]) => void
  holdNextWrite: () => void
  releaseHeldWrite: () => void
  hasHeldWrite: () => boolean
  failNextWrite: () => void
  holdNextRead: (count?: number) => void
  releaseHeldReads: () => number
  terminationAcks: Array<[string, string]>
  proxyTargets: Map<string, { url: string; headers: Record<string, string> }>
} {
  const files = new Map<string, Uint8Array>()
  const calls: string[] = []
  const lifecycleCallbacks = new Map<string, string[]>()
  const terminationAcks: Array<[string, string]> = []
  const httpAttempts = new Map<string, number>()
  const proxyTargets = new Map<string, { url: string; headers: Record<string, string> }>()
  let holdNext = false
  let failNext = false
  let heldWrite: (() => void) | undefined
  let holdReads = 0
  const heldReads: Array<() => void> = []

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
      case 'fs.writeFileAtomic': {
        if (name === 'fs.writeFileAtomic' && failNext) {
          failNext = false
          reply({ code: 'EIO', message: 'simulated write failure' })
          return
        }
        const finish = () => {
          files.set(first, second ?? new Uint8Array())
          reply(null, null)
        }
        if (name === 'fs.writeFileAtomic' && holdNext) {
          holdNext = false
          heldWrite = finish
        } else finish()
        return
      }
      case 'lifecycle.onBackground':
      case 'lifecycle.onForeground':
      case 'lifecycle.onTrimMemory':
      case 'lifecycle.onBeforeTerminate': {
        const callback = callbackName(0)
        if (callback) lifecycleCallbacks.set(name, [...(lifecycleCallbacks.get(name) ?? []), callback])
        reply(null, null)
        return
      }
      case 'lifecycle.acknowledgeTermination':
        terminationAcks.push([String(args[0]), String(args[1])])
        reply(null, null)
        return
      case 'fs.readFile': {
        const snapshot = files.get(first)
        const finish = () => {
          if (snapshot == null) {
            reply({ code: 'ENOENT', message: `no such file: ${first}` })
            return
          }
          // 请求时取快照：稍后写文件不能改变这次“慢读”看到的内容。
          reply(null, new Uint8Array(snapshot))
        }
        if (holdReads > 0) {
          holdReads--
          heldReads.push(finish)
        } else finish()
        return
      }
      case 'fs.readdir': {
        const prefix = first.endsWith('/') ? first : `${first}/`
        const children = new Map<string, { isFile: boolean; size: number; mtimeMs: number }>()
        for (const [filePath, bytes] of files) {
          if (!filePath.startsWith(prefix)) continue
          const rest = filePath.slice(prefix.length)
          const slash = rest.indexOf('/')
          if (slash === -1) {
            children.set(rest, { isFile: true, size: bytes.byteLength, mtimeMs: 0 })
          } else {
            const name = rest.slice(0, slash)
            if (!children.has(name)) children.set(name, { isFile: false, size: 0, mtimeMs: 0 })
          }
        }
        if (!children.size) {
          reply({ code: 'ENOENT', message: `no such directory: ${first}` })
          return
        }
        reply(
          null,
          [...children.entries()].map(([name, entry]) => ({
            path: `${prefix}${name}`,
            name,
            isFile: entry.isFile,
            isDirectory: !entry.isFile,
            size: entry.size,
            mtimeMs: entry.mtimeMs,
          }))
        )
        return
      }
      case 'fs.exists':
        reply(null, files.has(first))
        return
      case 'http.request': {
        const options = args[1] as { needRaw?: boolean }
        if (first.endsWith('/flaky')) {
          const attempt = (httpAttempts.get(first) ?? 0) + 1
          httpAttempts.set(first, attempt)
          reply(
            null,
            attempt < 3
              ? { statusCode: 503, headers: { 'Content-Type': 'text/plain' }, body: 'unavailable' }
              : { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: 'recovered' },
          )
          return
        }
        if (first.endsWith('/large')) {
          files.set('/tmp/response', new TextEncoder().encode('large response'))
          reply(null, { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, filePath: '/tmp/response' })
        } else {
          reply(null, options.needRaw
            ? { statusCode: 200, headers: { 'Content-Type': 'application/octet-stream' }, raw: new Uint8Array([0, 127, 255]) }
            : { statusCode: 207, headers: { 'Content-Type': 'application/xml' }, body: '<multistatus />' })
        }
        return
      }
      case 'http.registerProxyTarget':
        proxyTargets.set(String(args[0]), { url: String(args[1]), headers: args[2] as Record<string, string> })
        reply(null, null)
        return
      case 'http.unregisterProxyTarget':
        proxyTargets.delete(String(args[0]))
        reply(null, null)
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
  return {
    files, calls, client, proxyTargets,
    emitLifecycle(name, ...args) {
      for (const callback of lifecycleCallbacks.get(name) ?? []) {
        client.handleFrame(JSON.stringify([CALL_TYPE.CALLBACK_REQUEST, callback, args.map(encodeValue)]))
      }
    },
    terminationAcks,
    holdNextWrite() { holdNext = true },
    failNextWrite() { failNext = true },
    hasHeldWrite() { return heldWrite !== undefined },
    holdNextRead(count = 1) { holdReads += count },
    releaseHeldReads() {
      const pending = heldReads.splice(0)
      for (const finish of pending) finish()
      return pending.length
    },
    releaseHeldWrite() {
      if (!heldWrite) throw new Error('no held write')
      const finish = heldWrite
      heldWrite = undefined
      finish()
    },
  }
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

async function testConcurrentSafeFs(native: ReturnType<typeof installFakeNativeBridge>): Promise<void> {
  const path = '/qa/settings.json'
  await preloadFile(path)
  const store = new Store(path, false)
  store.set('value', 'first')
  native.holdNextWrite()
  const first = flushAll()
  store.set('value', 'second')
  const second = flushAll()
  let finished = false
  void second.then(() => { finished = true })
  await new Promise((resolve) => setImmediate(resolve))
  assertTrue(!finished, '旧写入尚未结束时不能确认设置落盘')
  native.releaseHeldWrite()
  await Promise.all([first, second])
  const saved = JSON.parse(new TextDecoder().decode(native.files.get(path))) as { value: string }
  assertEqual(saved.value, 'second', '并发写入后应保存最新设置')

  store.set('value', 'retry')
  native.failNextWrite()
  const previousError = console.error
  let failureCode = ''
  try {
    console.error = () => {}
    await flushAll()
  } catch (error) {
    failureCode = (error as { code?: string }).code ?? ''
  } finally {
    console.error = previousError
  }
  assertEqual(failureCode, 'EIO', '落盘失败必须传给等待方')
  await flushAll()
  const retried = JSON.parse(new TextDecoder().decode(native.files.get(path))) as { value: string }
  assertEqual(retried.value, 'retry', '失败后应保留最新设置以便重试')
}

async function testSafeFsPreloadRace(native: ReturnType<typeof installFakeNativeBridge>): Promise<void> {
  const readCalls = (): number => native.calls.filter((name) => name === 'fs.readFile').length
  const writePath = '/qa/preload-race/settings.json'
  native.files.set(writePath, new TextEncoder().encode(JSON.stringify({ old: true })))

  const readsBeforeWrite = readCalls()
  native.holdNextRead(1)
  const firstLoad = preloadFile(writePath)
  const secondLoad = preloadFile(writePath)
  await new Promise((resolve) => setImmediate(resolve))

  const store = new Store(writePath, false)
  store.set('fresh', 'value')
  assertEqual(native.releaseHeldReads(), 1, '两个并发预载应共享同一次挂起的读取')
  await Promise.all([firstLoad, secondLoad])
  assertEqual(readCalls() - readsBeforeWrite, 1, '同一路径的并发预载只能发起一次读取')
  const cached = getCachedFile(writePath)
  assertTrue(cached != null, '预载完成后应有缓存')
  assertEqual(
    JSON.parse(cached!.toString('utf8')),
    { fresh: 'value' },
    '慢读返回时不得覆盖写穿后的 dirty 缓存',
  )
  await flushAll()
  const flushed = JSON.parse(new TextDecoder().decode(native.files.get(writePath))) as Record<string, unknown>
  assertEqual(flushed, { fresh: 'value' }, '落盘内容也必须是新值')

  const reinstallPath = '/qa/preload-race/reinstall.json'
  native.files.set(reinstallPath, new TextEncoder().encode(JSON.stringify({ generation: 'old' })))
  const readsBeforeReinstall = readCalls()
  native.holdNextRead(1)
  const staleLoad = preloadFile(reinstallPath)
  await new Promise((resolve) => setImmediate(resolve))
  await evictFile(reinstallPath)
  native.files.set(reinstallPath, new TextEncoder().encode(JSON.stringify({ generation: 'new' })))
  const freshLoad = preloadFile(reinstallPath)
  assertEqual(native.releaseHeldReads(), 1, '重装前的旧读取应仍处于挂起状态')
  await Promise.all([staleLoad, freshLoad])
  assertEqual(readCalls() - readsBeforeReinstall, 2, '卸载后重新预载必须重新读取文件')
  const reinstalled = getCachedFile(reinstallPath)
  assertTrue(reinstalled != null, '重装后应有缓存')
  assertEqual(
    JSON.parse(reinstalled!.toString('utf8')),
    { generation: 'new' },
    'evict 之后返回的旧读取不得覆盖重装后的新缓存',
  )

  const discardPath = '/qa/preload-race/discard.json'
  native.files.set(discardPath, new TextEncoder().encode(JSON.stringify({ original: true })))
  await preloadFile(discardPath)
  const staleStore = new Store(discardPath, false, true)
  staleStore.set('stale', true)
  await evictFile(discardPath)
  assertEqual(getCachedFile(discardPath), null, 'evict 后必须立即清掉缓存')
  await new Promise((resolve) => setTimeout(resolve, 350))
  const preserved = JSON.parse(new TextDecoder().decode(native.files.get(discardPath))) as Record<string, unknown>
  assertEqual(preserved, { original: true }, '卸载时未落盘的 dirty 内容不能晚到覆盖已删除文件')
}

async function testExtensionConfigStore(native: ReturnType<typeof installFakeNativeBridge>): Promise<void> {
  const root = '/data/user/0/com.anylisten/files/app/extension/datas'
  const configPath = `${root}/ext-c/configuration.json`
  const extension = {
    id: 'ext-c',
    dataDirectory: `${root}/ext-c`,
  } as unknown as AnyListen.Extension.Extension

  native.files.set(configPath, new TextEncoder().encode(JSON.stringify({ legacy: 'kept', apiKey: 'old' })))

  // 不先扫描目录：getConfig 必须自己完成懒预载，覆盖运行期新安装/重装扩展。
  assertEqual(await getExtensionConfig(extension), { legacy: 'kept', apiKey: 'old' }, '懒预载读取现有配置')

  await saveExtensionConfig(extension, { legacy: 'kept', apiKey: 'new' })
  const written = JSON.parse(new TextDecoder().decode(native.files.get(configPath))) as Record<string, unknown>
  assertEqual(written, { legacy: 'kept', apiKey: 'new' }, 'saveConfig 返回前必须已落盘')

  native.failNextWrite()
  let failureCode = ''
  const previousError = console.error
  try {
    console.error = () => {}
    await saveExtensionConfig(extension, { legacy: 'kept', apiKey: 'failed' })
  } catch (error) {
    failureCode = (error as { code?: string }).code ?? ''
  } finally {
    console.error = previousError
  }
  assertEqual(failureCode, 'EIO', 'saveConfig 必须向调用方报告写盘失败')

  await saveExtensionConfig(extension, { legacy: 'kept', apiKey: 'recovered' })
  const recovered = JSON.parse(new TextDecoder().decode(native.files.get(configPath))) as Record<string, unknown>
  assertEqual(recovered, { legacy: 'kept', apiKey: 'recovered' }, '失败后可重试写穿')

  // 这里只证明同一配置路径的写盘串行、最终值完整；不把两次独立
  // getConfig→merge→saveConfig 的并发合并声称为安全（上游那段读改写仍不是原子操作）。
  native.holdNextWrite()
  const first = saveExtensionConfig(extension, { value: 'first' })
  const second = saveExtensionConfig(extension, { value: 'second' })
  await new Promise((resolve) => setImmediate(resolve))
  native.releaseHeldWrite()
  await Promise.all([first, second])
  const serialized = JSON.parse(new TextDecoder().decode(native.files.get(configPath))) as Record<string, unknown>
  assertEqual(serialized, { value: 'second' }, '同一路径的并发写盘按调用顺序收敛')

  await unloadExtensionConfig(extension)
  assertEqual(getCachedFile(configPath), null, '卸载后必须清掉配置缓存')
  native.files.set(configPath, new TextEncoder().encode(JSON.stringify({ reinstalled: true })))
  assertEqual(await getExtensionConfig(extension), { reinstalled: true }, '同 ID 重装应读取新文件而不是旧缓存')

  const raceConfigPath = `${root}/ext-race/configuration.json`
  const raceExtension = {
    id: 'ext-race',
    dataDirectory: `${root}/ext-race`,
  } as unknown as AnyListen.Extension.Extension
  native.files.set(raceConfigPath, new TextEncoder().encode(JSON.stringify({ generation: 'old' })))
  native.holdNextRead(1)
  const reading = getExtensionConfig(raceExtension)
  await new Promise((resolve) => setImmediate(resolve))
  await unloadExtensionConfig(raceExtension)
  assertEqual(native.releaseHeldReads(), 1, 'getConfig 的慢读应仍处于挂起状态')
  let canceledCode = ''
  try {
    await reading
  } catch (error) {
    canceledCode = (error as { code?: string }).code ?? ''
  }
  assertEqual(canceledCode, 'ESTALE', '卸载期间失效的 getConfig 必须报错，不能返回空配置')
  assertEqual(getCachedFile(raceConfigPath), null, '失效的 getConfig 不能在 evict 后重建旧缓存')
  native.files.set(raceConfigPath, new TextEncoder().encode(JSON.stringify({ generation: 'fresh' })))
  assertEqual(await getExtensionConfig(raceExtension), { generation: 'fresh' }, '重装后的 getConfig 应读取新配置')
}

async function testExtensionSettingsQueue(native: ReturnType<typeof installFakeNativeBridge>): Promise<void> {
  const root = '/data/user/0/com.anylisten/files/app/extension/datas'
  const firstPath = `${root}/ext-queue-a/configuration.json`
  const secondPath = `${root}/ext-queue-b/configuration.json`
  const first = {
    id: 'ext-queue-a',
    dataDirectory: `${root}/ext-queue-a`,
    loaded: false,
    internal: false,
  } as unknown as AnyListen.Extension.Extension
  const second = {
    id: 'ext-queue-b',
    dataDirectory: `${root}/ext-queue-b`,
    loaded: false,
    internal: false,
  } as unknown as AnyListen.Extension.Extension

  native.files.set(firstPath, new TextEncoder().encode(JSON.stringify({ base: true })))
  native.files.set(secondPath, new TextEncoder().encode(JSON.stringify({ base: true })))
  extensionState.extensions = [first, second]
  extensionState.extensionSettings = null
  try {
    await preloadFile(firstPath)
    await Promise.all([
      updateExtensionSettings(first.id, { alpha: 1 }),
      updateExtensionSettings(first.id, { beta: 2 }),
    ])
    const merged = JSON.parse(new TextDecoder().decode(native.files.get(firstPath))) as Record<string, unknown>
    assertEqual(merged, { base: true, alpha: 1, beta: 2 }, '同一扩展的并发更新必须按读改写顺序合并，不能互相覆盖字段')

    native.failNextWrite()
    let failureCode = ''
    const previousError = console.error
    try {
      console.error = () => {}
      await updateExtensionSettings(first.id, { failed: true })
    } catch (error) {
      failureCode = (error as { code?: string }).code ?? ''
    } finally {
      console.error = previousError
    }
    assertEqual(failureCode, 'EIO', '队列中的写盘失败必须传给调用方')
    await updateExtensionSettings(first.id, { recovered: true })
    const recovered = JSON.parse(new TextDecoder().decode(native.files.get(firstPath))) as Record<string, unknown>
    assertEqual(recovered.recovered, true, '一次写入失败后队列仍能继续')
    assertEqual(recovered.beta, 2, '失败后的下一次更新仍应基于完整配置')

    native.holdNextWrite()
    const firstUpdate = updateExtensionSettings(first.id, { held: true })
    const deadline = Date.now() + 1000
    while (!native.hasHeldWrite() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assertTrue(native.hasHeldWrite(), '第一个扩展应已进入被挂起的写盘')

    let secondFinished = false
    const secondUpdate = updateExtensionSettings(second.id, { parallel: true }).then(() => {
      secondFinished = true
    })
    await Promise.race([
      secondUpdate,
      new Promise((resolve) => setTimeout(resolve, 500)),
    ])
    assertTrue(secondFinished, '不同扩展的更新不能互相阻塞')
    const secondSaved = JSON.parse(new TextDecoder().decode(native.files.get(secondPath))) as Record<string, unknown>
    assertEqual(secondSaved, { base: true, parallel: true }, '第二个扩展应独立完成写入')

    native.releaseHeldWrite()
    await Promise.all([firstUpdate, secondUpdate])
  } finally {
    extensionState.extensions = []
    extensionState.extensionSettings = null
  }
}

async function testSqliteLifecycle(native: ReturnType<typeof installFakeNativeBridge>): Promise<void> {
  await initSqlite({ locateFile: () => nodePath.resolve('node_modules/sql.js/dist/sql-wasm.wasm') })
  registerSqliteLifecycle()
  const path = '/qa/lifecycle.db'
  const db = new Database(path)
  try {
    db.exec('CREATE TABLE t (value TEXT)')
    db.prepare('INSERT INTO t (value) VALUES (?)').run('first')
    native.emitLifecycle('lifecycle.onBackground')
    const deadline = Date.now() + 1000
    while (!native.files.has(path) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assertTrue(native.files.has(path), '后台事件应在定时落盘前触发数据库写入')
    await db.flushNow()

    native.holdNextWrite()
    db.prepare('INSERT INTO t (value) VALUES (?)').run('second')
    const firstFlush = db.flushNow()
    db.prepare('INSERT INTO t (value) VALUES (?)').run('third')
    const secondFlush = db.flushNow()
    native.releaseHeldWrite()
    await Promise.all([firstFlush, secondFlush])

    db.prepare('INSERT INTO t (value) VALUES (?)').run('fourth')
    native.holdNextWrite()
    native.emitLifecycle('lifecycle.onBeforeTerminate', '42')
    assertEqual(native.terminationAcks, [], '写盘完成前不能确认退出')
    native.releaseHeldWrite()
    const ackDeadline = Date.now() + 1000
    while (!native.terminationAcks.length && Date.now() < ackDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assertEqual(native.terminationAcks, [['42', 'db']], '数据库落盘后确认对应退出请求')

    assertTrue(await preloadDatabase(path), '落盘数据库可重新读取')
    const reopened = new Database(path, { fileMustExist: true })
    try {
      const row = reopened.prepare('SELECT COUNT(*) AS count FROM t').get() as { count: number }
      assertEqual(row.count, 4, '写盘期间和退出前新增的记录都必须落盘')
    } finally {
      reopened.close()
    }
  } finally {
    db.close()
  }
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
  const callbacksBefore = client.callbackCount
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
  assertEqual(client.callbackCount, callbacksBefore, 'listTree 结束后回调注册已释放')
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

function testLyricMetadataFilter(): void {
  const lyric = [
    '[00:00.000]晴天 - 周杰伦 (Jay Chou)',
    '[00:00.100]合声：周杰伦',
    '[00:00.200]合声编写：周杰伦',
    '[00:00.300]录音助理：刘勇志',
    '[00:00.400]录音工程：杨瑞代（Alfa Studio）',
    '[00:00.500]混音工程：杨大纬（杨大纬录音工作室）',
    '[00:08.000]故事的小黄花',
    '[00:12.000]爱：是一种需要练习的勇敢',
    '[00:15.000]我坐在窗边 - 看云走散',
  ].join('\n')

  assertEqual(
    filterLyricMetadata(lyric).split('\n'),
    [
      '[00:08.000]故事的小黄花',
      '[00:12.000]爱：是一种需要练习的勇敢',
      '[00:15.000]我坐在窗边 - 看云走散',
    ],
    '歌词制作信息过滤'
  )
}

async function testExtensionVmMessages(): Promise<void> {
  await vmShim.initVmShim()
  let received: unknown
  const ctx = vmShim.createContext({
    hostCall: (message: unknown) => { received = message },
  })
  try {
    vmShim.runInContext(`globalThis.receive = message => {
      if (!Array.isArray(message)) throw new Error('message is not array')
      hostCall(message)
      return message
    }`, ctx)
    const receive = (ctx as unknown as { receive: (message: unknown) => unknown }).receive
    const message = [0, 'request', ['test'], [{ title: '中文', count: 3 }], []]
    assertEqual(receive(message), message, 'host → sandbox → host')
    assertEqual(received, message, 'sandbox → host message')
    const bytes = [1, { raw: new Uint8Array([0, 127, 255]) }]
    const echoed = receive(bytes) as [number, { raw: Uint8Array }]
    assertTrue(echoed[1].raw instanceof Uint8Array, 'sandbox 二进制类型必须保留')
    assertEqual(Array.from(echoed[1].raw), [0, 127, 255], 'sandbox 二进制内容')
    assertTrue((received as [number, { raw: unknown }])[1].raw instanceof Uint8Array, 'host 二进制类型必须保留')
  } finally {
    vmShim.destroyContext(ctx)
  }
}

async function testExtensionVmJobs(): Promise<void> {
  await vmShim.initVmShim()
  const messages: unknown[] = []
  const ctx = vmShim.createContext({ hostCall: (message: unknown) => { messages.push(message) } })
  try {
    vmShim.runInContext(`void Promise.resolve().then(() => hostCall(['ready']))`, ctx)
    assertEqual(messages, [['ready']], 'sandbox Promise jobs')
    assertEqual(vmShim.runInContext(`Promise.resolve('done')`, ctx), { type: 'fulfilled', value: 'done' }, 'fulfilled Promise 返回值')
    assertEqual(vmShim.runInContext(`new Promise(() => {})`, ctx), { type: 'pending' }, 'pending Promise 返回值')
    assertEqual(vmShim.runInContext(`1 + 1`, ctx), 2, 'Promise 返回后上下文仍可用')
  } finally {
    vmShim.destroyContext(ctx)
  }
}

export async function qaVmGrowth(): Promise<void> {
  await vmShim.initVmShim()
  const ctx = vmShim.createContext()
  const state = (ctx as unknown as Record<symbol, { runtime: unknown }>)[Symbol.for('anylisten.vm.context')]
  const runtime = state.runtime as { module: { HEAPU8: Uint8Array }; contextMap: Map<number, unknown> }
  const beforeBytes = runtime.module.HEAPU8.buffer.byteLength
  const contextsBefore = [...runtime.contextMap.keys()]
  try {
    vmShim.runInContext(`void Promise.resolve().then(() => {
      globalThis.largeAllocation = new Uint8Array(32 * 1024 * 1024)
      globalThis.largeAllocation.fill(1)
    })`, ctx)
    const afterBytes = runtime.module.HEAPU8.buffer.byteLength
    assertTrue(afterBytes > beforeBytes, `job 必须触发 WASM 内存扩容: ${beforeBytes} → ${afterBytes}`)
    assertEqual([...runtime.contextMap.keys()], contextsBefore, '内存扩容后不得新建 QuickJS context')
    assertEqual(vmShim.runInContext('largeAllocation.length', ctx), 32 * 1024 * 1024, '扩容任务完成')
    console.log(`[vm-growth] WASM heap ${beforeBytes} → ${afterBytes}; contexts ${contextsBefore.length} → ${runtime.contextMap.size}`)
  } finally {
    vmShim.destroyContext(ctx)
  }
}

async function testExtensionVmIsolateBridge(): Promise<void> {
  await vmShim.initVmShim()
  let received = ''
  const ctx = vmShim.createContext({ hostObj: { onmessage: (message: string) => { received = message } } })
  try {
    vmShim.runInContext(`{
      const host = globalThis.hostObj
      delete globalThis.hostObj
      globalThis.contextObj = { onmessage: message => host.onmessage(message) }
    }`, ctx)
    const bridge = (ctx as unknown as { contextObj: { onmessage: (message: string) => void } }).contextObj
    vmShim.runInContext('delete globalThis.contextObj', ctx)
    bridge.onmessage('isolate message')
    assertEqual(received, 'isolate message', 'isolated context 消息')
  } finally {
    vmShim.destroyContext(ctx)
  }
}

async function testIsolateTimersAndCleanup(): Promise<void> {
  await vmShim.initVmShim()
  const id = 'qa-isolate-timers'
  const received: string[] = []
  const unsubscribers: Array<() => void> = []
  contextState.vmContexts.set(id, {
    unsubscribeEvents: unsubscribers,
    preloadFuncs: { isolateContextMessage: async (_contextId: string, message: string) => {
      received.push(JSON.parse(message) as string)
    } },
  } as unknown as (typeof contextState.vmContexts extends Map<string, infer T> ? T : never))
  const api = createIsolateFuncs({ id, grant: ['isolate_context'] } as AnyListen.Extension.Extension)
  try {
    const ctx = await api.createIsolateContext()
    await api.runInIsolateContext(ctx, `
      const canceled = setTimeout(() => postMessage('canceled'), 5)
      clearTimeout(canceled)
      setTimeout(() => postMessage('ready'), 5)
    `)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assertEqual(received, ['ready'], '隔离定时器触发和取消')
    await api.destroyIsolateContext(ctx)
    let rejected = false
    try { await api.runInIsolateContext(ctx, '1') } catch { rejected = true }
    assertTrue(rejected, '已销毁的隔离上下文不可继续使用')

    const contexts: string[] = []
    for (let index = 0; index < 5; index++) contexts.push(await api.createIsolateContext())
    rejected = false
    try { await api.createIsolateContext() } catch { rejected = true }
    assertTrue(rejected, '每个扩展的隔离上下文上限为 5')
    for (const context of contexts) await api.destroyIsolateContext(context)
    const reusable = await api.createIsolateContext()
    await api.runInIsolateContext(reusable, `setTimeout(() => postMessage('after destroy'), 10)`)
    await api.destroyIsolateContext(reusable)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assertEqual(received, ['ready'], '销毁后不得触发定时器')
  } finally {
    for (const unsubscribe of unsubscribers) unsubscribe()
    contextState.vmContexts.delete(id)
  }
}

async function testUiIpcCallbacks(): Promise<void> {
  let folderEnd: ((error?: string | null) => Promise<void>) | undefined
  let syncMerge: (() => Promise<string>) | undefined
  const seen: unknown[] = []
  const client = createMessage2Call({
    exposeObj: {},
    sendMessage: (message) => queueMicrotask(() => server.message(message as never)),
  })
  const server = createMessage2Call({
    exposeObj: {
      async importData(_path: string, select: (types: string[]) => Promise<string[]>, merge: () => Promise<string>) {
        seen.push(await select(['songlist']), await merge())
      },
      async runSyncWebDAV(merge: () => Promise<string>) { syncMerge = merge },
      async addFolderMusics(_id: string, _paths: string[], onEnd: typeof folderEnd) {
        folderEnd = onEnd
        return 'task-1'
      },
    } as unknown as ReadObj,
    sendMessage: (message) => queueMicrotask(() => client.message(message as never)),
  })
  const remote = withIpcCallbacks(client.remote as unknown as AnyListen.IPC.ServerIPC)
  try {
    await remote.importData('/backup.alcfg', async (types) => types, async () => 'overwrite')
    await remote.runSyncWebDAV(async () => 'merge')
    if (!syncMerge) throw new Error('sync callback was not forwarded')
    seen.push(await syncMerge())
    let finished = false
    assertEqual(await remote.addFolderMusics('love', ['/music'], () => { finished = true }), 'task-1', 'scan task id')
    if (!folderEnd) throw new Error('scan callback was not forwarded')
    await folderEnd(null)
    assertTrue(finished, 'scan callback must remain active after task id returns')
    assertEqual(seen, [['songlist'], 'overwrite', 'merge'], 'backup and sync callbacks')
  } finally {
    client.destroy()
    server.destroy()
  }
}

async function testExtensionFileDialogs(): Promise<void> {
  let openOptions: AnyListen.OpenDialogOptions | undefined
  const selected = await openExtensionFileDialog('音源扩展', {
    title: '选择音源', defaultPath: '/sources', openLabel: '导入',
    canSelectMany: true, filters: { JavaScript: ['js'] },
  }, async (options) => {
    openOptions = options
    return { canceled: false, filePaths: ['/sources/a.js', '/sources/b.js'] }
  })
  assertEqual(selected, ['/sources/a.js', '/sources/b.js'], '多选结果')
  assertEqual(openOptions, {
    modalTitle: '音源扩展', title: '选择音源', defaultPath: '/sources',
    filters: [{ name: 'JavaScript', extensions: ['js'] }],
    properties: ['openFile', 'multiSelections'], buttonLabel: '导入',
  }, '文件选择参数')
  const canceled = await openExtensionFileDialog('', {
    title: '选择目录', canSelectFiles: false, canSelectFolders: true,
  }, async (options) => {
    assertEqual(options.properties, ['openDirectory'], '目录选择参数')
    return { canceled: true, filePaths: ['/must-not-return'] }
  })
  assertEqual(canceled, [], '取消时不得返回路径')
  const saved = await saveExtensionFileDialog('音源扩展', {
    title: '导出音源', canSelectFolder: true, saveLabel: '导出',
  }, async (options) => {
    assertTrue(options.selectFolder === true && options.buttonLabel === '导出', '保存目录参数')
    return { canceled: false, filePath: '/export' }
  })
  assertEqual(saved, '/export', '保存目录')
  assertEqual(await saveExtensionFileDialog('', { title: '取消' }, async () => ({
    canceled: true, filePath: '/must-not-return',
  })), '', '取消保存时不得返回路径')
}

async function testHttpResponseCompatibility(native: ReturnType<typeof installFakeNativeBridge>): Promise<void> {
  const text = await request<string>('https://example.test/dav', { method: 'PROPFIND' })
  assertEqual(text.headers['content-type'], 'application/xml', '响应头名称归一化')
  assertEqual(text.body, '<multistatus />', 'XML 响应文本')
  const raw = await request('https://example.test/data', { needRaw: true })
  assertEqual(Array.from(raw.raw), [0, 127, 255], '原始响应字节')
  const stream = await request<{ bytes: () => Promise<Uint8Array> }>('https://example.test/data', { needBody: true })
  assertEqual(Array.from(await stream.body.bytes()), [0, 127, 255], '流式响应字节')
  const large = await request<string>('https://example.test/large')
  assertEqual(large.body, 'large response', '临时文件中的响应文本')

  const callsBeforeRetry = native.calls.filter((name) => name === 'http.request').length
  const recovered = await request<string>('https://example.test/flaky')
  assertEqual(recovered.body, 'recovered', '503 后应重试并返回最终成功响应')
  assertEqual(
    native.calls.filter((name) => name === 'http.request').length - callsBeforeRetry,
    3,
    '503 应重试两次',
  )
}

async function testProxyRegistration(native: ReturnType<typeof installFakeNativeBridge>): Promise<void> {
  proxyServerState.proxyBaseUrl = '/api/p_static'
  const path = await createProxy('https://example.test/song.mp3', {
    headers: { Authorization: 'test-header', Accept: ['audio/mpeg', 'audio/*'] },
    query: { key: 'hello world' },
  })
  assertTrue(path.startsWith('al-ps-host:/api/p_static/'), '代理地址保留上游虚拟路径')
  const name = path.slice(path.lastIndexOf('/') + 1)
  assertEqual(native.proxyTargets.get(name), {
    url: 'https://example.test/song.mp3?key=hello+world',
    headers: { Authorization: 'test-header', Accept: 'audio/mpeg, audio/*' },
  }, '原生代理登记地址、查询参数和请求头')
  await ports.http.unregisterProxyTarget(name)
  assertTrue(!native.proxyTargets.has(name), '原生代理登记可移除')
}

async function testSyncConflictMerge(native: { files: Map<string, Uint8Array> }): Promise<void> {
  native.files.set('/qa/deviceid', new TextEncoder().encode('qa-device'))
  await initDeviceId('/qa')

  const data = (items: Array<[string, number]>): AnyListen.List.ListDataFull => {
    const list = items.map(([id, updateTime]) => ({ id, isLocal: false, meta: { updateTime, deviceId: 'other' } }))
    const meta = { updateTime: 1, playCount: 0, songCount: list.length }
    return {
      defaultList: { id: 'default', type: 'default', meta, list },
      loveList: { id: 'love', type: 'default', meta: { ...meta, songCount: 0 }, list: [] },
      userList: [],
    } as unknown as AnyListen.List.ListDataFull
  }
  const base = data([['shared', 1], ['removed', 1]])
  const local = data([['shared', 2], ['local', 2]])
  const remote = data([['shared', 3], ['removed', 1], ['remote', 3]])

  const reconciled = mergeFullDataFromSnapshot(local, remote, base, 'bottom')
  assertEqual(reconciled.defaultList.list.map((item) => item.id), ['shared', 'local', 'remote'], '快照合并保留双方新增并应用删除')
  assertEqual(reconciled.defaultList.list[0].meta.updateTime, 3, '快照合并采用较新的曲目元数据')

  let choices = 0
  const [merged, updateLocal, updateRemote] = await mergeFullData(
    local, remote, 'bottom', async () => { choices++; return 'merge_local_remote' }, async () => local,
  )
  assertEqual(choices, 1, '首次同步冲突选择次数')
  assertEqual(merged.defaultList.list.map((item) => item.id), ['shared', 'local', 'removed', 'remote'], '首次同步合并两端歌曲')
  assertTrue(updateLocal && updateRemote, '首次合并需要更新两端')

  let cancelMessage = ''
  try {
    await mergeFullData(local, remote, 'bottom', async () => 'cancel', async () => local)
  } catch (error) {
    cancelMessage = error instanceof Error ? error.message : String(error)
  }
  assertEqual(cancelMessage, CANCELED_ERROR_MSG, '取消合并必须中止同步')
  assertEqual(
    mergeDislikeFromSnapshot('keep\nlocal', 'KEEP\nremoved\nremote', 'keep\nremoved'),
    'keep\nlocal\nremote',
    '不喜欢规则合并须应用删除、保留两端新增并忽略大小写',
  )
}

function testSettingsBackup(): void {
  const current = structuredClone(defaultSetting)
  current['player.volume'] = 0.8
  current['sync.webdav.password'] = 'current-password'
  current['network.proxy.host'] = 'current-proxy'

  const exported = createSettingsBackupData(current)
  assertEqual(exported.version, SETTINGS_BACKUP_VERSION, '设置备份版本')
  assertEqual(exported.data['player.volume'], 0.8, '设置备份包含当前值')
  assertTrue(exported.data !== current, '设置备份必须是独立快照')

  const imported = structuredClone(current)
  imported.version = '9.9.9'
  imported['player.volume'] = 0.35
  imported['sync.webdav.password'] = 'restored-password'
  imported['network.proxy.host'] = 'imported-proxy'
  const importedUnknown = imported as unknown as Record<string, unknown>
  importedUnknown['player.isMute'] = { invalid: true }
  importedUnknown['retired.setting'] = 'must-not-restore'

  const picked = pickRestorableSettings(imported, current)
  assertEqual(picked['player.volume'], 0.35, '恢复基础类型设置')
  assertEqual(picked['sync.webdav.password'], 'restored-password', '恢复同步凭据')
  assertTrue(!('version' in picked), '恢复时不得覆盖设置版本')
  assertTrue(!('network.proxy.host' in picked), '恢复时跳过运行时网络代理')
  assertTrue(!('player.isMute' in picked), '恢复时跳过非法复合值')
  assertTrue(!('retired.setting' in picked), '恢复时跳过已废弃字段')
  assertEqual(pickRestorableSettings(null, current), {}, '空备份不产生设置更新')
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
  check('歌词制作信息过滤', testLyricMetadataFilter)
  check('设置备份导出与恢复筛选', testSettingsBackup)
  await checkAsync('扩展沙箱任务内存扩容与销毁', qaVmGrowth)
  await checkAsync('扩展沙箱双向消息', testExtensionVmMessages)
  await checkAsync('扩展沙箱 Promise 回调', testExtensionVmJobs)
  await checkAsync('扩展隔离上下文桥接', testExtensionVmIsolateBridge)
  await checkAsync('隔离上下文定时器、上限与释放', testIsolateTimersAndCleanup)
  await checkAsync('备份、同步与目录扫描回调桥接', testUiIpcCallbacks)
  await checkAsync('扩展文件对话框多选、目录与取消', testExtensionFileDialogs)

  const native = installFakeNativeBridge()
  await checkAsync('SQLite 后台立即落盘及并发写入', () => testSqliteLifecycle(native))
  await checkAsync('同步冲突与快照合并', () => testSyncConflictMerge(native))
  await checkAsync('HTTP 响应头、原始字节与 503 重试', () => testHttpResponseCompatibility(native))
  await checkAsync('扩展音频代理登记与请求参数', () => testProxyRegistration(native))
  await checkAsync('Store + SafeFS（经 Ports RPC 落盘）', () => testStore(native))
  await checkAsync('设置并发写入和退出等待', () => testConcurrentSafeFs(native))
  await checkAsync('SafeFS 并发预载、慢读与卸载重装', () => testSafeFsPreloadRace(native))
  await checkAsync('扩展配置写穿、失败与卸载重装', () => testExtensionConfigStore(native))
  await checkAsync('扩展设置并发更新按 ID 串行、不同扩展互不阻塞', () => testExtensionSettingsQueue(native))
  await checkAsync('listTree 流式回调（[2,…] 反推 + 回调释放）', () =>
    testStreamingListTree(native.client)
  )
  await checkAsync('PortError 跨边界回传', testPortErrorPropagation)

  return { results, nativeCalls: native.calls.length }
}
