#!/usr/bin/env node
/**
 * 生成一个「仿真桌面数据目录」，用于回归测试 migrate.mjs。
 * ============================================================================
 * 为什么需要它：
 *   迁移脚本的正确性只能在真实 schema 上验证，但每次跑一遍桌面版太慢，
 *   Android 侧（native/fullstack）也需要一个已知内容的 DB 来验证
 *   SqliteAdapter / verifyDB / dbService 是否工作，而不必真的装一个桌面版。
 *
 * 用法：
 *   node porting/tools/test-fixture.mjs --out <目录> [--musics 20] [--keep-wal]
 *
 * 产出结构（与真实桌面版一致，见 docs/phase2-migration-plan.md §2）：
 *   <out>/
 *     config.json              { version, setting: {…137 项，含桌面专有键…} }
 *     deviceid                 <uuid>
 *     anylisten.data.db        WAL 模式，16 个表/索引，含本地音乐/歌单/歌词/下载记录
 *     anylisten.data.db-wal    仅 --keep-wal 时保留（验证 checkpoint 路径）
 *     sound_effect.json        { eqPreset:[…], convolutionPreset:[…] }
 *     data.json                { searchHistoryList:[…], listPrevSelectId:'…', ignoreVersion:null }
 *     backup/db_backups/daily/anylisten.data.db.<ts>.bak
 *     extension/
 *       extensions.json
 *       ext/demo.demo/manifest.json
 *       datas/demo.demo/
 *
 * 生成的数据刻意包含以下"坑"，用来验证迁移脚本能正确处理：
 *   - 本地音乐 id = 桌面路径（D:\Music\…），meta.filePath / meta.musicId 同值
 *   - 三首歌共享同一 deviceId，另有一首属于"另一台设备"（deviceId 不同，不应被改）
 *   - lyric 表里同时有本地路径 id 和在线 id（kg__xxx，不应被改）
 *   - dislike_list 里同时有本地路径 content 和歌手名 content
 *   - music_url 有一条 stale file:// 缓存（应被清空）
 *   - play_list_music_info 引用其中两首本地歌
 *   - download_list 一条指向桌面下载目录（Android 上必然失效）
 *   - config.json 含 45 个 desktopLyric.* 键 + tray.* + windowSizeId 等桌面专有项
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const _origEmitWarning = process.emitWarning
process.emitWarning = function (warning, ...rest) {
  const msg = typeof warning === 'string' ? warning : warning?.message ?? ''
  if (msg.includes('SQLite is an experimental feature')) return
  return _origEmitWarning.call(process, warning, ...rest)
}
const require_ = createRequire(import.meta.url)
const { DatabaseSync } = require_('node:sqlite')

// --- 与 tables.ts 逐字一致的 DDL（与 migrate.mjs 保持同步） ---
const DDL = `
  CREATE TABLE "metadata" (
    "field_name" TEXT NOT NULL,
    "field_value" TEXT,
    UNIQUE("field_name") ON CONFLICT REPLACE
  );
  CREATE TABLE "my_list" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "parent_id" TEXT,
    "meta" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    PRIMARY KEY("id")
  );
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
  CREATE INDEX "index_my_list_music_info" ON "my_list_music_info" (
    "id",
    "list_id"
  );
  CREATE TABLE "my_list_music_info_order" (
    "list_id" TEXT NOT NULL,
    "music_id" TEXT NOT NULL,
    "order" INTEGER NOT NULL
  );
  CREATE INDEX "index_my_list_music_info_order" ON "my_list_music_info_order" (
    "list_id",
    "music_id"
  );
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
  CREATE INDEX "index_music_info_other_source" ON "music_info_other_source" (
    "source_id",
    "id"
  );
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
  CREATE TABLE "lyric" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "singer" TEXT,
    "interval" TEXT,
    "lyric" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    UNIQUE("id","type") ON CONFLICT REPLACE
  );
  CREATE TABLE "music_url" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    UNIQUE("id") ON CONFLICT REPLACE
  );
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
  CREATE TABLE "dislike_list" (
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "meta" TEXT
  );
  CREATE TABLE "play_count" (
    "name" TEXT NOT NULL,
    "singer" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "time" INTEGER NOT NULL,
    "meta" TEXT,
    UNIQUE("name","singer") ON CONFLICT REPLACE
  );
  CREATE TABLE "log" (
    "time" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL
  );
`

const LIST_IDS = { DEFAULT: 'default', LOVE: 'love', LAST_PLAYED: 'last_played' }
const DB_NAME = 'anylisten.data.db'

function parseArgs(argv) {
  const o = { out: null, musics: 20, keepWal: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') o.out = argv[++i]
    else if (a === '--musics') o.musics = Number(argv[++i])
    else if (a === '--keep-wal') o.keepWal = true
    else if (a === '-h' || a === '--help') {
      console.log('用法：node porting/tools/test-fixture.mjs --out <目录> [--musics 20] [--keep-wal]')
      process.exit(0)
    }
  }
  if (!o.out) {
    console.error('缺少 --out')
    process.exit(1)
  }
  return o
}

const args = parseArgs(process.argv.slice(2))
const OUT = path.resolve(args.out)
const DESKTOP_ROOT = 'D:\\Music'
const DEMO_DEVICE = 'aaaaaaaa-1111-2222-3333-444444444444'
const OTHER_DEVICE = 'bbbbbbbb-1111-2222-3333-444444444444'

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------- deviceid
fs.writeFileSync(path.join(OUT, 'deviceid'), DEMO_DEVICE, 'utf-8')

// ---------------------------------------------------------------- config.json
// 含桌面专有项，验证裁剪逻辑
const setting = {
  version: '1.0.3',
  // 保留类
  'common.langId': 'zh-cn',
  'common.fontSize': 16,
  'common.isShowAnimation': true,
  'common.isAgreePact': true,
  'common.playBarProgressStyle': 'centerControl',
  'common.enableTrash': true,
  'common.enableDebug': false,
  'player.startupAutoPlay': false,
  'player.togglePlayMethod': 'listLoop',
  'player.playQuality': '320k',
  'player.volume': 0.8,
  'player.isMute': false,
  'player.playbackRate': 1,
  'player.preservesPitch': true,
  'player.isShowLyricTranslation': true,
  'player.isShowMediaSessionLyric': true,
  'player.isShowStatusBarLyric': false,
  'player.waitPlayEndStop': false,
  'player.waitPlayEndStopTime': '',
  'player.autoSkipOnError': true,
  'player.isSavePlayTime': true,
  'player.ignoreLocalLyrics': false,
  'player.soundEffect.convolution.fileName': 'big-hall.wav',
  'player.soundEffect.convolution.mainGain': 0.5,
  'player.soundEffect.panner.enable': false,
  'player.soundEffect.pitchShifter.playbackRate': 1,
  'sync.webdav.enable': true,
  'sync.webdav.url': 'https://dav.example.com/music',
  'sync.webdav.username': 'me',
  'sync.webdav.password': 'secret',
  'sync.webdav.path': '/anylisten',
  'sync.webdav.syncEnable.list': true,
  'sync.webdav.syncEnable.dislike': false,
  'playDetail.isZoomActiveLrc': true,
  'playDetail.style.fontSize': 22,
  'playDetail.style.align': 'center',
  'playDetail.coverStyle': 'square',
  'theme.id': 'default',
  'theme.lightId': 'default',
  'theme.darkId': 'default',
  'list.isShowActionBtn': true,
  'list.addMusicLocationType': 'top',
  'onlineResource.enable': true,
  'onlineResource.tipSearchSource': true,
  'extension.onlineExtensionHost': '',
  'extension.ghMirrorHosts': '',
  'network.proxy.enable': false,
  'network.proxy.host': '',
  'network.proxy.port': '',
  'network.proxyAllResources': false,
  'backup.backupPath': 'D:\\AnyListen\\backup',
  'download.savePath': 'D:\\AnyListen\\download',
  // 丢弃类（桌面专有）
  'common.windowSizeId': 3,
  'common.startInFullscreen': false,
  'common.transparentWindow': true,
  'common.tryAutoUpdate': true,
  'common.allowPreRelease': false,
  'common.showChangeLog': true,
  'common.font': '',
  'tray.enable': true,
  'tray.isToTray': false,
  'tray.themeId': 0,
  'player.mediaDeviceId': 'default',
  'player.isMediaDeviceChangedPausePlay': false,
  'player.isShowTitleLyric': true,
  'player.isShowTaskProgess': true,
}
// 45 个 desktopLyric.* （只保留 12 项样式子集）
setting['desktopLyric.enable'] = false
setting['desktopLyric.isLock'] = false
setting['desktopLyric.isAlwaysOnTop'] = true
setting['desktopLyric.pauseHide'] = false
setting['desktopLyric.classic.style.fontSize'] = 30
setting['desktopLyric.classic.style.lyricPlayedColor'] = 'rgba(255,255,255,1)'
setting['desktopLyric.classic.style.lyricUnplayColor'] = 'rgba(255,255,255,0.6)'
setting['desktopLyric.classic.style.lyricShadowColor'] = 'rgba(0,0,0,0.5)'
setting['desktopLyric.classic.style.isFontWeightFont'] = false
setting['desktopLyric.classic.style.isFontWeightLine'] = false
setting['desktopLyric.classic.style.align'] = 'left'
setting['desktopLyric.classic.style.ellipsis'] = false
for (let i = 0; i < 33; i++) setting[`desktopLyric.pad.${i}`] = i // 填充到 45 项

fs.writeFileSync(
  path.join(OUT, 'config.json'),
  JSON.stringify({ version: '1.0.3', setting }, null, '\t'),
  'utf-8'
)

// ---------------------------------------------------------------- sound_effect.json
fs.writeFileSync(
  path.join(OUT, 'sound_effect.json'),
  JSON.stringify(
    {
      eqPreset: [
        { id: 'p1', name: '我的重低音', data: [3, 4, 5, 3, 1, 0, -1, -1, 0, 1] },
        { id: 'p2', name: '人声', data: [-1, -1, 0, 2, 4, 4, 2, 0, -1, -1] },
      ],
      convolutionPreset: [{ id: 'c1', name: '大厅', fileName: 'big-hall.wav' }],
    },
    null,
    '\t'
  ),
  'utf-8'
)

// ---------------------------------------------------------------- data.json
fs.writeFileSync(
  path.join(OUT, 'data.json'),
  JSON.stringify(
    {
      searchHistoryList: ['周杰伦', 'Iris', 'city pop'],
      listPrevSelectId: 'love',
      ignoreVersion: null,
      winLegacyMessageShown: 1,
    },
    null,
    '\t'
  ),
  'utf-8'
)

// ---------------------------------------------------------------- DB
const DB_PATH = path.join(OUT, 'anylisten.data.db')
const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode=WAL')
db.exec(DDL)

const now = Date.now()
const meta0 = JSON.stringify({ playCount: 0, playTime: 0, createTime: now, updateTime: 0, posTime: 0 })
db.exec(`
  INSERT INTO "main"."metadata" ("field_name","field_value") VALUES
    ('db_version','3'), ('play_count','0'), ('play_time','0');
  INSERT INTO "main"."my_list" ("id","name","type","parent_id","meta","position") VALUES
    ('${LIST_IDS.DEFAULT}','default','${LIST_IDS.DEFAULT}',null,'${meta0}',0),
    ('${LIST_IDS.LOVE}','love','${LIST_IDS.DEFAULT}',null,'${meta0}',0),
    ('${LIST_IDS.LAST_PLAYED}','last_played','${LIST_IDS.DEFAULT}',null,'${meta0}',0),
    ('user1','我的最爱','user',null,'${meta0}',1);
`)

const insMusic = db.prepare(
  `INSERT INTO "main"."my_list_music_info" ("id","list_id","name","singer","interval","is_local","meta")
   VALUES (?,?,?,?,?,?,?)`
)
const insOrder = db.prepare(
  `INSERT INTO "main"."my_list_music_info_order" ("list_id","music_id","order") VALUES (?,?,?)`
)
const localPaths = []
for (let i = 0; i < args.musics; i++) {
  const sub = i % 3 === 0 ? '华语' : i % 3 === 1 ? 'Rock' : 'OST'
  const fileName = `track-${String(i).padStart(3, '0')}.flac`
  const filePath = `${DESKTOP_ROOT}\\${sub}\\${fileName}`
  localPaths.push({ filePath, name: `歌曲 ${i}`, singer: `歌手 ${i % 5}` })
  // 每 7 首有一首属于"另一台设备"，用于验证不会被误改
  const deviceId = i % 7 === 6 ? OTHER_DEVICE : DEMO_DEVICE
  const meta = JSON.stringify({
    deviceId,
    musicId: filePath,
    unparsed: false,
    albumName: `专辑 ${i % 4}`,
    filePath,
    picUrl: '',
    ext: 'flac',
    bitrateLabel: '900k',
    sizeStr: '30.2 MB',
    year: 2020,
    trackNo: i + 1,
    discNo: 1,
    createTime: now,
    updateTime: now,
    posTime: now,
  })
  insMusic.run(filePath, LIST_IDS.USER1 ?? 'user1', `歌曲 ${i}`, `歌手 ${i % 5}`, '03:45', 1, meta)
  insOrder.run('user1', filePath, i)
  if (i < 3) insMusic.run(filePath, LIST_IDS.LOVE, `歌曲 ${i}`, `歌手 ${i % 5}`, '03:45', 1, meta)
}
// 一首在线歌曲（is_local=0，不应被改）
insMusic.run(
  'kg__online_001',
  LIST_IDS.LOVE,
  '在线测试曲',
  '在线歌手',
  '04:00',
  0,
  JSON.stringify({ deviceId: DEMO_DEVICE, musicId: 'kg__online_001', albumName: '在线专辑', filePath: '', picUrl: '' })
)

// play_list_music_info：引用前两首本地歌
const insPlay = db.prepare(
  `INSERT INTO "main"."play_list_music_info"
   ("item_id","position","played","play_later","source","id","list_id","name","singer","interval","is_local","meta")
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
)
for (let i = 0; i < 2; i++) {
  const p = localPaths[i]
  insPlay.run(
    `item-${i}`, i, 0, 0, 1, p.filePath, 'user1', p.name, p.singer, '03:45', 1,
    JSON.stringify({ deviceId: DEMO_DEVICE, musicId: p.filePath, filePath: p.filePath, albumName: `专辑 ${i}`, picUrl: '', ext: 'flac' })
  )
}

// lyric：本地路径 id + 在线 id 各一条
const insLyric = db.prepare(
  `INSERT INTO "main"."lyric" ("id","name","singer","interval","lyric","type") VALUES (?,?,?,?,?,?)`
)
insLyric.run(localPaths[0].filePath, localPaths[0].name, localPaths[0].singer, '03:45', '[00:00.000]测试歌词', 'raw')
insLyric.run(localPaths[0].filePath, localPaths[0].name, localPaths[0].singer, '03:45', '[00:00.000]编辑过的歌词', 'edited')
insLyric.run('kg__online_001', '在线测试曲', '在线歌手', '04:00', '[00:00.000]在线歌词', 'raw')

// music_url：一条 stale file:// 缓存
db.prepare(`INSERT INTO "main"."music_url" ("id","url") VALUES (?,?)`).run(
  localPaths[0].filePath,
  'file:///D:/Music/%E5%8D%8E%E8%AF%AD/track-000.flac'
)

// dislike_list：本地路径 + 歌手名
const insDis = db.prepare(`INSERT INTO "main"."dislike_list" ("type","content","meta") VALUES (?,?,?)`)
insDis.run('music', localPaths[1].filePath, JSON.stringify({ name: localPaths[1].name }))
insDis.run('singer', '某不喜欢的歌手', null)

// download_list：桌面下载目录（Android 上必然失效）
db.prepare(
  `INSERT INTO "main"."download_list"
   ("id","is_complate","status","status_text","progress_downloaded","progress_total","url","quality","ext","file_name","file_path","music_info","position")
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  'dl-1', 1, 'completed', '完成', 100, 100, 'https://example.com/a.mp3', '320k', 'mp3',
  '在线测试曲 - 在线歌手.mp3', 'D:\\AnyListen\\download\\在线测试曲.mp3',
  JSON.stringify({ id: 'kg__online_001', name: '在线测试曲', singer: '在线歌手' }), 0
)

// play_count / log
db.prepare(`INSERT INTO "main"."play_count" ("name","singer","count","time","meta") VALUES (?,?,?,?,?)`)
  .run('歌曲 0', '歌手 0', 42, now, null)
db.prepare(`INSERT INTO "main"."log" ("time","type","content") VALUES (?,?,?)`)
  .run(now, 'music_play', JSON.stringify({ id: localPaths[0].filePath }))

// 保留 -wal：制造"未 checkpoint 的数据"，验证脚本的 checkpoint 路径
// 注意：db.close() 会触发 WAL checkpoint 并删除 -wal 文件，所以必须先 close 再重开，
// 写一条记录后直接 process.exit() 不 close —— 这样 -wal 会留在磁盘上，
// 与「桌面版还在运行 / 被强杀」的真实场景一致。
db.close()

// 备份目录（模拟 db.backup() 产物：单文件已 checkpoint）
const bakDir = path.join(OUT, 'backup', 'db_backups', 'daily')
fs.mkdirSync(bakDir, { recursive: true })
// 真实命名格式：${YYYYMMDD}-${HHmmssSSS}，见 backupTask/naming.ts:formatBackupTimestamp
const d = new Date(now)
const p2 = (n) => String(n).padStart(2, '0')
const bakName =
  `${DB_NAME}.` +
  `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-` +
  `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, '0')}` +
  '.bak'
fs.copyFileSync(DB_PATH, path.join(bakDir, bakName))

// ---------------------------------------------------------------- 扩展
const extRoot = path.join(OUT, 'extension')
fs.mkdirSync(path.join(extRoot, 'ext', 'demo.demo'), { recursive: true })
fs.mkdirSync(path.join(extRoot, 'datas', 'demo.demo'), { recursive: true })
fs.writeFileSync(
  path.join(extRoot, 'ext', 'demo.demo', 'manifest.json'),
  JSON.stringify(
    {
      id: 'demo.demo',
      name: '演示扩展',
      version: '1.0.0',
      main: 'index.js',
      publicKey: 'DEMO_PUBLIC_KEY',
      grant: ['internet', 'music_list'],
      contributes: {
        settings: [
          { key: 'api', name: '接口地址', type: 'input', default: 'https://example.com/api' },
          { key: 'quality', name: '音质', type: 'select', options: ['128k', '320k'], default: '320k' },
        ],
      },
    },
    null,
    2
  ),
  'utf-8'
)
fs.writeFileSync(path.join(extRoot, 'ext', 'demo.demo', 'index.js'), `console.log('demo extension')\n`, 'utf-8')
fs.writeFileSync(
  path.join(extRoot, 'extensions.json'),
  JSON.stringify([{ id: 'demo.demo', name: '演示扩展', enabled: true, installedTimestamp: now, updatedTimestamp: now, removed: false }], null, '\t'),
  'utf-8'
)
fs.writeFileSync(path.join(extRoot, 'datas', 'demo.demo', 'config.json'), JSON.stringify({ api: 'https://example.com/api' }), 'utf-8')

console.log(`✓ 仿真桌面数据已生成：${OUT}`)
console.log(`  本地音乐 ${args.musics} 首（其中 ${Math.floor(args.musics / 7) + (args.musics % 7 === 6 ? 1 : 0)} 首属于"另一台设备"）`)
console.log(`  在线音乐 1 首、歌词 3 条、播放队列 2 条、不喜欢 2 条、下载记录 1 条`)
console.log(`  config.json ${Object.keys(setting).length} 项（含桌面专有项）`)
console.log(`  deviceid = ${DEMO_DEVICE}`)
console.log(`  扩展 1 个（demo.demo）+ 1 个备份 ${bakName}`)

// ---------------------------------------------------------------------------
// 最后：模拟「桌面版正在运行 / 被强杀」——WAL 里有未 checkpoint 的数据
// 必须在所有文件都写完之后做，且不能 close（close 会 checkpoint 并删掉 -wal）
// ---------------------------------------------------------------------------
if (args.keepWal) {
  const db2 = new DatabaseSync(DB_PATH)
  db2.exec('PRAGMA journal_mode=WAL')
  db2.exec('PRAGMA wal_autocheckpoint=0')
  db2.prepare(`INSERT INTO "main"."play_count" ("name","singer","count","time","meta") VALUES (?,?,?,?,?)`)
    .run('仅存在于 WAL 的歌', 'WAL 歌手', 1, now, null)
  // 不做 checkpoint，直接退出 → 该行只存在于 -wal 中
  const walPath = DB_PATH + '-wal'
  const sz = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
  console.log(`  已保留 -wal：${sz} B（含 1 条仅存在于 WAL 的记录）`)
  process.exit(0)
}
