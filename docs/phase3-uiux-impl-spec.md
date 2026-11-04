# Any Listen Android — Phase 4 UI 实现清单（可直接抄）

> 作者：柯悦屏（移动端 UI/UX 重构专家）
> 配套：`phase3-uiux.md`（设计与策略）、`phase3-uiux-overlay-supplement.md`（悬浮窗）
> 本文是**执行版**：给出文件路径、改动位置（选择器/行号）、可粘贴的 CSS/JS 片段、依赖的触控令牌。
> 目标读者：fullstack-dev（JS/Svelte 部分）、native-engineer（WebView 与桥部分）。

---

## 0. 使用前必读：5 条硬规则 + 落盘位置

### 0.1 落盘位置（不修改 `source/`）

```
porting/js/
├── entries/main.ts                      ← 新建。我们自己的入口（替换 view-main/src/main.ts 的角色）
└── ui/
    ├── mobile.less                      ← N-0，全局覆盖表（唯一 CSS 文件，§1）
    ├── i18n.ts                          ← N-10，移动端文案字典（§0.5 / §16）
    ├── MobileApp.svelte                 ← N-1
    ├── shell/
    │   ├── MobileAppShell.svelte        ← N-2
    │   ├── MobileAppBar.svelte          ← N-4
    │   ├── MobileTabBar.svelte          ← N-3
    │   └── MiniPlayer.svelte            ← N-5
    ├── material/
    │   ├── BottomSheet.svelte           ← N-6
    │   └── ActionSheet.svelte           ← N-7
    ├── pages/
    │   ├── LibraryHome.svelte           ← N-8
    │   └── SearchPage.svelte            ← N-9
    ├── compositions/
    │   ├── longPress.svelte.ts          ← N-11
    │   └── swipeDismiss.svelte.ts       ← N-12
    └── overrides/                       ← O-1..O-5：从 source 复制后改，靠 alias 顶替原模块
        ├── components/common/MusicList/List/index.svelte            ← O-1
        ├── components/common/MusicList/List/ListItem.svelte         ← O-1b
        ├── components/layout/PlayDetail/RightLyric/LyricPlayer.svelte ← O-4
        ├── views/Library/index.svelte                               ← O-2
        ├── views/Search/index.svelte                                ← O-3
        └── views/Setting/AppSetting/AppSetting.svelte               ← O-5
```

**合计：6 个覆盖文件（O-1, O-1b, O-2, O-3, O-4, O-5）+ 13 个新增文件（N-0..N-12）+ `entries/main.ts` = 20 个文件。**

> 与 `phase3-uiux.md` §9.3 的"4 个 O + 13 个新增 ≈ 18"相比多了 2 个：`O-1b ListItem.svelte`（Svelte 5 的 `$props()` 不透传未声明 props，必须显式转发 4 个 pointer 事件，见 §2）、`O-5 AppSetting.svelte`（`SettingList` 读模块单例，只有原地 mutate 能同时管住左右两栏，见 §15）。另外 `entries/main.ts` 之前没算进"新增"，因为它原本被当成构建配置的一部分。

alias 配置见 `phase3-uiux.md` §9.3.3。**注意两条都来自 `view-main/vite.config.js:48-51`，移植构建必须原样复制**：

| alias | 目标 | 为什么必须复制 |
|---|---|---|
| `@` | `<view-main>/src` | 我们所有新组件都用 `@/components/...` 引用上游；缺了它 `porting/js` 里全部 `@/` 导入直接解析失败 |
| `sortablejs` | `node_modules/sortablejs/modular/sortable.core.esm.js` | 上游强制走 core 版（`vite.config.js:50`）；不复制会拉到完整版，`MultiDrag`/`Swap` 插件行为不同 |

**覆盖项的 alias 必须排在 `@` 之前**（vite 的 alias 是按数组顺序首个匹配，不是最长匹配）。例如：

```js
// porting/js/vite.config.mjs（节选）
resolve: {
  alias: [
    // ① 覆盖项优先：把上游路径重定向到我们的实现
    { find: /^@\/components\/common\/MusicList\/List\/index\.svelte$/, replacement: p('ui/overrides/components/common/MusicList/List/index.svelte') },
    { find: /^@\/components\/common\/MusicList\/List\/ListItem\.svelte$/, replacement: p('ui/overrides/components/common/MusicList/List/ListItem.svelte') },
    { find: /^@\/components\/layout\/PlayDetail\/RightLyric\/LyricPlayer\.svelte$/, replacement: p('ui/overrides/components/layout/PlayDetail/RightLyric/LyricPlayer.svelte') },
    { find: /^@\/views\/Library\/index\.svelte$/, replacement: p('ui/overrides/views/Library/index.svelte') },
    { find: /^@\/views\/Search\/index\.svelte$/, replacement: p('ui/overrides/views/Search/index.svelte') },
    { find: /^@\/views\/Setting\/AppSetting\/AppSetting\.svelte$/, replacement: p('ui/overrides/views/Setting/AppSetting/AppSetting.svelte') },
    // ② 上游原有两条，必须保留
    { find: /^@\//, replacement: srcPath + '/' },
    { find: /^sortablejs$/, replacement: '.../sortablejs/modular/sortable.core.esm.js' },
  ],
},
```

**必须用正则 `find`**：字符串形式的 find 也走"前缀匹配 + 拼接"，但 `@/views/Library/index.svelte` 这种带扩展名的精确路径用正则更可控，且能避免 `@/` 那条把 `@/views/Library/index.svelte/xxx` 拼出乱路径。

### 0.2 规则一：所有 CSS 选择器必须以 `html.mobile` 开头

Svelte 会把组件样式编译成 `.container.svelte-a1b2c3`（特异性 `0,2,0`）；`#app-main` 编译成 `#app-main.svelte-a1b2c3`（`1,1,0`）。
全局样式表里写 `.container{}`（`0,1,0`）**赢不了**，写 `html.mobile .container`（`0,2,1`）**必赢**，无需 `!important`。
只有一种情况需要 `!important`：**样式被 JS 以 inline style 写在元素上**（`menuLocaltion` 的 `left/top`、`Popup` 的 `transform`、`VirtualizedList` 的 `height`）。

**验证方法**（DevTools）：选中元素，看 Styles 面板里被划掉的规则；若我们的规则被划掉，说明前缀缺失或需要 `!important`。

### 0.3 规则二：`html.mobile` 前缀会让 px **保持 px**

`vite.config.js:185` 的 `selectorBlackList: ['html', 'ignore-to-rem']` 是 `selector.includes('html')` 匹配。
所以 `html.mobile .btn { width: 44px }` 里的 `44px` **不会**被 pxtorem 转成 rem —— 完全可预测。

**这是一条要主动利用的特性**：我们的所有尺寸写 `px` 就精确等于 `dp`，不依赖 `html{font-size}`。
反之，**若漏写 `html.mobile` 前缀**，px 会被转成 rem，一旦用户改了 `common.fontSize`（全局倍率）你的尺寸就跟着漂 —— 这是最容易踩的坑。

另：`mediaQuery: false`（`vite.config.js:186`），所以 `@media (max-width: 599.98px)` 里的 px **本来就不转**，断点可放心写 px。

### 0.4 规则三：`!important` 只在"打不过内联样式"时才用

Svelte 5 的 scoped CSS 会把 `.container` 编译成 `.container.svelte-xxxx`，特异性是 `0,2,0`；`html.mobile .container` 是 `0,2,1`，**必然赢**，不需要 `!important`。

三条判定：

| 上游写法 | 我们的对策 | 要不要 `!important` |
|---|---|---|
| 类选择器（绝大多数） | `html.mobile .xxx` | ❌ 不需要 |
| 内联 `style="..."`（如 `LyricPlayer` 的 `--play-detail-lrc-font-size`） | 覆盖 CSS 变量 **或** 改组件（见 O-4） | ✅ 必须（CSS 无法赢内联） |
| 第三方 `:global` 深嵌套（如 `settings/index.svelte` 的 `:global{}` 块） | 提高选择器长度（`html.mobile .a .b`） | ⚠ 视情况，先用特异性解决 |

本清单里出现 `!important` 的地方都只有一个原因：目标是**内联样式**或**上游带 `:global` 的高特异性块**。看到 `!important` 就去确认这一点，如果只是普通类选择器还写 `!important`，属于滥杀。

### 0.5 规则四：移动端新增文案**不能**改上游 i18n，用本地字典兜底

`shared/i18n/langs/*.json` 属于 `source/`，不可修改。而移动端确实需要新文案，且有两个坑（已实测）：

| 想用的 key | 实际情况 | 后果 |
|---|---|---|
| `search` | **不存在**（`t('search')` 只出现在被注释掉的代码里） | 会渲染出字面量 `search` |
| `list_name__default` | 实际值是 **「试听列表」**，不是「曲库」 | Tab 显示"试听列表" |
| `search_history` / `search_placeholder` | 不存在 | 渲染字面量 |

**方案：`porting/js/ui/i18n.ts` 本地字典 + 回退上游。**

