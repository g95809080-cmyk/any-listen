/**
 * Android 返回键契约（uiux D-07）。
 *
 * ## 为什么需要这个文件
 *
 * 原生 `MainActivity.kt:501-527` 的返回键逻辑依赖两个 JS 全局：
 * `window.__anylisten_canGoBack__ /* () => boolean *\/` 与 `__anylisten_goBack__ /* () => boolean *\/`。
 * 契约是原生定的，**JS 侧一直是空的** —— 于是探针返回 `null`，原生退化成
 * `webView.canGoBack()`，而那个值只在 `onPageFinished` 探一次（SPA 只有一次页面加载），
 * 缓存永远是首帧的 `false`。结果：**不管在哪个页面，按返回键一律退出 App**（P1-1）。
 *
 * ## 为什么不直接让原生用 `history.length`
 *
 * 上游 `navigator.ts:128` 的 `push()` 是 `window.location.hash = …`，确实新增历史条目，
 * 但 `history.length` **只增不减**：退回根页面后它仍然是 5、是 10，
 * 原生据此判断就永远"能回退"，按到天荒地老也退不出 App。
 * 所以"能不能回退"必须由 SPA 自己记账，不能用浏览器历史长度。
 *
 * ## 记账方式
 *
 * 维护一条 hash 栈：`hashchange` 时若新 hash 在栈里出现过，说明是**后退**（截断到那一格），
 * 否则是**前进**（入栈）。判据只看 `stack.length > 1`。
 *
 * 已知偏差（可接受）：`replace()` 会改 hash 但**不新增历史条目**（`navigator.ts:165`），
 * 这里会把它当成前进多记一格。后果是"多给一次可回退"，不会误退 App，
 * 且下一次真实后退会用 `lastIndexOf` 把栈截回去，误差自愈。
 *
 * ## 根级 Tab 不入栈（D-1，主理人裁决）
 *
 * 原实现把**每一次** Tab 切换都入栈，于是实测：从任意 Tab 都要按 3~4 次返回键才能退出，
 * 中间还夹着一次「按了没反应」，最后一次甚至把 WebView 导航出 SPA（空白页，像白屏崩溃）。
 *
 * Android 的导航惯例是「底部 Tab 是顶层，不入返回栈」：任何顶层 Tab 上按返回都应直接
 * 走「再按一次退出」。所以这里加一条根级判定：**目标 hash 去掉查询串后属于根级路径时，
 * 把栈截断为 1 格并指向当前页**（等价于"历史被重置，当前位置就是栈底"）。
 * 子页（`#/extenstion` 等）仍正常入栈，从它们返回能逐级退回。
 *
 * ## 播放详情是 overlay，但必须能被返回键关掉
 *
 * `PlayDetail/index.svelte` 用 `$isShowPlayDetail` 挂载覆盖层，**不改 hash** —— 记账栈看不到它。
 * 而它又是全屏的：不特殊处理的话，用户在播放详情里按返回 = 在根页按返回 = 退出 App，
 * 覆盖层还留在屏幕上（视觉上像"按返回把 App 关了"）。这里不改 store（本文件在 boot 阶段
 * 求值，保持零业务依赖），直接找它的关闭键并 `.click()`：**后退语义 = 关掉最上层覆盖层**。
 * 关不掉（没有那个键）时才退回"能不能回 hash 栈上一页"的判断。
 *
 * ## 返回键优先级：最上层弹层 → 弹窗 → 播放详情 → hash 栈（D-23 / D-27）
 *
 * 上一条只覆盖了"整屏覆盖层"，漏掉了**底部弹层**（`base/Popup`：倍速/音量/循环/播放列表）。
 * 它们是 Portal 到 `#root` 的浮层，同样不改 hash、也不是整屏 —— 于是用户在浮层打开时按返回，
 * 会直接落到 hash 栈判定（根页 → 退出 App），**浮层原地留在屏幕上**（D-23 的实测现象：
 * 返回后 Activity 到后台，回来浮层还在）。
 *
 * 所以优先级排四档，从"最局部"到"最全局"：
 *
 * 1. `findOpenPopup()` 有值 → 对它派发 `mouseleave`（与 D-22 点外部关闭**完全同一条路径**，
 *    判据也复用 `popupDismiss.ts` 的导出，两处不各写一份、不漂移）→ 返回 `true`；
 * 2. `findOpenModal()` 有值 → 走 Modal 自己的关闭入口（Escape / 关闭键）→ 返回 `true`；
 * 3. 播放详情的关闭键存在 → `.click()` → 返回 `true`；
 * 4. `stack.length > 1` → `history.back()` → 返回 `true`；否则 `false`（原生走"再按一次退出"）。
 *
 * **第 2 档是 D-27**：`.modal` 既不是 `.popup` 也不是整屏覆盖层，原先被漏在三档之外，
 * 于是在「播放详情里打开声音设置」时按返回，会先撞上第 3 档把播放详情关掉 ——
 * 声音设置弹窗反而留成了孤儿（评论弹窗同理，只剩一个可点遮罩）。`.modal` 在上游是**居中对话框**，
 * 语义上比全屏的播放详情更"局部"，因此排在它前面。
 *
 * `canGoBack()` 必须**同步**加上第 1、2 档，否则原生在"浮层/弹窗打开 + 根页"时会认为无处可退，
 * 直接弹退出 toast —— JS 的 `goBack()` 根本没机会被调用。
 */

const hashOf = () => window.location.hash || '#/'

