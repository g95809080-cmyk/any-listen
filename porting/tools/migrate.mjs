#!/usr/bin/env node
/**
 * Any Listen 桌面 → Android 数据迁移工具
 * ============================================================================
 * 设计依据：docs/phase2-architecture.md §5（数据迁移方案）、§9.0（E-13 勘误）
 * 本文件为零依赖 Node 脚本（Node ≥ 22.5，使用内置 node:sqlite）
 *
 * 用法：
 *   node porting/tools/migrate.mjs --input <桌面数据目录> --output <输出目录> [选项]
 *
 * 最小可用示例：
 *   node porting/tools/migrate.mjs \
 *     --input "%APPDATA%/anylisten/AnyListenDatas" \
 *     --output ./migration-out \
 *     --path-map "D:\\Music=/storage/emulated/0/Music"
 *
 * 选项：
 *   --input <dir>            桌面数据目录（必填）。等价于 AnyListenDatas 目录
 *   --output <dir>           输出目录（必填，会自动创建）
 *   --path-map <from=to>     本地音乐路径映射，可重复。Windows 建议用 "D:\\Music=/storage/emulated/0/Music"
 *   --device-id <uuid>       指定新 deviceId；缺省则生成新 UUID 并写入 deviceid 文件
 *   --db <path>              覆盖 DB 文件路径（默认 <input>/anylisten.data.db）
 *   --dry-run                只做检查与预演，不写任何文件（DB 改动在临时副本上验证）
 *   --force                  跳过阻塞性检查（db_version 不符 / 表结构不符）
 *   --skip-verify            跳过 verifyDB 表结构比对（不推荐）
 *   --no-extensions          不迁移扩展目录
 *   --drop-local-music       无 --path-map 时，清空本地音乐相关行（避免出现大量失效条目）
 *   --json                   输出机读 JSON 报告到 stdout
 *   -h, --help               显示帮助
 *
 * 退出码：
 *   0  成功
 *   1  参数错误
 *   2  输入检查失败（找不到关键文件 / DB 损坏 / 校验不通过）
 *   3  执行失败（写文件出错）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// 0. 抑制 node:sqlite 的 ExperimentalWarning（不影响其它警告）
// ---------------------------------------------------------------------------
const _origEmitWarning = process.emitWarning
process.emitWarning = function (warning, ...rest) {
  const msg = typeof warning === 'string' ? warning : warning?.message ?? ''
  if (msg.includes('SQLite is an experimental feature')) return
  return _origEmitWarning.call(process, warning, ...rest)
}

// ---------------------------------------------------------------------------
// 1. 常量（严格对齐 source/packages/shared/common/constants.ts 与
//    source/packages/shared/app/modules/worker/dbService/tables.ts）
// ---------------------------------------------------------------------------
const DB_NAME = 'anylisten.data.db'            // common/constants.ts: DB_NAME
const DEVICE_ID_NAME = 'deviceid'              // common/constants.ts: DEVICE_ID_NAME
const DB_VERSION = '3'                         // dbService/tables.ts:216
const BACKUP_DIR_NAME = 'db_backups'           // backupTask/constants.ts:6
const DAILY_BACKUP_DIR_NAME = 'daily'          // backupTask/constants.ts:7
const EVENT_BACKUP_DIR_NAME = 'event'          // backupTask/constants.ts:8
const EXTENSION_DIR_NAME = 'extension'         // common/constants.ts: STORE_NAMES.EXTENSION
const EXT_EXT_DIR_NAME = 'ext'                 // EXTENSION.extDirName
const EXT_DATAS_DIR_NAME = 'datas'             // EXTENSION.dataDirName
const EXT_TEMP_DIR_NAME = 'temp'               // EXTENSION.tempDirName
const EXT_CONFIG_NAME = 'extensions.json'      // EXTENSION.configFileName

/**
 * 与 tables.ts 的 16 条 DDL 逐字一致。
 * verifyDB 的比对规则（dbService/verifyDB.ts:5）：`sql.replace(/\n|\s|;|--.+/g, '')`
 * 必须在此复刻，否则误报。
 */
const TABLES = new Map([
  ['metadata', `
  CREATE TABLE "metadata" (
    "field_name" TEXT NOT NULL,
    "field_value" TEXT,
    UNIQUE("field_name") ON CONFLICT REPLACE
  );
`],
  ['my_list', `
  CREATE TABLE "my_list" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "parent_id" TEXT,
    "meta" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    PRIMARY KEY("id")
  );
`],
  ['my_list_music_info', `
  CREATE TABLE "my_list_music_info" (
    "id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "singer" TEXT NOT NULL,
    "interval" TEXT,
    "is_local" INTEGER NOT NULL,
    "meta" TEXT NOT NULL,
    UNIQUE("id","list_id") ON CONFLICT REPLACE
  );
`],
  ['index_my_list_music_info', `
  CREATE INDEX "index_my_list_music_info" ON "my_list_music_info" (
    "id",
    "list_id"
  );
`],
  ['my_list_music_info_order', `
  CREATE TABLE "my_list_music_info_order" (
    "list_id" TEXT NOT NULL,
    "music_id" TEXT NOT NULL,
    "order" INTEGER NOT NULL
  );
`],
  ['index_my_list_music_info_order', `
  CREATE INDEX "index_my_list_music_info_order" ON "my_list_music_info_order" (
    "list_id",
    "music_id"
  );
`],
  ['music_info_other_source', `
  CREATE TABLE "music_info_other_source" (
    "source_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "singer" TEXT NOT NULL,
    "interval" TEXT,
    "meta" TEXT NOT NULL,
    "time" INTEGER NOT NULL,
    "order" INTEGER NOT NULL,
    UNIQUE("source_id","id") ON CONFLICT REPLACE
  );
`],
  ['index_music_info_other_source', `
  CREATE INDEX "index_music_info_other_source" ON "music_info_other_source" (
    "source_id",
    "id"
  );
`],
  ['play_list_music_info', `
  CREATE TABLE "play_list_music_info" (
    "item_id" string NOT NULL,
    "position" INTEGER NOT NULL,
    "played" INTEGER NOT NULL,
    "play_later" INTEGER NOT NULL,
    "source" INTEGER NOT NULL,
    "id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "singer" TEXT NOT NULL,
    "interval" TEXT,
    "is_local" INTEGER NOT NULL,
    "meta" TEXT NOT NULL,
    UNIQUE("item_id")
  );
`],
  ['lyric', `
  -- TODO  "meta" TEXT NOT NULL,
  CREATE TABLE "lyric" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "singer" TEXT,
    "interval" TEXT,
    "lyric" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    UNIQUE("id","type") ON CONFLICT REPLACE
  );
`],
  ['music_url', `
  CREATE TABLE "music_url" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    UNIQUE("id") ON CONFLICT REPLACE
  );
`],
  ['download_list', `
  CREATE TABLE "download_list" (
    "id" TEXT NOT NULL,
    "is_complate" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "status_text" TEXT NOT NULL,
    "progress_downloaded" INTEGER NOT NULL,
    "progress_total" INTEGER NOT NULL,
    "url" TEXT,
    "quality" TEXT NOT NULL,
    "ext" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "music_info" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    PRIMARY KEY("id")
  );
`],
  ['dislike_list', `
  CREATE TABLE "dislike_list" (
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "meta" TEXT
  );
`],
  ['play_count', `
  CREATE TABLE "play_count" (
    "name" TEXT NOT NULL,
    "singer" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "time" INTEGER NOT NULL,
    "meta" TEXT,
    UNIQUE("name","singer") ON CONFLICT REPLACE
  );
`],
  ['log', `
  -- type: music_play list_play
  CREATE TABLE "log" (
    "time" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL
  );
`],
])

/**
 * 设置项三分法（依据 docs/phase2-architecture.md §5.4 + §9.0/§9.2）
 * KEEP   : 原值迁入
 * REMAP  : 保留但值/语义需调整
 * DROP   : 移动端无意义，丢弃（Android 侧读不到即用 defaultSetting 默认值）
 */
