/**
 * 底部弹层（`base/Popup.svelte`）在触屏上的**关闭契约**（D-22 / D-23）。
 *
 * ## 为什么必须在这里补（问题本体在上游，但上游不能改）
 *
 * 上游 `Popup` 的关闭路径**只有一条**：`onmouseleave` → `PopupBtn.handlMsLeave()` →
 * 100ms 后 `visible = false`。触屏上没有 `mouseleave`，于是：
 *
 * 1. `Popup.svelte` 根节点只有一个 `onclick={(e) => e.stopPropagation()}`，**不关闭**；
 * 2. `PopupBtn.handleShowPopup()`：`if (visible) { evt.stopPropagation(); if (autoshow) return }`
 *    —— autoshow 时**再点触发器也直接 return**，等于"同一个按钮关不掉自己"；
 * 3. 桌面靠"鼠标移开"隐式关闭，触屏把这条路径整条掐断
 *    → 实测：倍速/音量/循环/播放列表浮层一旦打开就再也关不掉，
 *    而且 `elementFromPoint` 在视口任意四点都返回 `DIV.popup`（见第 3 节）。
 *
 * ## 第 3 节（我们的 BottomSheet 化）为什么会加剧它
 *
 * `ui/mobile.less` §3 把 `.menu`/`.popup` 改成底部抽屉，并给它们加了一条全屏 scrim：
 *
 *   html.mobile .popup::before { position: fixed; inset: 0; z-index: -1; background: rgb(0 0 0/40%) }
 *   html.mobile .popup { pointer-events: auto !important }
 *
 * 伪元素的**命中目标就是宿主元素**，所以整个视口都被算成"点在 `.popup` 上" ——
 * 点空白处、点触发器、点播放键，`event.target` 全是 `DIV.popup`，触发器根本收不到 click。
 * 也就是说"点外部关闭"这条普通方案在这个结构下**不成立**，必须按**几何位置**判定，
 * 而不是按 `event.target` 判定。
 *
 * ## 还有第二层：光派发 `mouseleave` 关不掉（实测踩到的坑）
 *
 * 只把 `visible` 改掉是不够的。上游卸载 DOM 只认 `ontransitionend` → `render = false`，
 * 而 §3 用 `opacity: 1 !important` + `transform: none !important` 把过渡两端钉成同一个值
 * → 过渡不发生 → `transitionend` 永不触发 → 元素留在 DOM 里、`opacity` 仍是 1。
 * 实测证据：派发 `mouseleave` 后 `class` 已从 `popup top active` 变成 `popup top`、
 * `inert` 已加上（**状态关掉了**），但 `getBoundingClientRect()` 仍非 0、`opacity` 仍为 `1`
 * （**像素没变**）—— 这就是 QA 看到"关不掉"的直接原因。
 * 所以配套的 CSS 修在 `mobile.less` §3：`html.mobile .popup[inert], .menu[inert] { display:none }`。
 * 本文件的 `isShown()` 用 rect 判据，`display:none` 后自动返回 false，两条修法互补。
 *
 * ## 判据（本文件导出的三个函数，`androidBack.ts` 复用同一套，避免两处判据漂移）
 *
 * - 打开态：`.popup` 元素的 `getBoundingClientRect()` 宽高都 > 0 且不是
 *   `display:none / visibility:hidden`。**不要**用 `visible` 变量 —— 那是 Svelte 内部状态，
 *   这里拿不到；`.popup` 只在 `render` 为真时存在，隐藏后会被移除（有 160ms 过渡尾巴）。
 * - 内部可交互区：`.popup-content` 的 rect。**不能用 `.popup` 的 rect** —— 它被我们的样式
 *   改成了"底部整条 + 全屏 scrim"，用它判定等于永远"点在内部"。
 * - 关闭：对弹层元素 `dispatchEvent(new MouseEvent('mouseleave'))`，走上游自己的
 *   `onmouseleave` 处理器。**不删 DOM、不改 `visible` 绑定**——那是组件私有状态，
 *   外部硬改会让 `render`/`anim` 与真实状态不一致（正是"关一次就永久失效"的成因）。
 *
 * ## 两条硬约束
 *
 * 1. **不 `preventDefault`**：底部抽屉里的滚动、长按（`ui/compositions/longPress.ts`）、
 *    滑动手势都要靠默认行为。监听因此用 `passive: true`（我们从不取消事件，
 *    passive 只会更省一次合成器往返；万一以后有人误加 preventDefault，平台会直接告警）。
 * 2. **幂等**：没有打开态弹层时立刻返回；重复调用只会重复发一次 `mouseleave`
 *    （上游 `handlMsLeave` 对 `!visible` 直接 return），不会阻止下一次打开。
 */

const POPUP_SEL = '.popup'
const MENU_SEL = '.menu'
const CONTENT_SEL = '.popup-content'
/** `material/Modal.svelte` 的根类名（声音设置 / 评论 / 导入 / 排序 / 扩展详情…都用它） */
const MODAL_SEL = '.modal'

