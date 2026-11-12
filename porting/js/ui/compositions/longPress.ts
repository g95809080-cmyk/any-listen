/**
 * 长按 → 合成 `contextmenu`（N-11）。
 *
 * ## 为什么这样做，而不是改 34 个组件
 * 上游有 34 处 `oncontextmenu`（歌曲列表、歌词、队列…），每处都自己调 `menu.show(event.pageX, event.pageY)`。
 * 触屏上没有右键，桌面版靠长按由 WebView 原生合成 `contextmenu`——但 Android WebView 的
 * 原生长按只对"可选文本/链接"可靠触发，对 `div[role=button]` 不行。
 *
 * 于是我们在 **document 层**补一次：长按 500ms 后手动 `dispatchEvent(new MouseEvent('contextmenu'))`，
 * 目标元素上现成的 34 个 handler 全部原样生效，**零改上游组件**。
 * 再配合 `ui/mobile.less` §3 的「`.menu`/`.popup` → BottomSheet」，这些菜单自动变成底部弹出。
 *
 * ## 与滚动的冲突
 * 触摸设备上长按和滚动是同一次指针序列。判定规则：
 * - 位移 > 10px → 视为滚动，取消计时（不误触菜单）；
 * - 500ms 内抬起 → 视为点击，取消计时；
 * - 多指（`isPrimary === false`）→ 直接不管，避免捏合缩放时弹菜单。
 *
 * ## 为什么还要吞掉随后的 click
 * 长按抬起后浏览器仍会派发 `click`。若目标是歌曲行，会顺带触发一次播放 —— 用户只想开菜单。
 * 因此在 contextmenu 之后挂一个**一次性 capture 阶段** click 拦截，只吞掉紧邻的那一次。
 */

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE_PX = 10

/** 这些元素上不要劫持：输入框里长按是选择文本/粘贴菜单 */
const IGNORE_SELECTOR = 'input, textarea, [contenteditable="true"], [contenteditable=""], .ignore-long-press'

export interface LongPressOptions {
  /** 长按阈值，默认 500ms（Android 系统观感值） */
  delayMs?: number
  /** 位移容差，默认 10px */
  moveTolerancePx?: number
}

/**
 * 安装全局长按 → contextmenu 合成。
 * @returns 卸载函数（组件销毁时调用）
 */
export function installLongPressContextMenu(options: LongPressOptions = {}): () => void {
  const delay = options.delayMs ?? LONG_PRESS_MS
  const tolerance = options.moveTolerancePx ?? MOVE_TOLERANCE_PX

  let timer: ReturnType<typeof setTimeout> | null = null
  let startX = 0
  let startY = 0
  let target: Element | null = null
  /** 刚刚合成过 contextmenu：吞掉紧接着的一次 click */
  let swallowClick = false

  function clear(): void {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
    target = null
  }

  function onPointerDown(event: PointerEvent): void {
    if (!event.isPrimary) return
    if (event.pointerType === 'mouse') return // 桌面浏览器里长按鼠标不弹菜单，与系统一致
    const el = event.target
    if (!(el instanceof Element)) return
    if (el.closest(IGNORE_SELECTOR)) return

    clear()
    startX = event.clientX
    startY = event.clientY
    target = el
    timer = setTimeout(() => {
      timer = null
      const hit = target
      clear()
      if (!hit) return
      swallowClick = true
      // 菜单 handler 里用的是 `event.pageX/pageY`。`MouseEventInit` 不接受这两个字段，
      // 但浏览器会按 `pageX = clientX + scrollX` 自动推导，正是我们要的值 —— 不要手动塞。
      hit.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: startX,
          clientY: startY,
          button: 2,
          buttons: 0,
        })
      )
      navigator.vibrate?.(15)
    }, delay)
  }

  function onPointerMove(event: PointerEvent): void {
    if (timer == null) return
    if (Math.abs(event.clientX - startX) > tolerance || Math.abs(event.clientY - startY) > tolerance) {
      clear()
    }
  }

  function onClickCapture(event: MouseEvent): void {
    if (!swallowClick) return
    swallowClick = false
    // `stopPropagation()` 只阻止事件继续冒泡，不能阻止同一元素上的其他监听器。
    // 上游弹层也在 document capture 阶段监听 click 以处理“点外部关闭”；若长按结束后的
    // 合成 click 仍到达它，菜单位于手指上方时会在用户抬起手指的瞬间被关闭。
    event.stopImmediatePropagation()
    event.preventDefault()
  }

  function onPointerEnd(): void {
    clear()
  }

  document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
  document.addEventListener('pointerup', onPointerEnd, { capture: true, passive: true })
  document.addEventListener('pointercancel', onPointerEnd, { capture: true, passive: true })
  document.addEventListener('click', onClickCapture, true)
  // 系统侧原生长按若也触发了 contextmenu，把我们的计时器撤掉，避免弹两次
  document.addEventListener('contextmenu', onPointerEnd, { capture: true, passive: true })

  return () => {
    clear()
    document.removeEventListener('pointerdown', onPointerDown, { capture: true })
    document.removeEventListener('pointermove', onPointerMove, { capture: true })
    document.removeEventListener('pointerup', onPointerEnd, { capture: true })
    document.removeEventListener('pointercancel', onPointerEnd, { capture: true })
    document.removeEventListener('click', onClickCapture, true)
    document.removeEventListener('contextmenu', onPointerEnd, { capture: true })
  }
}