const SETTINGS_KEEP_PREFIX = [
  'player.',          // 42 项（含 soundEffect 17）——但要排除下面 REMAP 里的少数
  'sync.webdav.',     // 8 项
  'playDetail.',      // 7 项
  'theme.',           // 4 项
  'list.',            // 2 项
  'onlineResource.',  // 2 项
  'extension.',       // 2 项
  'network.',         // 4 项（proxy.*，Android 由 HttpPort.setProxy 生效）
]
const SETTINGS_KEEP_EXACT = [
  'common.langId',
  'common.fontSize',
  'common.isShowAnimation',
  'common.isAgreePact',
  'common.playBarProgressStyle',
  'common.enableTrash',
  'common.enableDebug',
  'backup.backupPath',
  'download.savePath',
]
const SETTINGS_DROP_EXACT = [
  // 窗口 / 桌面形态
  'common.windowSizeId',
  'common.startInFullscreen',
  'common.transparentWindow',
  'common.tryAutoUpdate',       // PDR：不分发，不做自更新
  'common.allowPreRelease',
  'common.showChangeLog',
  'common.font',                // 字体枚举依赖 font-list，Android 无法枚举
  // 托盘
  'tray.enable',
  'tray.isToTray',
  'tray.themeId',
  // setSinkId 在 Android 不可用（见 §4.7 getCapabilities().setSinkId）
  'player.mediaDeviceId',
  'player.isMediaDeviceChangedPausePlay',
  // 标题栏歌词（Android 无标题栏）
  'player.isShowTitleLyric',
  // 下载进度条在桌面右下角任务栏
  'player.isShowTaskProgess',
]
/** desktopLyric.* 45 项 → 保留样式子集（§9.2 / §8.3 待 uiux 给最终清单，此处为约定缺省） */
const DESKTOP_LYRIC_KEEP_SUFFIX = [
  'style.fontSize',
  'style.lyricPlayedColor',
  'style.lyricUnplayColor',
  'style.lyricShadowColor',
  'style.isFontWeightFont',
  'style.isFontWeightLine',
  'style.align',
  'style.ellipsis',
  'isLock',
  'isAlwaysOnTop',
  'pauseHide',
  'enable',
]

// ---------------------------------------------------------------------------
// 2. CLI
// ---------------------------------------------------------------------------
const EXIT = { OK: 0, ARG: 1, INPUT: 2, RUN: 3 }

function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    pathMap: [],
    deviceId: null,
    db: null,
    dryRun: false,
    force: false,
    skipVerify: false,
    noExtensions: false,
    dropLocalMusic: false,
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new ArgError(`选项 ${a} 缺少参数`)
      return v
    }
    switch (a) {
      case '--input': opts.input = next(); break
      case '--output': opts.output = next(); break
      case '--path-map': opts.pathMap.push(parsePathMap(next())); break
      case '--device-id': opts.deviceId = next(); break
      case '--db': opts.db = next(); break
      case '--dry-run': opts.dryRun = true; break
      case '--force': opts.force = true; break
      case '--skip-verify': opts.skipVerify = true; break
      case '--no-extensions': opts.noExtensions = true; break
      case '--drop-local-music': opts.dropLocalMusic = true; break
      case '--json': opts.json = true; break
      case '-h':
      case '--help': opts.help = true; break
      default:
        if (a.startsWith('--')) throw new ArgError(`未知选项：${a}`)
        throw new ArgError(`无法识别的参数：${a}`)
    }
  }
  return opts
}

class ArgError extends Error {}

function parsePathMap(raw) {
  const eq = raw.indexOf('=')
  if (eq <= 0 || eq === raw.length - 1) {
    throw new ArgError(`--path-map 格式应为 <桌面路径>=<Android 路径>，收到：${raw}`)
  }
  // 注意：Git Bash / MSYS 会对看起来像 Windows 路径的参数做转换，
  // "D:\\Music" 可能被传成 "D:/Music" 甚至 "D://Music"（实测），
  // 所以这里统一归一化，并对两侧都做。
  const from = normalizeRoot(raw.slice(0, eq))
  const to = normalizeRoot(raw.slice(eq + 1))
  if (!from || !to) throw new ArgError(`--path-map 两侧都不能为空：${raw}`)
  return { from, to }
}

/** 路径统一归一化：反斜杠转正斜杠、折叠重复斜杠、去尾部斜杠 */
function normalizeRoot(p) {
  let s = String(p).trim().replace(/\\/g, '/')
  // 保留 UNC 前缀 //server 的形式
  const isUnc = s.startsWith('//')
  s = s.replace(/\/{2,}/g, '/')
  if (isUnc) s = '/' + s
  return s.replace(/\/+$/, '')
}

// ---------------------------------------------------------------------------
// 3. 日志
// ---------------------------------------------------------------------------
const C = {
  reset: '\u001b[0m', dim: '\u001b[2m', bold: '\u001b[1m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', blue: '\u001b[36m',
}
const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (c, s) => (useColor ? `${c}${s}${C.reset}` : s)

// --json 模式：stdout 必须是**纯 JSON**，否则 `migrate --json | jq` 会挂。
// 做法是把 console.log / console.error 整体改为"有内容才输出"，
// 并在关键节点用 emitJson 直接写真实 stdout / stderr。
const realOut = console.log.bind(console)
let JSON_MODE = false

function enterJsonMode() {
  JSON_MODE = true
  console.log = () => {}   // 吞掉全部人类可读进度
}
function emitJson(obj, toStdErr = false) {
  const s = JSON.stringify(obj, null, 2)
  if (toStdErr) process.stderr.write(s + '\n')
  else realOut(s)
}

const log = {
  step: (n, msg) => console.log(`\n${paint(C.bold + C.blue, `[${n}]`)} ${msg}`),
  info: (msg) => console.log(`    ${msg}`),
  ok: (msg) => console.log(`    ${paint(C.green, '✓')} ${msg}`),
  warn: (msg) => console.log(`    ${paint(C.yellow, '!')} ${msg}`),
  fail: (msg) => console.log(`    ${paint(C.red, '✗')} ${msg}`),
  kv: (k, v) => console.log(`    ${paint(C.dim, k.padEnd(24))} ${v}`),
}

/** 干跑时把所有写操作收集到这里，便于报告 */
const plannedWrites = []

function writeOut(filePath, data, opts) {
  plannedWrites.push(filePath)
  if (opts.dryRun) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, data)
}

// ---------------------------------------------------------------------------
// 4. 路径工具
// ---------------------------------------------------------------------------
const isWinAbs = (p) => /^[A-Za-z]:[\\/]/.test(p)
/** 与 normalizeRoot 一致，但用于比较与拼接：只做分隔符归一 + 折叠重复斜杠，不去尾斜杠 */
const normSep = (p) => String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/')

/**
 * 判断 str 是否是"以某个桌面根开头的路径"，若是则返回映射后的 Android 路径。
 * 关键设计：只转换命中 --path-map 的字符串，其余一律原样返回。
 * 这样 lyric.id / dislike_list.content 这类"可能是本地路径也可能是在线 id"的列
 * 不会被误改（在线 id 形如 kg__xxx、tx__xxx，不会以桌面根开头）。
 */
function makePathMapper(pathMaps) {
  const maps = pathMaps.map((m) => {
    const from = normSep(m.from)
    return {
      fromLower: from.toLowerCase(),
      to: normSep(m.to),
      len: from.length,
    }
  })
  return function mapPath(str) {
    if (typeof str !== 'string' || !str) return str
    const s = normSep(str)
    const lower = s.toLowerCase()
    for (const m of maps) {
      if (lower === m.fromLower) return m.to
      if (lower.startsWith(m.fromLower + '/')) {
        const rest = s.slice(m.len).replace(/^\/+/, '')
        return `${m.to}/${rest}`
      }
    }
    return str
  }
}

/** 递归转换 JSON 里所有命中映射的字符串值（含数组/嵌套对象） */
function mapJsonDeep(value, mapPath) {
  if (typeof value === 'string') return mapPath(value)
  if (Array.isArray(value)) return value.map((v) => mapJsonDeep(v, mapPath))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = mapJsonDeep(v, mapPath)
    return out
  }
  return value
}

function* walkFiles(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) yield* walkFiles(full)
    else if (ent.isFile()) yield full
  }
}

function dirSize(dir) {
  let total = 0
  let files = 0
  if (!fs.existsSync(dir)) return { total, files }
  for (const f of walkFiles(dir)) {
    try {
      total += fs.statSync(f).size
      files++
    } catch { /* ignore */ }
  }
  return { total, files }
}

/**
 * 递归复制目录。
 *
 * 不用 `fs.cpSync(..., { recursive: true })`：Node 22.22.2 / Windows 下
 * 该调用会**静默硬崩**（退出码 127，无异常、无 stderr），已实测复现。
 * 用 walkFiles + copyFileSync 逐文件复制，行为可预测且跨平台一致。
 *
 * @param skipRel 需要跳过的相对路径前缀（用 '/' 分隔），例如 'ext/temp'
 */
function copyDirSync(src, dst, skipRel = []) {
  const skip = new Set(skipRel.map((s) => s.replace(/\\/g, '/')))
  let copied = 0
  fs.mkdirSync(dst, { recursive: true })
  for (const f of walkFiles(src)) {
    const rel = path.relative(src, f).replace(/\\/g, '/')
    if ([...skip].some((s) => rel === s || rel.startsWith(s + '/'))) continue
    const out = path.join(dst, rel)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.copyFileSync(f, out)
    copied++
  }
  return copied
}

const human = (n) => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// ---------------------------------------------------------------------------
// 5. node:sqlite 载入（延迟，便于给出友好错误）
// ---------------------------------------------------------------------------
function loadSqlite() {
  try {
    const require = createRequire(import.meta.url)
    return require('node:sqlite')
  } catch (err) {
    throw new Error(
      `当前 Node 不支持 node:sqlite（需要 Node ≥ 22.5，实测 22.22.2 可用）。\n` +
      `当前版本：${process.version}\n` +
      `处理办法：升级 Node，或改用「备份文件直搬」路线（见 docs/phase2-migration-plan.md §3 路线 C）。\n` +
      `原始错误：${err.message}`
    )
  }
}