/** 弹层探测/关闭与 D-22 共用同一套判据（`findOpenPopup` / `dismissPopup`），避免两处漂移 */
import { dismissModal, dismissPopup, findOpenModal, findOpenPopup } from './popupDismiss'
import { isSettingsChildHash, isSettingsHomeHash } from '@porting/ui/settings/navigation'

/** 栈上限：防止长时间使用无限增长（超出后丢最老的，语义上等价于"很早以前的页面回不去了"） */
const MAX_DEPTH = 50

/** 根级（Tab 顶层）路径。设置首页单独判断，二级设置页需要回首页。 */
const ROOT_PATHS = ['/online', '/search']

const pathOf = (hash: string) => {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const path = raw.split('?')[0] ?? ''
  // 去掉尾部斜杠（`/settings/` 与 `/settings` 等价）；根 `'/'` 保留
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/**
 * 曲库现在分两级：`/library` 是一级歌单列表，`/library?id=…` 是二级歌曲页。
 * 旧实现把所有 `/library…` 都当根级，从二级页按 Android 返回会直接走「再按一次退出」。
 */
const hasLibraryListId = (hash: string) => {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const search = raw.split('?')[1] ?? ''
  return new URLSearchParams(search).get('id') != null
}

const isRootHash = (hash: string) => {
  const path = pathOf(hash)
  if (path === '/library') return !hasLibraryListId(hash)
  if (path === '/settings') return isSettingsHomeHash(hash)
  return ROOT_PATHS.includes(path)
}

/** 深链直达子页时没有 hash 上一页，返回键仍应回到设置首页而不是退出 App。 */
const fallbackHash = (hash: string): string | null => {
  if (isSettingsChildHash(hash)) return '#/settings'
  if (pathOf(hash) === '/extenstion') return '#/settings'
  return null
}

/**
 * 播放详情的关闭键（见文件头「覆盖层」一节）。
 * 找不到就返回 null —— 这条判据必须"证据驱动"：只有真的能关掉，才声称自己处理了返回。
 */
const findPlayDetailCloseBtn = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('.play-detail .control-btn button.hide')

const stack: string[] = [hashOf()]

const onHashChange = () => {
  const next = hashOf()
  const top = stack[stack.length - 1]
  if (next === top) return
  if (isRootHash(next)) {
    // 根级 Tab：历史重置为「当前页就是栈底」→ 任何顶层 Tab 上 canGoBack 恒 false，
    // 原生据此走「再按一次退出」（而不是空返回、更不是把 SPA 导航出空白页）。
    stack.length = 1
    stack[0] = next
    return
  }
  const idx = stack.lastIndexOf(next)
  if (idx > -1) {
    // 后退：截断到目标格（含）
    stack.length = idx + 1
  } else {
    stack.push(next)
    if (stack.length > MAX_DEPTH) stack.splice(0, stack.length - MAX_DEPTH)
  }
}

window.addEventListener('hashchange', onHashChange)

const api = {
  /** 原生在返回键按下时**每次**调用（不能缓存，缓存就是 P1-1 的成因） */
  canGoBack: () =>
    findOpenPopup() != null ||
    findOpenModal() != null ||
    findPlayDetailCloseBtn() != null ||
    stack.length > 1 ||
    fallbackHash(hashOf()) != null,
  /** 返回 false 表示"已到根，请按退出处理"；true 表示"我自己处理了" */
  goBack: () => {
    // 第 1 档：最上层弹层（倍速/音量/循环/播放列表…）。它是 Portal 到 #root 的浮层，
    // 不改 hash 也不是整屏 —— 不在这里关掉，返回就会直接落到 hash 栈 / 退出 App，
    // 浮层孤儿化留在屏幕上（D-23）。关闭方式与 D-22 点外部完全一致：派发 mouseleave。
    const popup = findOpenPopup()
    if (popup) {
      dismissPopup(popup)
      return true
    }
    // 第 2 档：Modal 对话框（声音设置/评论/导入/排序…，D-27）。它是**居中**的，
    // 比全屏的播放详情更局部，所以排在它之前关。关闭入口见 dismissModal 的注释：
    // 本构建里 header 关闭键不存在，实际走的是 `.content` 的 Escape 处理器。
    const modal = findOpenModal()
    if (modal && dismissModal(modal)) return true
    // 第 3 档：播放详情覆盖层。它是全屏的，不关掉就等于"按返回退出 App"。
    const closeBtn = findPlayDetailCloseBtn()
    if (closeBtn) {
      closeBtn.click()
      return true
    }
    // 第 4 档：hash 记账栈；深链子页无栈可退时回到设置首页
    if (stack.length > 1) {
      window.history.back()
      return true
    }
    const fallback = fallbackHash(hashOf())
    if (fallback) {
      window.location.hash = fallback
      return true
    }
    return false
  },
  /** 调试用：原生/CDP 都能读，出问题时不必猜 */
  debug: () => ({
    stack: [...stack],
    hash: hashOf(),
    path: pathOf(hashOf()),
    isRoot: isRootHash(hashOf()),
    playDetail: findPlayDetailCloseBtn() != null,
    popup: findOpenPopup() != null,
    modal: findOpenModal() != null,
  }),
}

Object.defineProperty(window, '__anylisten_canGoBack__', {
  value: api.canGoBack,
  configurable: true,
  writable: true,
})
Object.defineProperty(window, '__anylisten_goBack__', {
  value: api.goBack,
  configurable: true,
  writable: true,
})
Object.defineProperty(window, '__anylisten_back_debug__', {
  value: api.debug,
  configurable: true,
  writable: true,
})

export {}
