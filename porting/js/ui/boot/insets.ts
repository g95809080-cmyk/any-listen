/**
 * 原生 → 页面的安全区注入（ERR-009）。
 *
 * ## 为什么不能只靠 `env(safe-area-inset-bottom)`
 * 实测 Android WebView 133（模拟器 API 36，三键导航）：`viewport-fit=cover` 下
 * `safe-area-inset-top` 能拿到 48px，但 **`safe-area-inset-bottom` 恒为 0**。
 * 结果是 `--tabbar-h` 那 56px 里有 48px 压在系统导航栏的半透明遮罩下面 ——
 * 截图里底部三个标签整体发灰，点击区也被手势条/三键条吃掉。
 *
 * ## 契约（与 `MainActivity.installInsetsBridge()` 成对，改一边必须改另一边）
 * 原生在 `setOnApplyWindowInsetsListener` 里算好 CSS px（px ÷ density），然后执行：
 *
 *   window.__anylisten_pendingInsets__ = [top, bottom];
 *   window.__anylisten_applyInsets__ && window.__anylisten_applyInsets__(top, bottom);
 *
 * 写 `__anylisten_pendingInsets__` 是为了**时序**：insets 往往在本文档的 JS 还没求值时就
 * 已经派发过一次，那次 `applyInsets` 必然落空。所以原生无条件记下最近一次值，
 * 本文件在装配钩子后立刻补应用一次（首帧就不会缺底部安全区）。
 *
 * 注入的是 `--inset-top` / `--inset-bottom`，与 `ui/mobile.less` 的
 * `--safe-top/--safe-bottom: max(env(...), var(--inset-*))` 配合使用 —— 取最大值，
 * 有 env 无原生、有原生无 env 都成立，且两者同时存在时不会重复叠加。
 */

type ApplyInsets = (top: number, bottom: number) => void

declare global {
  interface Window {
    __anylisten_applyInsets__?: ApplyInsets
    __anylisten_pendingInsets__?: [number, number]
  }
}

const apply: ApplyInsets = (top, bottom) => {
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return
  const root = document.documentElement
  root.style.setProperty('--inset-top', `${Math.max(0, top)}px`)
  root.style.setProperty('--inset-bottom', `${Math.max(0, bottom)}px`)
}

window.__anylisten_applyInsets__ = apply

const pending = window.__anylisten_pendingInsets__
if (pending) apply(pending[0], pending[1])

export {}