```ts
// porting/js/ui/i18n.ts
import { i18n } from '@/plugins/i18n'

/** 移动端专属文案（上游没有的）。key 加 mobile__ 前缀避免与上游冲突 */
const dict = {
  mobile__tab_library: { 'zh-cn': '曲库', 'zh-tw': '曲庫', 'en-us': 'Library' },
  mobile__tab_online: { 'zh-cn': '在线', 'zh-tw': '線上', 'en-us': 'Online' },
  mobile__tab_search: { 'zh-cn': '搜索', 'zh-tw': '搜尋', 'en-us': 'Search' },
  mobile__back: { 'zh-cn': '返回', 'zh-tw': '返回', 'en-us': 'Back' },
  mobile__open_player: { 'zh-cn': '打开播放页', 'zh-tw': '開啟播放頁', 'en-us': 'Open player' },
  mobile__search_placeholder: { 'zh-cn': '搜索歌曲、歌手、歌单', 'zh-tw': '搜尋歌曲、歌手、歌單', 'en-us': 'Songs, artists, playlists' },
  mobile__search_history: { 'zh-cn': '搜索历史', 'zh-tw': '搜尋歷史', 'en-us': 'Recent searches' },
  mobile__selected_count: { 'zh-cn': '已选 {num} 项', 'zh-tw': '已選 {num} 項', 'en-us': '{num} selected' },
  mobile__scan_needed: { 'zh-cn': '本地歌曲需要重新扫描', 'zh-tw': '本機歌曲需要重新掃描', 'en-us': 'Local library needs rescan' },
  mobile__retry: { 'zh-cn': '重试', 'zh-tw': '重試', 'en-us': 'Retry' },
} as const

export type MobileMessageKey = keyof typeof dict

/** 优先取移动端字典，其次上游 i18n，最后回退 key 本身 */
export const tm = (key: MobileMessageKey, values?: Record<string, string | number>): string => {
  const entry = dict[key]
  const lang = (i18n.locale || 'zh-cn') as keyof typeof entry
  let text: string = entry?.[lang] ?? entry?.['zh-cn'] ?? i18n.t(key as never)
  if (values) {
    for (const [k, v] of Object.entries(values)) text = text.replace(`{${k}}`, String(v))
  }
  return text
}

/** 上游已有且语义正确的 key，直接用这个薄封装，避免各处 import 不一致 */
export const t = i18n.t.bind(i18n)
```

**可以直接复用上游的 key（已核对存在且语义正确）**

| 用途 | key | 实际值 |
|---|---|---|
| 设置 Tab / 设置页标题 | `setting` | 设置 |
| 在线 Tab（若用四字） | `online_resources` | 在线资源 |
| 搜索 Tab（四字场景） | `online__type_search` | 搜索 |
| 我喜欢 chip | `list_name__love` | 我喜欢 |
| 播放历史 chip | `list_name__last_play` | 播放历史 |
| 全选 / 退出多选 | `select_all` / `batch_select_exit` | 全选 / 退出多选 |
| 播放 / 暂停 / 队列 | `player__play` / `player__pause` / `player__list` | ✓ |
| 清空 | `btn_clear` | ✓ |

> 下面各组件代码里的 `tm(...)` 都来自这个文件；`t(...)` 是上游的。**不要**在组件里直接 `t('search')`。

### 0.6 规则五：注入顺序与 `mobile` 类的来源

```ts
// porting/js/entries/main.ts —— 完整文件
import { mount } from 'svelte'
import 'virtual:svg-icons-register'          // 必须，SvgIcon 依赖 sprite
import '<SRC>/view-main/src/app.less'         // 上游基础样式（reset / #root 背景 / 主题变量）
import './ui/mobile.less'                    // 我们的覆盖表，必须在 app.less 之后
import MobileApp from './ui/MobileApp.svelte'

// 兜底加类（桥注入前也要能跑，方便浏覧器里手动验证）
if (!document.documentElement.classList.contains('mobile')) document.documentElement.classList.add('mobile')

mount(MobileApp, { target: document.getElementById('root')! })
```

> **不要** `import '<SRC>/view-main/src/main.ts'`——它会 mount 桌面版 `App.svelte` 并初始化第二套 IPC/Worker，重复执行会双份订阅。

---

## 1. N-0 全局覆盖表 `porting/js/ui/mobile.less`

> 完整可粘贴。按崩坏点编号分段，便于逐段验收。每段开头标注它修的是 `phase3-uiux.md` §1.4 的哪几个 B-xx。