// ---------------------------------------------------------------------------
// 6. 输入定位
// ---------------------------------------------------------------------------
function locateInput(inputDir) {
  const abs = path.resolve(inputDir)
  if (!fs.existsSync(abs)) throw new InputError(`输入目录不存在：${abs}`)
  if (!fs.statSync(abs).isDirectory()) throw new InputError(`输入路径不是目录：${abs}`)

  const found = {
    root: abs,
    variant: null,
    configJson: null,
    dbFile: null,
    walFile: null,
    shmFile: null,
    deviceIdFile: null,
    extensionDir: null,
    backupRoot: null,
    jsonStores: {},
    warnings: [],
  }

  /** 依次尝试候选布局 */
  const candidates = [
    { dir: abs, variant: 'desktop(AnyListenDatas)' },
    // 用户可能给到上一级（%APPDATA%/anylisten），自动下钻
    { dir: path.join(abs, 'AnyListenDatas'), variant: 'desktop(anylisten/AnyListenDatas)' },
    // portable 布局
    { dir: path.join(abs, 'userData', 'AnyListenDatas'), variant: 'desktop(portable/userData/AnyListenDatas)' },
    // web-server 布局（data/app）
    { dir: path.join(abs, 'app'), variant: 'web-server(data/app)' },
  ]

  let picked = null
  for (const c of candidates) {
    const cfg = path.join(c.dir, 'config.json')
    const db = path.join(c.dir, DB_NAME)
    if (fs.existsSync(cfg) || fs.existsSync(db)) {
      picked = { ...c, hasCfg: fs.existsSync(cfg), hasDb: fs.existsSync(db) }
      break
    }
  }
  if (!picked) {
    throw new InputError(
      `在 ${abs} 下没找到 config.json 或 ${DB_NAME}。\n` +
      `请确认 --input 指向桌面版的数据目录（Windows 默认：\n` +
      `  %APPDATA%\\anylisten\\AnyListenDatas\n` +
      `便携版：<安装目录>\\portable\\userData\\AnyListenDatas\n` +
      `已尝试的候选：\n` + candidates.map((c) => '  - ' + c.dir).join('\n')
    )
  }

  found.root = picked.dir
  found.variant = picked.variant
  found.configJson = picked.hasCfg ? path.join(picked.dir, 'config.json') : null
  found.dbFile = picked.hasDb ? path.join(picked.dir, DB_NAME) : null
  found.walFile = picked.hasDb ? path.join(picked.dir, `${DB_NAME}-wal`) : null
  found.shmFile = picked.hasDb ? path.join(picked.dir, `${DB_NAME}-shm`) : null
  const devFile = path.join(picked.dir, DEVICE_ID_NAME)
  found.deviceIdFile = fs.existsSync(devFile) ? devFile : null

  const extDir = path.join(picked.dir, EXTENSION_DIR_NAME)
  found.extensionDir = fs.existsSync(extDir) ? extDir : null

  const backupRoot = path.join(picked.dir, 'backup', BACKUP_DIR_NAME)
  found.backupRoot = fs.existsSync(backupRoot) ? backupRoot : null

  for (const name of ['sound_effect', 'data', 'list_scroll_position', 'theme']) {
    const p = path.join(picked.dir, `${name}.json`)
    if (fs.existsSync(p)) found.jsonStores[name] = p
  }

  if (!found.dbFile) found.warnings.push(`未找到 ${DB_NAME}（将只迁移设置与扩展）`)
  if (!found.configJson) found.warnings.push('未找到 config.json（将使用 Android 默认设置）')

  return found
}

class InputError extends Error {}
class VerifyError extends Error {}