/** 元素当前是否"真的打开着"（宽高非 0、未 display/visibility 隐藏） */
function isShown(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  const style = window.getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

/** 当前所有打开中的弹层（DOM 顺序，最后一个是最上层） */
export function findOpenPopups(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(POPUP_SEL)).filter(isShown)
}

/** 最上层弹层；没有则 null。`androidBack.ts` 的返回键优先级第一档用的就是它 */
export function findOpenPopup(): HTMLElement | null {
  const list = findOpenPopups()
  return list.length ? list[list.length - 1]! : null
}

/**
 * 当前打开中的 Modal（`material/Modal.svelte`），没有则 null。
 *
 * 与 `.popup` 的区别：Modal 是**居中的对话框**（`position:absolute; width/height:100%`，
 * 内部 `.content` 是卡片），`.popup` 是底部抽屉。两者都 Portal 到 `#root`、都不改 hash，
 * 所以返回键必须分两档处理 —— 否则在 Modal 上按返回会直接落到"关播放详情 / 退 App"（D-27）。
 *
 * 判据复用 `isShown`：上游 `{#if visible}` 才挂 DOM，但 `transition:fly` 的退出动画期间
 * 元素还在，靠"元素存在"判定会把正在关闭的弹窗也算成打开态。
 */
export function findOpenModal(): HTMLElement | null {
  const list = Array.from(document.querySelectorAll<HTMLElement>(MODAL_SEL)).filter(isShown)
  return list.length ? list[list.length - 1]! : null
}

/**
 * 关闭一个 Modal；返回 `true` 表示"已经按上游的关闭路径发出指令"。
 *
 * 为什么**不能**像 `.popup` 那样派发 `mouseleave`：Modal 压根没有 onmouseleave，
 * 它的关闭入口只有三个 —— ①头部关闭键（`closebtn`）、②点背景（`domClick` + `bgclose`）、
 * ③`.content` 上的 `onkeydown` 处理 Escape。
 *
 * 而 ① 在本构建里**不存在**：`Modal.svelte:157-166` 的 header 只在 `VITE_IS_DESKTOP`
 * 或 `VITE_IS_WEB` 分支渲染，而我们的构建两者都硬编码为 false（与 O-7 的 D-10 同源）。
 * 实测手机上的 Modal 没有标题栏、也没有关闭键，用户只能点背景关掉。
 * 所以这里走 ③：给 `.content` 派发一次 Escape —— 与桌面"按 Esc 关弹窗"**完全相同**的路径，
 * 会依次执行 `onclose`（可能弹确认）→ `visible = false`，不硬改组件私有状态。
 *
 * 返回 `true` 不代表"已关闭"，只代表"关闭指令已交给上游"：`onclose` 可能返回 false 拦下
 * （例如有未保存内容）。此时返回键这一次算被消费掉，用户再按一次会重新走这条路径 ——
 * 比"越过 Modal 去关它背后的页面"安全。
 */
export function dismissModal(el: HTMLElement): boolean {
  // 只认 Modal **自己**的头部关闭键：`.modal > .content > header > button`。
  // 绝对不能写成 `el.querySelector('.header button')` —— 弹窗内容区里常常自带 `.header`
  // （实测「音效设置」面板的 header 里有一个「重置」按钮），那样按返回键会去点「重置」，
  // 既关不掉弹窗、又把用户的音效配置清空。这一条是实测踩出来的，不是理论洁癖。
  const content = el.querySelector<HTMLElement>(':scope > .content') ?? el.querySelector<HTMLElement>('.content')
  const closeBtn = content?.querySelector<HTMLElement>(':scope > header.header > button, :scope > header > button')
  if (closeBtn) {
    closeBtn.click()
    return true
  }
  if (!content) return false
  // ③ `.content` 上的 onkeydown 处理 Escape → close()，与桌面「按 Esc 关弹窗」完全同一条路径，
  // 不硬改组件私有状态（`visible` 由组件自己置 false，`{#if visible}` 才卸载）。
  content.focus?.()
  content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  return true
}

const warnOnce = (() => {
  let warned = false
  return (msg: string) => {
    if (warned) return
    warned = true
    console.warn(`[ui/boot/popupDismiss] ${msg}`)
  }
})()

/**
 * 补发一次合成的 `transitionend`，让上游走 `render = false` 真正卸载 DOM。
 *
 * 上游 `Popup.svelte:84-87` / `Menu.svelte:83-85` / `MiniPlayProgress.svelte:64-67` 的清理
 * 全都挂在 `ontransitionend` 上（`if (!visible) render = false`）。而 `mobile.less` §3 把
 * `opacity`/`transform` 用 `!important` 钉死 → 过渡不会跑 → 这个事件永远不来 → 关闭后
 * 元素虽然被 `[inert] → display:none` 藏起来了，但**仍然留在 DOM 里**（实测关一次就多一个
 * `.popup` 实例）。这里在确认已进入关闭态后补发一次，让上游的清理逻辑按它原本的设计执行。
 *
 * 只在 `[inert]` 存在时发（`anim === false` = 上游自己认定已关闭）；用户又点开时 `inert`
 * 被移除，这里自然不发 —— 不会把刚打开的弹层卸载掉。
 * 用 `TransitionEvent` 而非 `Event`：`propertyName` 是上游 `handleTransitionEnd` 可能读的字段。
 */