```less
/* ============================================================================
 * Any Listen Android — 移动端全局覆盖表
 * 规则：所有选择器必须以 html.mobile 开头（见实现清单 §0.2 / §0.3）
 * 单位：1 CSS px = 1 dp（html.mobile 下 px 不被 pxtorem 转换）
 * ========================================================================== */

/* ---------- 0. 设计令牌（phase3-uiux.md §3.1）---------- */
html.mobile {
  --touch-min: 44px;          /* 最小命中区（硬底线） */
  --touch-comfort: 48px;      /* 常规图标按钮 */
  --touch-primary: 56px;      /* 主按钮 */
  --touch-play: 72px;         /* 播放页主播放键 */
  --gap-min: 8px;             /* 相邻可点元素最小间距（硬底线） */
  --gap-group: 16px;
  --page-pad-x: 16px;
  --row-music: 72px;          /* 与 List/index.svelte 的 useListItemHeight(4.5) 一致 */
  --row-list: 72px;
  --row-menu: 56px;
  --row-setting: 56px;
  --appbar-h: 56px;
  --tabbar-h: 56px;
  --miniplayer-h: 60px;
  --sheet-radius: 16px;
  --sheet-max-h: 60dvh;
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --dur-tap: 100ms;
  --dur-sheet: 240ms;
}

/* ---------- 1. 视口 / 安全区 / 外壳（B-01 B-17）---------- */
html.mobile {
  height: 100dvh;
  min-width: 0;              /* 干掉 app.less:71 的 min-width:650px（B-01） */
  min-height: 0;
  overflow: hidden;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
@supports not (height: 100dvh) {
  html.mobile { height: 100vh; }
}
html.mobile body {
  height: 100%;
  overflow: hidden;
  overscroll-behavior: none;  /* 禁掉橡皮筋，避免与自定义滚动打架 */
  touch-action: manipulation; /* 去掉双击缩放 300ms 延迟 */
}
html.mobile #root {
  height: 100%;
  border-radius: 0;
  box-shadow: none;           /* app.less 的窗口阴影在手机上无意义 */
}
/* #root::before 是桌面毛玻璃层（app.less:109-121），手机上关掉省一次全屏合成 */
html.mobile #root::before { display: none; }
/* 桌面窗口拖拽区（B-18） */
html.mobile .drag,
html.mobile .drag-no-modal,
html.mobile .drag-no-any-modal { -webkit-app-region: no-drag; }

/* ---------- 2. 触控目标放大（B-11 B-13 B-14）---------- */
/* Btn.icon：32dp → 44dp（视觉 svg 仍 24dp，靠 padding 撑命中区） */
html.mobile .btn.icon { width: var(--touch-min) !important; height: var(--touch-min) !important; padding: 10px !important; }
html.mobile .btn.icon.min { width: var(--touch-min) !important; height: var(--touch-min) !important; padding: 12px !important; }
/* Btn.min（无 icon）：行高 19dp → 44dp */
html.mobile .btn.min { min-height: var(--touch-min) !important; padding: 0 16px !important; font-size: 13px !important; }
html.mobile .btn.middle { min-height: var(--touch-min) !important; font-size: 13px !important; }
/* 所有裸 button 兜底（含 PopupBtn / Modal 关闭 / PlayDetail 控制键） */
html.mobile .btn,
html.mobile button.btn { min-height: var(--touch-min); }

/* Checkbox：14dp → 20dp 视觉，整行可点由父级行高保证（B-13） */
html.mobile .checkbox { font-size: 15px !important; }
html.mobile .checkbox .container { width: 20px !important; height: 20px !important; }
html.mobile .checkbox .content { min-height: var(--touch-min); }
html.mobile .checkbox .label { line-height: 1.35; }

/* Modal 头部：18dp → 56dp，关闭按钮 44dp（B-14） */
html.mobile .modal .content { min-width: 0 !important; max-width: 100% !important; width: 100% !important;
  border-radius: var(--sheet-radius) var(--sheet-radius) 0 0 !important; }
html.mobile .modal { align-items: flex-end; }          /* 底部对齐 */
html.mobile .modal .content { max-height: 88dvh !important; min-height: 0 !important; }
html.mobile .modal .header { height: 56px !important; padding: 0 8px 0 20px; }
html.mobile .modal .header h3 { font-size: 16px !important; }
html.mobile .modal .header button { width: var(--touch-min) !important; height: var(--touch-min) !important; padding: 0 !important; }
html.mobile .modal .header button svg { height: 16px !important; }

/* 分页：每页按钮 44dp */
html.mobile .pagination button,
html.mobile .pagination .btn { min-width: var(--touch-min) !important; min-height: var(--touch-min) !important; }

/* ---------- 3. 弹层 → BottomSheet（B-10）---------- */
/* 覆盖 34 处右键菜单（base/Menu）+ 全部 Dropdown + hover 弹层（base/Popup）
   这些元素的 left/top/transform/opacity 都是 JS 写在 inline style 上的 → 必须 !important */
html.mobile .menu,
html.mobile .popup {
  position: fixed !important;
  left: 0 !important;
  right: 0 !important;
  top: auto !important;
  bottom: 0 !important;
  width: auto !important;
  max-width: none !important;
  max-height: var(--sheet-max-h) !important;
  margin: 0 !important;
  overflow-y: auto !important;
  border-radius: var(--sheet-radius) var(--sheet-radius) 0 0 !important;
  transform: none !important;
  opacity: 1 !important;
  filter: none !important;
  z-index: 20 !important;
  padding: 8px 0 max(8px, var(--safe-bottom)) !important;
  box-shadow: 0 -2px 16px rgb(0 0 0 / 18%) !important;
  pointer-events: auto !important;
}
/* scrim：fixed 子元素 + 负 z-index 覆盖整个视口（见实现清单 §1 注释） */
html.mobile .menu::before,
html.mobile .popup::before {
  content: '' !important;
  position: fixed !important;
  inset: 0 !important;
  z-index: -1 !important;
  display: block !important;
  width: auto !important;
  height: auto !important;
  border: 0 !important;
  background: rgb(0 0 0 / 40%) !important;
  backdrop-filter: none !important;
}
/* 菜单项 34px → 56dp */
html.mobile .menu .menu-item,
html.mobile .popup .menu-item {
  min-width: 0 !important;
  min-height: var(--row-menu) !important;
  padding: 0 24px !important;
  font-size: 15px !important;
  line-height: var(--row-menu) !important;
  text-align: left;
}
html.mobile .menu .hr { margin: 4px 0; }
/* Popup 内容区：去掉 10px padding 与外层 max-height */
html.mobile .popup .popup-content { padding: 0 !important; }
/* 播放队列（PlaylistBtn 内 .container 是 500px 宽，B-04） */
html.mobile .popup .container { width: 100% !important; min-height: 0 !important; max-height: none !important; }
/* 音量/倍速 弹层内的滑块占满 */
html.mobile .popup .setting { width: 100% !important; padding: 8px 20px !important; }
/* 歌词操作面板（LyricMenu，class="container" 且 Portal 到 #root） */
html.mobile #root > .container {
  position: fixed !important; left: 0 !important; right: 0 !important; top: auto !important; bottom: 0 !important;
  width: auto !important; max-height: 50dvh; overflow-y: auto;
  border-radius: var(--sheet-radius) var(--sheet-radius) 0 0 !important;
  transform: none !important; opacity: 1 !important; z-index: 20 !important;
  padding: 12px 20px calc(12px + var(--safe-bottom)) !important;
}

/* ---------- 4. 歌曲列表：4 列 → 双行卡片（B-03）---------- */
/* ListItem 的 5 个子元素是同级 flex 子项：
   1=.pic  2=.name-cell  3=singer  4=album  5=time
   → 父容器切 grid 即可视觉重排，不动 DOM。
   行高由 VirtualizedList 的 inline height 控制（72px，来自 useListItemHeight(4.5)），此处不设 height。 */
html.mobile .my-list .container {
  display: grid !important;
  grid-template-columns: 48px minmax(0, 1fr) auto;
  grid-template-rows: auto auto;
  grid-template-areas: "pic name side" "pic singer side";
  align-items: center;
  column-gap: 12px;
  row-gap: 2px;
  padding: 8px 12px !important;
  border-radius: 8px !important;
}
html.mobile .my-list .container > .pic { grid-area: pic; width: 48px !important; height: 48px !important; }
html.mobile .my-list .container > .name-cell { grid-area: name; min-width: 0; }
html.mobile .my-list .container > .name-cell .name { font-size: 15px !important; line-height: 1.3; }
html.mobile .my-list .container > .name-cell .label { gap: 6px; }
html.mobile .my-list .container > .name-cell .label .badge { font-size: 10px; }
html.mobile .my-list .container > :nth-child(3) { grid-area: singer; font-size: 12px !important; opacity: .66; line-height: 1.3; }
html.mobile .my-list .container > :nth-child(4) { display: none !important; }  /* 专辑列隐藏 */
html.mobile .my-list .container > :nth-child(5) { grid-area: side; font-size: 11px !important; opacity: .6; }
/* 行内按钮常显（不再 hover 显形，B-03 副产物） */
html.mobile .my-list .container .name-right { opacity: 1 !important; margin: 0 0 0 8px; }
html.mobile .my-list .container .name-right .auto-hide-btns { display: flex !important; }
/* 表头整体隐藏（B-03） */
html.mobile .my-list > .header,
html.mobile .my-list .header { display: none !important; }

/* 列表信息头（封面 140dp → 96dp，B-03） */
html.mobile .view-container > .header .left { width: 96px !important; height: 96px !important; }
html.mobile .view-container > .header .title { font-size: 18px !important; }
html.mobile .view-container > .header { padding: 12px 16px !important; }
html.mobile .view-container > .header .control-btns { margin-top: 10px !important; gap: 8px; }

/* ---------- 5. 播放详情：50/50 → 纵向（B-05 B-16）---------- */
html.mobile .play-detail { border-radius: 0 !important; }
html.mobile .player-detail-main { flex-direction: column !important; }
html.mobile .left-info {
  width: 100% !important;
  flex: none !important;
  padding: 8px 24px 0 !important;
  --content-width: 62%;
}
html.mobile .left-info > :first-child { max-height: 38dvh; }   /* 封面区 */
html.mobile .right-lyric { flex: auto !important; min-height: 0; }
html.mobile .play-detail .footer { height: auto !important; padding-bottom: calc(12px + var(--safe-bottom)); }
html.mobile .play-detail .footer-content { padding: 0 16px !important; }
/* footer 顶部控制行：3 组横排 → 分两行（主控居中在上、两侧辅控在下） */
html.mobile .play-detail .footer .control { flex-wrap: wrap; }
html.mobile .play-detail .footer .side { flex: 1 1 40%; }
/* 播放详情顶栏控制键（关闭/全屏）→ 44dp，隐藏全屏键 */
html.mobile .play-detail .control-btn button { width: var(--touch-min) !important; height: var(--touch-min) !important; }
html.mobile .play-detail .control-btn button.fullscreen { display: none !important; }

/* ---------- 6. 进度条 / 滑块：5px → 44dp 触控带（B-12）---------- */
/* PlayerProgressBar：轨道保持细，命中区靠 ::before 撑高 */
html.mobile .progress { height: 6px !important; overflow: visible !important; }
html.mobile .progress-mask {
  height: var(--touch-min) !important;
  top: 50% !important;
  transform: translateY(-50%);
}
/* thumb：无 thumb 的进度条加一个（拖动时可见） */
html.mobile .progress-mask::after {
  content: '';
  position: absolute;
  top: 50%;
  left: calc(var(--p, 0) * 100%);
  width: 16px;
  height: 16px;
  margin: -8px 0 0 -8px;
  background: var(--color-button-font, #fff);
  border-radius: 50%;
  box-shadow: 0 1px 4px rgb(0 0 0 / 30%);
  opacity: 0;
  transition: opacity 200ms;
}
html.mobile .progress-mask.show-thumb::after { opacity: 1; }
/* SliderBar（音量/音效）：100px → 屏宽-64，命中区 44dp */
html.mobile .slider { width: auto !important; flex: auto; padding: 19px 0 !important; opacity: 1 !important; }
html.mobile .slider .slider-content { height: 6px !important; border-radius: 6px; overflow: visible; }
html.mobile .slider .slider-bar { border-radius: 6px; }
html.mobile .slider .slider-mask { height: 100% !important; }
html.mobile .slider .slider-mask::after {
  content: '';
  position: absolute; top: 50%; left: calc(var(--p, 0) * 100%);
  width: 16px; height: 16px; margin: -8px 0 0 -8px;
  background: var(--color-button-font, #fff); border-radius: 50%;
  box-shadow: 0 1px 4px rgb(0 0 0 / 30%);
}

/* ---------- 7. Tab：30dp → 44dp + 横滚（B-09 B-08）---------- */
html.mobile .header > .list {
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
  gap: var(--gap-min) !important;
  font-size: 14px !important;
  flex: auto;
}
html.mobile .header > .list::-webkit-scrollbar { display: none; }
html.mobile .header > .list .list-item { min-height: var(--touch-min); scroll-snap-align: start; }
html.mobile .header > .list .list-item .label { padding: 0 2px !important; min-height: var(--touch-min); }
html.mobile .header { padding: 0 16px !important; gap: 8px; }

/* ---------- 8. 卡片网格：300px → 150px（2 列）---------- */
/* 只对 display:grid 的元素生效，非 grid 的 ul 完全不受影响 → 可安全放宽选择器 */
html.mobile ul {
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)) !important;
  gap: 12px !important;
  padding: 0 16px 16px !important;
}

/* ---------- 9. 设置页：两栏 → 左栏横滚 chip 条（B-07）---------- */
html.mobile .settings-app-list {
  flex: none;
  width: auto !important;
  max-width: none !important;
  margin: 0 0 12px !important;
  background: transparent !important;
  overflow: visible !important;
  border-radius: 0;
}
html.mobile .settings-app-list .list {
  display: flex !important;
  flex-flow: row nowrap !important;
  gap: var(--gap-min);
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  padding: 0 16px 8px;
  height: auto !important;
  scrollbar-width: none;
}
html.mobile .settings-app-list .list::-webkit-scrollbar { display: none; }
html.mobile .settings-app-list .list-item {
  flex: none !important;
  height: var(--touch-min) !important;
  line-height: var(--touch-min) !important;
  padding: 0 14px !important;
  font-size: 13px !important;
  white-space: nowrap;
  scroll-snap-align: start;
  border-radius: 22px !important;
  background-color: var(--color-primary-light-300-alpha-900) !important;
}
html.mobile .settings-app-list .list-item.active {
  background-color: var(--color-primary-alpha-300) !important;
  font-weight: 600;
}
html.mobile .settings-app-list .list-item > svg { display: none !important; }
/* 设置行 36px → 56dp */
html.mobile .settings-list { margin: 0 !important; padding: 0 16px 32px !important; }
html.mobile .settings-item { padding: 0 !important; }
html.mobile .settings-item + .settings-item { margin-top: 0; }
html.mobile .settings-title { font-size: 16px !important; margin: 16px 0 8px !important; }
html.mobile .settings-item-checkbox,
html.mobile .settings-item-radio,
html.mobile .settings-item-input { min-height: var(--row-setting); display: flex; flex-direction: column; justify-content: center; }

/* ---------- 10. 通知（Toast → Snackbar）---------- */
html.mobile .notify-container { bottom: calc(var(--tabbar-h) + var(--miniplayer-h) + 16px) !important; }
html.mobile .notify-item { min-width: 0 !important; width: calc(100vw - 32px) !important; margin: 0 16px !important; }

/* ---------- 11. hover 语义修正 ---------- */
/* 触摸设备上 :hover 会在 tap 后一直保留 → 只在真 hover 设备生效
   （Svelte 的 :hover 规则无法用 @media 包裹，这里用 pointer 检测取消遗留态） */
@media (pointer: coarse) {
  html.mobile .btn:hover,
  html.mobile .menu .menu-item:hover,
  html.mobile .nav-item .link:hover,
  html.mobile .list-item:hover { background-color: revert-layer; opacity: revert-layer; }
}

/* ---------- 12. 自定义滚动条不参与触摸 ---------- */
html.mobile .custom-scrollbar { display: none !important; }
html.mobile * { -webkit-tap-highlight-color: transparent; }
```

**两处需要 `!important` 的例外说明**