// ---------------------------------------------------------------------------
// 7. DB：探针（只读，用于预检）
// ---------------------------------------------------------------------------
function probeDb(dbPath, sqlite) {
  const { DatabaseSync } = sqlite
  const info = {
    ok: false,
    journalMode: null,
    dbVersion: null,
    tables: {},
    missing: [],
    mismatched: [],
    counts: {},
    deviceIds: [],
    localPathSamples: [],
    error: null,
    probedOnCopy: false,
  }
  // 在临时副本上探测：① 绝不碰源文件；② 有 -wal 时能正常回放，不会因只读/占用失败
  let scratch = null
  let workPath = dbPath
  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'anylisten-probe-'))
    workPath = path.join(scratch, DB_NAME)
    fs.copyFileSync(dbPath, workPath)
    for (const s of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + s)) fs.copyFileSync(dbPath + s, workPath + s)
    }
    info.probedOnCopy = true
  } catch (err) {
    info.error = `准备探测副本失败：${err.message}`
    return info
  }

  let db
  try {
    db = new DatabaseSync(workPath)
    info.journalMode = db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? null
    // 强制把 WAL 合进主文件，才能看到"最新的"数据（桌面版可能刚写过还没 checkpoint）
    try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all() } catch { /* ignore */ }

    const master = db
      .prepare('SELECT type,name,tbl_name,sql FROM "main".sqlite_master WHERE sql NOT NULL')
      .all()
    const rxp = /\n|\s|;|--.+/g // 复刻 verifyDB.ts:5
    const dbSql = new Map()
    for (const row of master) dbSql.set(row.name, String(row.sql).replace(rxp, ''))

    for (const [name, sql] of TABLES) {
      if (!dbSql.has(name)) info.missing.push(name)
      else if (dbSql.get(name) !== sql.replace(rxp, '')) info.mismatched.push(name)
      info.tables[name] = dbSql.has(name)
    }

    try {
      const row = db
        .prepare(`SELECT "field_value" FROM "main"."metadata" WHERE "field_name"='db_version'`)
        .get()
      info.dbVersion = row?.field_value ?? null
    } catch { /* metadata 表可能缺失 */ }

    for (const t of [
      'my_list',
      'my_list_music_info',
      'my_list_music_info_order',
      'play_list_music_info',
      'lyric',
      'music_url',
      'download_list',
      'dislike_list',
      'play_count',
    ]) {
      try {
        info.counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM "main"."${t}"`).get()?.c ?? 0
      } catch { info.counts[t] = null }
    }

    // 统计 deviceId 分布（只统计本地音乐）
    try {
      const rows = db
        .prepare(`SELECT "meta" FROM "main"."my_list_music_info" WHERE "is_local"=1`)
        .all()
      const set = new Map()
      const samples = []
      for (const r of rows) {
        let meta
        try { meta = JSON.parse(r.meta) } catch { continue }
        const id = meta?.deviceId ?? '(missing)'
        set.set(id, (set.get(id) ?? 0) + 1)
        if (samples.length < 3 && typeof meta?.filePath === 'string') samples.push(meta.filePath)
      }
      info.deviceIds = [...set.entries()].map(([id, count]) => ({ id, count }))
      info.localPathSamples = samples
    } catch { /* ignore */ }

    info.ok = true
  } catch (err) {
    info.error = err.message
  } finally {
    try { db?.close() } catch { /* ignore */ }
    try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  return info
}

// ---------------------------------------------------------------------------
// 8. 设置裁剪
// ---------------------------------------------------------------------------
function trimSettings(setting) {
  const kept = {}
  const dropped = []
  const remapped = []

  for (const [key, value] of Object.entries(setting)) {
    if (key === 'version') continue // 顶层 version 单独处理

    if (key.startsWith('desktopLyric.')) {
      const suffix = key.slice('desktopLyric.'.length)
      if (DESKTOP_LYRIC_KEEP_SUFFIX.some((s) => suffix === s || suffix.endsWith('.' + s))) {
        kept[key] = value
      } else dropped.push(key)
      continue
    }
    if (SETTINGS_DROP_EXACT.includes(key)) { dropped.push(key); continue }
    if (SETTINGS_KEEP_EXACT.includes(key)) { kept[key] = value; continue }
    if (SETTINGS_KEEP_PREFIX.some((p) => key.startsWith(p))) { kept[key] = value; continue }
    dropped.push(key)
  }

  // 值级 REMAP
  if (kept['download.savePath']) {
    remapped.push({ key: 'download.savePath', from: kept['download.savePath'], to: null, note: '需在 Android 上重选目录（SAF）' })
    delete kept['download.savePath']
  }
  if (kept['backup.backupPath']) {
    remapped.push({ key: 'backup.backupPath', from: kept['backup.backupPath'], to: null, note: '需在 Android 上重选目录（SAF）' })
    delete kept['backup.backupPath']
  }
  // 代理开关：保留键，但主机/端口在 Android 由 HttpPort 生效，值原样带过去即可
  if (kept['network.proxy.enable']) {
    remapped.push({ key: 'network.proxy.*', from: 'desktop', to: 'HttpPort.setProxy', note: '原值迁移，Android 由 OkHttp 按请求注入' })
  }

  return { kept, dropped, remapped }
}

// ---------------------------------------------------------------------------
// 9. DB 改写（核心）
// ---------------------------------------------------------------------------
function rewriteDb({ dbPath, outDbPath, machineId, sourceDeviceId, mapPath, dropLocalMusic, opts }) {
  const sqlite = loadSqlite()
  const { DatabaseSync } = sqlite
  const report = {
    opened: false,
    journalModeBefore: null,
    journalModeAfter: null,
    checkpoint: null,
    deviceIdRewritten: 0,
    deviceIdSkippedForeign: 0,
    foreignDeviceIds: [],
    pathRewritten: 0,
    lyricIdRewritten: 0,
    dislikeContentRewritten: 0,
    musicUrlCleared: 0,
    localRowsDropped: 0,
    downloadReported: 0,
    jsonParseFailures: 0,
    collisions: [],
    warnings: [],
  }

  /**
   * 只重绑「属于本机」的行：
   *  - deviceId 等于源库的 deviceId，或
   *  - meta 里没有 deviceId（历史数据）
   * 外来设备（多设备同步来的本地条目）**保持原样**，否则会让 Android 误以为
   * 这些文件在本机存在（getMusicUrl 会去 checkFile 然后失败，表现为"点了没反应"，
   * 比原来更迷惑）。保留原 deviceId 时 Android 会明确判定"非本机"，语义正确。
   */
  const shouldRebind = (did) => {
    if (!did) return true
    if (!sourceDeviceId) return true
    return String(did) === String(sourceDeviceId)
  }
  const noteForeign = (did) => {
    if (!report.foreignDeviceIds.includes(did)) report.foreignDeviceIds.push(did)
    report.deviceIdSkippedForeign++
  }

  // 目标路径：干跑时用临时目录做副本，保证不写用户指定的输出目录
  const target = opts.dryRun
    ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anylisten-migrate-dry-')), DB_NAME)
    : outDbPath
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(dbPath, target)
  // 一并复制 WAL/SHM，node:sqlite 打开时会自动回放未 checkpoint 的事务
  for (const suffix of ['-wal', '-shm']) {
    const src = dbPath + suffix
    if (fs.existsSync(src)) fs.copyFileSync(src, target + suffix)
  }

  const db = new DatabaseSync(target)
  report.opened = true
  report.journalModeBefore = db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? null

  try {
    // --- 9.1 先把 WAL 落到主文件，再切出 WAL 模式（保证单文件完整） ---
    // 记录 -wal 字节数作为可验证证据：TRUNCATE 成功后应为 0
    const walTarget = target + '-wal'
    report.walBytesBefore = fs.existsSync(walTarget) ? fs.statSync(walTarget).size : 0
    try {
      const ck = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all()
      report.checkpoint = ck?.[0] ?? null
    } catch (e) {
      report.warnings.push('wal_checkpoint 失败（可能本来就是 DELETE 模式）：' + e.message)
    }
    report.walBytesAfter = fs.existsSync(walTarget) ? fs.statSync(walTarget).size : 0
    if (report.walBytesBefore > 0 && report.walBytesAfter === 0) {
      report.warnings.push(
        `WAL 已合并：-wal ${report.walBytesBefore} B → 0 B（未 checkpoint 的写入已并入主文件）`
      )
    }
    if (report.journalModeBefore === 'wal') {
      db.exec('PRAGMA journal_mode=DELETE')
    }
    report.journalModeAfter = db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? null

    db.exec('PRAGMA foreign_keys=OFF')
    db.exec('BEGIN IMMEDIATE')

    const needLocalRebind =
      !dropLocalMusic &&
      (mapPath !== null || (Boolean(machineId) && machineId !== sourceDeviceId))

    // --path-map 可能缺省（原地使用桌面数据）。此时路径改写退化为恒等，
    // 但 deviceId 重绑仍可能发生，所以不能把 mapPath 当函数直接调。
    const mp = typeof mapPath === 'function' ? mapPath : (s) => s

    // --- 9.2 my_list_music_info：id + meta ---
    if (needLocalRebind) {
      const rows = db.prepare(
        `SELECT rowid, "id", "list_id", "meta" FROM "main"."my_list_music_info" WHERE "is_local"=1`
      ).all()
      const seen = new Map()
      const upd = db.prepare(
        `UPDATE "main"."my_list_music_info" SET "id"=?, "meta"=? WHERE rowid=?`
      )
      for (const r of rows) {
        let meta
        try { meta = JSON.parse(r.meta) } catch { report.jsonParseFailures++; continue }
        const beforeDid = meta?.deviceId
        if (shouldRebind(beforeDid)) {
          if (meta.deviceId !== machineId) report.deviceIdRewritten++
          meta.deviceId = machineId
        } else noteForeign(beforeDid)
        const newMeta = mapJsonDeep(meta, mp)
        const newId = mp(r.id)
        if (newId !== r.id) report.pathRewritten++
        // id 碰撞检查（同一 list 内）
        const ck = `${newId}::${r.list_id}`
        if (seen.has(ck)) {
          report.collisions.push({ table: 'my_list_music_info', list_id: r.list_id, id: newId, firstRowid: seen.get(ck), rowid: r.rowid })
        } else seen.set(ck, r.rowid)
        upd.run(newId, JSON.stringify(newMeta), r.rowid)
      }
    } else if (dropLocalMusic) {
      const n = db.prepare(`DELETE FROM "main"."my_list_music_info" WHERE "is_local"=1`).run()
      report.localRowsDropped += Number(n.changes ?? 0)
    }

    // --- 9.3 my_list_music_info_order ---
    if (mapPath && !dropLocalMusic) {
      // 借 my_list_music_info 已有的 id 映射来改 music_id（避免漏掉非 is_local 的本地条目）
      const rows = db.prepare(`SELECT rowid, "music_id" FROM "main"."my_list_music_info_order"`).all()
      const upd = db.prepare(`UPDATE "main"."my_list_music_info_order" SET "music_id"=? WHERE rowid=?`)
      for (const r of rows) {
        const nv = mapPath(r.music_id)
        if (nv !== r.music_id) upd.run(nv, r.rowid)
      }
    } else if (dropLocalMusic) {
      const n = db.prepare(`DELETE FROM "main"."my_list_music_info_order"`).run()
      report.localRowsDropped += Number(n.changes ?? 0)
    }

    // --- 9.4 play_list_music_info：id + meta ---
    if (needLocalRebind) {
      const rows = db.prepare(
        `SELECT rowid, "id", "meta" FROM "main"."play_list_music_info" WHERE "is_local"=1`
      ).all()
      const upd = db.prepare(`UPDATE "main"."play_list_music_info" SET "id"=?, "meta"=? WHERE rowid=?`)
      for (const r of rows) {
        let meta
        try { meta = JSON.parse(r.meta) } catch { report.jsonParseFailures++; continue }
        const beforeDid = meta?.deviceId
        if (shouldRebind(beforeDid)) {
          if (meta.deviceId !== machineId) report.deviceIdRewritten++
          meta.deviceId = machineId
        } else noteForeign(beforeDid)
        const newId = mp(r.id)
        if (newId !== r.id) report.pathRewritten++
        upd.run(newId, JSON.stringify(mapJsonDeep(meta, mp)), r.rowid)
      }
    } else if (dropLocalMusic) {
      const n = db.prepare(`DELETE FROM "main"."play_list_music_info" WHERE "is_local"=1`).run()
      report.localRowsDropped += Number(n.changes ?? 0)
    }

    // --- 9.5 lyric：id 是 music id，本地音乐时为路径 ---
    if (mapPath && !dropLocalMusic) {
      const rows = db.prepare(`SELECT rowid, "id" FROM "main"."lyric"`).all()
      const upd = db.prepare(`UPDATE "main"."lyric" SET "id"=? WHERE rowid=?`)
      for (const r of rows) {
        const nv = mapPath(r.id)
        if (nv !== r.id) { upd.run(nv, r.rowid); report.lyricIdRewritten++ }
      }
    }

    // --- 9.6 dislike_list：type='music' 时 content 可能是本地路径 ---
    if (mapPath && !dropLocalMusic) {
      const rows = db.prepare(`SELECT rowid, "type", "content", "meta" FROM "main"."dislike_list"`).all()
      const upd = db.prepare(`UPDATE "main"."dislike_list" SET "content"=?, "meta"=? WHERE rowid=?`)
      for (const r of rows) {
        const nc = mapPath(r.content)
        const nm = r.meta == null ? r.meta : JSON.stringify(mapJsonDeep(safeJson(r.meta), mapPath))
        if (nc !== r.content) { upd.run(nc, nm, r.rowid); report.dislikeContentRewritten++ }
        else if (nm !== r.meta) upd.run(nc, nm, r.rowid)
      }
    }

    // --- 9.7 music_url：纯缓存，直接清空（本地 file:// / 代理 URL 均已失效） ---
    {
      const n = db.prepare(`DELETE FROM "main"."music_url"`).run()
      report.musicUrlCleared = Number(n.changes ?? 0)
    }

    // --- 9.8 download_list：只报告，不删（用户可能想保留记录） ---
    try {
      const rows = db.prepare(`SELECT "file_path" FROM "main"."download_list"`).all()
      report.downloadReported = rows.length
      if (rows.length) {
        const invalid = rows.filter((r) => {
          if (!mapPath) return true
          return mapPath(r.file_path) === r.file_path // 没命中映射 → Android 上必定不存在
        }).length
        if (invalid) {
          report.warnings.push(
            `download_list 有 ${invalid}/${rows.length} 条记录的 file_path 无法映射到 Android 路径，` +
            `这些条目在 Android 上会显示为"文件不存在"。脚本不删除记录，请自行决定是否在应用内清理。`
          )
        }
      }
    } catch { /* 表可能不存在 */ }

    // --- 9.9 play_count 以 name+singer 为键，无需改 ---

    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    try { db.close() } catch { /* ignore */ }
    throw err
  }

  db.exec('PRAGMA optimize')
  db.close()

  // 清理残留 WAL/SHM（切换出 WAL 后通常已无，防御性删除）
  for (const suffix of ['-wal', '-shm']) {
    const p = target + suffix
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p) } catch { /* ignore */ }
    }
  }

  // 干跑：把临时副本删掉
  if (opts.dryRun) {
    try { fs.rmSync(path.dirname(target), { recursive: true, force: true }) } catch { /* ignore */ }
  }

  report.outSize = opts.dryRun ? 0 : fs.statSync(target).size
  return report
}

function safeJson(s) {
  try { return JSON.parse(s) } catch { return s }
}

// ---------------------------------------------------------------------------
// 10. 迁移后校验
// ---------------------------------------------------------------------------
function verifyMigratedDb(dbPath, { machineId, sourceDeviceId, mapPath, pathMaps, sqlite }) {
  const { DatabaseSync } = sqlite
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const issues = []
  const stats = {}
  try {
    const rxp = /\n|\s|;|--.+/g
    const master = db.prepare('SELECT type,name,sql FROM "main".sqlite_master WHERE sql NOT NULL').all()
    const dbSql = new Map(master.map((r) => [r.name, String(r.sql).replace(rxp, '')]))
    for (const [name, sql] of TABLES) {
      if (!dbSql.has(name)) issues.push(`缺少表/索引：${name}`)
      else if (dbSql.get(name) !== sql.replace(rxp, '')) issues.push(`表结构不符：${name}`)
    }
    stats.journalMode = db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? null
    stats.integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check ?? null

    const dv = db.prepare(`SELECT "field_value" FROM "main"."metadata" WHERE "field_name"='db_version'`).get()
    stats.dbVersion = dv?.field_value ?? null
    if (stats.dbVersion !== DB_VERSION && !issues.some((i) => i.includes('db_version'))) {
      issues.push(`db_version 期望 ${DB_VERSION}，实际 ${stats.dbVersion}`)
    }

    stats.counts = {}
    for (const t of ['my_list', 'my_list_music_info', 'my_list_music_info_order', 'play_list_music_info', 'lyric', 'download_list', 'play_count']) {
      stats.counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM "main"."${t}"`).get()?.c ?? 0
    }

    // 残留检查：还有没有"属于源设备但没重绑"的本地条目
    // （外来设备的 deviceId 是刻意保留的，不算残留）
    if (machineId) {
      const rows = db.prepare(`SELECT "meta" FROM "main"."my_list_music_info" WHERE "is_local"=1`).all()
      let stale = 0
      let foreign = 0
      for (const r of rows) {
        const m = safeJson(r.meta)
        if (!m || typeof m !== 'object') continue
        const did = m.deviceId
        if (did === machineId) continue
        if (!did) { stale++; continue }
        if (!sourceDeviceId || did === sourceDeviceId) stale++
        else foreign++
      }
      stats.staleDeviceId = stale
      stats.foreignDeviceIdRows = foreign
      if (stale) issues.push(`仍有 ${stale} 条本地音乐 deviceId 未重绑`)
    }

    // 残留检查：还有没有未映射的桌面路径
    if (mapPath) {
      const rows = db.prepare(`SELECT "id","meta" FROM "main"."my_list_music_info" WHERE "is_local"=1`).all()
      const unmapped = []
      for (const r of rows) {
        const m = safeJson(r.meta)
        const fp = m && typeof m === 'object' ? m.filePath : null
        if (typeof fp === 'string' && isUnderSourceRoot(fp, pathMaps)) unmapped.push(fp)
      }
      stats.unmappedLocalPaths = unmapped.length
      if (unmapped.length) {
        issues.push(
          `${unmapped.length} 条本地音乐的 filePath 仍以桌面路径开头（未命中 --path-map），在 Android 上会失效。\n` +
          `    例：${unmapped[0]}\n` +
          `    请检查 --path-map 的 from 是否与数据库里的实际路径前缀一致（区分大小写以外的全等匹配）。`
        )
      }
    }
  } finally {
    db.close()
  }
  return { issues, stats }
}

