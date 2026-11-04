/**
 * `@/shared/ipc/app` 的 Android 覆写。
 *
 * ## 为什么需要覆写
 *
 * 上游原文件（`view-main/src/shared/ipc/app/index.ts:38-50`）的两个文件对话框长这样：
 *
 * ```ts
 * export const showOpenDialog: ... = async (opts) => {
 *   if (import.meta.env.VITE_IS_WEB) return showFileSelectModal(opts)   // ← 网页版：内置文件浏览器
 *   return ipc.showOpenDialog(opts)                                     // ← 桌面版：主进程原生对话框
 * }
 * ```
 *
 * Android 上两条路都走不通：
 * - `VITE_IS_WEB` 在本项目的构建里被硬编码为 `false`（`vite.config.mjs` 的 `define`），
 *   所以 `if` 分支在构建期就被摇掉，永远走 `ipc.showOpenDialog`；
 * - 而 Android host **没有也不可能**有 `showOpenDialog`：上游 web-server 版同样**故意**把它
 *   注释掉了（`web-server/src/app/renderer/winMain/preload/app.ts:79-83`），
 *   因为网页版的落点是内置文件浏览器弹窗。
 *
 * 结果：点「导入本地音乐」→ `importLocalFile()`（`components/layout/Aside/MyList/action.ts:44`）
 * 第一行就 `ipc.showOpenDialog` → message2call 到 host → host 无此方法 →
 * 抛 `showOpenDialog is not defined`，按钮点了没反应。`showSaveDialog`（导出日志/备份）同理。
 *
 * ## 为什么走内置文件浏览器，而不是原生 SAF 选择器
 *
 * 原生 `ACTION_OPEN_DOCUMENT` 返回的是 `content://` URI，而整条导入链路
 * （`createLocalMusicInfos` → `ports/fs` → `shims/fs` → 原生文件读）**全部按绝对文件路径**工作，
 * 拿不到 `/storage/emulated/0/...` 这样的路径就无法解析音乐元数据。当前权限方案是
 * `MANAGE_EXTERNAL_STORAGE`（整机可读），绝对路径是完整可用的，因此文件浏览器 + 绝对路径
 * 是链路最短、且与 web-server 版行为一致的选择。
 *
 * ## 为什么用 `export *`
 *
 * 本文件只替换 2 个导出，其余 30 多个转发函数（getSetting / setSetting / openUrl / ...）
 * 一个字都不该改。`export *` 提供全部转发，下面两个**同名具名导出优先级高于 star**
 * （ESM 规范：`export *` 不会覆盖本地具名导出）。这样上游将来加函数时我们不用跟着加。
 *
 * ## 别名约定（本文件里三个前缀的含义，别混）
 *
 * - `@ui-raw/xxx` → **绕过覆写表**直取 `source/packages/view-main/src/xxx`
 *   （`vite.config.mjs` 的 `RAW_TARGETS`，同名条目在 `tsconfig.json` 的 `paths` 里也有一条）。
 *   不加 `-raw` 的 `@ui/shared/ipc/app` 会解析到**本文件自己**，形成自引用。
 * - `@ui/xxx` → `view-main/src/xxx`（会走覆写表，正是我们想要的：拿覆写版 fileSelectModal）
 * - `@/xxx` → 按 importer 位置推断，本文件在 `porting/js` 下，顺序是
 *   `host/` → `web-server/src` → `view-main/src`；**不要**依赖它，写 `@ui/` 更明确。
 */

// 其余转发函数全部沿用上游实现（同名具名导出会覆盖这里的同名 star 导出）
export * from '@ui-raw/shared/ipc/app'

import { showFileSaveModal, showFileSelectModal } from '@ui/shared/ipc/fs/fileSelectModal'

/**
 * 选文件 / 选目录 → 内置文件浏览器弹窗。
 *
 * `showFileSelectModal` 内部只做两件事：
 * 1. 把 `opts.filters` / `opts.properties` 翻译成 `showFileExplorerModal` 的选项
 *    （`multi` ← `multiSelections`，`openDir` ← `openDirectory`，`openFile` ← `openFile`）；
 * 2. 用 `@/shared/ipc/fs/fs.ts` 的 `readRootDir()` / `readDir()` 喂目录树，
 *    而这两条 IPC（`fileSystemAction` 的 `read_root_dir` / `read_dir`）host 侧已经实现。
 */
export const showOpenDialog: AnyListen.IPC.ServerIPC['showOpenDialog'] = async (opts) => {
  return showFileSelectModal(opts)
}

/**
 * 保存文件 → 内置文件浏览器弹窗（含新建目录）。
 *
 * 注意这里**不要**照抄上游桌面分支的 `if (opts.defaultFileName) opts.defaultPath = opts.defaultFileName`
 * —— 那是为了 Electron 的 `dialog.showSaveDialog` 参数兼容做的兼容补丁；网页版
 * `showFileSaveModal` 自己处理 `defaultFileName`（写进文件名输入框），两个都设会让
 * 目录变成文件名。导出日志 / 数据备份走这条。
 */
export const showSaveDialog: AnyListen.IPC.ServerIPC['showSaveDialog'] = async (opts) => {
  return showFileSaveModal(opts)
}