| 位置 | 原因 |
|---|---|
| `.menu` / `.popup` 的 `left/top/transform/opacity` | 由 `menuLocaltion.svelte.ts:54-57` / `Popup.svelte:45` 以 inline style 写入 |
| `.my-list .container` 的 `padding` | ListItem 的 `padding: 5px` 是组件内 scoped 规则，我们加 `!important` 是为了同时覆盖 `VirtualizedList` 的 `contain` 影响，非特异性问题 |

---

## 2. O-1 `components/common/MusicList/List/index.svelte`（整文件覆盖）

**源文件**：`source/packages/view-main/src/components/common/MusicList/List/index.svelte`（238 行）
**复制到**：`porting/js/ui/overrides/ListIndex.svelte`
**为什么必须整文件覆盖**：需要改 JS 行为（长按进多选、行高系数），CSS 无法表达状态变化。

### 改动 1：行高系数 3.2 → 4.5（第 47 行）

```diff
-  let listItemHeight = useListItemHeight(3.2)
+  // 移动端：16 × 4.5 = 72dp，与 mobile.less 的 --row-music 一致
+  let listItemHeight = useListItemHeight(4.5)
```

### 改动 2：新增长按进多选（在第 74 行 `let select = useSelect({...})` 之后插入）

```ts
// ---- 移动端长按进多选 ----
const LONG_PRESS_MS = 500
const MOVE_TOLERANCE = 8
let pressTimer: number | null = null
let pressStart = { x: 0, y: 0 }
let longPressed = false

const clearPressTimer = () => {
  if (pressTimer != null) {
    clearTimeout(pressTimer)
    pressTimer = null
  }
}
const handleItemPointerDown = (event: PointerEvent, index: number) => {
  if (event.pointerType === 'mouse') return       // 桌面/外接指针保持原语义
  longPressed = false
  pressStart = { x: event.clientX, y: event.clientY }
  clearPressTimer()
  pressTimer = window.setTimeout(() => {
    pressTimer = null
    longPressed = true
    multimode = true
    select.handleSelect(index)                     // 长按即选中该项
    navigator.vibrate?.(10)
  }, LONG_PRESS_MS)
}
const handleItemPointerMove = (event: PointerEvent) => {
  if (pressTimer == null) return
  if (Math.abs(event.clientX - pressStart.x) > MOVE_TOLERANCE || Math.abs(event.clientY - pressStart.y) > MOVE_TOLERANCE) {
    clearPressTimer()                              // 位移超阈值 = 用户在滚动，取消
  }
}
const handleItemPointerUp = () => {
  clearPressTimer()
}
```

### 改动 3：`row` snippet 里挂上指针事件 + 拦截长按后的误播（第 152-194 行）

```diff
       {#snippet row(item, index)}
         <ListItem
           musicinfo={item}
           listid={listinfo.id}
           {source}
           active={activeIndex == index}
           selected={select.list.includes(item)}
           selectedactive={hotkey.isShiftDown && select.selectIndex == index}
           {index}
           {picStyle}
           playing={playingIndex == index}
+          onpointerdown={(e) => handleItemPointerDown(e, index)}
+          onpointermove={handleItemPointerMove}
+          onpointerup={handleItemPointerUp}
+          onpointercancel={handleItemPointerUp}
           oncontextmenu={(event) => {
             event.preventDefault()
             event.stopPropagation()
             activeIndex = index
             menu!.show(...)
           }}
           onclick={(isKey) => {
+            // 长按刚触发过 → 忽略紧随的 click，避免误播放
+            if (longPressed) {
+              longPressed = false
+              return
+            }
             if (multimode || hotkey.isKeyMultiKeyDown()) {
```

> **注意**：`ListItem` 目前没有 `onpointerdown` 等 props，Svelte 5 会把未知属性透传到根元素吗？**不会**——`ListItem` 用 `$props()` 解构，未声明的 props 会被忽略。
> 因此**这个改动同时要求给 `ListItem` 增加 4 个 props 并转发到根 div**。`ListItem` 只需 3 行改动，但它在**另一个文件**里，所以：

### 改动 4：`ListItem.svelte` 也要覆盖（升为 O-1b，仅 6 行改动）

**复制到**：`porting/js/ui/overrides/ListListItem.svelte`

```diff
   let {
     musicinfo, listid, index, source, picStyle, selected, selectedactive, playing, active,
     oncontextmenu, onclick, onplay,
+    onpointerdown, onpointermove, onpointerup, onpointercancel,
   }: {
     ...
     oncontextmenu?: MouseEventHandler<HTMLDivElement>
     onclick: (isKey: boolean) => void
     onplay?: () => void
+    onpointerdown?: (event: PointerEvent) => void
+    onpointermove?: (event: PointerEvent) => void
+    onpointerup?: (event: PointerEvent) => void
+    onpointercancel?: (event: PointerEvent) => void
   } = $props()
@@
   onclick={handleClick}
   {oncontextmenu}
+  {onpointerdown}
+  {onpointermove}
+  {onpointerup}
+  {onpointercancel}
   onmouseenter={() => (hovered = true)}
```

> ⚠ **代价提示**：这让 O 文件从 4 个变成 5 个（+366 行）。**替代方案**（若想省掉这个文件）：在 `mobile.less` 里给 `.my-list .container` 加 `touch-action: pan-y`，然后用**事件委托**在 `List/index.svelte` 的容器上监听 `pointerdown` 并用 `document.elementFromPoint` 反查 `li` 索引。这样只改 1 个文件，但代码更脆（依赖 DOM 结构）。**推荐还是走 O-1b**，因为 `ListItem` 的结构很稳定。

### 改动 5：多选态底部操作条（替换掉被隐藏的表头复选框）

在 `<Menu .../>` 之后插入：

```svelte
{#if multimode}
  <div class="mobile-select-bar">
    <button class="msb-btn" aria-label={$t('select_all')} onclick={() => select.override(select.list.length == list.length ? [] : [...list])}>
      {$t('select_all')}
    </button>
    <span class="msb-count">{$t('selected_count', { num: select.list.length }) ?? `已选 ${select.list.length}`}</span>
    <button class="msb-btn" onclick={() => (multimode = false)}>{$t('batch_select_exit')}</button>
  </div>
{/if}

<style lang="less">
  .mobile-select-bar {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    z-index: 3;
    display: flex;
    gap: 8px;
    align-items: center;
    height: 56px;
    padding: 0 12px calc(0px + env(safe-area-inset-bottom));
    background: var(--color-content-background);
    box-shadow: 0 -1px 8px rgb(0 0 0 / 12%);
  }
  .msb-btn { min-width: 44px; min-height: 44px; padding: 0 12px; font-size: 14px; color: var(--color-primary);
    background: transparent; border: 0; border-radius: 8px; }
  .msb-btn:active { background: var(--color-primary-background-active); }
  .msb-count { flex: auto; text-align: center; font-size: 13px; color: var(--color-font-label); }
</style>
```

> `{$t('selected_count', {...})}` 若 i18n 里无此 key 会回退为 key 本身 —— 用 `??` 兜底成中文字面量。全选文案已存在（`select_all` / `batch_select_exit` 见 `MusicList/List/Header.svelte:24,99`）。

---

## 3. O-2 `views/Library/index.svelte`（整文件覆盖，改动集中在模板层）

**源文件**：179 行 → **复制到** `porting/js/ui/overrides/LibraryIndex.svelte`
**改动**：`/library` 无 `id` 时渲染歌单总览（桌面是 `replace` 到"上次播放"）。

```diff
 <script lang="ts">
   ...
   import { LIST_PIC_ICON } from '@/shared/constants'
+  import LibraryHome from '../pages/LibraryHome.svelte'
```

```diff
 <div class="view-container container">
-  {#if listInfo}
+  {#if !$query.id && $userListInited}
+    <LibraryHome />
+  {:else if listInfo}
     <MusicList bind:this={musicList} listinfo={listInfo} {list} onscroll={handleScroll} />
   {/if}
 </div>
```

同时**必须**关掉原有的"无 id 就跳上次列表"逻辑（第 144-154 行的 `$effect`）：

```diff
   $effect(() => {
     const id = $query.id
     if (!$userListInited) return
     if (id && $userListsAll.some((l) => l.id == id)) {
       void saveListPrevSelectId(id)
-    } else {
-      void getListPrevSelectId().then((prevId) => {
-        void replace(`/library?id=${prevId || LIST_IDS.LOVE}`)
-      })
-    }
+    }
   })
```

> 副作用（有意为之）：从「我喜欢的音乐」返回时，曲库停在总览页而不是歌单详情。这符合移动端"总览 → 详情 → 返回总览"的心智。

---

## 4. O-3 `views/Search/index.svelte`（原 5 行空壳 → 搜索页）

**源文件**：`<div class="view-container">hello search</div>`（5 行）
**复制到**：`porting/js/ui/overrides/SearchIndex.svelte`（内容即 N-9 的包装）

```svelte
<script lang="ts">
  import SearchPage from '../pages/SearchPage.svelte'
</script>

<SearchPage />
```

> 原文件是空壳，所以这不是"重写上游"，而是"填一个占位"。`/search`、`/list`、`/download`、`/songList/*`、`/topSongs` 六个路由共用它（`plugins/routes.ts:18-22`），因此**六个路由都会变成同一个搜索页** —— 这与桌面现状一致（桌面也是"hello search"），不是功能回退。真正的「下载」「歌单列表」页在移动端 MVP 不做（`/download` 无桌面实现）。

---

## 5. O-4 `components/layout/PlayDetail/RightLyric/LyricPlayer.svelte`（patch）

**源文件**：约 200 行 → **复制到** `porting/js/ui/overrides/LyricPlayer.svelte`

### 改动 1：字号公式（第 16、18、56 行）