// ---------------------------------------------------------------------------
// 11. 主流程
// ---------------------------------------------------------------------------
async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(paint(C.red, `参数错误：${err.message}`))
    console.error('用 --help 查看用法')
    process.exit(EXIT.ARG)
  }
  if (opts.help) {
    console.log(HELP)
    process.exit(EXIT.OK)
  }
  if (!opts.input || !opts.output) {
    console.error(paint(C.red, '缺少必填参数：--input 与 --output'))
    console.error('用 --help 查看用法')
    process.exit(EXIT.ARG)
  }

  const report = {
    tool: 'anylisten-migrate',
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    dryRun: opts.dryRun,
    node: process.version,
    input: path.resolve(opts.input),
    output: path.resolve(opts.output),
    deviceId: null,
    pathMap: opts.pathMap,
    inputScan: null,
    probe: null,
    settings: null,
    db: null,
    verify: null,
    extensions: null,
    outputs: [],
    warnings: [],
    errors: [],
    fatal: false,
  }

  if (opts.json) enterJsonMode()

  const fail = (msg, code = EXIT.INPUT) => {
    report.errors.push(msg)
    report.fatal = true
    report.ok = false
    if (opts.json) emitJson(report, true)
    else log.fail(msg)
    process.exit(code)
  }

  try {
    // ---------------- Step 1: 输入定位 ----------------
    log.step(1, `定位输入${opts.dryRun ? paint(C.yellow, '（干跑，不写任何文件）') : ''}`)
    const found = locateInput(opts.input)
    log.kv('输入布局', found.variant)
    log.kv('数据目录', found.root)
    log.kv('config.json', found.configJson ?? paint(C.yellow, '（缺失）'))
    log.kv('数据库', found.dbFile ?? paint(C.yellow, '（缺失）'))
    log.kv('deviceid', found.deviceIdFile ?? '（缺失，将新建）')
    log.kv('扩展目录', found.extensionDir ?? '（无）')
    log.kv('自动备份', found.backupRoot ?? '（无）')
    for (const w of found.warnings) log.warn(w)
    report.warnings.push(...found.warnings)

    if (!found.dbFile && !found.configJson) fail('既没有数据库也没有配置文件，无法迁移')

    // ---------------- Step 2: 环境与 DB 探针 ----------------
    log.step(2, '检查数据库状态（只读）')
    const sqlite = loadSqlite()
    let dbSource = opts.db ? path.resolve(opts.db) : found.dbFile
    let probe = dbSource ? probeDb(dbSource, sqlite) : null

    if (dbSource && !probe.ok) {
      log.fail(`数据库无法打开：${probe.error}`)
      log.info('尝试从自动备份恢复…')
      const fallback = pickLatestBackup(found.backupRoot)
      if (fallback) {
        log.ok(`找到备份：${fallback}`)
        dbSource = fallback
        probe = probeDb(dbSource, sqlite)
        report.fellBackToBackup = fallback
        report.warnings.push(`原库无法打开，已改用备份：${fallback}`)
      } else {
        fail(
          '数据库无法打开且没有可用备份。\n' +
          '  处理办法：\n' +
          '   1) 确认桌面版已完全退出（避免文件被占用）后重试\n' +
          '   2) 桌面版内「设置 → 数据备份」导出 JSON 备份，改用「路线 B：应用内 JSON 导入」\n' +
          '   3) 见 docs/phase2-migration-plan.md §3'
        )
      }
    }

    if (probe) {
      log.kv('journal_mode', probe.journalMode ?? '?')
      log.kv('db_version', probe.dbVersion ?? paint(C.red, '读取失败'))
      const walSize = found.walFile && fs.existsSync(found.walFile) ? fs.statSync(found.walFile).size : 0
      log.kv('-wal 大小', walSize ? `${human(walSize)}（有未 checkpoint 的数据，脚本会自动合并）` : '0（已干净）')
      for (const [t, c] of Object.entries(probe.counts)) {
        if (c !== null) log.kv(t, c)
      }
      if (probe.deviceIds.length) {
        log.kv('本地音乐 deviceId', probe.deviceIds.map((d) => `${d.id.slice(0, 8)}…×${d.count}`).join('  '))
      }
      if (probe.localPathSamples.length) {
        log.kv('本地音乐路径样例', probe.localPathSamples.join(' | '))
      }

      if (probe.missing.length) {
        log.warn(`缺表：${probe.missing.join(', ')}`)
        if (!opts.force && !opts.skipVerify) {
          fail(
            `数据库缺少 ${probe.missing.length} 个表/索引，Android 端 verifyDB 会判定为损坏并\n` +
            `**重建空库**（dbService/verifyDB.ts → db/init 返回 null → 备份后重建 = 静默丢全部数据）。\n` +
            `  可能原因：桌面版版本过旧，或这不是 any-listen 的数据库。\n` +
            `  处理办法：先在桌面版启动一次让它完成 migrate，再重跑本脚本；或加 --force 强制执行（不建议）`
          )
        }
      }
      if (probe.mismatched.length) {
        log.warn(`表结构不符：${probe.mismatched.join(', ')}`)
        if (!opts.skipVerify && !opts.force) {
          fail(
            `表结构不符（${probe.mismatched.join(', ')}）→ Android 端 verifyDB 会判定损坏并重建空库。\n` +
            `  处理办法：在桌面版启动一次让 migrateData 完成升级后重跑；或加 --skip-verify 跳过比对（风险自负）`
          )
        }
      }
      if (probe.dbVersion && probe.dbVersion !== DB_VERSION && !opts.force) {
        log.warn(`db_version=${probe.dbVersion}，期望 ${DB_VERSION}`)
        log.info('migrate.ts 会在 Android 首次启动时自动升级，通常可继续。若失败请加 --force。')
      }
      report.probe = probe
    }

    // ---------------- Step 3: deviceId 决定 ----------------
    log.step(3, '决定新 deviceId')
    const oldDeviceId = found.deviceIdFile
      ? fs.readFileSync(found.deviceIdFile, 'utf-8').trim()
      : null
    let machineId = opts.deviceId
    if (!machineId) {
      if (oldDeviceId) {
        if (opts.pathMap.length > 0) {
          // 有路径映射 = 同一批音乐换设备，deviceId 必须换（否则 Android 会误认为这些歌属于本机却找不到文件）
          machineId = randomUUID()
          log.info('沿用旧 deviceId 会导致「本机路径不匹配」，因此生成新 deviceId')
        } else {
          machineId = oldDeviceId
          log.info('沿用桌面 deviceId（未提供 --path-map，视为原地使用）')
        }
      } else machineId = randomUUID()
    }
    if (!/^[0-9a-fA-F-]{16,64}$/.test(machineId)) {
      fail(`deviceId 格式不合法：${machineId}（期望 UUID 或 16-64 位十六进制）`)
    }
    log.kv('新 deviceId', machineId)
    report.deviceId = machineId
    report.sourceDeviceId = oldDeviceId
    report.deviceIdChanged = oldDeviceId ? machineId !== oldDeviceId : true

    // ---------------- Step 4: 路径映射检查 ----------------
    log.step(4, '检查路径映射')
    if (!opts.pathMap.length) {
      log.warn('未提供 --path-map：本地音乐条目的 filePath/id 将保持桌面路径，在 Android 上全部失效')
      log.info('Android 端表现：列表还在，但点播放无反应（getMusicUrl 返回 null）')
      log.info('建议：加 --path-map "D:\\Music=/storage/emulated/0/Music" 重新执行')
      if (!opts.dropLocalMusic) {
        log.info('或者：加 --drop-local-music 清空本地音乐条目，之后在 Android 上重新添加目录扫描')
      }
    } else {
      for (const m of opts.pathMap) log.kv('映射', `${m.from}  →  ${m.to}`)
    }
    const mapPath = opts.pathMap.length ? makePathMapper(opts.pathMap) : null

    // ---------------- Step 5: 设置裁剪 ----------------
    log.step(5, '处理 config.json')
    let configOut = null
    if (found.configJson) {
      let raw
      try { raw = JSON.parse(fs.readFileSync(found.configJson, 'utf-8')) } catch (e) {
        fail(`config.json 不是合法 JSON：${e.message}`)
      }
      // 桌面格式：{ version, setting: {...} }
      const setting = raw?.setting ?? raw
      if (!setting || typeof setting !== 'object') fail('config.json 结构异常：找不到 setting 对象')
      const { kept, dropped, remapped } = trimSettings(setting)
      configOut = { version: raw?.version ?? setting.version ?? '1.0.3', setting: kept }
      log.kv('原始设置项', Object.keys(setting).length)
      log.kv('保留', Object.keys(kept).length)
      log.kv('丢弃', dropped.length)
      for (const r of remapped) {
        log.kv('需重设', `${r.key}（${r.note}）`)
      }
      report.settings = {
        total: Object.keys(setting).length,
        kept: Object.keys(kept).length,
        dropped: dropped.length,
        droppedKeys: dropped,
        remapped,
      }
    } else {
      log.warn('无 config.json，跳过（Android 将使用内置默认设置）')
      report.settings = { total: 0, kept: 0, dropped: 0, droppedKeys: [], remapped: [] }
    }

    // ---------------- Step 6: DB 改写 ----------------
    let dbOutPath = path.join(path.resolve(opts.output), DB_NAME)
    if (dbSource) {
      log.step(6, `改写数据库（deviceId 重绑${mapPath ? ' + 路径映射' : ''}）`)
      const dbReport = rewriteDb({
        dbPath: dbSource,
        outDbPath: dbOutPath,
        machineId,
        // 源设备 = 出现次数最多的那一个（多设备同步场景下外来设备通常只占少数）
        sourceDeviceId: pickSourceDeviceId(probe),
        mapPath,
        dropLocalMusic: opts.dropLocalMusic,
        opts,
      })
      log.kv('journal_mode', `${dbReport.journalModeBefore} → ${dbReport.journalModeAfter}`)
      log.kv('checkpoint', JSON.stringify(dbReport.checkpoint))
      log.kv('deviceId 重绑', `${dbReport.deviceIdRewritten} 行`)
      if (dbReport.deviceIdSkippedForeign) {
        log.kv('外来设备行（保留）', `${dbReport.deviceIdSkippedForeign} 行（${dbReport.foreignDeviceIds.map((s) => s.slice(0, 8) + '…').join(', ')}）`)
        log.info('这些条目属于其它设备，保留原 deviceId → Android 上会显示为"非本机"，语义正确')
      }
      log.kv('路径改写', `${dbReport.pathRewritten} 行`)
      log.kv('lyric.id 改写', `${dbReport.lyricIdRewritten} 行`)
      log.kv('dislike 改写', `${dbReport.dislikeContentRewritten} 行`)
      log.kv('music_url 清空', `${dbReport.musicUrlCleared} 行`)
      if (dbReport.localRowsDropped) log.kv('本地条目删除', `${dbReport.localRowsDropped} 行`)
      if (dbReport.downloadReported) log.kv('下载记录（未动）', `${dbReport.downloadReported} 行`)
      if (dbReport.jsonParseFailures) log.warn(`${dbReport.jsonParseFailures} 条 meta 不是合法 JSON，已跳过`)
      if (dbReport.collisions.length) {
        log.warn(`发现 ${dbReport.collisions.length} 处 id 碰撞（多个桌面路径映射到同一 Android 路径）`)
        for (const c of dbReport.collisions.slice(0, 5)) {
          log.info(`  ${c.table} list_id=${c.list_id} id=${c.id}`)
        }
      }
      for (const w of dbReport.warnings) log.info(w)
      report.db = dbReport

      // ---------------- Step 7: 迁移后校验（写盘后再校验，干跑校验临时副本） ----------------
      if (!opts.dryRun) {
        log.step(7, '校验输出数据库')
        const v = verifyMigratedDb(dbOutPath, {
          machineId,
          sourceDeviceId: pickSourceDeviceId(probe),
          mapPath,
          pathMaps: opts.pathMap,
          sqlite,
        })
        log.kv('journal_mode', v.stats.journalMode)
        log.kv('integrity_check', v.stats.integrity)
        log.kv('db_version', v.stats.dbVersion)
        for (const [t, c] of Object.entries(v.stats.counts)) log.kv(t, c)
        if (typeof v.stats.staleDeviceId === 'number') log.kv('残留 deviceId', v.stats.staleDeviceId)
        if (v.stats.foreignDeviceIdRows) log.kv('外来设备行（保留）', v.stats.foreignDeviceIdRows)
        if (typeof v.stats.unmappedLocalPaths === 'number') log.kv('未映射本地路径', v.stats.unmappedLocalPaths)
        report.verify = v
        if (v.issues.length) {
          for (const i of v.issues) log.warn(i)
          report.warnings.push(...v.issues)
        } else {
          log.ok(
            report.deviceIdChanged
              ? '校验通过：表结构一致、完整性 OK、deviceId 全部重绑'
              : '校验通过：表结构一致、完整性 OK、无残留 deviceId'
          )
        }
      }
    } else {
      log.step(6, '无数据库，跳过')
    }

    // ---------------- Step 7/8: 输出其它文件 ----------------
    log.step(dbSource ? 8 : 7, '写出迁移包')
    const outDir = path.resolve(opts.output)
    if (!opts.dryRun) fs.mkdirSync(outDir, { recursive: true })

    /** 干跑时不要打绿勾（会被误读成"已写出"），统一加标记 */
    const outOk = (m) => log.ok(opts.dryRun ? `${m}${paint(C.dim, '   [干跑·未写]')}` : m)

    // config.json
    if (configOut) {
      writeOut(path.join(outDir, 'config.json'), JSON.stringify(configOut, null, '\t'), opts)
      report.outputs.push('config.json')
      outOk('config.json')
    }
    // deviceid
    writeOut(path.join(outDir, DEVICE_ID_NAME), machineId, opts)
    report.outputs.push(DEVICE_ID_NAME)
    outOk(`${DEVICE_ID_NAME}  = ${machineId}`)
    // DB
    if (dbSource && !opts.dryRun) {
      report.outputs.push(`${DB_NAME}（${human(report.db.outSize)}）`)
      outOk(`${DB_NAME}（${human(report.db.outSize)}）`)
    }
    // sound_effect.json（用户 EQ / 卷积预设，值得保留）
    if (found.jsonStores.sound_effect) {
      const se = safeJson(fs.readFileSync(found.jsonStores.sound_effect, 'utf-8'))
      if (se && typeof se === 'object') {
        writeOut(path.join(outDir, 'sound_effect.json'), JSON.stringify(se, null, '\t'), opts)
        report.outputs.push('sound_effect.json')
        const nEq = Array.isArray(se.eqPreset) ? se.eqPreset.length : 0
        const nCv = Array.isArray(se.convolutionPreset) ? se.convolutionPreset.length : 0
        outOk(`sound_effect.json（EQ 预设 ${nEq} 条 / 卷积预设 ${nCv} 条）`)
      }
    }
    // data.json：只保留搜索历史与上次选中列表
    if (found.jsonStores.data) {
      const d = safeJson(fs.readFileSync(found.jsonStores.data, 'utf-8'))
      if (d && typeof d === 'object') {
        const keep = {}
        for (const k of Object.keys(d)) {
          if (/searchHistory|listPrevSelectId/i.test(k)) keep[k] = d[k]
        }
        if (Object.keys(keep).length) {
          writeOut(path.join(outDir, 'data.json'), JSON.stringify(keep, null, '\t'), opts)
          report.outputs.push('data.json')
          outOk(`data.json（保留 ${Object.keys(keep).join(', ')}）`)
        }
      }
    }
    // 扩展目录
    if (found.extensionDir && !opts.noExtensions) {
      const src = found.extensionDir
      const dst = path.join(outDir, EXTENSION_DIR_NAME)
      // 扩展临时下载区（ext/temp）无需迁移
      const skipRel = [`${EXT_EXT_DIR_NAME}/${EXT_TEMP_DIR_NAME}`]
      let total = 0
      let files = 0
      for (const f of walkFiles(src)) {
        const rel = path.relative(src, f).replace(/\\/g, '/')
        if (skipRel.some((s) => rel === s || rel.startsWith(s + '/'))) continue
        try { total += fs.statSync(f).size; files++ } catch { /* ignore */ }
      }
      if (!opts.dryRun) copyDirSync(src, dst, skipRel)
      plannedWrites.push(dst)
      report.outputs.push(`${EXTENSION_DIR_NAME}/（${files} 文件 / ${human(total)}）`)
      report.extensions = { files, size: total, src, dst }
      outOk(`${EXTENSION_DIR_NAME}/（${files} 文件 / ${human(total)}）`)
      const extRoot = path.join(src, EXT_EXT_DIR_NAME)
      if (fs.existsSync(extRoot)) {
        const exts = fs.readdirSync(extRoot, { withFileTypes: true }).filter((e) => e.isDirectory())
        log.kv('扩展数量', exts.length)
        for (const e of exts.slice(0, 12)) log.info(`  · ${e.name}`)
        if (exts.length > 12) log.info(`  … 另 ${exts.length - 12} 个`)
      } else {
        log.warn(`扩展目录为空（${extRoot} 不存在）`)
      }
    } else if (found.extensionDir && opts.noExtensions) {
      log.info('按 --no-extensions 跳过扩展迁移')
    }

    // ---------------- 报告 ----------------
    log.step(9, opts.dryRun ? '将写出迁移报告' : '写出迁移报告')
    const reportName = 'MIGRATION_REPORT.md'
    writeOut(path.join(outDir, reportName), buildMarkdownReport(report, opts), opts)
    writeOut(path.join(outDir, 'migration-report.json'), JSON.stringify(report, null, 2), opts)
    report.outputs.push(reportName, 'migration-report.json')
    outOk(reportName)
    outOk('migration-report.json')

    // ---------------- 收尾 ----------------
    console.log('')
    if (opts.dryRun) {
      console.log(paint(C.yellow + C.bold, '干跑完成，未写入任何文件。'))
      console.log(paint(C.dim, `将写出的文件：\n` + plannedWrites.map((p) => '  - ' + p).join('\n')))
      console.log(paint(C.dim, '确认无误后去掉 --dry-run 重新执行。'))
    } else {
      console.log(paint(C.green + C.bold, `迁移包已生成：${outDir}`))
      printHandoff(outDir, report)
    }
    if (opts.json) emitJson({ ok: !report.fatal, ...report })
    process.exit(EXIT.OK)
  } catch (err) {
    if (err instanceof InputError) fail(err.message)
    report.errors.push(err.stack ?? err.message)
    report.fatal = true
    if (opts.json) emitJson({ ok: false, ...report }, true)
    else {
      console.error(paint(C.red, '\n执行失败：') + err.message)
      if (process.env.DEBUG) console.error(err.stack)
    }
    process.exit(EXIT.RUN)
  }
}

