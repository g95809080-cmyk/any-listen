/**
 * 首帧路由归一化。
 *
 * **必须是 `entries/main.ts` 的第一条 import**，原因见下。
 *
 * ## 问题
 *
 * 首帧 URL 是 `http://127.0.0.1:17930/?t=<cachebuster>`，没有 hash。
 * `view-main/src/plugins/svelte-spa-router/navigator.ts:44-58` 的 `getLocation()`
 * 在 `href` 里找不到 `#/` 时把 `rawLocation` 置成 `'/'`；而 `plugins/routes.ts` 只有
 * `/library` 与 `'*'` 等具体项，`'/'` 落到 `'*'` 兜底 → 渲染 Library，但 `$location` 仍是 `'/'`。
 * 于是：
 * - `MobileTabBar` 的 `isActive('/library')` 判 false → **三个 tab 一个都不高亮**；
 * - `views/Online/index.svelte:33-35` 的 `setLastHistory($location, …)` 把 `'/'` 写进"上次位置"，
 *   之后 `modules/resource/actions.ts:66-77` 的 `toOnlineSearch()`（空文本分支）会拿它当 fallback
 *   直接 `push('/')` 跳回根路径 —— 只改 TabBar 的判定是治不好的。
 *
 * ## 为什么必须最早求值
 *
 * `navigator.ts:71-78` 是
 * `export const loc = readable<Location>(getLocation(), …)` —— `readable` 的**初始值在模块
 * 求值时立刻算定**，之后的 `hashchange` 只会更新订阅者，不会重算初值。所以归一化必须发生在
 * `navigator.ts` 被 import **之前**，晚一步就白改（`main.ts` 第 32 行的 `@ui/modules` 会把
 * router 插件整条链拉进来）。
 *
 * ## 为什么用 `replaceState` 而不是 `pushState` / `location.hash =`
 *
 * - `replaceState` **不新增历史条目**，替换的是"首次加载那条唯一 entry"，
 *   按返回键仍然直接退出 App —— 与修复前的行为完全一致，后退语义不变。
 * - `location.hash = '#/library'` 会新增一条历史记录，用户按返回会回到 `'/'` 再退一次。
 *
 * ## 两个细节
 *
 * 1. `href.split('#')[0]` 而不是 `location.pathname + location.search`：前者逐字保留
 *    `?t=<cachebuster>`，也不会把 path 里的百分号编码二次转义。
 * 2. 手工派发 `hashchange`：`navigator.ts:150` 的 `replace()` 也是这么做的，否则
 *    `readable` 的 `start()` 订阅者（若已订阅）收不到首次通知。
 */

const href = window.location.href

if (!href.includes('#/')) {
  try {
    history.replaceState({ ...history.state }, '', `${href.split('#')[0]}#/library`)
    window.dispatchEvent(new Event('hashchange'))
  } catch {
    /* 非 http(s) 场景（file:// / about:blank）会抛 SecurityError，忽略即可 */
  }
}

export {}