```diff
-  let winRadio = $state(document.getElementById('root')!.clientWidth / 1020)
+  // 移动端：不再用 1020 基准（411dp 下会得到 0.40 倍 → 10px 歌词）
+  // 改为屏宽自适应 + 用户百分比（playDetail.style.fontSize，移动语义 60–140）
   const textAlign = useSettingValue('playDetail.style.align')
   const isZoomActiveLrc = useSettingValue('playDetail.isZoomActiveLrc')
   const fontSize = useSettingValue('playDetail.style.fontSize')
   const fontWeight = useSettingValue('playDetail.style.fontWeight')
-  const styles = $derived(`--play-detail-lrc-font-size:${(fontSize.val / 100 + 0.8) * winRadio}rem; text-align:${textAlign.val};`)
+  const lrcPct = $derived(Math.min(140, Math.max(60, Number(fontSize.val) || 100)))
+  const styles = $derived(`--lrc-pct:${lrcPct}; text-align:${textAlign.val};`)
```

### 改动 2：删掉 `onDomSizeChanged` 里的 winRadio 更新（第 56-64 行）

```diff
   onMount(() => {
-    const unsub = onDomSizeChanged(document.getElementById('root')!, (width) => {
-      winRadio = width / 1020
-    })
-    return () => {
-      unsub()
-    }
+    return () => {}
   })
```

### 改动 3：样式里换掉字号变量（`.lyric` 的 `font-size`）

```diff
-    font-size: var(--play-detail-lrc-font-size, 16px);
+    /* 411dp：14 + 1.2vw ≈ 18.9px；pct 60→11.3px / 140→26.5px */
+    font-size: calc((14px + 1.2vw) * (var(--lrc-pct, 100) / 100));
```

> `onDomSizeChanged` 的 import 若因此未使用，请一并删掉（ESLint 会报）。

---

## 6. N-1 `MobileApp.svelte`（外壳入口，替换桌面 `App.svelte`）

```svelte
<script lang="ts">
  import Icons from '@/components/layout/Icons.svelte'
  import MobileAppShell from './shell/MobileAppShell.svelte'
  import PlayDetail from '@/components/layout/PlayDetail/index.svelte'
  import { useAppAeady } from '@/modules/app/reactive.svelte'
  import { onMount } from 'svelte'

  const appReady = useAppAeady()

  onMount(() => {
    document.documentElement.classList.add('mobile')
    const root = document.getElementById('root')
    if (root) root.style.display = 'block'
  })
</script>

<div id="container" class="view-container">
  <Icons />
  {#if appReady.appAeady}
    <MobileAppShell />
    <PlayDetail />
  {/if}
</div>
```

> 对比桌面 `App.svelte:19-33`：不再按 `VITE_IS_DESKTOP/WEB` 分支，不含 `Login`（本地模式无登录），不含 `AppLayout`。

---

## 7. N-2 `shell/MobileAppShell.svelte`

**职责**：顶栏插槽 + 路由内容 + MiniPlayer + TabBar 的纵向骨架。**它自己不含任何业务逻辑。**

```svelte
<script lang="ts">
  import Router from '@/plugins/svelte-spa-router/Router.svelte'
  import routes, { location } from '@/plugins/routes'
  import MiniPlayer from './MiniPlayer.svelte'
  import MobileTabBar from './MobileTabBar.svelte'
  import { musicInfo } from '@/modules/player/reactive.svelte'

  const hasMusic = $derived(!!$musicInfo.id)
  // 全屏类页面（播放详情是 overlay，不在此列）不需要底部留白
  const isRoot = $derived(['/online', '/library', '/search', '/settings'].some((p) => $location === p || $location.startsWith(p + '?')))
</script>

<div class="shell" class:with-player={hasMusic}>
  <main class="content" id="view">
    <Router {routes} />
  </main>
  {#if hasMusic}
    <MiniPlayer />
  {/if}
  <MobileTabBar />
</div>

<style lang="less">
  .shell {
    position: relative;
    display: flex;
    flex: auto;
    flex-flow: column nowrap;
    height: 100%;
    min-height: 0;
    background-color: var(--color-content-background);
  }
  .content {
    position: relative;
    flex: auto;
    min-height: 0;
    overflow: hidden;
  }
  /* 页面自带滚动容器（VirtualizedList / settings list），外层不再滚 */
</style>
```

> `.content` 需要 `overflow:hidden` + 子级 `height:100%`：`views/*` 的根节点都是 `.view-container.container`（`flex:auto; flex-flow:column`），它原本依赖 `#view{flex:auto}`（`Main.svelte:12-14`）。这里 `#view` 由 `.content` 承担，等价。

---

## 8. N-3 `shell/MobileTabBar.svelte`

```svelte
<script lang="ts">
  import SvgIcon from '@/components/base/SvgIcon.svelte'
  import { link, location } from '@/plugins/routes'
  import { t, tm } from '../i18n'   // tm = 移动端本地字典；t = 上游 i18n 薄封装（`setting` 复用上游）

  type Tab = { to: string; icon: string; label: string }
  const tabs: Tab[] = [
    { to: '/library', icon: 'music_library', label: tm('mobile__tab_library') },
    { to: '/online', icon: 'sound_cloud', label: tm('mobile__tab_online') },
    { to: '/search', icon: 'search', label: tm('mobile__tab_search') },
    { to: '/settings', icon: 'settings', label: t('setting') },
  ]

  const isActive = (to: string) =>
    $location === to || $location.startsWith(to + '?') || $location.startsWith(to + '/')
</script>

<nav class="tabbar" role="tablist">
  {#each tabs as tab (tab.to)}
    <a
      class="tab"
      class:active={isActive(tab.to)}
      role="tab"
      aria-selected={isActive(tab.to)}
      aria-label={tab.label}
      href={tab.to}
      {@attach link()}
    >
      <SvgIcon name={tab.icon} />
      <span>{tab.label}</span>
    </a>
  {/each}
</nav>

<style lang="less">
  .tabbar {
    display: flex;
    flex: none;
    flex-flow: row nowrap;
    height: calc(56px + env(safe-area-inset-bottom, 0px));
    padding-bottom: env(safe-area-inset-bottom, 0px);
    background-color: var(--color-content-background);
    border-top: 1px solid var(--color-primary-light-400-alpha-800);
  }
  .tab {
    display: flex;
    flex: 1 1 0;
    flex-flow: column nowrap;
    gap: 2px;
    align-items: center;
    justify-content: center;
    min-width: 0;
    height: 56px;
    font-size: 11px;
    color: var(--color-font-label);
    text-decoration: none;
    transition: color 100ms;

    & :global(.svg-icon) { width: 24px; height: 24px; }
    &:active { opacity: .6; }
    &.active { color: var(--color-primary); font-weight: 600; }
  }
</style>
```

> **为什么不给选中项加"顶部指示条"**：4 个 Tab 均分 411dp（每个 ≈102dp），颜色 + 字重已经足够区分；再加指示条会在 MiniPlayer 与 TabBar 相邻处产生视觉噪音。
> **无障碍**：`role="tablist"` + `aria-selected`，与桌面 `Aside/Nav.svelte:117-119` 的写法一致。

---

## 9. N-4 `shell/MobileAppBar.svelte`

```svelte
<script lang="ts">
  import SvgIcon from '@/components/base/SvgIcon.svelte'
  import type { Snippet } from 'svelte'
  import { tm } from '../i18n'

  let {
    title,
    back = false,
    onback,
    actions,
  }: {
    title: string
    back?: boolean
    onback?: () => void
    actions?: Snippet
  } = $props()
</script>

<header class="appbar">
  {#if back}
    <button class="ab-btn" aria-label={tm('mobile__back')} onclick={() => onback?.()}>
      <SvgIcon name="back" />
    </button>
  {:else}
    <span class="ab-pad"></span>
  {/if}
  <h1 class="ab-title">{title}</h1>
  <div class="ab-actions">
    {@render actions?.()}
  </div>
</header>

<style lang="less">
  .appbar {
    display: flex;
    flex: none;
    flex-flow: row nowrap;
    gap: 4px;
    align-items: center;
    height: calc(56px + env(safe-area-inset-top, 0px));
    padding-top: env(safe-area-inset-top, 0px);
    padding-right: 4px;
    padding-left: 4px;
    background-color: var(--color-content-background);
  }
  .ab-pad { width: 12px; flex: none; }
  .ab-title { flex: auto; min-width: 0; font-size: 20px; font-weight: 600; .mixin-ellipsis-1(); }
  .ab-btn {
    display: flex; flex: none; align-items: center; justify-content: center;
    width: 44px; height: 44px; padding: 0; color: var(--color-font);
    background: transparent; border: 0; border-radius: 22px;
    & :global(.svg-icon) { width: 22px; height: 22px; }
    &:active { background-color: var(--color-primary-background-active); }
  }
  .ab-actions { display: flex; flex: none; gap: 4px; align-items: center; }
</style>
```

> `.mixin-ellipsis-1()` 来自 `assets/styles/mixin.less`，由 `svelte.config.js` 的 `lessConfig` 全局注入（上游组件都直接用，说明已配 additionalData）。

---

## 10. N-5 `shell/MiniPlayer.svelte`

**复用两个上游组件**（重要：这省掉全部播放逻辑与封面加载逻辑）
- `PlayBar/components/Pic.svelte` —— 封面 + 点击打开播放页（内部已 `setShowPlayDetail(true)`）
- `PlayBar/components/PlayInfo.svelte` —— 歌名 + **播放时显示当前歌词行**（`lyricLine.text`）