/**
 * 判断某字符串是否仍以某个"桌面源根"开头。
 * 用于迁移后校验：如果还命中源根，说明这条路径没被映射，Android 上必然失效。
 * 注意不能写成 `mapPath(x) === x` —— 迁移后路径已是 Android 路径，
 * mapPath 当然会原样返回，会造成全量误报。
 */
function isUnderSourceRoot(str, pathMaps) {
  if (typeof str !== 'string' || !str || !pathMaps?.length) return false
  const s = normSep(str).toLowerCase()
  return pathMaps.some((m) => {
    const from = normSep(m.from).toLowerCase()
    return s === from || s.startsWith(from + '/')
  })
}

/** 源设备 = 出现次数最多的 deviceId（排除 "(missing)"） */
function pickSourceDeviceId(probe) {
  const list = (probe?.deviceIds ?? []).filter((d) => d.id && d.id !== '(missing)')
  if (!list.length) return null
  list.sort((a, b) => b.count - a.count)
  return list[0].id
}

function pickLatestBackup(backupRoot) {  if (!backupRoot || !fs.existsSync(backupRoot)) return null
  const cands = []
  for (const sub of [DAILY_BACKUP_DIR_NAME, EVENT_BACKUP_DIR_NAME]) {
    const dir = path.join(backupRoot, sub)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(DB_NAME + '.') && f.endsWith('.bak')) {
        cands.push({ p: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs })
      }
    }
  }
  if (!cands.length) return null
  cands.sort((a, b) => b.m - a.m)
  return cands[0].p
}