const flushClose = (el: HTMLElement) => {
  if (!el.isConnected || !el.hasAttribute('inert')) return
  el.dispatchEvent(new TransitionEvent('transitionend', { propertyName: 'opacity', bubbles: false }))
}

/**
 * 关闭一个弹层：派发上游 `onmouseleave`，让组件自己走 `visible = false`，等它真的进入
 * 关闭态后再补一次卸载信号。
 *
 * 为什么不用"固定延时 + 一次检查"：上游 `handlMsLeave` 有 100ms 去抖，而**触屏上 Chrome 会
 * 在 `pointerup` 之后补发一套兼容 mouse 事件**（`mouseover`/`mouseenter`/…），可能把去抖位
 * 抢掉、让 `visible = false` 落地得比预期晚。实测同一串操作连做 3 次，有 1 次 250ms 时
 * `[inert]` 还没加上 → 卸载信号被跳过 → DOM 里留一个 `display:none` 的僵尸弹层。
 * 所以改成 100ms 一轮、最多 20 轮（2s）的短轮询：**每一轮都只看状态、不猜时间**。
 *
 * - 元素已从 DOM 移除（含被上游自己卸载）→ 收工；
 * - 出现 `[inert]`（= 上游认定已关闭）→ 补发 `transitionend` 卸载，收工；
 * - 第 3 轮（约 300ms）还没关 → 重发一次 `mouseleave` 兜底；
 * - 第 20 轮还没关 → 收工并留一条 warn（只留一次）。
 *
 * 兜底只重试**同一个元素**，不去猜触发器：弹层被 Portal 到 `#root`，DOM 上与触发器无父子关系，
 * 靠 `activeElement` 定位到的只会是 `.popup-content`，猜错就会误关别的东西。
 * 幂等：中途被用户重新打开时 `[inert]` 消失 → 这一轮不发卸载信号，等它下次关闭。
 */
export function dismissPopup(el: HTMLElement): void {
  const leave = () => el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: false }))
  leave()
  let ticks = 0
  const timer = window.setInterval(() => {
    ticks++
    if (!el.isConnected) {
      window.clearInterval(timer)
      return
    }
    if (el.hasAttribute('inert')) {
      window.clearInterval(timer)
      flushClose(el)
      return
    }
    if (ticks === 3) leave()
    if (ticks < 20) return
    window.clearInterval(timer)
    if (isShown(el)) warnOnce(`弹层 2s 内未响应 mouseleave（class=${el.className}），可能是非 PopupBtn 来源的 .popup`)
  }, 100)
}

/**
 * 兜住**所有**关闭路径的卸载：不管是本文件点外部关的、还是上游自己关的
 * （`TogglePlayModeBtn` 里点选项后直接 `popup.hide()`、`PopupBtn` 的 autoshow=false 分支、
 * 右键菜单的 `onHide()`），只要真的进了关闭态，Svelte 就会给元素加上 `inert`。
 * 于是在 `inert` 上加一个观察者补发 `transitionend` —— 否则经 `popup.hide()` 关掉的弹层
 * 会被 `mobile.less` 的 `[inert] → display:none` 藏住，却仍以僵尸 DOM 留在页面里
 * （实测：点循环选项关掉后 `.popup` 计数从 1 不回落）。
 *
 * 只观察 `inert` 一个属性：全页只有 `.popup` / `.menu` 会用到它，代价可忽略。
 * 打开首帧（`render` 已真、`anim` 还没置真）也会触发一次，但三个上游处理器都先判
 * `visible` / `show`（`Popup.svelte:85`、`Menu.svelte:84`、`MiniPlayProgress.svelte:65`），
 * 打开态下收到这个事件是空操作，不会把刚开的弹层卸掉。
 */
const closeWatcher = new MutationObserver((records) => {
  for (const record of records) {
    if (record.attributeName !== 'inert') continue
    const el = record.target
    if (!(el instanceof HTMLElement)) continue
    if (!el.matches(POPUP_SEL) && !el.matches(MENU_SEL)) continue
    flushClose(el)
  }
})
closeWatcher.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['inert'] })

/** 指针是否落在弹层内容区内部（内容区 = 真正可交互的那块） */
function isInsideContent(el: HTMLElement, x: number, y: number): boolean {
  const content = el.querySelector<HTMLElement>(CONTENT_SEL)
  if (!content) return false
  const rect = content.getBoundingClientRect()
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

const onPointerDown = (event: PointerEvent) => {
  // 注意：`event.target` 在这里**没有判定价值** —— 全屏 scrim 是宿主的伪元素，
  // 命中目标恒为 `DIV.popup`。只能按坐标判。
  const popup = findOpenPopup()
  if (!popup) return
  if (isInsideContent(popup, event.clientX, event.clientY)) return
  dismissPopup(popup)
}

document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })

export {}