```svelte
<script lang="ts">
  import Pic from '@/components/layout/PlayBar/components/Pic.svelte'
  import PlayInfo from '@/components/layout/PlayBar/components/PlayInfo.svelte'
  import SvgIcon from '@/components/base/SvgIcon.svelte'
  import { actions } from '@/shared/actions'
  import { playing } from '@/modules/player/reactive.svelte'
  import { setShowPlayDetail } from '@/modules/playDetail/store/action'
  import { t, tm } from '../i18n'
</script>

<div class="mini">
  <button class="mini-main" aria-label={tm('mobile__open_player')} onclick={() => setShowPlayDetail(true)}>
    <Pic />
    <PlayInfo />
  </button>
  <button class="mini-btn" aria-label={$playing ? t('player__pause') : t('player__play')}
    onclick={() => actions.exec('player.togglePlay')}>
    <SvgIcon name={$playing ? 'pause' : 'play'} />
  </button>
  <button class="mini-btn" aria-label={t('player__list')} onclick={() => setShowPlayDetail(true)}>
    <SvgIcon name="playlist" />
  </button>
</div>

<style lang="less">
  .mini {
    display: flex;
    flex: none;
    flex-flow: row nowrap;
    align-items: center;
    height: 60px;
    padding-right: 4px;
    background-color: var(--color-main-background);
    border-top: 1px solid var(--color-primary-light-400-alpha-800);
  }
  .mini-main {
    display: flex; flex: auto; flex-flow: row nowrap; align-items: center;
    min-width: 0; height: 100%; padding: 0; text-align: left;
    background: transparent; border: 0;
    &:active { opacity: .7; }

    /* 注意：Pic 与 PlayInfo 的根 class 都叫 .container（同名！），绝不能写 :global(.container) —— 见下方说明。
       这里只按"内部唯一类名"定位：Pic 只有一个 button.btn，PlayInfo 只有 .name / .status-text。 */
    & :global(.container) { min-width: 0; }
    & :global(button.btn) {
      /* Pic: .btn 是 height:100% + aspect-ratio:1，60dp 条减 padding 16 = 44dp，天然满足 44×44 触控规范 */
      width: 44px;
      height: 44px;
    }
    & :global(.name) {
      padding: 0 !important;
      font-size: 14px !important;
      color: var(--color-font) !important;
    }
    & :global(.status-text) {
      height: 16px !important;
      padding: 0 !important;
      font-size: 12px !important;
      color: var(--color-font-label) !important;
    }
  }
  .mini-btn {
    display: flex; flex: none; align-items: center; justify-content: center;
    width: 44px; height: 44px; padding: 0; color: var(--color-font);
    background: transparent; border: 0;
    & :global(.svg-icon) { width: 24px; height: 24px; }
    &:active { opacity: .6; }
  }
</style>
```

> **已核对（2026-11-02）：这里原本是个坑，现已修正。** 我原稿写 `:global(.pic-container)`，核对源码发现两个组件**根 class 同名**：
> - `PlayBar/components/Pic.svelte:10` → `<div class="container">`
> - `PlayBar/components/PlayInfo.svelte:16` → `<div class="container">`
>
> 所以 `:global(.container)` 会**同时命中两者**（Pic 的 padding/height 覆盖会把 PlayInfo 也一起改掉）。现在改为只按内部唯一类名定位：`button.btn`（仅 Pic 有）、`.name` / `.status-text`（仅 PlayInfo 有）。
>
> 另外 Pic 的 `.btn` 本来就是 `height:100%; aspect-ratio:1`（`Pic.svelte:35-37`），在 60dp 条里减掉上下 padding 16dp 正好 44dp 见方 —— **尺寸本来就合规，不需要改**，写 `width/height:44px` 只是把它钉死防漂移。

---

## 11. N-6 `material/BottomSheet.svelte`

```svelte
<script lang="ts">
  import Portal from '@/components/base/Portal.svelte'
  import type { Snippet } from 'svelte'
  import { tick } from 'svelte'

  let {
    visible = $bindable(false),
    title,
    maxheight = '60dvh',
    onclose,
    children,
  }: {
    visible: boolean
    title?: string
    maxheight?: string
    onclose?: () => void
    children: Snippet
  } = $props()

  let render = $state(false)
  let anim = $state(false)
  let startY = 0
  let dragY = $state(0)

  $effect(() => {
    if (visible) {
      render = true
      void tick().then(() => (anim = true))
      return
    }
    anim = false
    dragY = 0
  })

  const close = () => {
    visible = false
    onclose?.()
  }
  const onpointerdown = (e: PointerEvent) => {
    startY = e.clientY
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onpointermove = (e: PointerEvent) => {
    const dy = e.clientY - startY
    dragY = Math.max(0, dy)
  }
  const onpointerup = () => {
    if (dragY > 64) close()
    dragY = 0
  }
</script>

{#if render}
  <Portal to="#root">
    <div class="bs-scrim" class:show={anim} role="presentation" onclick={close}></div>
    <div
      class="bs"
      class:show={anim}
      style={`max-height:${maxheight}; transform: translateY(${anim ? dragY : 400}px)`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      ontransitionend={() => { if (!visible) render = false }}
    >
      <div class="bs-grabber-area" onpointerdown={onpointerdown} onpointermove={onpointermove} onpointerup={onpointerup}>
        <div class="bs-grabber"></div>
      </div>
      {#if title}
        <div class="bs-title">{title}</div>
      {/if}
      <div class="bs-body">{@render children()}</div>
    </div>
  </Portal>
{/if}

<style lang="less">
  .bs-scrim {
    position: fixed; inset: 0; z-index: 19; background: rgb(0 0 0 / 40%);
    opacity: 0; transition: opacity 240ms; pointer-events: none;
    &.show { opacity: 1; pointer-events: auto; }
  }
  .bs {
    position: fixed; right: 0; bottom: 0; left: 0; z-index: 20;
    display: flex; flex-flow: column nowrap;
    padding-bottom: env(safe-area-inset-bottom, 0px);
    background: var(--color-content-background);
    border-radius: 16px 16px 0 0;
    box-shadow: 0 -2px 16px rgb(0 0 0 / 18%);
    transition: transform 240ms cubic-bezier(.32, .72, 0, 1);
  }
  .bs-grabber-area { display: flex; flex: none; align-items: center; justify-content: center; height: 24px; touch-action: none; }
  .bs-grabber { width: 32px; height: 4px; background: var(--color-primary-alpha-500); border-radius: 2px; }
  .bs-title { flex: none; padding: 4px 24px 12px; font-size: 16px; font-weight: 600; }
  .bs-body { flex: auto; min-height: 0; overflow-y: auto; padding-bottom: 8px; }
</style>
```

---

## 12. N-7 `material/ActionSheet.svelte`

```svelte
<script lang="ts">
  import BottomSheet from './BottomSheet.svelte'

  export type ActionItem = {
    key: string
    label: string
    icon?: string
    danger?: boolean
    disabled?: boolean
    onclick: () => void
  }

  let {
    visible = $bindable(false),
    title,
    items = [],
  }: {
    visible: boolean
    title?: string
    items: Array<ActionItem | 'hr'>
  } = $props()

  const run = (item: ActionItem) => {
    if (item.disabled) return
    visible = false
    // 关闭动画期间执行，避免视觉跳变
    setTimeout(() => item.onclick(), 120)
  }
</script>

<BottomSheet bind:visible {title} maxheight="70dvh">
  <div class="as">
    {#each items as item, i (item === 'hr' ? `hr${i}` : item.key)}
      {#if item === 'hr'}
        <div class="as-hr"></div>
      {:else}
        <button class="as-item" class:danger={item.danger} disabled={item.disabled} onclick={() => run(item)}>
          <span class="as-label">{item.label}</span>
        </button>
      {/if}
    {/each}
  </div>
</BottomSheet>

<style lang="less">
  .as { display: flex; flex-flow: column nowrap; }
  .as-item {
    display: flex; align-items: center; min-height: 56px; padding: 0 24px;
    font-size: 15px; text-align: left; color: var(--color-font);
    background: transparent; border: 0;
    &:active { background: var(--color-primary-background-active); }
    &.danger { color: var(--color-font-error, #e5484d); }
    &[disabled] { opacity: .4; }
  }
  .as-hr { height: 1px; margin: 4px 0; background: var(--color-primary-light-400-alpha-900); }
</style>
```

---

## 13. N-8 `pages/LibraryHome.svelte`（曲库总览）

**数据源**：`$userListsAll`（已合并默认歌单 + 用户歌单，`modules/musicLibrary/reactive.svelte.ts:73`）
**刻意不做的事**：不显示"共 N 首"——那需要对每个歌单调 `getListMusics`（N+1 查询）。改成显示 `meta.playCount`（已有字段）或留空。P2 再上批量计数接口。

```svelte
<script lang="ts">
  import { push } from '@/plugins/routes'
  import { useUserList, userListsAll, userListInited, useListCover } from '@/modules/musicLibrary/reactive.svelte'
  import { LIST_IDS } from '@any-listen/common/constants'
  import { LIST_PIC_ICON } from '@/shared/constants'
  import Image from '@/components/base/Image.svelte'
  import SvgIcon from '@/components/base/SvgIcon.svelte'
  import MobileAppBar from '../shell/MobileAppBar.svelte'
  import { t, tm } from '../i18n'
  import { dateFormat } from '@/shared'

  const lists = $derived($userListsAll)
  const open = (id: string) => push(`/library?id=${id}`)
</script>

<MobileAppBar title={tm('mobile__tab_library')} />

<div class="home">
  <div class="quick">
    <button class="chip" onclick={() => open(LIST_IDS.LAST_PLAYED)}>
      <SvgIcon name="memories" /><span>{t('list_name__last_play')}</span>
    </button>
    <button class="chip" onclick={() => open(LIST_IDS.LOVE)}>
      <SvgIcon name="love" /><span>{t('list_name__love')}</span>
    </button>
  </div>

  {#if !$userListInited}
    <div class="tip">Loading…</div>
  {:else}
    <ul class="lists">
      {#each lists as item (item.id)}
        {@const cover = useListCover(item)}
        <li>
          <button class="row" onclick={() => open(item.id)}>
            <Image src={cover.val ?? item.meta?.pic ?? ''} icon={LIST_PIC_ICON[item.id]} />
            <span class="meta">
              <span class="name">{item.name}</span>
              <span class="sub">
                {#if item.type !== 'default' && item.meta?.createTime}
                  {dateFormat(item.meta.createTime, 'Y-M-D')}
                {:else if item.type !== 'default'}
                  {/* 已核对：真实 key 前缀是 edit_list_modal__list_，不是 list_type__（后者不存在） */}
                  {t(`edit_list_modal__list_${item.type}` as never)}
                {/if}
              </span>
            </span>
            <SvgIcon name="angle-right-solid" />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style lang="less">
  .home { display: flex; flex: auto; flex-flow: column nowrap; min-height: 0; overflow-y: auto; }
  .quick { display: flex; flex: none; gap: 8px; padding: 4px 16px 12px; }
  .chip {
    display: flex; flex: none; gap: 6px; align-items: center; height: 44px; padding: 0 16px;
    font-size: 13px; color: var(--color-font); background: var(--color-primary-light-300-alpha-900);
    border: 0; border-radius: 22px;
    & :global(.svg-icon) { width: 18px; height: 18px; }
    &:active { background: var(--color-primary-background-active); }
  }
  .lists { padding: 0 16px 16px; }
  .row {
    display: flex; gap: 12px; align-items: center; width: 100%; min-height: 72px;
    padding: 8px 0; text-align: left; background: transparent; border: 0;
    &:active { opacity: .7; }
    & :global(img), & :global(.pic) { width: 56px !important; height: 56px !important; border-radius: 8px; }
    & :global(.svg-icon) { width: 16px; height: 16px; opacity: .4; }
  }
  .meta { display: flex; flex: auto; flex-flow: column nowrap; gap: 2px; min-width: 0; }
  .name { font-size: 15px; .mixin-ellipsis-1(); }
  .sub { font-size: 12px; color: var(--color-font-label); .mixin-ellipsis-1(); }
  .tip { padding: 40px; text-align: center; color: var(--color-font-label); }
</style>
```