// ---------------------------------------------------------------------------
// 12. 报告渲染
// ---------------------------------------------------------------------------
function printHandoff(outDir, report) {
  console.log('')
  console.log(paint(C.bold, '下一步（三选一）'))
  console.log(paint(C.dim, '─'.repeat(72)))
  console.log(paint(C.bold, '① 推荐：应用内导入（无需 adb / 无需 root）'))
  console.log(`   1. 把 ${paint(C.blue, outDir)} 下的全部内容打包，传到手机（微信文件/网盘/USB 均可）`)
  console.log('   2. 在手机上解压到 /sdcard/Download/anylisten-migrate/')
  console.log('   3. 打开 Any Listen → 设置 → 数据迁移 → 选择「迁移包目录」→ 选上一步的目录')
  console.log('')
  console.log(paint(C.bold, '② adb 直推（仅 debuggable 构建可用）'))
  const pkg = 'com.anylisten.mobile'
  console.log(`   ${paint(C.dim, '# 先清空应用数据（首次迁移时做一次即可）')}`)
  console.log(`   adb shell pm clear ${pkg}`)
  console.log(`   ${paint(C.dim, '# 逐项推送（WAL 已 checkpoint，无 -wal/-shm 需要处理）')}`)
  console.log(`   adb push "${path.join(outDir, DB_NAME)}" /sdcard/Download/`)
  console.log(`   adb shell run-as ${pkg} mkdir -p files/any-listen`)
  console.log(`   adb shell "run-as ${pkg} cp /sdcard/Download/${DB_NAME} files/any-listen/"`)
  console.log(`   adb push "${path.join(outDir, 'config.json')}" /sdcard/Download/`)
  console.log(`   adb shell "run-as ${pkg} cp /sdcard/Download/config.json files/any-listen/"`)
  console.log(`   adb push "${path.join(outDir, DEVICE_ID_NAME)}" /sdcard/Download/`)
  console.log(`   adb shell "run-as ${pkg} cp /sdcard/Download/${DEVICE_ID_NAME} files/any-listen/"`)
  console.log('')
  console.log(paint(C.bold, '③ 备份文件直搬（脚本已帮你做完，仅作对照）'))
  console.log(`   取 ${DB_NAME}（脚本已${report.deviceIdChanged ? ' checkpoint 并重绑 deviceId' : ' checkpoint'}），放到上面 ② 的位置即可`)
  console.log(paint(C.dim, '─'.repeat(72)))
  console.log(paint(C.bold, '迁移后必做'))
  console.log('   1. 启动应用，确认歌单数量与桌面一致')
  if (report.deviceIdChanged) {
    console.log(`   2. 进 设置 → 存储，添加音乐目录并扫描（deviceId 已重绑为 ${report.deviceId.slice(0, 8)}…）`)
  } else {
    console.log('   2. 进 设置 → 存储，添加音乐目录并扫描（deviceId 沿用桌面值，本地音乐可直接命中）')
  }
  if (!report.pathMap?.length) {
    console.log(paint(C.yellow, '   3. ⚠ 本次未做路径映射：本地音乐条目在 Android 上会失效，扫描后可删除旧条目'))
  }
}

function buildMarkdownReport(report, opts) {
  const L = []
  const push = (...a) => L.push(...a)
  push(`# Any Listen 迁移报告`)
  push('')
  push(`- 生成时间：${report.generatedAt}`)
  push(`- 工具：${report.tool} v${report.version}（Node ${report.node}）`)
  push(`- 模式：${opts.dryRun ? '**干跑（未写文件）**' : '实际执行'}`)
  push(`- 输入：\`${report.input}\``)
  push(`- 输出：\`${report.output}\``)
  if (report.fellBackToBackup) {
    push('')
    push(
      `> ⚠ **本次数据来自自动备份，不是主库**：\`${report.fellBackToBackup}\`\n` +
      `> 主库无法打开，已改用该备份。备份点之后的改动（最后一段播放记录/新增歌曲）不会包含在迁移包里。\n` +
      `> 若要拿到最新数据：关闭桌面版 → 确认进程已退出 → 删除或改名损坏的 \`${DB_NAME}\` → 重新执行本脚本。`
    )
  }
  push('')
  push(`## 1. 设备与路径`)
  push('')
  push(`| 项 | 值 |`)
  push(`|---|---|`)
  push(
    `| deviceId | \`${report.deviceId}\`${report.deviceIdChanged ? '（新生成）' : '（沿用桌面值，未变）'} |`
  )
  if (report.pathMap?.length) {
    for (const m of report.pathMap) push(`| 路径映射 | \`${m.from}\` → \`${m.to}\` |`)
  } else {
    push(`| 路径映射 | **未提供**（本地音乐会失效） |`)
  }
  push('')
  if (report.probe) {
    push(`## 2. 源数据库状态`)
    push('')
    push(`| 项 | 值 |`)
    push(`|---|---|`)
    push(`| journal_mode | ${report.probe.journalMode} |`)
    push(`| db_version | ${report.probe.dbVersion} |`)
    for (const [t, c] of Object.entries(report.probe.counts)) {
      if (c !== null) push(`| ${t} | ${c} |`)
    }
    push('')
  }
  if (report.db) {
    push(`## 3. 数据库改写明细`)
    push('')
    push(`| 项 | 数量 |`)
    push(`|---|---|`)
    push(`| journal_mode 变更 | ${report.db.journalModeBefore} → ${report.db.journalModeAfter} |`)
    push(`| WAL checkpoint | \`${JSON.stringify(report.db.checkpoint)}\` |`)
    push(`| deviceId 重绑 | ${report.db.deviceIdRewritten} 行 |`)
    push(`| 路径改写 | ${report.db.pathRewritten} 行 |`)
    push(`| lyric.id 改写 | ${report.db.lyricIdRewritten} 行 |`)
    push(`| dislike_list 改写 | ${report.db.dislikeContentRewritten} 行 |`)
    push(`| music_url 清空 | ${report.db.musicUrlCleared} 行 |`)
    if (report.db.localRowsDropped) push(`| 本地条目删除 | ${report.db.localRowsDropped} 行 |`)
    if (report.db.downloadReported) push(`| download_list（未动） | ${report.db.downloadReported} 行 |`)
    push('')
    if (report.db.collisions?.length) {
      push(`### ⚠ id 碰撞（多个桌面路径映射到同一 Android 路径）`)
      push('')
      for (const c of report.db.collisions.slice(0, 20)) {
        push(`- \`${c.table}\` list_id=\`${c.list_id}\` id=\`${c.id}\``)
      }
      push('')
    }
  }
  if (report.settings) {
    push(`## 4. 设置项`)
    push('')
    push(`原始 ${report.settings.total} 项 → 保留 ${report.settings.kept} 项，丢弃 ${report.settings.dropped} 项。`)
    push('')
    if (report.settings.remapped?.length) {
      push(`**需在 Android 上重设：**`)
      push('')
      for (const r of report.settings.remapped) push(`- \`${r.key}\`：${r.note}`)
      push('')
    }
    if (report.settings.droppedKeys?.length) {
      push(`<details><summary>已丢弃的 ${report.settings.droppedKeys.length} 项</summary>`)
      push('')
      for (const k of report.settings.droppedKeys) push(`- \`${k}\``)
      push('')
      push(`</details>`)
      push('')
    }
  }
  if (report.verify) {
    push(`## 5. 迁移后校验`)
    push('')
    push(`- journal_mode：${report.verify.stats.journalMode}`)
    push(`- integrity_check：**${report.verify.stats.integrity}**`)
    push(`- db_version：${report.verify.stats.dbVersion}`)
    if (typeof report.verify.stats.staleDeviceId === 'number') {
      push(`- 残留未重绑 deviceId：${report.verify.stats.staleDeviceId}`)
    }
    if (typeof report.verify.stats.unmappedLocalPaths === 'number') {
      push(`- 未映射本地路径：${report.verify.stats.unmappedLocalPaths}`)
    }
    push('')
    if (report.verify.issues.length) {
      push(`**存在问题：**`)
      push('')
      for (const i of report.verify.issues) push(`- ⚠ ${i}`)
    } else {
      push(`✅ 表结构与 \`tables.ts\` 一致，Android 端 \`verifyDB\` 会通过。`)
    }
    push('')
  }
  if (report.outputs?.length) {
    push(`## 6. 产物清单`)
    push('')
    for (const o of report.outputs) push(`- ${o}`)
    push('')
  }
  if (report.warnings?.length) {
    push(`## 7. 警告`)
    push('')
    for (const w of report.warnings) push(`- ${w}`)
    push('')
  }
  if (report.errors?.length) {
    push(`## 8. 错误`)
    push('')
    for (const e of report.errors) push('```\n' + e + '\n```')
    push('')
  }
  push(`## 附：Android 端落位路径`)
  push('')
  push('```')
  push('/data/data/com.anylisten.mobile/files/any-listen/')
  push('  ├── config.json')
  push('  ├── deviceid')
  push('  ├── anylisten.data.db')
  push('  ├── sound_effect.json     （可选）')
  push('  ├── data.json             （可选）')
  push('  └── extension/            （可选）')
  push('        ├── extensions.json')
  push('        ├── ext/<extId>/')
  push('        └── datas/')
  push('```')
  push('')
  return L.join('\n')
}

const HELP = `
Any Listen 桌面 → Android 数据迁移工具

用法：
  node porting/tools/migrate.mjs --input <桌面数据目录> --output <输出目录> [选项]

必填：
  --input <dir>           桌面数据目录。Windows 默认 %APPDATA%\\anylisten\\AnyListenDatas
                          （也接受上一级 %APPDATA%\\anylisten，脚本会自动下钻）
  --output <dir>          输出目录，自动创建

常用：
  --path-map <from=to>    本地音乐路径映射，可重复。**强烈建议提供**
                          例：--path-map "D:\\\\Music=/storage/emulated/0/Music"
  --device-id <uuid>      指定新 deviceId（缺省自动生成并写入 deviceid 文件）
  --dry-run               只检查与预演，不写任何文件
  --force                 跳过阻塞性检查（表结构不符等），风险自负
  --drop-local-music      清空本地音乐相关行（不提供 --path-map 时避免大量失效条目）
  --no-extensions         不迁移扩展目录
  --db <path>             覆盖数据库路径
  --json                  额外输出机读 JSON 报告

退出码：0 成功 / 1 参数错误 / 2 输入检查失败 / 3 执行失败

文档：docs/phase2-migration-plan.md
`

main()