> `LIST_PIC_ICON[item.id]` 只在默认歌单有值（`shared/constants.ts`），用户歌单会 undefined → `Image` 的 `icon` 为 undefined 时走 `src`，行为正确（与 `MusicList/Header.svelte:46` 用法一致）。

---

## 14. N-9 `pages/SearchPage.svelte`（搜索输入页 + 结果页）

**范围说明**：MVP 只做"输入 + 历史/热词 + 跳转到在线搜索"。真正的四类结果列表（单曲/歌单/专辑/歌手）复用 `views/Online/Search/*`，通过路由 `replace('/online?type=search&...')` 跳过去——**不重写结果渲染**。

```svelte
<script lang="ts">
  import MobileAppBar from '../shell/MobileAppBar.svelte'
  import SvgIcon from '@/components/base/SvgIcon.svelte'
  import { push } from '@/plugins/routes'
  import { t, tm } from '../i18n'
  import { toOnlineSearch } from '@/modules/resource/actions'

  const KEY = 'anylisten.mobile.searchHistory'
  let keyword = $state('')
  let history = $state<string[]>(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[])
  let inputEl = $state<HTMLInputElement>()

  const save = (kw: string) => {
    const k = kw.trim()
    if (!k) return
    history = [k, ...history.filter((h) => h !== k)].slice(0, 12)
    localStorage.setItem(KEY, JSON.stringify(history))
  }
  const submit = (kw: string) => {
    save(kw)
    void toOnlineSearch(kw)      // 复用上游：跳 /online?type=search&keyword=...
  }
  const clear = () => {
    history = []
    localStorage.removeItem(KEY)
  }
</script>

<MobileAppBar title={tm('mobile__tab_search')} />

<div class="search">
  <div class="field">
    <SvgIcon name="search" />
    <input
      bind:this={inputEl}
      bind:value={keyword}
      type="search"
      enterkeyhint="search"
      placeholder={tm('mobile__search_placeholder')}
      autocomplete="off"
      onkeydown={(e) => { if (e.key === 'Enter') submit(keyword) }}
    />
    {#if keyword}
      <button class="clear" aria-label={t('btn_clear')} onclick={() => { keyword = ''; inputEl?.focus() }}>
        <SvgIcon name="multiply" />
      </button>
    {/if}
  </div>

  <button class="primary" onclick={() => submit(keyword)}>{tm('mobile__tab_search')}</button>

  {#if history.length}
    <div class="section">
      <div class="section-head">
        <span>{tm('mobile__search_history')}</span>
        <button class="text-btn" onclick={clear}>{t('btn_clear')}</button>
      </div>
      <div class="chips">
        {#each history as kw (kw)}
          <button class="chip" onclick={() => submit(kw)}>{kw}</button>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style lang="less">
  .search { display: flex; flex: auto; flex-flow: column nowrap; min-height: 0; overflow-y: auto; padding: 0 16px 16px; }
  .field {
    display: flex; flex: none; gap: 8px; align-items: center; height: 44px; padding: 0 12px;
    background: var(--color-primary-light-300-alpha-900); border-radius: 22px;
    & :global(.svg-icon) { flex: none; width: 18px; height: 18px; opacity: .5; }
    input {
      flex: auto; min-width: 0; height: 100%; font-size: 15px; color: var(--color-font);
      background: transparent; border: 0; outline: none;
      &::placeholder { color: var(--color-font-label); }
    }
  }
  .clear { display: flex; flex: none; align-items: center; justify-content: center; width: 32px; height: 44px; padding: 0; color: var(--color-font-label); background: transparent; border: 0; }
  .primary {
    flex: none; height: 48px; margin-top: 12px; font-size: 15px; font-weight: 500;
    color: var(--color-button-font); background: var(--color-primary); border: 0; border-radius: 12px;
    &:active { opacity: .85; }
  }
  .section { margin-top: 24px; }
  .section-head { display: flex; align-items: center; justify-content: space-between; height: 44px; font-size: 13px; color: var(--color-font-label); }
  .text-btn { min-height: 44px; padding: 0 4px; font-size: 13px; color: var(--color-primary); background: transparent; border: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { min-height: 40px; padding: 0 14px; font-size: 13px; color: var(--color-font); background: var(--color-primary-light-300-alpha-900); border: 0; border-radius: 20px; &:active { opacity: .7; } }
</style>
```

> `toOnlineSearch` 已存在（`modules/resource/actions.ts`，被 `Aside/Nav.svelte:8,42` 使用）。MVP 不做本地/在线结果合并——那是 P2 的"全局搜索"。
> **`search_placeholder` / `search_history` / `btn_clear` 三个 i18n key 需核对**是否已在 `shared/i18n/langs/*.json` 中；缺失时 Phase 4 补 3 条文案（见 `phase3-uiux.md` §6 的"新增约 28 条"）。

---

## 15. O-5 `views/Setting/AppSetting/AppSetting.svelte`（设置页过滤）

**为什么只改这一个组件**：`views/Setting/AppSetting/settings.ts`（753 行）是设置项的**唯一数据源**，而 `AppSetting.svelte` 只有 35 行、纯粹是"把数据分发给 `SettingList` + `SettingView`"。移动端要做的事只有一件——**过滤**。不需要新建 L1/L2 两级页：左栏由 `mobile.less` §9 改成横滚 chip 条（见 §1 第 9 段），L2 内容仍由上游 `SettingView.svelte` 渲染。

**核源码时踩到的三个坑（任何一个都会让"顺手 filter 一下"的写法失效）**：

1. **`SettingList.svelte` 不接收 props 形式的设置数据**。它第 3 行直接 `import { settings } from './settings'` 自己读模块单例，只把 `active` / `onchange` 当 props（`SettingList.svelte:7-13`）。所以在 `AppSetting.svelte` 里 `const settings = filtered...` 只能影响右侧 `SettingView`，**左侧分组导航照样显示「桌面歌词」「快捷键」**。
2. **`settings` 是 `SettingListSection[]` 数组**（`settings.ts:65`），不是对象。`AppSetting.svelte:8` 写的是 `Object.values(settings).find(...)`，对数组也能跑，**但不要模仿**。
3. **上游自己就在运行时 mutate 这个数组**——`settings.ts:741-752` 用 `settings.splice(...)` 按 `VITE_IS_WEB` 插入 `security` 分组。这说明**原地改是被上游承认的合法用法**。

**结论：不做"传参过滤"，改为"原地剔除"**。因为 `SettingList` 读的是模块单例，只有 mutate 才能同时影响左右两侧。代码放在覆盖件的**模块顶层**（`import` 之后、组件渲染之前）：此时 `SettingList` 虽已被 import，但它只在模板里读 `settings`，时序安全。

顺带纠正路由：`/settings?type=app&id=xxx` 是**两个参数**（`AppSetting.svelte:19`），不是只有 `type`。

```svelte
<!-- porting/js/ui/overrides/AppSetting.svelte（O-5，整文件 34 行）-->
<script lang="ts">
  import { query, replace } from '@/plugins/routes'
  import SettingList from '@/views/Setting/AppSetting/SettingList.svelte'
  import SettingView from '@/views/Setting/AppSetting/SettingView.svelte'
  import { settings } from '@/views/Setting/AppSetting/settings'

  /** 整段隐藏的分组（桌面/键盘/悬浮窗专属） */
  const HIDDEN_SECTIONS = new Set(['hotkey', 'desktopLyric'])

  /** 整项隐藏（取自 phase3-uiux.md §4.3 的 61 项隐藏清单中，仍需按 field 过滤的部分） */
  const HIDDEN_ITEMS = new Set<string>([
    // 窗口 / 桌面（8）
    'common.windowSizeId', 'common.startInFullscreen', 'common.transparentWindow',
    'common.enableTrash', 'common.playBarProgressStyle', 'common.font',
    'common.isAgreePact', 'common.enableDebug',
    // 托盘（2）
    'tray.enable', 'tray.themeId',
    // 桌面专属播放项（3）
    'player.startupAutoPlay', 'player.isShowStatusBarLyric', 'player.isShowTitleLyric',
    // 桌面音频设备（2）—— 手机无多路输出设备概念
    'player.mediaDeviceId', 'player.isMediaDeviceChangedPausePlay',
    // 音量：改由播放页即时控件承载（1）
    'player.volume',
  ])

  /* 原地剔除（沿用 settings.ts:741-752 的 splice 惯例，见上方陷阱 2）。
     放在模块顶层是为了在任何组件读取 settings 之前完成。 */
  for (let i = settings.length - 1; i >= 0; i--) {
    const section = settings[i]
    if (HIDDEN_SECTIONS.has(section.id)) {
      settings.splice(i, 1)
      continue
    }
    section.list = section.list.filter((item) => {
      if (!item) return false                                     // settings.ts 里大量 `? {...} : null`
      const field = 'field' in item ? item.field : undefined
      return !(field && HIDDEN_ITEMS.has(field as string))
    })
  }

  // 路由是 /settings?type=app&id=xxx（两个参数，AppSetting.svelte:19），别只读 type
  let activeSetting = $derived(settings.find((e) => e.id === $query.id) ?? settings[0])
</script>

{#if activeSetting}
  <div class="settings-app-container">
    <SettingList
      active={activeSetting.id}
      onchange={(id: string) => { void replace('/settings', { type: 'app', id }) }}
    />
    <SettingView settings={activeSetting} />
  </div>
{/if}

<style lang="less">
  /* 左右排布本身不用改：mobile.less §9 已把 flex-direction 改成 column 且把左栏做成横滚 chip 条 */
  .settings-app-container {
    display: flex;
    flex-flow: row nowrap;
    height: 100%;
    min-height: 0;
    padding-top: 10px;
  }
</style>
```

**顺带确认的免费项**：`settings.ts:71-77` 的托盘项是 `VITE_IS_DESKTOP ? {...} : null` —— APK 构建下 `VITE_IS_DESKTOP=false`，`tray.enable` 根本不进数组，`HIDDEN_ITEMS` 里的 `tray.*` 只是防御性冗余。`security`（登录设备）分组只在 `VITE_IS_WEB=true` 时插入 —— APK 构建里 UI 本身就是 Web 产物，**大概率会插进来**，移动端**保留它**（手机上看登录设备有意义）。

**扩展入口**：真正的扩展安装页是独立路由 `/extenstion`（上游拼写就是 `extenstion`，少个 `i`，**不要去"修正"它**）。`settings.ts` 的 `extension` 分组只含「GitHub 镜像」一个组件，不含入口。移动端做法：**在 `LibraryHome` 的快捷 chip 行加一个「扩展」chip 跳 `/extenstion`**（见 §13），不占底部 Tab、不改设置页结构。

---

## 16. N-10 `ui/i18n.ts`（移动端文案字典，**已在 §0.5 给全**）

路径：`porting/js/ui/i18n.ts`，内容就是 §0.5 那段 `dict` + `tm()` + `t` 薄封装，**照抄即可，本节不重复**。

一句话交代它为什么是独立文件而不是塞进某个组件：`tm()` 被 `MobileTabBar` / `MobileAppBar` / `SearchPage` 三个组件共用，且 `dict` 需要在同一处维护，散落会导致文案不一致。

---

## 17. N-11 `compositions/longPress.svelte.ts`

```ts
/** 长按 attachment：500ms、位移 >8px 取消、触发时震动 10ms */
export const longPress = ({
  onlongpress,
  ms = 500,
  tolerance = 8,
  haptic = true,
}: {
  onlongpress: (event: PointerEvent) => void
  ms?: number
  tolerance?: number
  haptic?: boolean
}) => {
  return (node: HTMLElement) => {
    let timer: number | null = null
    let sx = 0
    let sy = 0
    let fired = false

    const clear = () => {
      if (timer != null) {
        clearTimeout(timer)
        timer = null
      }
    }
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return
      fired = false
      sx = e.clientX
      sy = e.clientY
      clear()
      timer = window.setTimeout(() => {
        timer = null
        fired = true
        if (haptic) navigator.vibrate?.(10)
        onlongpress(e)
      }, ms)
    }
    const move = (e: PointerEvent) => {
      if (timer == null) return
      if (Math.abs(e.clientX - sx) > tolerance || Math.abs(e.clientY - sy) > tolerance) clear()
    }
    const up = () => clear()

    node.addEventListener('pointerdown', down, { passive: true })
    node.addEventListener('pointermove', move, { passive: true })
    node.addEventListener('pointerup', up, { passive: true })
    node.addEventListener('pointercancel', up, { passive: true })
    node.addEventListener('pointerleave', up, { passive: true })

    return () => {
      clear()
      node.removeEventListener('pointerdown', down)
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerup', up)
      node.removeEventListener('pointercancel', up)
      node.removeEventListener('pointerleave', up)
    }
  }
}
```

**用法**：`<div {@attach longPress({ onlongpress: () => ... })}>`

---

## 18. N-12 `compositions/swipeDismiss.svelte.ts`

```ts
/** 下滑关闭 / 上滑展开。用于播放详情页（封面态下滑收起、上滑切歌词） */
export const swipeDismiss = ({
  ondown,
  onup,
  axis = 'y',
  threshold = 0.25, // 相对元素高度
  velocity = 0.5,   // px/ms
}: {
  ondown?: () => void
  onup?: () => void
  axis?: 'x' | 'y'
  threshold?: number
  velocity?: number
}) => {
  return (node: HTMLElement) => {
    let sy = 0
    let sx = 0
    let st = 0
    let tracking = false

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return
      tracking = true
      sy = e.clientY
      sx = e.clientX
      st = performance.now()
    }
    const up = (e: PointerEvent) => {
      if (!tracking) return
      tracking = false
      const dy = e.clientY - sy
      const dx = e.clientX - sx
      const dt = Math.max(1, performance.now() - st)
      const size = axis === 'y' ? node.clientHeight : node.clientWidth
      const delta = axis === 'y' ? dy : dx
      const speed = Math.abs(delta) / dt

      // 主轴判定：避免斜滑时误判（G-05）
      const primary = axis === 'y' ? Math.abs(dy) >= Math.abs(dx) * 1.5 : Math.abs(dx) >= Math.abs(dy) * 1.5
      if (!primary) return

      if (delta < 0 && (Math.abs(delta) > size * threshold || speed > velocity)) onup?.()
      else if (delta > 0 && (delta > size * threshold || speed > velocity)) ondown?.()
    }

    node.addEventListener('pointerdown', down, { passive: true })
    node.addEventListener('pointerup', up, { passive: true })
    node.addEventListener('pointercancel', () => (tracking = false), { passive: true })
    return () => {
      node.removeEventListener('pointerdown', down)
      node.removeEventListener('pointerup', up)
    }
  }
}
```

---

## 19. 交付顺序（与 `phase3-uiux.md` §5.6 的 P0 对应）

| 序 | 交付物 | 验收方式 | 依赖 |
|---|---|---|---|
| 1 | `entries/main.ts` + `mobile.less` §1/§2 | 打开 App 无横向溢出；顶栏/底栏不压手势条 | 无 |
| 2 | `MobileApp` + `MobileAppShell` + `MobileTabBar` + `MobileAppBar` | 4 Tab 可切换；`/library` 不再空白（此时先显示空歌单） | 1 |
| 3 | `mobile.less` §4（列表双行）+ O-1/O-1b | 歌曲行 72dp、双行、无表头、`⋮`/收藏常显 | 2 |
| 4 | `MiniPlayer` + `mobile.less` §5/§6 | 播放条 60dp；进度条可拖且命中 44dp | 2 |
| 5 | `BottomSheet`/`ActionSheet` + `mobile.less` §3 | **长按歌曲行**弹出底部菜单（走 `contextmenu` → `.menu`） | 3（需要 O-1 的长按） |
| 6 | O-2 `LibraryIndex` + `LibraryHome` | 曲库总览 → 歌单详情 → 返回总览 | 3 |
| 7 | O-3 `SearchIndex` + `SearchPage` | 输入 → 跳在线搜索 | 2 |
| 8 | O-5 `AppSetting` + `mobile.less` §9 | 设置分组 chip 横滚；`desktopLyric`/`hotkey` 不出现 | 2 |
| 9 | O-4 `LyricPlayer` + `mobile.less` §5 | 歌词字号 18.9px（不是 10px） | 5 |

**P0 总计（与团队口径对齐）**

| 类别 | 数量 | 文件 |
|---|---|---|
| 新增：入口 | 1 | `entries/main.ts` |
| 新增：样式 | 1 | `ui/mobile.less`（N-0） |
| 新增：组件/工具 | 12 | `ui/i18n.ts`(N-10)、`MobileApp`(N-1)、`shell/*`×4(N-2..N-5)、`material/*`×2(N-6..N-7)、`pages/*`×2(N-8..N-9)、`compositions/*`×2(N-11..N-12) |
| 覆盖 | 6 | O-1、O-1b、O-2、O-3、O-4、O-5 |
| **合计** | **20** | 新增 14 + 覆盖 6 |

> 团队最初口径是"4 个 O + 13 个新增 = 18"。差异解释：**+2 个 O**（O-1b `ListItem.svelte` 是 Svelte 5 props 不透传的硬约束；O-5 `AppSetting.svelte` 是 `SettingList` 读模块单例的硬约束，两者都无法用 CSS 或替换别的文件绕过），**`entries/main.ts` 之前没计入**（被当成构建配置）。总代码量预估不变：**约 3.4–4.0k 行，占 view-main 46k 行的 7–9%**。

---

## 20. 验收清单（Phase 5 直接用）

```
□ 横向溢出：document.documentElement.scrollWidth === clientWidth
□ 触控目标：遍历 button/a/[role=button]，getBoundingClientRect() 均 ≥44×44（除白名单：文字链、Tab 内 label）
□ 间距：相邻可点元素的 rect 间距 ≥8dp
□ 安全区：TabBar 底部 padding = env(safe-area-inset-bottom)；顶栏 padding-top 同
□ 长按：歌曲行长按 500ms → 进多选 + 震动；滑动列表时不误触发
□ 长按弹菜单：长按歌曲行 → 底部弹出 12 项 ActionSheet（56dp/项），点外部关闭
□ 进度条：拖动时 thumb 出现；命中区 44dp（从轨道上方 22dp 处按下也能拖）
□ 歌词字号：411dp 下 100% 时实际计算值 ≈ 18.9px（getComputedStyle）
□ 弹层不溢出：队列页（原 500px）在 411dp 下 width === 411
□ 无 hover 残留：点过的按钮不会保持高亮
□ 桌面元素不出现：无窗口最小化/最大化/关闭按钮、无自定义滚动条
□ 键盘弹出：搜索页输入时 TabBar/MiniPlayer 不顶起（visualViewport）
```
