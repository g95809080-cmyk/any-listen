# Any Listen → Android 移动端 UI/UX 重构设计（Phase 3）

> 作者：柯悦屏（移动端 UI/UX 重构专家）
> 目标机：小米 13，1080×2400，**411dp 逻辑宽**，Android 13 / HyperOS
> 源码基线：`source/packages/view-main`（Svelte 5 SPA）、`source/packages/view-lyric`、`source/packages/shared/{theme,web,i18n}`
> 约束来源：`docs/porting-decision-record.md` PDR-001（独立 App / 本地模式）、PDR-002（保留扩展生态）、PDR-004（411dp 基准）、PDR-005（复用 Web Audio）
> 原则：**触控优先重排，不做等比缩小**。所有结论均标注源码路径，可被 fullstack-dev 直接执行。

> ✅ **悬浮窗最终结论：不做。** PDR-006 于 2026-11-02 经用户复核改判（推翻同日早前的"要做"），R-05 = **[低]**。
> 因此本文 **§4.1 / §4.3 / §8-Q-02 / §9.1 / §9.6 的原始结论即为最终有效版本，无需任何覆盖声明**：
> ① 不做 `SYSTEM_ALERT_WINDOW` 悬浮窗，歌词两层 = 应用内全屏歌词页 + 通知栏歌词；
> ② `desktopLyric.*` **44 项全部丢弃不迁移**；
> ③ 歌词样式保留 **6 项** = 复用 `playDetail.*` 5 项 + 新增 `lyricView.style.lineGap`（§9.1）。
>
> `docs/phase3-uiux-overlay-supplement.md`（原"增补/覆盖"文档）**已降级为 P2 技术备档，不投入实现**；其中"保留 13 项"等结论作废，以本文为准。
> 实现级清单见 `docs/phase3-uiux-impl-spec.md`（Phase 4 执行输入）。

---

## 0. 结论摘要

1. **现有 UI 是纯桌面布局，且移动适配"基础具备"是被高估的**。`view-main` 里 **`@media` 查询 0 处**（仅 `prefers-color-scheme`）、**安全区 0 处**（仅 macOS `titlebar-area-height`）。`postcss-pxtorem` 的 `rootValue: 16` 配合 `document.documentElement.style.fontSize = '16px'`（`modules/setting/init.ts:50`）在默认值下是**恒等变换**——它只提供了"把 px 变 rem"的机制，**没有产生任何缩放效果**。真正的设计基准可以从 `PlayDetail/RightLyric/LyricPlayer.svelte:20` 反推：`winRadio = root.clientWidth / 1020`，即 **UI 按 1020px 宽设计**。411dp ÷ 1020 ≈ **40%**。
2. **因此不能走"等比缩放"路线**（0.4 倍后 13px 正文变 5.2px，字与拇指同时不可用）。必须做**布局重排 + 触控规格重建**。
3. **桌面导航骨架必须整体替换**：`#app-main` = 左侧 Aside(20%, max 320px) + 右侧 Header/Main（`components/layout/index.svelte:9-15`）→ 移动端改为 **顶栏 + 内容 + 迷你播放条 + 底部 Tab**，Aside 在手机断点下 `display:none`。
4. **触控硬伤可量化**：图标按钮 32dp / 25.6dp（`base/Btn.svelte:113,122`）、右键菜单项行高 34px（`base/Menu.svelte:145`）、进度条与音量条可视高度 5px 且**无滑块**（`common/PlayerProgressBar.svelte:114`、`base/SliderBar.svelte:188`）、设置导航行高 36px（`Setting/AppSetting/SettingList.svelte:69`）、Tab 行高约 30px（`base/Tab.svelte:152`）。全部 < 44dp。
5. **两个"键盘独占"的功能在手机上直接不可达，必须新增触控入口**：
   - 歌单拖拽排序：`shared/compositions/sortable.svelte.ts:75-85` 只在 `Ctrl` **按住期间**才 `option('disabled', false)` —— 无键盘 = 永远无法排序。
   - 多选：`MusicList/List/index.svelte:180` 依赖 `shift/ctrl` 才进多选（`useHotkey.svelte.ts:46-48`）。
6. **设置 133 项中 78 项需要处置**（`shared/common/defaultSetting.ts` 实测 133 个设置 key，其中 `desktopLyric.*` 44 项、`player.soundEffect.*` 17 项）：**可见 55 项 / 迁移到播放页 17 项（音效）/ 隐藏或改由播放页控件承载 61 项**。手机端设置页按 16 个分组、最多两层呈现。
7. **框架结论（ADR）**：**复用 view-main Svelte SPA + WebView + 原生桥**（与 Phase 1 §6.4 Mode C、PDR 一致），**否决**原生重写与"等比缩放复用"。决定性依据不是"省事"，而是 **PDR-002 要求保留扩展生态，而扩展的 UI 是由 `contributes.settings` 运行时 JSON 驱动的动态表单**（`extensionService/manage.ts` + `views/Setting/ExtensionSetting/*`）——原生侧要等价实现等于自研通用 JSON 表单渲染器，成本远超 UI 重排。
8. **桌面歌词窗**：只做 **应用内歌词页 + 通知栏歌词（MediaSession metadata）**，**不做悬浮窗**（已与 arch 达成共识，见 §4.1/§9.6）。理由是 `modules/player/init/mediaSessionInfo.ts` 已实现完整 MediaSession 双向绑定 + 把歌词写进 `title` 的成熟技巧（`updateMediaSessionInfo(lrc)`，第 33-66 行），**移动端几乎零成本复用**；R-05 因此从 [高] 降为 **[低]**。诚实记录代价：桌面"任意界面置顶看歌词"在 Android 上不等价（通知栏可跨应用可见但仅 1–2 行）。
9. **实现成本已收敛（§9.3）**：在不修改 `source/` 的约束下，UI 只需**覆盖 4 个 `.svelte`（约 620 行源文件）+ 1 个全局 `mobile.less` + 13 个新增文件 ≈ 18 文件 / 3.5–4.2k 行**，占 `view-main` 46k 行的 9%。**不需要整页重写 533 个文件**——三个杠杆：① 外壳不用 `AppLayout`，由自己的入口 mount 新 `MobileApp.svelte`；② 34 处右键菜单/弹层用一条 `html.mobile .menu` 的 `!important` CSS 统一改造成 BottomSheet；③ 歌曲列表 4 列 → 双行用 CSS Grid 在同级子元素上重排。

---

## 1. 现有 UI 结构盘点（基于真实代码）

### 1.1 应用外壳 DOM 层级（`App.svelte` + `components/layout/index.svelte`）

```
#container.view-container                    (flex column, 100%)
├── <Icons />                                (svg sprite 注入: 87 个 icon)
├── #app-main                                 (flex row)
│   ├── <Aside />   width:20% / max 320px     ← 桌面左侧栏
│   │   ├── Logo
│   │   ├── Nav       (在线/最近播放/设置/扩展  5 项，icon+text，padding 8px)
│   │   └── MyList    (默认歌单 + 用户歌单，可拖拽排序)
│   └── #app-right                             (flex column)
│       ├── <Header />  height @height-toolbar = 54px  (搜索框 + 窗口控件)
│       └── <Main />    Router 内容区
├── <PlayBar />      height @height-player = 72px       ← 底部播放条（6 种样式变体）
└── <PlayDetail />   全屏覆盖层（右侧 fly-in）           ← 播放详情/歌词
```
证据：`App.svelte:17-33`、`components/layout/index.svelte:9-17`、`Aside/index.svelte:22-48`、`Header/index.svelte:31-54`、`variables.less:7-8`。

### 1.2 路由与页面清单（`plugins/routes.ts`）

| 路由 | 组件 | 布局范式 | 411dp 判定 |
|---|---|---|---|
| `/online` | `views/Online/index.svelte` | 顶部 Tab（5 类）+ 二级 Tab（4 类搜索类型）+ 右侧 Portal 再挂 Tab + 卡片网格 `minmax(300px,1fr)` | ⚠ **三层横向 Tab**，必然溢出 |
| `/online/songlist` | `views/Online/Songlist/detail/Detail.svelte` | 详情页 + 歌曲列表 | ⚠ 列表 4 列 |
| `/online/topSongs` | `views/Online/TopSongs/detail/Detail.svelte` | 同上 | ⚠ 列表 4 列 |
| `/library` | `views/Library/index.svelte` | 单栏 MusicList（依赖 Aside 选歌单） | ❌ **无 Aside 后无法选歌单** |
| `/settings` | `views/Setting/index.svelte` | **左右两栏**：section 导航 18%(max 200px) + 内容 | ❌ 74px 宽的导航栏放不下中文 |
| `/extenstion` | `views/Extenstion/index.svelte` | Tab(4) + 卡片网格 `minmax(300px,1fr)` | ⚠ 单列可接受 |
| `/search` `/list` `/download` `/songList/*` `/topSongs` | `views/Search/index.svelte` | **占位符**（文件内容仅 `<div class="view-container">hello search</div>`） | ✅ 可自由重定义 |
| `*` | → Library | — | — |

> 关键情报：`/search`、`/list`、`/download`、`/songList/list`、`/songList/detail`、`/topSongs` **六个路由目前是空壳**（`views/Search/index.svelte` 共 5 行）。这意味着**搜索页、下载页、歌曲列表页的 IA 可以按移动优先重新定义，不存在"兼容桌面实现"的包袱**。

### 1.3 交互依赖清单（全量统计，`view-main/src` 250 个 `.svelte`）

| 依赖类型 | 出现次数 | 典型文件 | 触控后果 |
|---|---|---|---|
| `:hover` 样式规则 | **72** | `base/Btn.svelte:93-99`、`MusicList/List/ListItem.svelte:186-189` | 悬停才显形的按钮在触屏上**永不显形** |
| `oncontextmenu` 右键菜单 | **34** | `MusicList/List/index.svelte:163`、`Aside/MyList/List.svelte:39` | 长按在 WebView 里默认触发 `contextmenu`，但菜单是 34px 行高的鼠标定位浮层 |
| `mouseenter/mouseleave` | **17** | `material/PopupBtn.svelte:85-92`（hover 100ms 弹层） | 触屏 tap 会先触发 hover → 弹层"闪开又关" |
| `mousemove` 跟随 | **13** | `apis/tooltips/attach.svelte.ts:116`（tooltip 跟随光标） | 无语义；且 tooltip 绑在 34 个按钮的 `aria-label` 上，触屏上信息**完全丢失** |
| `wheel` 滚轮 | **15** | `common/VolumeBtn.svelte:11`、`base/SliderBar.svelte:78` | 手机无滚轮 |
| `keydown` 键盘 | **25** | `MusicList/List/useHotkey.svelte.ts`、`modules/hotkey/*`、`Setting/AppSetting/Hotkey/*` | 无键盘 = 功能缺失 |
| `sortablejs` 拖拽排序 | 2 处 | `Aside/MyList/List.svelte:48`、`compositions/sortable.svelte.ts` | **仅 Ctrl 按住时启用** → 手机不可达 |
| 自定义滚动条 | 6 处 | `compositions/verticalScrollbar.svelte.ts:83-94` 仅 `mouseenter` 显示 | 手机上永不显示（无害但占位 6px 挡住右缘点击） |
| 窗口控件 | 5 处 | `Header/ControlBtns*.svelte`（最小化/最大化/关闭）、`-webkit-app-region: drag` | Android 无窗口概念，必须删除 |

### 1.4 「411dp 必然崩坏点」清单（按严重度排序）

| # | 组件 / 证据 | 崩坏原因（量化） | 处置 |
|---|---|---|---|
| **B-01** | `app.less:71` `html.web.fullscreen { min-width: 650px }` | 硬地板 650px > 411dp → 整页横向溢出，必须横向滚动才能看到右侧 | **删除**该规则（手机端） |
| **B-02** | `components/layout/index.svelte:9-15` 左侧栏 Aside `width:20%; max-width:320px` | 411 × 20% = 82px，容纳 `#icon-xx + 13px 文本`（`Aside/Nav.svelte:250-253`）必截断 | 手机断点 `display:none`，内容迁移到底部 Tab + 曲库页 |
| **B-03** | `common/MusicList/List/ListItem.svelte:153-161` + `List/Header.svelte:36-39` | 4 列固定占比：歌名 `auto` / 歌手 22% / 专辑 22% / 时长 9%。411-32(padding)-4×10(gap)-42(pic) ≈ 剩余 297px，扣 22%+22%+9%(≈157px) → **歌名列只剩 ~140px ≈ 8~9 个汉字**；`Header.svelte` 同样被压成"名…/歌…/专…" | 改 **双行卡片行**（名称 + 歌手·专辑副行），删除专辑列与表头 |
| **B-04** | `common/PlaylistBtn/index.svelte:80` `.container { width: 500px }` + `height="32rem"`(512px) | 500px > 411dp；512px 高的弹层挂在 72px 播放条上方 → 遮满全屏且溢出 | 改 **全屏队列页（上滑面板）** |
| **B-05** | `components/layout/PlayDetail/Main.svelte` → `LeftInfo/index.svelte:18` `width:50%` + `RightLyric` | 封面 205dp 宽 + 歌词 205dp 宽并排；歌词字号 `winRadio` = 411/1020 = 0.40 → `(0.8+0.8)×0.40 rem = 10px` 歌词，不可读 | 改**纵向分层**：封面区（约 44% 屏高）在上、歌词在下；字号改 `clamp()` |
| **B-06** | `components/layout/PlayBar/*` 高 72px 单行内容：封面+信息+进度+5 个控制按钮+3 个播放按钮+音量滑条 | 411dp 内放 11 个元素，每个 < 37dp 宽 | 拆为 **MiniPlayer(60dp, 4 元素)** + 全屏播放页承载全部控制 |
| **B-07** | `views/Setting/index.svelte` + `AppSetting/SettingList.svelte:49` 左导航 `width:18%; max-width:200px` | 74px 放中文分组名（如"播放详情"）必省略 | **主干导航 ↔ 内容**两级页面（列表点入 + 返回） |
| **B-08** | `views/Online/index.svelte:38` + `Online/Search/Search.svelte:64` + `Header.svelte:22` | 三层横向 Tab（5 类型 + 4 搜索类型 + 音源选择），无 `overflow-x` | 一级 Tab 改横滚（可滑），二级改 Segmented，音源改 Dropdown→BottomSheet |
| **B-09** | `base/Tab.svelte:92,152` `gap:12/24px` + `padding:8px 1px` + `font-size:12px` | 单项命中高 ≈ 30px，< 44dp；5 项 × ~64px + 24×4 = 416px > 411 | 增高到 44dp，`gap:8px`，容器 `overflow-x:auto` + `scroll-snap` |
| **B-10** | `base/Menu.svelte:142-145` `min-width:140px; line-height:34px; font-size:12px` | 右键菜单项目 34px 高；菜单 12 项（`MusicList/List/Menu.svelte:60-80`）→ 高 408px 浮层贴在手指位置 | 改 **BottomSheet**：项高 56dp，分组、可滚动、max-height 60% |
| **B-11** | `base/Btn.svelte:113,122,138-141` `.icon{2rem=32px}` `.icon.min{1.6rem=25.6px}` `.min{padding:2.5px 8px;font-size:12px}` | 32dp / 25.6dp 命中区 | 全局提升到 44dp（视觉图标仍可 20-24dp，用透明内边距撑大命中区） |
| **B-12** | `common/PlayerProgressBar.svelte:114` 高 5px、`base/SliderBar.svelte:168,188` 宽 100px 高 5px，均**无滑块（thumb）** | 命中区 5px；无滑块 = 无位置可见性；音量条 100px 上拖 1px ≈ 1% 音量，精度不足 | 命中区 44dp（透明 padding），视觉轨 6dp，thumb 16dp，音量条宽 ≥ 屏-64dp |
| **B-13** | `base/Checkbox.svelte:111-112` 方框 `1em`(14px) | 命中区取决于 label 文本宽度，行高约 21px | 设置行整体可点，行高 56dp，右侧开关 48×28 |
| **B-14** | `material/Modal.svelte:232,245` header 高 18px、关闭按钮 `padding: 0 7px` + `svg{height:.7em}` | 关闭按钮 ≈ 18×25px | header 56dp，关闭按钮 44×44 |
| **B-15** | `apis/updateModal/UpdateModal.svelte:354` `min-width:500px`、`DuplicateMusicModal/index.svelte:123` `min-width:460px`、`apis/dialog/App.svelte:101` `min-width:320px` | 500/460px 直接溢出；320px 在 411dp 上只剩 45dp 边距 | 统一改为**全宽抽屉/底部卡片**：`width:100%; max-width:100%` |
| **B-16** | `layouts/PlayDetail/Footer/index.svelte:33` `height: 100px` 三段式（左控制/中播放/右控制）+ `MiddlePlayProgress` | 100dp 内横排 3 组、共 9 个控件 | 播放页底部改两行：进度条一行 + 主控一行（5 键） |
| **B-17** | `app.less:3` `html{height:100vh}`，全仓 `safe-area-inset` 0 处 | Android 手势导航条 / 挖孔状态栏 → 底栏被系统条压住 | `100dvh` + `env(safe-area-inset-*)` |
| **B-18** | `Header/ControlBtnsDesktop.svelte` / `ControlBtnsWeb.svelte`、`-webkit-app-region: drag`（`app.less:36-51`） | 无窗口 | 手机端整块不渲染 |
| **B-19** | `compositions/verticalScrollbar.svelte.ts:21-22` 右侧 absolute 6px 轨道 + `contextmenu` 事件重派发 | 遮挡右缘 6px 点击区，手机上永不显示却存在 | 手机端不挂载（`pointer: coarse` 时不注入） |
| **B-20** | `APIs/tooltips/attach.svelte.ts` tooltip 靠 `mousemove` | 34 个纯图标按钮的语义**全靠 tooltip**（`aria-label` → tooltip） | 保留 `aria-label` 做无障碍；视觉上改为"图标 + 文字"或长按提示（见 §3.3） |

### 1.5 移动适配现状纠偏（回答 Phase 1 遗留 A-09 / E-13）

| Phase 1 说法 | 复核 | 结论 |
|---|---|---|
| E-13「已具备移动适配基础（device-width viewport + pxtorem）」 | viewport 确为 `width=device-width`（`vite.config.js:100-107`，`width=1036` 版本被注释掉）；但 `pxtorem(rootValue:16)` + `html{font-size:16px}` 是**恒等映射** | ⚠ **半对**：机制在，效果无。**不能据此认为"改改 CSS 就行"** |
| A-09「pxtorem 在 430~500dp 宽度视觉密度是否可接受」 | 见上；且 `modules/setting/init.ts:50` 会把 `common.fontSize`（默认 16）写到 `html` font-size，等效于「全局缩放倍率」 | ✅ 有答案：**密度不可接受**（正文 13px、图标 32px、4 列表格）。同时得到一个**白送的收益**：`common.fontSize` 天然是"全局字号倍率"，可直接作为**无障碍大字号**能力保留 |
| `propList` 覆盖范围（`vite.config.js:161-183`） | 含 `height/width/*-height/*-width/padding/margin/gap/border-radius/font-size`，**不含 `line-height`**；且 `selectorBlackList: ['html','ignore-to-rem']`（第 185 行）把 `html` 排除在转换之外 | ⚠ 隐患：12 处 `line-height: Npx` 不随倍率缩放（`Menu.svelte:145`、`SettingList.svelte:69` 等），改字号时会错位。根因清理项见 §5.5。**好消息**：`html` 被排除意味着我们在 `html` 上写 px 不会被转 rem，安全区/dvh 改造不会与 pxtorem 冲突 |

---

## 2. 触控化信息架构重设计

### 2.1 导航模型决策

**决策：底部 Tab（4 个）+ 顶栏 + 常驻 MiniPlayer；抽屉不作为一级导航。**

| 底部 Tab | 图标（复用已有 svg） | 承载 | 理由 |
|---|---|---|---|
| **曲库** | `music_library.svg` | 歌单总览（快捷入口：最近播放 / 我喜欢的 / 本地 / 下载 / 不喜欢）+ 歌单列表 + 单歌单详情 | 桌面 Aside `MyList` 的直系继承；听力场景最高频 |
| **在线** | `sound_cloud.svg` | 音源 Tab + 5 类内容（搜索/歌单/排行榜/专辑/歌手）+ 详情 | 桌面 `/online` |
| **搜索** | `search.svg` | 输入页（历史 / 热词）→ 结果页（4 类 Segmented） | 桌面把搜索框**常驻在 Header**（`Header/SearchInput.svelte`）。411dp 上顶栏放不下「搜索框 + 排序 + 更多」，且"找歌"是最高频单点任务 → 独立 Tab 直接进输入态 |
| **设置** | `settings.svg` | 外观/播放/歌词/网络/同步/备份/存储/扩展/更新/关于 | 桌面 `/settings`（含 `/extenstion` 下沉） |

**否决项与理由**

| 备选方案 | 否决理由 |
|---|---|
| 汉堡抽屉 + 无底栏（照搬 Aside 的移动版） | 抽屉把 4 个一级入口藏在 1 次点击之后；音乐类 App 的核心循环（找歌→播放→切歌）需要 0 层级可达。且 Drawer 与系统侧滑返回手势冲突 |
| 5 个 Tab（把"扩展"提到一级） | 扩展安装是低频一次性配置，占用宝贵的 1/5 底栏会挤压高频入口；桌面版自身都把 `/extenstion` 标了 `hidden: true`（`Aside/Nav.svelte:87`） |
| 底部 Tab 里放"正在播放" | 正在播放应**常驻可见**（MiniPlayer），而不是需要点击才看到 |
| 顶部 Tab（TabLayout 风格） | 单手 411dp 宽、2400 高（约 20:9），顶部 Tab 超出拇指可达区（reachability 差）；底部更优 |

**抽屉（Drawer）承载的内容**（明确边界，避免变成第二套导航）：
- 曲库页右上「管理」→ 打开「歌单管理」页（不是抽屉）：支持长按拖拽排序、批量删除、新建。理由见 §3.4 冲突消解 G-02。
- 不加全局 Drawer。

### 2.2 应用外壳线框

```
┌───────────────────────────────────────────┐  ← 状态栏（沉浸式，safe-area-top）
│ 曲库                            ⚙ 管理    │  AppBar 56dp，标题 20sp/500
│ [最近播放] [我喜欢] [本地] [下载] [不喜欢] │  快捷 chip 行 48dp，横滚
├───────────────────────────────────────────┤
│                                           │
│  ▣ 我喜欢的音乐                    286 首  │  歌单行 72dp
│  ▣ 夜跑歌单 · 本地                  42 首  │  封面 56dp 圆角 8dp
│  ▣ WebDAV 我的音乐                  310 首 │  右侧 44×44 [更多]
│  ▣ 华语流行 · 在线                  120 首 │
│  ...                                      │
│                                           │  内容区 flex:auto
│                                           │  overflow-y:auto
│                                           │  padding-bottom:8dp
├───────────────────────────────────────────┤
│ ▣ 晴 天 - 周杰伦                 ⏵  ☰     │  MiniPlayer 60dp（封面44 + 双行 + 2×44按钮）
├───────────────────────────────────────────┤
│   ♫        ☁        ⌕        ⚙           │  TabBar 56dp，4 × (icon24 + label11)
│  曲库      在线      搜索      设置         │  选中项：primary 色 + 顶部 2dp 指示条
└───────────────────────────────────────────┘  ← 手势条（safe-area-bottom）
```

尺寸：AppBar 56dp；chip 行 48dp；内容区自适应；MiniPlayer 60dp；TabBar 56dp + `env(safe-area-inset-bottom)`。
注：底栏与 MiniPlayer 均为 `position: fixed`（相对 WebView viewport）或 flex 固定项，内容区独立滚动。**采用 flex 固定项**（不 fix），避免 `100vh` 与软键盘互相打架。

### 2.3 各 Tab 线框

**(A) 曲库 → 歌单列表**（新增 `views/Library/Home.svelte`）

```
┌ AppBar: 曲库                        [+ 新建] ┐
│ 快捷入口 chips（横滚，44dp 高）              │
├─────────────────────────────────────────────┤
│ ▣ 封面56 │ 我喜欢的音乐            286 首 ⋮ │ 72dp
│          │ 最近更新 · 8月3日                │
├─────────────────────────────────────────────┤
│ ...                                         │
└─────────────────────────────────────────────┘
长按行 → BottomSheet：重命名 / 编辑 / 导出 / 删除
```

**(B) 曲库 → 歌单详情**（复用 `views/Library/index.svelte` 的 MusicList，改造 List/ListItem）

```
┌ AppBar: ‹ 我喜欢的音乐          ⏵全部 ▶随机  ⋮ ┐
│ 封面 96 + 名称 + 286 首 · 我喜欢的音乐          │  头部压缩为 96dp 高（原 140dp 见
├─────────────────────────────────────────────┤  MusicList/Header.svelte:129-130）
│ ▣ 48 │ 晴天                      周杰伦  ⏵ ⋮ │  行 72dp 双行
│      │ 周杰伦 · 叶惠美 · 4:29                │  副行 12sp，label 色
├─────────────────────────────────────────────┤
│ ▣ 48 │ 七里香 ...                            │
└─────────────────────────────────────────────┘
单击行 = 立即播放（沿用现逻辑）
长按行 → 进多选 + 底部条：[加入歌单][下一首播放][下载][不喜欢][更多…]
```

**(C) 在线**

```
┌ AppBar: 在线                  [音源: 默认 ▾] ┐  音源 Dropdown → BottomSheet
│ [搜索][歌单][排行][专辑][歌手]  ← 横滚 44dp   │
├─────────────────────────────────────────────┤
│ 结果区：卡片网格 → 手机改 2 列 (minmax(150px)) │  原 minmax(300px) 见
│ 或列表行（按类型）                            │  Songlist/list/Songlist.svelte:80
└─────────────────────────────────────────────┘
```

**(D) 搜索**

```
状态1（输入页）
┌ [🔍 搜索歌曲/歌手/歌单        ] [取消] ┐
│ 搜索历史            [清空]              │  chip 换行排列，44dp
│ 热门搜索                                │
└─────────────────────────────────────────┘
状态2（结果页）
┌ [🔍 晴天                       ] [取消] ┐
│ [单曲][歌单][专辑][歌手]  ← Segmented   │ 44dp 高，4 等分
├─────────────────────────────────────────┤
│ 结果列表（行 72dp）                      │
└─────────────────────────────────────────┘
```

**(E) 设置**

```
L1（分组列表）
┌ AppBar: 设置 ┐
│ 外观与主题            ›  │ 56dp
│ 播放                  ›  │
│ 歌词与播放页          ›  │
│ 列表与排序            ›  │
│ 在线资源与音源        ›  │  含 extension.onlineExtensionHost / ghMirrorHosts
│ 扩展                  ›  │  → /extenstion（复用桌面页，改 Tab+网格）
│ 网络                  ›  │
│ 数据同步（WebDAV）    ›  │
│ 备份与恢复            ›  │
│ 存储与缓存            ›  │
│ 后台与通知            ›  │  ← 新增（PDR-001 Android 专属）
│ 不喜欢列表            ›  │
│ 更新                  ›  │
│ 关于                  ›  │
└──────────────┘
L2（分组内）
┌ AppBar: ‹ 播放 ┐
│ 播放模式        列表循环 ›  │ 56dp 行，右侧当前值 + ›
│ 音质            128k     ›  │
│ 记住播放进度    [●  ]      │ 48×28 开关，整行可点
│ 媒体设备变化时暂停 [ ]     │
└──────────────┘
```

### 2.4 播放页 / 歌词页

**组织方式：MiniPlayer →（单击/上滑）→ 全屏播放页（封面态）→（上滑）→ 歌词态（同一页面第二个"页面位"，横向/纵向切换）。**

```
全屏播放页（封面态）
┌ ‹ 收起                    ⋮ 更多 ┐   顶栏 48dp，下滑/‹ 收起
│                                  │
│      ┌──────────────────┐        │   封面区 height: 42dvh
│      │   方形封面 / CD   │        │   保留 playDetail.coverStyle
│      └──────────────────┘        │   (cd / square，settings 可选)
│  晴天                            │   20sp/600，单行省略
│  周杰伦 · 叶惠美                  │   13sp，label 色
│  ♡ 收藏        ☁ 音源        ⋯    │   3 × 44dp
│                                  │
│  ─────●─────────────────────     │   进度：触控带 44dp，轨 6dp，thumb 16dp
│  01:12              02:38        │   拖动时 thumb 上方浮出气泡时间
│                                  │
│   ⤨      ⏮      ⏵      ⏭      ☰ │   48  56  72  56  48（主键 72dp 圆形）
│                                  │
│  ♪ 歌词   ≡ 队列   🎛 音效   🔊 音量 │   4 × 48dp，图标行
└──────────────────────────────────┘

            上滑封面区 ↓↑ 下滑
┌ ‹                        ⋮ ┐
│                              │
│      晴天                    │  ← 歌词页：全屏歌词（复用
│  周杰伦 · 叶惠美              │    PlayDetail/RightLyric/LyricPlayer）
│ ─────────────────────        │
│      窗外的麻雀              │  当前行 primary 色 + 放大 1.06
│      在电线杆上多嘴          │  ← 其余行 label 色
│      你说这一句              │
│      很有夏天的感觉          │  点行 = 跳转该行（已有 handleSkipPlay）
│                              │  长按 = 复制歌词 / 调整偏移（LyricMenu → BottomSheet）
└──────────────────────────────┘
```

层级（z-index，沿用现值）：内容 1 → MiniPlayer 2 → 全屏播放页 10 → BottomSheet 20 → 通知/Toast 99。

### 2.5 三条主流程任务切片

**流程 A：找歌播放（目标 ≤3 次点击、≤12 秒）**

| 步 | 屏幕 | 触控 | 桌面原路径 |
|---|---|---|---|
| 1 | 搜索 Tab（输入页） | 点底栏「搜索」→ 键盘自动弹出 | Header 常驻输入框（小屏已无空间） |
| 2 | 结果页 | 输入关键词 → 「单曲」Segmented 自动选中 → 点行 | 回车后同页切换 |
| 3 | MiniPlayer 出现 | 点行即播放（沿用 `musicClick`），MiniPlayer 弹出「已开始播放」 | PlayBar 更新 |
| 分支 | 换音源 | 长按行 → BottomSheet「切换音源」 | 右键 → 换源（12 项菜单里第 7 项） |

**流程 B：管理歌单（批量操作，目标在手机上可完成）**

| 步 | 屏幕 | 触控 | 桌面原路径 |
|---|---|---|---|
| 1 | 曲库 | 点歌单行 | 点 Aside 歌单 |
| 2 | 歌单详情 | **长按任一行** → 自动进入多选模式并选中该项 | `Ctrl/Shift + 点击`（**手机不可达**） |
| 3 | 多选态 | 单击继续加选/取消；顶部条 [全选][取消]；底部操作条 5 个 48dp 按钮 | 键盘 `mod+a` 全选 |
| 4 | 执行 | 点「加入歌单」→ BottomSheet 选目标歌单 → 完成 → Toast + 退出多选 | 右键 → 加入歌单 |
| 补充 | 歌单排序 | 曲库 → [管理] → 歌单管理页 → **拖拽把手**（24×44dp，仅把手接管触摸） | `Ctrl` 按住 + 拖拽（**手机不可达**） |
| 补充 | 歌曲排序 | 长按 → BottomSheet「排序」→ 数值输入（`MusicSortModal` 已存在，改弹层） | 右键 → 排序 → 输入序号 |

**流程 C：配置音源（首次配置，目标引导式不迷路）**

| 步 | 屏幕 | 触控 | 桌面原路径 |
|---|---|---|---|
| 1 | 设置 | 点「在线资源与音源」 | 设置 → 在线资源 |
| 2 | L2 | 打开「启用在线资源」开关 | 复选框 |
| 3 | L2 底部 | 点「管理扩展 ›」→ `/extenstion` | 侧栏「扩展」 |
| 4 | 扩展页 | 「商店」Tab → 卡片 → 详情 → 安装（全程 44dp 按钮） | 同（桌面 hover 显示安装按钮，见 §3.3） |
| 5 | 返回在线 Tab | 音源 Dropdown 出现新音源（`resourceList.resources` 已响应式） | 左侧 Nav 的「在线」 |

### 2.6 页面改造清单（文件级，供 Phase 4 执行）

> ⚠ **本节路径是"逻辑归属"，不是"要修改的文件"。** Phase 2 已确定**不修改 `source/`**，实际落盘位置与覆盖方式见 **§9.3**（结论：只需覆盖 4 个 `.svelte`，其余靠 1 个全局 `mobile.less` + 13 个新增文件）。下表"新增"类对应 `porting/js/ui/**`，"改造"类按 §9.3.2 的方式列处理。

| 类型 | 逻辑归属（源码对应位置） | 说明 |
|---|---|---|
| 新增 | `components/layout/MobileAppShell.svelte` | 移动外壳：AppBar 插槽 + 内容 + MiniPlayer + TabBar |
| 新增 | `components/layout/MobileTabBar.svelte` | 4 Tab，44dp 命中，safe-area 处理 |
| 新增 | `components/layout/MiniPlayer.svelte` | 60dp，封面/标题/播放/队列，点击展开 |
| 新增 | `components/layout/MobileAppBar.svelte` | 56dp，`‹` 返回 + 标题 + 右侧动作插槽 |
| 新增 | `components/material/BottomSheet.svelte` | 通用底部弹层（拖拽关闭、max-height 60%、scrim） |
| 新增 | `components/material/ActionSheet.svelte` | 基于 BottomSheet 的菜单（项 56dp、分组分隔、危险项红色） |
| 新增 | `views/Library/Home.svelte` | 歌单总览（替代 Aside/MyList 的展示职责） |
| 新增 | `views/Search/index.svelte`（重写空壳） | 搜索输入页 + 结果页 |
| 新增 | `views/Setting/mobile/*` | L1 分组列表 + L2 分组页（复用 `AppSetting/settings.ts` 的 section 定义） |
| 新增 | `shared/compositions/longPress.svelte.ts` | 长按检测（500ms、位移 >8px 取消、`navigator.vibrate(10)`） |
| 新增 | `shared/compositions/swipeDismiss.svelte.ts` | 上滑/下滑展开收起（播放页） |
| 全局样式 | `assets/styles/mobile.less` | 移动令牌 + 断点 + 触控基线（§3.1、§5.5、§9.3.1） |
| ~~改造~~ | `App.svelte` / `components/layout/index.svelte` | **改为新增 `MobileApp.svelte` 由 `entries/main.ts` 直接 mount，不覆盖、不渲染 `AppLayout`**（§9.3.1 杠杆 1） |
| 改造→**S** | `components/layout/PlayDetail/*` | 50/50 → 纵向分层；footer 100dp → 两行（纯 CSS） |
| 改造→**S** | `components/common/MusicList/List/{ListItem,Header}.svelte` | 4 列 → 双行卡片；表头隐藏（CSS Grid 重排，§9.3.1 杠杆 3） |
| 改造→**S** | `components/common/PlaylistBtn/index.svelte` | Popup(500×512) → BottomSheet（CSS） |
| 改造→**S** | `views/Setting/index.svelte` | 两栏 → 左栏变横滚 chip 条（CSS） |
| 改造→**S** | `app.less` | 移除 `min-width:650px`、`-webkit-app-region`、`100vh` → `100dvh`（`html.mobile` 前缀覆盖） |
| 改造→**O** | `components/common/MusicList/List/index.svelte` | 长按进多选 + 行高系数（必须改 JS） |
| 改造→**O** | `views/Library/index.svelte` | `/library` 无 id → Home |
| 改造→**O** | `views/Search/index.svelte` | 空壳重写（原 5 行） |
| 改造→**O**（可选） | `components/layout/PlayDetail/RightLyric/LyricPlayer.svelte` | 歌词字号公式 `w/1020` → `--lrc-pct` |

---

## 3. 触控交互规格

### 3.1 全局设计令牌（`src/assets/styles/mobile.less`，`html.mobile` 生效）

> 单位换算约定：**1 CSS px = 1 dp**（因为 `html{font-size:16px}` + `pxtorem(rootValue:16)` 是恒等映射）。以下数值直接写 px 即等于 dp。

| 令牌 | 值 | 用途 / 依据 |
|---|---|---|
| `--touch-min` | `44px` | 最小命中区（硬底线） |
| `--touch-comfort` | `48px` | 常规图标按钮 / 列表内动作按钮 |
| `--touch-primary` | `56px` | 主操作按钮（播放/暂停以外的主按钮） |
| `--touch-play` | `72px` | 播放页主播放键 |
| `--gap-min` | `8px` | 相邻可点元素最小间距（硬底线） |
| `--gap-group` | `16px` | 分组之间 |
| `--page-pad-x` | `16px` | 页面左右内边距 |
| `--row-music` | `72px` | 音乐行（封面 48 + 双行文本 + 右侧 44 按钮） |
| `--row-list` | `72px` | 歌单/扩展卡片行 |
| `--row-menu` | `56px` | BottomSheet / ActionSheet 项 |
| `--row-setting` | `56px` | 设置项（单行）；带描述 72px |
| `--appbar-h` | `56px` | 顶栏 |
| `--tabbar-h` | `56px` | 底部 Tab（不含安全区） |
| `--miniplayer-h` | `60px` | 迷你播放条 |
| `--sheet-radius` | `16px 16px 0 0` | 底部弹层圆角 |
| `--sheet-max-h` | `60dvh` | 弹层最大高度（留出上层信息） |
| `--safe-top` | `env(safe-area-inset-top, 0px)` | 状态栏/挖孔 |
| `--safe-bottom` | `env(safe-area-inset-bottom, 0px)` | 手势导航条 |
| `--hit-inset` | `(44 - 视觉尺寸)/2` | **透明内边距**撑大命中区的标准做法 |
| `--dur-tap` | `100ms` | 按下反馈 |
| `--dur-sheet` | `240ms cubic-bezier(.32,.72,0,1)` | 弹层进出（M3 标准） |

**手势安全区/系统区规则**
- 顶栏：`padding-top: var(--safe-top)`；状态栏文字色由原生壳设置（深色主题用 light status bar）。
- 底栏：`padding-bottom: max(8px, var(--safe-bottom))`；**TabBar 内容区不得压在手势条上**。
- 左右边缘 24dp 内**禁止**放置横向可滚动区、可拖拽把手、`swipe-to-action`（避让 Android 手势返回）。
- 软键盘：搜索输入页使用 `visualViewport` 监听，键盘弹出时 TabBar/MiniPlayer 隐藏（`body.keyboard-open`）。

### 3.2 组件级触控规格（逐项校验）

| 组件（文件） | 现状 | 移动端目标 | 校验 |
|---|---|---|---|
| `base/Btn.svelte` `.icon` | 32dp | 44dp 命中（`padding:10px`，svg 24dp） | ✅ |
| `base/Btn.svelte` `.min` | 25.6dp / 行高 19dp | 44dp 命中，`font-size:13px`，`padding:0 16px` | ✅ |
| `base/Menu.svelte` 项 | 高 34px / 宽 ≥140px | **废弃**（改 ActionSheet：项 56dp，宽 = 屏-32dp） | ✅ |
| `base/Tab.svelte` | 高 ≈30px，gap 12/24 | 高 44dp，gap 8px，容器 `overflow-x:auto` + `scroll-snap-type:x mandatory` + 隐藏滚动条 | ✅ |
| `base/Checkbox.svelte` | 方框 14dp | 保留方框 20dp 视觉 + **整行 label 可点**，行高 56dp | ✅ |
| `base/SliderBar.svelte` | 宽 100px，轨 5px，无 thumb | 宽 = 屏-64dp（音量）/ 100%（音效），**触控带 44dp**（`padding:19px 0` 透明），轨 6dp，thumb 16dp 圆形 + 拖动放大 20dp | ✅ |
| `common/PlayerProgressBar.svelte` | 高 5px，无 thumb | 触控带 44dp，轨 6dp，thumb 16dp，拖动时显示目标时间气泡（`12sp`，距 thumb 上 12dp） | ✅ |
| `base/Popup.svelte` + `material/PopupBtn.svelte` | hover 100ms 弹出，宽 140-500px，max-h 250px | 手机端**禁用 Popup**，`PopupBtn` 降级为"点击 → ActionSheet/BottomSheet"；仅 `pointer:fine` 时保留 Popup | ✅ |
| `material/Modal.svelte` | header 18px，`min-width:320px`，`max-width:76%` | 手机端：`width:100%; max-width:100%; border-radius:16px 16px 0 0; 底部对齐`；header 56dp；关闭按钮 44dp；`max-height:88dvh` | ✅ |
| `common/MusicList/List/ListItem.svelte` | 行高 52px，4 列，fz 13 | 行高 **72dp**，双行（名 15sp / 副行 12sp），封面 48dp；右侧 `⋮` 44dp 常显（不再 hover 显形） | ✅ |
| `common/MusicList/List/Header.svelte` | 表头 36px 4 列 | **删除**；多选态时替换为「已选 N / 全选 / 取消」条 48dp | ✅ |
| `common/MusicList/MiniHeader.svelte` | 见文件 | 保留，改为单行 + 排序入口 44dp | ✅ |
| `Aside/MyList/ListItem.svelte` | 行高 ≈ 3.2×字体 = 52px | 迁移到 `Library/Home`，行 72dp | ✅ |
| `Setting/AppSetting/SettingList.svelte` | 行高 36px，宽 18% | 改为 L1 全宽行 56dp（`›` 指示） | ✅ |
| `views/Setting/components/CheckboxItem.svelte` | 行高 ≈ 21px | 行 56dp（整行点击），右侧开关 48×28 | ✅ |
| `common/PlaylistBtn/*` | 弹层 500×512 | 全屏队列页（`‹ 播放队列` AppBar + 行 64dp + 当前行高亮 + 长按操作） | ✅ |
| `common/VolumeBtn.svelte` | 图标 24dp + Popup 140px | 图标命中 44dp；音量改为播放页内的滑块行（系统音量键 + 应用内滑块双通道） | ✅ |
| `common/TogglePlayModeBtn.svelte` | 图标 24dp | 44dp，点击直接循环切换 + Toast 显示当前模式（不弹菜单） | ✅ |
| `apis/notify/Item.svelte` | `min-width:100px` | Toast 改为底部 Snackbar：宽 屏-32dp，底部距 TabBar 16dp，4s 自动消失，可上滑关闭 | ✅ |
| `apis/tooltips/*` | 跟随鼠标 | 手机端**不挂载**；`aria-label` 保留给 TalkBack；纯图标按钮若无可见文本 → 长按 500ms 显示 Toast 提示（仅首次） | ✅ |
| `compositions/verticalScrollbar` | 仅 hover 显示 | `@media (pointer: coarse)` 不注入 | ✅ |

### 3.3 桌面交互逐项替换表

| # | 桌面原交互 | 位置（证据） | 触控替代 | 备注 |
|---|---|---|---|---|
| 1 | hover 才显形的「播放」按钮 + 序号 | `MusicList/List/ListItem.svelte:113-117,128-146` | 行内右侧 `⋮`（44dp）**常显**；序号常显在封面左上角小字（或直接不显示序号，用 `playing` 高亮替代） | 触屏无 hover，隐藏即丢失 |
| 2 | 右键 → 12 项上下文菜单 | `MusicList/List/Menu.svelte:60-80` | **长按行 → ActionSheet**（56dp 项，分组：播放/下一首播放 ｜ 加入歌单/移动/排序/换源 ｜ 评论/复制名称 ｜ 不喜欢/移除） | 项数 >6 时 ActionSheet 可滚动 |
| 3 | 右键空白 → 菜单 | `Aside/MyList/List.svelte:39-44` | AppBar「+ 新建歌单」按钮 | — |
| 4 | `Ctrl` 按住 + 拖拽排序 | `sortable.svelte.ts:75-85` | **专用「歌单管理」页 + 拖拽把手**（把手 24×44dp，仅把手 `touch-action:none`） | 长按拖拽与长按菜单**同屏互斥**，故拆分页面（G-02） |
| 5 | `Ctrl/Shift + 点击` 多选 | `List/index.svelte:180`、`useHotkey.svelte.ts:46-48` | **长按进多选**（自动选中该项）→ 单击 toggle；顶部条 [全选][取消]；区间选择用「全选 + 反选」替代 | 复用现有 `useSelect.handleSelect`（非 shift 分支即 toggle，`useSelect.svelte.ts:54-57`），**逻辑零改动** |
| 6 | `mod+a` 全选 | `useHotkey.svelte.ts:10-14` | 多选态顶部「全选」按钮 44dp | — |
| 7 | 全局/局部快捷键（8 个命令） | `modules/player/init/playCmdAction.ts:16-52`（play/pause/playToggle/next/previous/favorite/unfavorite/dislike） | **媒体通知按钮 + 耳机线控/蓝牙 AVRCP + 通知栏**（走 `MediaSession` action handler）；应用内提供「手势」：MiniPlayer 左右滑切歌（P2） | 命令总线已存在，桥只需派发 `command` |
| 8 | 滚轮调音量 | `VolumeBtn.svelte:11-13` | 播放页音量滑块 + 系统音量键 | — |
| 9 | 滚轮/方向键调滑块 | `SliderBar.svelte:78-101` | 拖动 + 长按后精细调整（±1 步长按钮，播放页展开态提供） | 高精度需求由步进器兜住 |
| 10 | 窗口最小化/最大化/关闭 | `Header/ControlBtns*.svelte`、`PlayDetail/Header.svelte:48-92` | **删除**；播放页 `‹` 收起 = 关闭 | `-webkit-app-region` 全删 |
| 11 | 拖拽标题栏移动窗口 | `app.less:36-51`、`Header/index.svelte:22` | 删除 | — |
| 12 | 右键播放详情页 = 关闭 | `PlayDetail/index.svelte:72`、`shared/useHidePlayDtail.ts` | **下滑关闭**（`swipeDismiss`）+ `‹` 按钮 + 系统返回键 | — |
| 13 | 点击播放条封面 → 打开播放详情 | `PlayBar/components/Pic.svelte:15` | 点击 **MiniPlayer 整条** → 打开（命中区更大） | — |
| 14 | 桌面歌词窗（透明置顶穿透） | `winLyric/*`、`modules/lyric/desktopLyric.ts` | 见 §4.1 | — |
| 15 | 托盘图标/菜单/状态栏歌词 | `desktop/src/modules/tray/index.ts` | **常驻媒体通知**（MediaStyle + 前台服务） | 见 §4.2 |
| 16 | 全局热键 | `desktop/src/modules/hotKey/*` | 媒体键 + 通知 | 见 §4.2 |
| 17 | 系统主题跟随 | `desktop/src/app/index.ts:200-205` | WebView `prefers-color-scheme`（已可用）+ 现状 `theme.id` 设置；Android 侧注入 `uiMode` | 已具备 |
| 18 | 文件对话框（选目录/文件） | `dialog.showOpenDialog`、`shared/ipc/fs/*` | **SAF（`ACTION_OPEN_DOCUMENT_TREE`）**，桥返回 `content://` URI 列表；`fs.ts` 的 `fileSystemAction` 语义需重定义 | 依赖 arch（A-06） |
| 19 | 新建歌单/重命名 → 输入弹窗 | `apis/inputModal/*` | 底部输入卡片（键盘上方 16dp），确认按钮 48dp，`inputMode` 按内容设置 | — |
| 20 | 数据表格「排序弹窗」输入序号 | `MusicSortModal` | 步进器（− / 数字 / ＋，各 44dp）+ 快捷「置顶/置底」 | 数值输入替代拖拽微调 |
| 21 | hover 显示自定义滚动条 | `verticalScrollbar` | 不注入；依赖系统滚动惯性 | — |
| 22 | hover 才显示 tooltip 说明 | 34 处 `aria-label` | 关键项改「图标 + 文字」；次要项删除 | 信息不能只存在于 tooltip |
| 23 | 多窗口并排（主窗 + 歌词窗） | Electron 双窗口 | 单窗口 + 播放页内歌词态 / 系统级悬浮窗（可选） | — |

### 3.4 手势映射与冲突消解

**手势总表**

| 手势 | 触发区域 | 动作 | 反馈 |
|---|---|---|---|
| 单击 | 音乐行 | 立即播放（沿用 `musicClick`） | 行按下 100ms 高亮 + MiniPlayer 更新 |
| 长按 500ms | 音乐行 | 进多选（选中该项）+ 底部操作条 | 触觉 `vibrate(10)` + 行左侧勾选框出现（150ms 动画） |
| 长按 500ms | 已处多选态的行 | ActionSheet（针对该项） | 同上 |
| 单击 | 行内 `⋮`（44dp） | ActionSheet（不改变选择态） | 按下高亮 |
| 拖动把手 | 歌单管理页行的右端 | 排序拖拽 | 行浮起（elevation + 缩放 1.02）+ 触觉 |
| 横向拖动 | 进度条 / 音量条 / 音效滑块 | 调整数值 | thumb 放大 + 数值气泡 |
| 上滑 | MiniPlayer | 展开播放页 | 跟随手指位移（`translateY`） |
| 下滑 | 播放页封面区顶栏 | 收起 | 位移 > 25% 屏高或速度 > 0.5px/ms 则收起 |
| 上滑 | 播放页封面区 | 切到歌词态 | 内容横向交叉淡入（240ms） |
| 下滑 | 歌词态 | 回封面态 | 同上 |
| 左/右滑 | MiniPlayer（P2） | 上一首 / 下一首 | 卡片横向跟手，超过 30% 宽度切换 |
| 单击 | 歌词行 | 跳到该行播放（已有 `handleSkipPlay`） | 目标行高亮 2 次闪烁 |
| 长按 | 歌词区 | 歌词操作（偏移/字号/复制） | ActionSheet |
| 双指捏合 | 歌词区（P2） | 字号缩放（写回 `playDetail.style.fontSize`） | 实时字号 |
| 系统返回键 | 全局 | 关闭最上层（ActionSheet → 播放页 → 二级页 → Tab 首页 → 退出） | 由原生 `onBackPressed` 经桥询问 Web 侧栈 |

**冲突消解表**

| 编号 | 冲突对 | 冲突场景 | 消解方案 |
|---|---|---|---|
| **G-01** | 侧滑返回 ↔ 横向滚动 / Tab 横滚 | 在 Tab 横滚区边缘侧滑，系统抢走手势 | ① 页面根容器 `touch-action: pan-y`；② 横向滚动容器显式 `touch-action: pan-x` 且**左右各留 24dp 外边距**；③ 与系统手势导航协商：WebView 内不监听 `touchstart` 做自定义边缘侧滑 |
| **G-02** | 长按拖拽排序 ↔ 长按弹菜单 | 同一行同时是"可拖拽"和"可长按操作" | **物理分离**：排序只在「歌单管理」页（页面内只有拖拽语义，无长按菜单）；音乐列表只有长按菜单，无拖拽。**并在拖拽把手之外的行区域禁用 `draggable`** |
| **G-03** | 进度条拖动 ↔ 页面垂直滚动 | 手指按在进度条上想上下滚页面，结果 seek | 进度条容器 `touch-action: pan-y`；用 Pointer Events 判断首次位移方向：**水平位移 > 8px 才接管，垂直位移优先交给滚动**（`pointercancel` 释放） |
| **G-04** | 歌词拖动 ↔ 播放页下滑收起 | 在歌词态下滑想滚歌词，结果收起页面 | 歌词态**禁用**下滑收起（只能用 `‹` 或返回键）；收起手势仅在封面态顶栏 56dp 区域内生效 |
| **G-05** | 上滑展开播放页 ↔ MiniPlayer 上的横向切歌（P2） | 斜向滑动歧义 | 判定主轴：`Math.abs(dx) > 1.5 * Math.abs(dy)` → 横向切歌；`Math.abs(dy) > 1.5 * Math.abs(dx)` → 展开；否则不触发 |
| **G-06** | 长按 ↔ 选择文本 | 长按歌曲名触发系统文本选择 | 全局 `user-select: none`（`app.less` 已有部分）；仅输入框、歌词复制模式、`Setting › 关于` 允许选择 |
| **G-07** | 长按 ↔ 系统 `contextmenu` | Android WebView 长按会派发 `contextmenu` | 在 `longPress` 组合式里 `event.preventDefault()`；旧 `oncontextmenu` 处理器在 `html.mobile` 下改为空操作（保留桌面分支） |
| **G-08** | 底部安全区 ↔ 弹层底部按钮 | BottomSheet 主按钮被手势条遮挡 | `padding-bottom: max(16px, env(safe-area-inset-bottom))` |
| **G-09** | 软键盘 ↔ 固定底栏 | 搜索输入时 TabBar 顶到键盘上方 | `visualViewport` 变化 > 120px 判定键盘弹出 → 隐藏 TabBar/MiniPlayer，页面 `padding-bottom:0` |

### 3.5 触控反馈与可达性（移动端最低要求）

- **按下态**：所有可点元素必须有 `:active` 视觉反馈（现有 `:active` 规则基本齐备，仅需确认在 `pointer:coarse` 下不被 `:hover` 覆盖——建议用 `@media (hover: hover)` 包裹所有 `:hover` 规则）。
- **触觉**：长按进入多选、拖拽开始/结束、切歌 —— `navigator.vibrate(10)`（Android WebView 支持；无振动马达时静默失败）。
- **对比度**：主题色系由 `@shared/theme`（15 套）提供，`--color-font-label` 在浅色主题下对照度需 ≥ 4.5:1（Phase 5 走查项）。
- **TalkBack**：保留全部 `aria-label`；列表项 `role="button"` + `aria-label="{歌名} {歌手}"`；多选态 `aria-checked`。
- **字号**：最小 11sp 仅用于 badge；正文 13–15sp；标题 20sp。`common.fontSize` 保留为全局倍率（0.8×–1.3×）。
- **触控目标校验方式**：Phase 5 用「开发者选项 → 显示布局边界」+ 自定义 overlay 检查 44×44dp，或注入脚本 `querySelectorAll('button,a,[role=button]')` 遍历 `getBoundingClientRect()` 输出 <44dp 清单。

---

## 4. 桌面专有能力映射

### 4.1 桌面歌词窗 → 应用内歌词页 + 通知栏歌词（**已与 arch 达成共识，悬浮窗不做**）

桌面实现：`desktop/src/renderer/winLyric/main.ts:105,241-291` 独立 BrowserWindow，`transparent + setAlwaysOnTop('screen-saver') + setIgnoreMouseEvents`，渲染 `view-lyric` SPA（含 `lock`、`hover 淡化`、`resize 把手`、拖拽）。

**共同结论（arch D 决策 + 本人复核一致）：Android 主形态 = 「应用内歌词页（播放详情页内全屏歌词）」+「通知栏歌词」两个载体，不做 `SYSTEM_ALERT_WINDOW` 悬浮窗。** 排版上限与接口见 **§9.2**。

| 方案 | 机制 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. 应用内歌词页 + 通知栏歌词** | ① 应用内：复用 `PlayDetail/RightLyric/LyricPlayer.svelte`，播放页上滑切歌词态；② 通知栏：原生 `MediaSessionCompat` + `MediaStyle`，歌词写入 `MediaMetadata.TITLE`（复用 `titleLyric` 机制） | ① **零特殊权限**；② `modules/player/init/mediaSessionInfo.ts:33-66` 已实现「歌词 → metadata.title」完整链路，开关 `player.isShowMediaSessionLyric` 已存在；③ 锁屏/通知栏/耳机线控一致；④ 符合 Android 媒体应用规范；⑤ **不增加常驻 View 与耗电** | 通知栏只 1–2 行；跨应用置顶不可得（形态差异，非能力缺失） | ✅ **唯一主方案** |
| **B. 悬浮窗（`SYSTEM_ALERT_WINDOW`）** | 原生 `WindowManager` + `TYPE_APPLICATION_OVERLAY` | 视觉最接近桌面 | ① 需二次授权，首次成功率低；② HyperOS 管控严格，长期驻留被清理；③ 无法跨应用置顶（与桌面"等价"是错觉）；④ 常驻 View 耗电与复杂度 | ❌ **不做**（arch 结论，本人同意） |
| **C. 复用 `view-lyric` SPA 做第二个 WebView 悬浮窗** | 第二次 `WebView` 加载歌词 SPA | 视觉 100% 复用 | 两个 WebView 常驻 → 内存 +100MB 量级；`view-lyric` 的 resize/拖拽依赖鼠标事件；`lock/hover` 语义在触屏无意义 | ❌ **否决** |

**落地路径**
1. P0：原生 `MediaSessionCompat` 作为**唯一媒体会话持有者**；JS 桥上报 `metadata(title/artist/album/artwork)`、`playbackState`、`position`；歌词行写入 `title`（复用 `updateMediaSessionInfo(lrc)` 逻辑，出口从 `navigator.mediaSession` 换成 `bridge.setMediaMetadata`）。
2. P0：前台服务 `foregroundServiceType="mediaPlayback"` + `AudioFocus`（无需 `PARTIAL_WAKE_LOCK`）。
3. P0：应用内歌词页 = `PlayDetail` 的歌词态（上滑进入），样式设置 6 项见 §9.1。
4. P1：若实测单行不满足 → 展开态改 RemoteViews **2 行**（不做 3 行，理由见 §9.2）。
5. ~~P2：悬浮歌词~~ **删除**。

> 移植风险对应：**R-05 从 [高] 直接降为 [低]**——不需要 `SYSTEM_ALERT_WINDOW`、不需要第二个 WebView、不需要常驻 View，只依赖已在 Phase 1 判定"零成本复用"的 MediaSession 链路。**代价诚实记录**：桌面版"任意界面置顶看歌词"在 Android 上不等价（通知栏可跨应用可见但仅 1–2 行）。这是形态差异，需在交付说明里写明，不掩饰。

### 4.2 托盘 / 全局热键 → 媒体通知 + 媒体键

| 桌面能力 | 证据 | Android 等价物 | 设计要点 |
|---|---|---|---|
| 托盘图标 + 菜单（播放/暂停/上下曲/显示主窗/退出） | `desktop/src/modules/tray/index.ts` | **常驻媒体通知**：`MediaSessionCompat` + `MediaStyle`，动作集 `[⏮][⏯][⏭]` + `[♡]`（收藏）+ `[歌词]`（开关歌词） | 通知点击 → 拉起 App 到播放页；`setShowActionsInCompactView(0,1,2)` |
| 托盘状态栏歌词（`Tray.setTitle`） | 同上 | 媒体通知副标题 / 进度条 | 用 `setSubText` 或 `setProgress` |
| 全局快捷键（8 命令） | `modules/hotKey/globalHotkey.ts`、`playCmdAction.ts` | ① `MediaSession` action handler（耳机线控/蓝牙 AVRCP/系统媒体面板）；② 通知按钮；③ 应用内 MiniPlayer 手势（P2） | 命令总线已存在（`commandEvent.register()` 注册了 play / pause / playToggle / next / previous / favorite / unfavorite / dislike 八个），桥只需 `bridge.dispatchCommand(name)` |
| 窗口置顶/全屏 | `setAlwaysOnTop`、`setFullScreen` | 无等价 | 删除 |
| 应用级代理 `session.setProxy` | `desktop/src/app/index.ts:134-137` | 应用内代理（`fetch` + 代理控制器）或系统代理 | 依赖 arch（R-10） |

### 4.3 设置页 133 项 → 移动端分组与层级

`shared/common/defaultSetting.ts` 实测 **133 个设置 key**。三类处置：**可见 55 / 迁移到播放页 17 / 隐藏或改由播放页控件承载 61**（55 + 17 + 61 = 133）。

| 处置 | 分组 / 去向 | 包含的 key（数量） |
|---|---|---|
| **可见 L1「外观与主题」** | | `theme.id` `theme.lightId` `theme.darkId` `common.isShowAnimation` `common.fontSize` `common.langId` (6) |
| **可见 L1「播放」** | | `player.togglePlayMethod` `player.playQuality` `player.isSavePlayTime` `player.preservesPitch` `player.isMediaDeviceChangedPausePlay` `player.isShowTaskProgess` `player.autoSkipOnError` `player.waitPlayEndStop` `player.waitPlayEndStopTime` `player.isAutoCleanPlayedList` `player.audioVisualization` (11) |
| **可见 L1「歌词与播放页」** | | `player.isShowLyricTranslation` `player.isShowLyricRoma` `player.isSwapLyricTranslationAndRoma` `player.isS2t` `player.isPlayAwlrc` `player.ignoreLocalLyrics` `playDetail.isZoomActiveLrc` `playDetail.isDelayScroll` `playDetail.style.fontSize` `playDetail.style.align` `playDetail.style.fontWeight` `playDetail.coverStyle` `playDetail.isDynamicBackground` `player.isShowMediaSessionLyric`（改名为「通知栏歌词」） (14) |
| **可见 L1「列表与排序」** | | `list.isShowActionBtn` `list.addMusicLocationType` (2) |
| **可见 L1「在线资源与音源」** | | `onlineResource.enable` `onlineResource.tipSearchSource` `extension.onlineExtensionHost` `extension.ghMirrorHosts` (4) |
| **可见 L1「扩展」** | → `/extenstion`（复用桌面页，Tab+网格改为手机布局）+ `Setting/ExtensionSetting` | （组件入口，非 key） |
| **可见 L1「网络」** | | `network.proxy.enable` `network.proxy.host` `network.proxy.port` `network.proxyAllResources` (4) |
| **可见 L1「数据同步（WebDAV）」** | | `sync.webdav.enable` `sync.webdav.url` `sync.webdav.username` `sync.webdav.password` `sync.webdav.path` `sync.webdav.debugEnable` `sync.webdav.syncEnable.list` `sync.webdav.syncEnable.dislike` (8) |
| **可见 L1「备份与恢复」** | | `backup.backupPath`（SAF 目录）+ 自动备份/导出（组件） (1) |
| **可见 L1「存储与缓存」** | | `download.savePath` `download.fileName` + 资源缓存/音乐缓存（组件） (2) |
| **可见 L1「不喜欢列表」** | | （组件 `DislikedList.svelte`） (0) |
| **可见 L1「更新」** | | `common.tryAutoUpdate` `common.allowPreRelease` `common.showChangeLog` (3) |
| **可见 L1「关于」** | | （组件 `About.svelte`；含许可证声明 AGPL） (0) |
| **可见（新增，Android 专属）** | 「后台与通知」 | 新增：通知栏歌词开关（映射 `player.isShowMediaSessionLyric`）、电池优化白名单引导、音频焦点策略、锁屏控制（0 个新 key；**不含**悬浮歌词——已按 arch 结论取消，见 §4.1/§9.6） |
| **迁移（17）** | `player.soundEffect.*` 全部 17 项 → 播放页「🎛 音效」BottomSheet（预设 chips + 4 折叠组，EQ 分 3 段 Tab；**config key 位置不变，只搬 UI 入口**，见 §9.5） | 音效是**播放场景的即时调整**，放设置深处不合理 |
| **隐藏或改由播放页控件承载（61）** | ① `desktopLyric.*`（**44**，**全丢不迁移**，样式最小集见 §9.1 = 复用 `playDetail.*` 5 项 + 新增 `lyricView.style.lineGap` 1 项）；② tray 类 `tray.enable` `tray.themeId`（**2**）；③ 窗口/桌面类 `common.windowSizeId` `common.startInFullscreen` `common.transparentWindow` `common.enableTrash` `common.playBarProgressStyle` `common.font` `common.isAgreePact` `common.enableDebug`（**8**）；④ 桌面专属播放项 `player.startupAutoPlay` `player.isShowStatusBarLyric` `player.isShowTitleLyric`（**3**）；⑤ **改由播放页即时控件承载**：`player.volume` `player.isMute` `player.playbackRate` `player.mediaDeviceId`（**4**） | 桌面/窗口/托盘专属（`playBarProgressStyle` 的 6 种变体已被固定 MiniPlayer 取代）；⑤ 的 4 项属于"正在播放时的即时调整"，放在设置页属于典型的桌面思路残留；① 的颜色类项由 15 套主题变量驱动，无需用户再配 |

**隐藏项的实现方式**：不删除 key（保持 `config.json` 与桌面版互通），只在移动端 `settings.ts` 里按 `import.meta.env.VITE_IS_ANDROID` 过滤掉对应 section/item。**这样跨设备同步配置文件不会丢数据。**

**二级页深度上限**：L1 → L2，**最多 2 层**。需要第 3 层的（如 WebDAV 同步）用 BottomSheet 完成，不再跳页。

---

## 5. 框架选型 ADR

### 5.1 决策

**ADR-M01：移动端 UI 采用「复用 view-main（Svelte 5 SPA）+ Android WebView 承载 + 原生桥」，UI 层做移动端布局重排（reflow），不做等比缩放。**

### 5.2 对比矩阵

评分 1（差）–5（优）。权重按本项目实测约束。

| 维度（权重） | A. 复用 Svelte + WebView + 重排（**选定**） | B. Flutter 重写 UI | C. Kotlin + Compose 全原生 | D. 复用 + 等比缩放（rootValue 缩放） |
|---|---|---|---|---|
| **复用度**（25%） | **5** — 250 个 `.svelte`、全部 `modules/*`（状态/RPC/播放/歌词）原样可用；仅改 20–25 个布局文件 | 2 — 只能复用 TS 业务逻辑（还需 FFI/JSON 桥），UI 0 复用 | 1 — 业务逻辑需经桥暴露，UI 全重写 | 5 |
| **触控体验上限**（20%） | **3.5** — WebView 滚动惯性/长列表可用（`VirtualizedList` 已实现虚拟化），但手势精细度、原生控件感不如原生；音频延时可接受（Web Audio 已在 WebView 内） | **4.5** — 接近原生，但音频仍需桥回 WebView 或用 `just_audio` 重写引擎 | **5** | 1 — 0.4 倍后正文 5.2px，**不可用** |
| **工期**（20%） | **4** — 重排 + 令牌 + 交互层，估 12–18 人日 | 2 — 重写 UI 层 60–90 人日 + 桥设计 | 1.5 — 100+ 人日 | 4.5 — 看似 3 人日，但返工风险 100% |
| **维护成本**（15%） | **4** — 与上游 any-listen 同构，未来可合并上游改动（AGPL 有利） | 2 — UI 双份维护 | 1 — 完全分叉 | 3 — 无法维护 |
| **与 Phase 2 架构契合**（20%） | **5** — Mode C 只需实现 `window.__anylisten_ipc_init__` 的 JS 侧桥（`view-main/src/shared/ipc/ipc.ts:14-49` 是唯一注入点），**完全不动 app 层调用代码** | 2 — 需重新定义 UI↔原生协议 | 2 — 同上，且要重写扩展宿主 API | 5 |
| **加权总分** | **4.35** | 2.50 | 2.10 | 3.80（但「触控体验上限」单项即否决） |

### 5.3 依据（按决定性排序）

1. **PDR-002（保留扩展生态）在原生方案下会引发"UI 层二次开发"的硬成本。** 扩展的 UI 由 manifest 的 `contributes.settings` **运行时 JSON** 决定（`shared/app/modules/worker/extensionService/internalExtension/extensions/webdav/index.ts:4-40` 的 `settings` 贡献点），由 `views/Setting/ExtensionSetting/*` 与 `views/Extenstion/*` 动态渲染。原生重写必须自研「通用 JSON Schema → 表单」渲染器，且要覆盖 `input/boolean/radio/selection/textarea/自定义 component` 六种控件与 `enum` 异步加载（`AppSetting/settings.ts:31-67` 的 `SettingListItem` 类型即完整契约）。**这一项单独就足以否决原生方案。**
2. **音频引擎是纯 Web 且已在 `view-main` 内**（`plugins/player/index.ts`，Web Audio + AudioWorklet + `pitch-shifter/`）——PDR-005 已定"优先复用"。若 UI 换原生，引擎要么跟着搬（失去复用意义），要么跨进程传 PCM（性能与复杂度都不可接受）。
3. **RPC 契约规模**：`ServerIPC` 约 900 行类型（Phase 1 §2.2）。复用 Svelte 意味着**这条契约一行不用改**（`shared/ipc/*` 已按 `invoke` 封装好），桥只需要提供一个 `sendMessage(data)` 传输实现。
4. **MediaSession 现成**：`modules/player/init/mediaSessionInfo.ts` 已完整绑定 play/pause/stop/seek/prev/next + 歌词进 title。Android 媒体通知是"把已有能力接到原生"而不是"新做功能"。
5. **重构面可枚举**：UI 侧真正需要动的文件约 20–25 个（见 §2.6 与 §5.6），而"原生重写"是 250 个组件的等价物。工作量比 ≈ 1:10。
6. **等比缩放的否决是数学的**：设计基准 1020px（`LyricPlayer.svelte:20`），411/1020 = 0.40。13px 正文 → 5.2px；44dp 目标 → 17.6dp。**规格无法通过缩放达成，只能重排。**

### 5.4 否决方案及理由

| 方案 | 否决理由 |
|---|---|
| **B. Flutter 重写** | ① UI 零复用，且需重写"扩展动态表单"；② 音频引擎要跨 Dart/原生/WebView 三处；③ 与 Phase 2 的 Mode C 桥设计冲突（Flutter 侧需再造一套 RPC 客户端）；④ 双份 UI 违反"移植"目标 |
| **C. Kotlin + Compose 全原生** | 同上，且工作量最大（100+ 人日）。**唯一优势是触控体验上限**，但本项目是个人自用（PDR-003），体验"够好"即可，不值得 5 倍工期 |
| **D. 复用 + 等比缩放** | 数学不可行（0.40 倍）；且会同时破坏触控目标（44dp→17.6dp）与可读性，直接违反本角色硬底线 |
| **Unity/Godot 嵌入** | 本项目无 2D/3D 渲染需求，不适用 |

### 5.5 CSS / 布局改造策略（供 Phase 4 直接执行）

**（1）基准值：保持 `rootValue: 16` 不变，禁止改 rootValue。**
理由：改 rootValue 等于整体缩放，会让 rem 与 `common.fontSize` 语义互相污染。**`1 CSS px = 1 dp`** 是本项目移动端所有尺寸换算的唯一约定。

**（2）`html` 字体基准与 `100dvh`（`src/app.less`）**

```less
html {
  height: 100dvh;              // 原 100vh（B-17）
  @supports not (height: 100dvh) { height: 100vh; }
}
html.web.fullscreen {          // 删除 min-width: 650px（B-01）
  min-width: 0;
  min-height: 0;
}
```
- `document.documentElement.style.fontSize` 仍由 `modules/setting/init.ts:50` 写入（默认 16px）。移动端额外在 `init.ts` 里对 `common.fontSize` 做 clamp：`Math.min(21, Math.max(13, fontSize))`，避免用户把桌面配置同步过来（如 24）导致整页炸开。

**（3）断点（新增 `src/assets/styles/mobile.less`）**

| 断点名 | 范围 | 判定依据 | 布局 |
|---|---|---|---|
| `compact` | `< 600px` | 手机竖屏（411dp 落此段） | 底栏 Tab + 单栏 + MiniPlayer |
| `medium` | `600–839px` | 手机横屏 / 小折叠展开 / 大折叠折叠态 | 保留底栏 Tab，内容区双栏（列表 + 详情） |
| `expanded` | `≥ 840px` | 平板 / 折叠展开 / 外接显示器 | 恢复接近桌面布局（Aside 变窄 240px + 底栏可保留） |

**折叠屏策略：只看视口宽度，不看设备类型。** 折叠/展开切换时监听 `resize`（`@media` 自动生效），`VirtualizedList` 已有 `handleResize`（`VirtualizedList.svelte:186-196`）。
**外接指针策略**：`@media (pointer: fine)` 恢复 hover 语义、显示自定义滚动条、Popup 弹层可用；`@media (hover: hover)` 包裹所有 `:hover` 规则（避免触屏 tap 触发 hover 态残留）。

**（4）落地顺序（务必按此序，否则会互相覆盖）**
1. 在 `main.ts` / 桥注入处给 `<html>` 加 `mobile` 类（原生壳检测最稳：`navigator.userAgent` 含 `AnyListenAndroid` 或桥注入 `window.__anylisten_platform__ === 'android'`）。
2. 引入 `mobile.less` 定义令牌 + 断点（`html.mobile` 与 `@media (max-width: 599px)` 双保险）。
3. `app.less` 修正（`100dvh`、删 `min-width`、`env(safe-area-inset-*)`、`-webkit-app-region` 在 `html.mobile` 下失效）。
4. `components/layout/index.svelte` 加 `{#if mobile}` 分支 → `MobileAppShell`。
5. 逐组件重排（按 §5.6 优先级）。
6. 交互层：`longPress` / `swipeDismiss` / `ActionSheet` 接入（替换 `oncontextmenu` / `sortable`）。
7. 清理 `line-height: Npx`（12 处）→ 改为无单位倍数或 `rem`，修复 `propList` 不含 `line-height` 的缩放错位。

### 5.6 组件级重排清单（按优先级，供 Phase 4 排期）

> **执行方式以 §9.3.2 为准**：下表的"文件"是逻辑归属，实际只有 4 个文件需要复制覆盖（O），其余是「一个全局 `mobile.less`（S）」或「新增文件（N）」。下表 P0 第 1–14 项中，除 `MusicList/List/index.svelte`（O-1）外**全部可走 S，无需复制源文件**。

**P0（不做则不可用）**

| # | 文件 | 动作 | 预估 |
|---|---|---|---|
| 1 | `assets/styles/mobile.less`（新增） | 令牌 + 断点 + `safe-area` + `hover` 包裹 | 0.5d |
| 2 | `app.less` | `100dvh`、删 `min-width:650px`、安全区、清理 `-webkit-app-region` | 0.2d |
| 3 | `components/layout/MobileAppShell.svelte`（新增） | AppBar + 内容 + MiniPlayer + TabBar 骨架 | 1d |
| 4 | `components/layout/index.svelte` + `App.svelte` | 注入 mobile 分支，Aside/Header/PlayBar 不挂载 | 0.3d |
| 5 | `components/layout/MobileTabBar.svelte`（新增） | 4 Tab，44dp 命中，safe-area | 0.5d |
| 6 | `components/layout/MiniPlayer.svelte`（新增） | 60dp，4 元素，点击展开 | 0.8d |
| 7 | `components/common/MusicList/List/ListItem.svelte` | 4 列 → 双行卡片，行高 72dp，`⋮` 常显 | 1d |
| 8 | `components/common/MusicList/List/Header.svelte` | 表头删除 → 多选条 | 0.5d |
| 9 | `components/material/BottomSheet.svelte` + `ActionSheet.svelte`（新增） | 通用底部弹层 | 1d |
| 10 | `components/common/MusicList/List/Menu.svelte` → ActionSheet | 12 项分组迁移 | 0.8d |
| 11 | `shared/compositions/longPress.svelte.ts`（新增） + `List/index.svelte` | 长按进多选；`oncontextmenu` 改为长按 | 0.8d |
| 12 | `components/layout/PlayDetail/{Main,LeftInfo,Footer}` | 50/50 → 纵向；footer 两行；字号 `clamp()` | 1.5d |
| 13 | `base/Btn.svelte` / `base/Tab.svelte` / `base/Checkbox.svelte` | 命中区 44dp | 0.8d |
| 14 | `common/PlayerProgressBar.svelte` + `base/SliderBar.svelte` | 触控带 44dp + thumb + 时间气泡 | 1d |
| 15 | `views/Library/Home.svelte`（新增） + `views/Library/index.svelte` | 歌单总览一级页；`/library` 无 id 时渲染 Home | 1.2d |
| 16 | `views/Search/index.svelte`（重写空壳） | 搜索输入页 + 结果页 | 1.5d |
| 17 | `views/Setting/index.svelte` + `Setting/mobile/*`（新增） | 两栏 → 两级 | 1.5d |
| 18 | `components/common/PlaylistBtn/index.svelte` | Popup(500×512) → 全屏队列页 | 0.8d |

P0 小计 ≈ **16.7 人日**

**P1（体验达标）**

| # | 文件 | 动作 |
|---|---|---|
| 19 | `views/Online/{index,Header,Search/Search}.svelte` | 三层 Tab → 横滚一级 + Segmented + 音源 BottomSheet |
| 20 | `views/Online/Songlist/list/Songlist.svelte` 等 3 处网格 | `minmax(300px)` → `minmax(150px)`（2 列） |
| 21 | `components/layout/Aside/Nav.svelte` + `Aside/MyList/*` → 歌单管理页 | 拖拽把手 + 批量删除 |
| 22 | `material/Modal.svelte` + `apis/{dialog,inputModal,updateModal}` | 底部卡片化，header 56dp，关闭 44dp |
| 23 | `apis/notify/*` | Toast → Snackbar（底部、可上滑关闭） |
| 24 | `views/Extenstion/*` | Tab 44dp + 网格 1–2 列 + 安装按钮常显（原 hover 显形） |
| 25 | `views/Setting/AppSetting/Hotkey/*` | 手机端隐藏整个分组 |
| 26 | `components/layout/PlayDetail/RightLyric/LyricPlayer.svelte` | `winRadio`（/1020）→ `clamp(12px, 4.6vw, 22px)`；点行跳转保留；长按 → ActionSheet |
| 27 | `base/Popup.svelte` / `material/PopupBtn.svelte` | `pointer: coarse` 下禁用，降级 ActionSheet |

P1 小计 ≈ **8 人日**

**P2（增强）**

| # | 项 | 说明 |
|---|---|---|
| 28 | 悬浮歌词（`SYSTEM_ALERT_WINDOW`） | 设置内引导 + 原生 overlay |
| 29 | 通知栏 RemoteViews 3 行歌词 | 节流 200ms，可在设置关闭 |
| 30 | MiniPlayer 左右滑切歌 | 需 G-05 主轴判定 |
| 31 | 双指捏合歌词字号 | 写回 `playDetail.style.fontSize` |
| 32 | 平板/折叠展开布局（`expanded` 断点） | 恢复 Aside + 双栏 |
| 33 | 触觉反馈策略细化 | 振动样式与开关 |

---

## 6. UI 可复用资产清单

| 资产 | 位置 | 规模 | 处置 | 理由 |
|---|---|---|---|---|
| **图标 SVG** | `view-main/src/assets/svgs/*.svg` | **87 个 / 59.9KB** | **全部复用**（`vite-plugin-svg-icons` sprite 已就绪，`components/layout/Icons.svelte` 注入） | 尺寸由 CSS 控制（`SvgIcon` + `.icon svg{width:100%}`），从 20dp 放大到 24dp 无质量损失 |
| ├ 底部 Tab 图标 | 复用 `music_library` `sound_cloud` `search` `settings` | 4/4 已存在 | **零新增** | — |
| ├ 需新增 | 无必须项 | — | 可选新增：`drag-handle`（拖拽把手，6 圆点）、`grabber`（弹层顶部横条）、`chevron-down`（可用 `angle-right-solid` 旋转替代） | 可先用 CSS/SVG 内联实现，避免动 sprite |
| **主题系统** | `shared/theme/index.json` | **15 套主题 / 251KB**，CSS 变量（`--color-primary-alpha-*` 等 200+ 变量） | **100% 复用** | 主题是纯 CSS 变量，与布局解耦；手机端只需新增令牌（`--touch-*`），**不新增主题** |
| ├ 主题背景图 | `shared/theme/theme_images/*` | 5 张 / **3.7MB**（1080p+ JPG/PNG） | **重绘（重新编码）** | 移动端需 1080×2400 竖版构图 + WebP，否则首屏解码 1.3MB 级图片会明显掉帧 |
| **字体** | `shared/web/fonts/Inter-*.ttf` | 2 个变量字体 / **1.78MB** | **适配（裁剪）** | Android 系统已有 Roboto/思源黑体；建议只保留 Inter **latin 子集 woff2**（或直接使用系统字体，`@shared/web/fonts` 作为可选）。理由：`font-list`（`desktop/src/shared/fontManage.ts`）在 Android 不可枚举系统字体（R-11），设置页「字体」项改为内置列表 |
| **i18n 文案** | `shared/i18n/langs/{zh-cn,zh-tw,en-us}.json` | **886 key × 3 语言 / 167KB（171,338 字节）** | **复用 + 新增约 28 条** | 新增：`mobile__tab_library/online/search/settings`、`mobile__notification_lyric`、`mobile__floating_lyric`、`mobile__battery_opt_guide`、`mobile__storage_permission`、`mobile__drag_handle`、`mobile__long_press_hint`、`mobile__select_all`、`mobile__exit_select`、`mobile__more_actions` 等 |
| **LESS 变量与 mixin** | `view-main/src/assets/styles/{variables,mixin,reset,index}.less` | 小 | **适配** | `@radius-border:4px` → 移动端 8–12px；`@transition-*` 保留；`reset.less` 的 `font-family` 分支（`.windows/.mac/.linux`）新增 `.android` 分支 |
| **音频滤镜素材** | `view-main/src/assets/medias/filters/*.wav` | 14 个卷积混响 IR | **复用** | 音效功能整体复用（搬入播放页「音效」面板） |
| **虚拟列表** | `components/base/VirtualizedList.svelte` | 1 个 | **复用** | 固定行高 + `overflow-y:auto`，触屏滚动天然可用；滚动中 `pointer-events:none` 恰好防误触。约束：行高必须统一（72dp），**不可做变高卡片** |
| **播放详情/歌词组件** | `PlayDetail/RightLyric/*`、`shared/web/lyric-font-player` | — | **复用 + 重排** | 逐字卡拉 OK 渲染逻辑不动，只改布局与字号算法 |
| **MediaSession 封装** | `modules/player/init/mediaSessionInfo.ts` | 200 行 | **复用（出口替换）** | 把 `navigator.mediaSession.*` 换成桥调用即可驱动原生媒体通知 |
| **命令总线** | `modules/command/*`、`playCmdAction.ts` | 8 个命令 | **复用** | 媒体键/通知按钮的触达点 |
| **`Btn` / `Input` / `Selection` / `Tab` 等基础组件** | `components/base/*` | 16 个 | **复用 + 调尺寸** | 尺寸由令牌驱动，不重写结构 |
| 桌面窗口 UI | `Header/ControlBtns*.svelte`、`-webkit-app-region` 相关 | — | **弃用** | 无窗口概念 |
| 桌面歌词 SPA | `packages/view-lyric/*` | 整个包 | **弃用（不打包）** | 见 §4.1 方案 C，双 WebView 不可接受 |

---

## 7. 阶段门禁自检

| # | 门禁项 | 结论 | 证据 / 说明 |
|---|---|---|---|
| 1 | **所有触控目标 ≥ 44×44dp** | ✅ 通过 | §3.2 逐组件校验 22 项全部给出达标尺寸；现状 15 处不达标已列明（B-09~B-14）。设计令牌 `--touch-min:44px` 为硬约束，Phase 5 用遍历脚本复核 |
| 2 | **相邻可点击元素间距 ≥ 8dp** | ✅ 通过 | `--gap-min:8px`；Tab 现 12/24px → 统一 8px 最小；列表内 `⋮` 与行内容间距 ≥ 8dp；底栏 4 Tab 均分（每项 ≈ 102dp，间距充足） |
| 3 | **所有鼠标精度依赖都有触控替代** | ✅ 通过 | 逐项替换表 23 行（§3.3）覆盖：hover(72) → 常显/长按；右键(34) → 长按 ActionSheet；sortable(Ctrl 门控) → 把手拖拽 + 专用页；多选(Ctrl/Shift) → 长按进多选；快捷键(8 命令) → 媒体键/通知；滚轮 → 滑块/步进器；tooltip(34 处) → 可见文本/长按提示；自定义滚动条 → 系统滚动 |
| 4 | **无「照搬桌面 UI」提案** | ✅ 通过 | 导航模型（Aside→底部 Tab）、播放条（72dp 11 元素→MiniPlayer+全屏页）、列表（4 列表格→双行卡片）、设置（左右两栏→两级）、在线（三层 Tab→横滚+Segmented）、播放详情（50/50→纵向）**全部结构性重排**。唯一"保留"的是主题、图标、文案、虚拟列表等技术资产，不是布局 |
| 5 | 触控目标 ≥44dp 的**反例检查** | ✅ 已显式列出 | `Btn.icon` 32dp、`Btn.min` 25.6dp、`Menu` 项 34px、`Tab` 30px、`ProgressBar` 5px、`SliderBar` 5px、`Checkbox` 14px、`SettingList` 36px、`Modal` header 18px、`CheckboxItem` 21px、`Pagination`、`SearchInput`、`PopupBtn` 25.6dp —— 全部列入 B-07~B-14 / §3.2 待修 |
| 6 | 手势冲突已消解 | ✅ 通过 | G-01~G-09 共 9 组冲突，逐组给出可执行方案（`touch-action`、主轴判定、物理分离、`visualViewport`） |
| 7 | 系统级适配（安全区/dvh/返回键） | ✅ 通过 | `env(safe-area-inset-*)`、`100dvh`、`onBackPressed` 栈式返回（B-17、§3.1） |
| 8 | 框架选型有依据、有否决 | ✅ 通过 | §5.2 加权矩阵 + §5.3 六条依据（含 PDR-002 动态表单这一决定性理由）+ §5.4 四个否决 |
| 9 | 资产处置明确到"复用/适配/重绘" | ✅ 通过 | §6 共 15 行，重绘项仅"主题背景图 5 张"，新增项仅"约 28 条文案 + 2 个可选图标" |
| 10 | 器件级可执行性 | ✅ 已闭合 | §9.3 给出「4 个 O 文件 + 1 个全局样式表 + 13 个新增文件 ≈ 18 文件 / 3.5–4.2k 行（占 view-main 46k 行的 9%）」，含 alias 片段与样式注入点；arch 5 问已逐条答复（§9.1–§9.5） |

**门禁结论：Phase 3 设计可以冻结。** 触控规格（§3）与框架选型（§5.1）**建议立即冻结**，Phase 4 可并行开工 P0 项 1–9（这些只依赖 CSS/布局，不依赖桥的实现）。

---

## 8. 与 arch 的对齐点 / 待冻结项

**已可冻结（本文件确定，Phase 4 直接执行）**
1. 触控设计令牌全表（§3.1）。
2. 底部 Tab 四分法 + MiniPlayer + 全屏播放页的导航模型（§2.1–2.4）。
3. 断点定义（compact <600 / medium 600–839 / expanded ≥840），**按视口宽度而非设备类型**（§5.5）。
4. 框架结论：复用 Svelte + WebView + 重排；**禁止改 `pxtorem.rootValue`**（§5.1、§5.5）。
5. 设置 133 项的可见/迁移/隐藏三分（§4.3：可见 55 / 迁移 17 / 隐藏或控件承载 61）——需产品侧确认"隐藏 61 项"是否可接受。
6. 桌面歌词 → 通知栏歌词（MediaSession）为主方案（§4.1）。

**依赖 arch（Phase 2）才能定稿**（★ = 已于 §9 回填闭合）
| 编号 | 依赖项 | 我需要 arch 提供什么 | 状态 |
|---|---|---|---|
| D-01 | 通知/媒体会话归属 | 媒体会话由**原生持有**（arch 已确认走 `MediaSessionPort` + `NotificationPort`）；桥签名见 arch §4.6 | ★ **已闭合**，落地路径见 §4.1，排版上限见 §9.2 |
| D-02 | 后台播放保活 | 前台服务类型、AudioFocus 策略、锁屏控制 | ★ 已闭合（`foregroundServiceType="mediaPlayback"` + `AudioFocus`）；待 A-01 真机结论回填 `backgroundAudio` 能力位 |
| D-03 | 文件访问（SAF） | `ServerIPC.fileSystemAction` / `fs` 语义映射 | ⏳ 仍需 arch（影响流程 C 与「存储与缓存」分组的加载态，不影响布局） |
| D-04 | 本地音乐播放 URL | `file://` / `/p_static` 的替代 | ⏳ 仍需 arch（不影响布局，只影响「本地」入口加载态与错误文案） |
| D-05 | 扩展宿主 | `contributes.settings` JSON 结构是否与桌面完全一致 | ⏳ 仍需 arch（决定「设置 › 扩展」能否 100% 复用 `ExtensionSetting/*`） |
| D-06 | 桥的注入时机 | `window.__anylisten_ipc_init__` 何时注入；`html.mobile` / `VITE_IS_ANDROID` 判定 | ★ 已定方案：`entries/main.ts` 是我们自己的文件，直接 mount `ui/MobileApp.svelte` 并 `import './ui/mobile.less'`（§9.3.4），**不依赖注入时机** |
| D-07 | 返回键路由 | 需 JS 暴露 `canGoBack()/goBack()` | ⏳ 仍需 arch |
| D-08 | WebView 长按是否派发 `contextmenu` | 保持 WebView 默认长按行为（不设 `setOnLongClickListener` / `isLongClickable=false`） | ⏳ **关键**：这是"一个 CSS 改造 34 处右键菜单"的前提（§9.3.1 杠杆 2、§9.7-1） |
| D-09 | WebView `textZoom` 必须为 100% | `setTextZoom(100)` + `setSupportZoom(false)` | ⏳ **硬要求**：非 100 时 `rem`/`dp` 约定失准，44dp 目标被二次放大破坏（§9.7-2） |
| D-10 | 音效能力位补 4 个 | `pitchShifter` / `playbackRateRange` / `supportsPreservesPitch` / `convolverIrLoadable` | ⏳ 需 arch 在 `getCapabilities()` 里加（§9.5） |

**需要与 team-lead / 产品确认的取舍**
- Q-01：设置隐藏 61 项（含 `desktopLyric.*` 44 项、`player.soundEffect.*` 之外的桌面播放项）是否接受？（本文件按"隐藏但不删 key"设计，配置可跨端互通）
- Q-02：~~悬浮歌词是否列入 MVP~~ → **已关闭**：按 arch 结论不做（§4.1、§9.6）。R-05 从 [高] 降 [低]。
- Q-03：平板/折叠屏 `expanded` 断点是否在 MVP 范围？（本文件定为 P2-32）

---

## 9. 与 Phase 2 架构的接口回填（arch 5 问的答复）

> 来源：arch-engineer 2026-11-02 消息。约束前提：**构建方案不修改 `source/`**，UI 改动只能通过 vite alias 覆盖单个 `.svelte`（`porting/js/host/ui-overrides/`）。本章据此**重写 §2.6 / §5.6 的"改造方式"**，结论以本章为准。

### 9.0 先纠正一个会误导后续实现的前提

arch 消息第 4 点说"现有 px 会自动缩放（pxtorem 已启用）"——**这个判断不成立，实现时若照此假设会做出错误的尺寸决策**：

- `vite.config.js:159` `rootValue: 16`；
- `modules/setting/init.ts:50` `document.documentElement.style.fontSize = ${setting['common.fontSize']}px`，`common.fontSize` 默认 **16**（`shared/common/defaultSetting.ts:5`）。

`postcss-pxtorem` 做的是 `13px → 13/16 rem = 0.8125rem`；浏览器把 `0.8125rem` 按 `html{font-size:16px}` 解析回 `13px`。**两端一致 = 恒等变换，视觉上完全没有缩放。** `pxtorem` 只带来两个副作用：① 所有尺寸变成"可被 `html{font-size}` 整体倍率的量"；② `line-height` 不在 `propList` 里，不参与倍率。

**设计基准**同样不是 411dp，而是 **1020px 宽**（`PlayDetail/RightLyric/LyricPlayer.svelte:20`：`winRadio = document.getElementById('root').clientWidth / 1020`）。所以 411dp = 设计基准的 **40%**，**必须重排，不能缩放**。

> 对你的 D2/D5 无影响，但请不要再把"A-09 已通过 pxtorem 缓解"写进结论——真实结论是"信息密度在 411dp 下不可接受，需要重排"（§1.4 给了 20 个崩坏点，全部量化）。

### 9.1 歌词视图样式设置的最小集合

**决策：`desktopLyric.*` 44 项（你记 45，多出的是源码里被注释掉的 `desktopLyric.style.ellipsis`）→ 迁移 0 项，全部丢弃。应用内歌词页复用 `playDetail.*` 5 项 + 新增 1 项。**

理由：应用内歌词页**就是** `PlayDetail/RightLyric/LyricPlayer.svelte`，它已经在读 `playDetail.*`；而桌面歌词窗的样式项与 `playDetail.*` 语义重复（字号/对齐/字重/高亮放大各有一份）。颜色类（`lyricPlayedColor`/`lyricUnplayColor`/`lyricShadowColor`）在移动端**由主题变量驱动**（`LyricPlayer.svelte` 里 `@unplay-color: var(--color-300)`、`@played-color: var(--color-primary-dark-100)`），15 套主题自动生效，不需要用户再配一遍。字体族必须丢（R-11：Android 无法枚举系统字体）。几何类（`classic.x/y/widthByFontNum`、`multiLine.width/height/x/y/direction/scrollAlign/alignX`）无窗口即无意义。`mode`（单行/多行）语义由"通知栏 1 行 + 应用内多行"覆盖，不需要设置项。

**必选 6 项（冻结）**

| # | 键 | 来源 | 移动端默认 | 取值范围/形态 | 控件 | 层级 |
|---|---|---|---|---|---|---|
| L-1 | `playDetail.style.fontSize` | **复用**（语义改） | **100** | 60–140，步进 5 | 滑块（44dp 触控带）+ 实时预览 | 歌词页 `⋮` → 歌词设置 |
| L-2 | `playDetail.style.align` | 复用 | **`center`**（桌面默认 `left`） | left/center/right | 三选 Segmented（44dp） | 同上 |
| L-3 | `playDetail.style.fontWeight` | 复用 | `false` | 开关 | 整行 56dp | 同上 |
| L-4 | `playDetail.isZoomActiveLrc` | 复用 | `true` | 开关 | 同上 | 同上 |
| L-5 | `playDetail.isDelayScroll` | 复用 | `false` | 开关 | 同上 | 同上 |
| L-6 | `lyricView.style.lineGap` | **新增** | `10` | 4–24 | 滑块 | 同上 |

**P2 可选 2 项（默认跟随主题，不增加必选路径）**

| # | 键 | 默认 | 说明 |
|---|---|---|---|
| L-7 | `lyricView.style.playedColor` | `''`（空 = 跟随 `--color-primary-dark-100`） | 取色器 |
| L-8 | `lyricView.style.unplayColor` | `''`（空 = 跟随 `--color-300`） | 取色器 |

**`fontSize` 语义改写（实现方注意）**：桌面是"1020 基准下的相对百分比"，`(80/100+0.8)*winRadio` rem；移动端改为"屏宽自适应百分比"，公式：

```css
/* 411dp 屏 → 14 + 1.2vw ≈ 18.9px；pct=140 → 26.5px；pct=60 → 11.3px */
html.mobile .lyric { font-size: calc((14px + 1.2vw) * (var(--lrc-pct) / 100)); }
```
`--lrc-pct` 由 `playDetail.style.fontSize` 注入（`LyricPlayer.svelte` 现有的 `style={styles}` 会被覆盖为 `--lrc-pct: N`，走 §9.3 的 S 方式或对 `LyricPlayer.svelte` 做 1 文件 O，见下）。

**迁移动作**：`desktopLyric.*` 44 项 → 读取时忽略（`defaultSetting` 已有默认值，无需兜底代码）；`playDetail.style.fontSize` 若从桌面配置带入 80，**不要映射**，直接重置为 100（桌面 80 对 1020 基准有意义，对 411dp 无意义）。**§5.4 第三类可以从"改语义保留 12 项"简化为"丢弃 44 项 + 新增 1 项"。**

### 9.2 通知栏歌词排版上限（`NotificationPort.postMedia` 参数）

| 项 | 决策 | 依据 |
|---|---|---|
| **折叠态行数** | **1 行** | MediaStyle 折叠态文本区实测约 1 行（title 下方），叠 3 个 action button 后总高 92dp 左右；HyperOS 会在折叠态直接裁掉第 2 行 |
| **展开态行数** | **2 行**（当前行 + 下一行） | 展开后 actions 行 + 进度条会挤压文本区；**3 行在 HyperOS / One UI 上大概率被裁**，且 250ms 级刷新 3 个 TextView 的 RemoteViews 重绘会明显掉帧 |
| **超长处理** | **尾部省略号，不滚动** | `TextUtils.TruncateAt.END`。不用 marquee：MediaStyle 的 RemoteViews 里 marquee 在部分 ROM 不生效，生效时也持续重绘耗电 |
| **字数预算** | 中文 **≤14 全角字/行**，英文 **≤30 字符** | 411dp 通知内容区宽约 300dp，13sp 中文 ≈ 16 字；取 14 作为设计预算，**但 JS 侧不要预截断**，交给 `TruncateAt.END`（中英混排按字符数算会算错） |
| **更新频率** | **≤4Hz（250ms 节流）** | 歌词是行级变化（3–5s/行），4Hz 足够；逐字卡拉 OK **只在应用内做**，通知栏不做 |
| **无歌词时** | `lyricLine` 传 `null`/空 → 回落为「歌名」/「歌手」 | 与现有 `updateMediaSessionInfo()` 的回落逻辑一致（`mediaSessionInfo.ts:33-47`） |

**接口建议（字段只增不改）**

```ts
postMedia(n: {
  // ...现有字段
  lyricLine?: string      // 保留：当前行（折叠态第 1 行 / 展开态第 1 行）
  lyricNext?: string      // 新增：下一行（仅展开态第 2 行使用，折叠态忽略）
  lyricEnabled?: boolean  // 新增：对应 player.isShowMediaSessionLyric，false 时 Android 侧不渲染歌词位
})
```
**折叠态行 2 = 歌名 · 歌手**（`setSubText` / `setContentInfo`），歌词只占行 1 —— 这样"谁在唱什么"和"唱到哪"同时可读，也是网易云/QQ音乐的通行做法。

### 9.3 触控重写范围：页面清单 + 覆盖方式

**先给方法结论：不需要整页重写。最终只需覆盖 3 个 `.svelte` 文件（约 420 行），其余全部靠「1 个全局样式表 + 13 个新文件」。**

#### 9.3.1 三个关键杠杆（这是能把 533 文件压到 3 个的原因）

**杠杆 1：外壳不进 `AppLayout`，而是我们自己的入口直接 mount 新的 `MobileApp.svelte`**
`porting/js/entries/main.ts` 是我们自己的文件（不走 alias），把它里面的 `import App from './App.svelte'` 换成 `import App from './ui/MobileApp.svelte'`，即可**完全不渲染 `components/layout/index.svelte`**（Aside / Header / PlayBar / PlayDetail 一起消失），`MobileApp.svelte` 内部按需渲染 `<Icons/>` + `<MobileAppShell>`（内含 `<Main/>` 路由 + `<MiniPlayer/>` + `<MobileTabBar/>`）+ `<PlayDetail/>`。
→ **省掉 `App.svelte`(43) + `layout/index.svelte`(52) + `PlayBar/index.svelte`(25) 三个覆盖文件。**

**杠杆 2：弹层靠 CSS `!important` 改造成 BottomSheet，不覆盖组件**
所有右键菜单（34 处）最终都渲染 `components/base/Menu.svelte` 的 `class="menu"`；所有 hover 弹层渲染 `base/Popup.svelte` 的 `class="popup"`；`material/Dropdown.svelte` 也是 `class="menu"`。它们的定位是**内联 style**（`menuLocaltion`/`cmpStyle` 写 `dom.style.left/top`），因此全局样式必须用 `!important` 覆盖：

```css
/* 一行覆盖 34 处右键菜单 + 全部 Dropdown；inline style 需 !important */
html.mobile .menu {
  position: fixed !important;
  inset: auto 0 0 0 !important;          /* 贴底 */
  left: 0 !important; top: auto !important;
  width: auto !important; max-width: none !important;
  max-height: 60dvh; overflow-y: auto;
  margin: 0 !important;
  border-radius: 16px 16px 0 0 !important;
  transform: none !important;            /* 干掉 scale(0) 与 translate 修正 */
  opacity: 1 !important;
  padding-bottom: max(8px, env(safe-area-inset-bottom));
  z-index: 20 !important;
}
/* scrim：fixed 子元素 + 负 z-index 可覆盖整个视口 */
html.mobile .menu::before {
  content: ''; position: fixed; inset: 0; z-index: -1;
  background: rgb(0 0 0 / 40%);
}
html.mobile .menu .menu-item {
  min-height: 56px !important; line-height: 56px !important;
  font-size: 15px !important; padding: 0 24px !important; min-width: 0 !important;
}
```
→ **省掉 `base/Menu.svelte`(177) 覆盖**；`VolumeBtn` / `PlaylistBtn` / `PlaybackRateBtn` / `DesktopLyricBtn` 的弹层同理（再给 `.popup` 一份同样的规则）。
⚠ 边界：`PlaylistBtn` 的 `.container{width:500px}` 要额外 `html.mobile .popup .container{width:100%!important;min-height:0!important}`；`LyricMenu`(`class="container"`) 用 `html.mobile #root > .container` 定向，若与其他 Portal 冲突则退回 **1 文件 O**（60 行）。

**杠杆 3：列表「4 列 → 双行卡片」用 CSS Grid 重排，不改 DOM**
`ListItem.svelte` 的 5 个子元素是**同级 flex 子项**（`.pic` / `.name-cell` / singer / album / time），因此可以在父容器上切 `display:grid` 做视觉重排，无需改结构：

```css
html.mobile .my-list .container {
  display: grid !important;
  grid-template-columns: 48px 1fr auto;
  grid-template-rows: auto auto;
  grid-template-areas: "pic name side" "pic singer side";
  align-items: center; gap: 0 12px;
  height: 72px !important; padding: 8px 12px !important;
}
html.mobile .my-list .container > .pic        { grid-area: pic; width: 48px !important; height: 48px !important; }
html.mobile .my-list .container > .name-cell  { grid-area: name; }
html.mobile .my-list .container > .list-item-cell:nth-child(3) { grid-area: singer; font-size: 12px; opacity: .7; }
html.mobile .my-list .container > .list-item-cell:nth-child(4) { display: none; }  /* 专辑列隐藏 */
html.mobile .my-list .container > .list-item-cell:nth-child(5) { grid-area: side; font-size: 11px; } /* 时长移到右侧 */
html.mobile .my-list .header { display: none; }   /* 表头整体隐藏 */
html.mobile .my-list .name-right { opacity: 1 !important; }  /* 收藏/播放按钮常显，不再 hover 显形 */
```
→ **省掉 `ListItem.svelte`(366) + `List/Header.svelte`(68) 覆盖**。
约束：`VirtualizedList` 用**固定行高**（`VirtualizedList.svelte:70` 生成 `height:${itemheight}px`），上表 72px 必须与 `useListItemHeight()` 的输出一致 → 由 `common.fontSize`（16）× 系数控制。**移动端系数取 4.5**（16×4.5=72），桌面是 3.2（16×3.2=52，`List/index.svelte:47`）。这需要一次 JS 改动，见下 O-1。

#### 9.3.2 最终覆盖清单

**S = 全局样式（`porting/js/ui/mobile.less`，0 个 .svelte）· O = 整文件覆盖（vite alias）· N = 新增文件（不覆盖）**

| # | 页面/区域 | 源文件 | 方式 | 覆盖文件 / 实现位置 | 行数 | 说明 |
|---|---|---|---|---|---|---|
| O-1 | 歌曲列表交互 | `components/common/MusicList/List/index.svelte` | **O** | `ui-overrides/MusicList.List.index.svelte` | 238 | ① 长按进多选（`pointerdown` 500ms + 位移>8px 取消 + `vibrate(10)`，长按后抑制紧随的 `click` 防止误播）；② 行高系数 3.2→4.5；③ 多选态渲染底部操作条（替代 `List/Header.svelte` 的复选框行）。**必须改 JS，CSS 无法表达状态变化** |
| O-2 | 曲库首页 | `views/Library/index.svelte` | **O** | `ui-overrides/Library.index.svelte` | 179 | `/library` 无 `id` 时（桌面会 `replace` 到上次列表）改为渲染 `Library/Home.svelte`（歌单总览）；有 `id` 时原逻辑不变 |
| O-3 | 搜索页 | `views/Search/index.svelte` | **O**（等同新建） | `ui-overrides/Search.index.svelte` | **5**（原空壳） | 原文件仅 `hello search`，覆盖成本≈新建。承载搜索输入页 + 结果页 |
| O-4 | 歌词字号公式 | `components/layout/PlayDetail/RightLyric/LyricPlayer.svelte` | **O**（可选） | `ui-overrides/LyricPlayer.svelte` | 约 200 | 把 `winRadio = w/1020` 换成 `--lrc-pct`；若放弃 L-1 字号可调则此项可省。**建议做**，否则歌词在 411dp 上只有 10px |
| S-1 | 触控目标放大 | `Btn` / `Tab` / `Checkbox` / `PopupBtn` / `Menu` / `SliderBar` / `ProgressBar` / `Modal` / `CheckboxItem` 等 | **S** | `mobile.less` | 0 | 全部用 `html.mobile .<class>` 前缀 + 必要的 `!important`（内联 style 场景） |
| S-2 | 弹层 → BottomSheet | `base/Menu` / `base/Popup` / `material/Dropdown` | **S** | `mobile.less` | 0 | 见 §9.3.1 杠杆 2 |
| S-3 | 歌曲列表 4 列 → 双行 | `List/ListItem` + `List/Header` | **S** | `mobile.less` | 0 | 见 §9.3.1 杠杆 3 |
| S-4 | 设置两栏 → 单栏 | `views/Setting/index.svelte` + `AppSetting/SettingList.svelte` | **S** | `mobile.less` | 0 | 左栏 `width:18%` → `position:sticky; display:flex; overflow-x:auto` 的 chip 条（44dp 高）；右栏 `width:100%` |
| S-5 | 在线三层 Tab | `views/Online/{index,Header,Search/Search}.svelte` | **S** | `mobile.less` | 0 | Tab 容器 `overflow-x:auto; scroll-snap-type:x mandatory`，项高 44dp、`gap:8px`；`#online-header-right` 的 Portal Tab 降级为同一行内横滚 |
| S-6 | 卡片网格 1 列 | `Online/Songlist/list/Songlist`、`TopSongs/list`、`Extenstion/*List` | **S** | `mobile.less` | 0 | `minmax(300px,1fr)` → `minmax(150px,1fr)`（2 列）；`gap:16px→12px` |
| S-7 | 播放详情 50/50 → 纵向 | `PlayDetail/{Main,LeftInfo,Footer}` | **S** | `mobile.less` | 0 | `flex-direction:column`；`LeftInfo width:50%→100%`、封面 `height:42dvh`；`Footer height:100px→152px` + 两行排布 |
| S-8 | 桌面专属元素隐藏 | `Header/ControlBtns*`、`-webkit-app-region`、`Aside`、`ProgressBar` 滚动条 | **S** | `mobile.less` + `app.less` 覆盖 | 0 | `display:none`；滚动条 `pointer:coarse` 下不注入 |
| S-9 | 安全区 / `100dvh` / 删除 `min-width:650px` | `app.less` | **S** | `mobile.less`（`html.mobile` 前缀可覆盖，`#root` 用 `html.mobile #root` 稳赢 Svelte 作用域 `#root.svelte-x`） | 0 | — |
| N-1 | 移动外壳 | 新增 | **N** | `porting/js/ui/MobileApp.svelte` | — | `<Icons/>` + `<MobileAppShell/>` + `<PlayDetail/>`，被 `entries/main.ts` mount |
| N-2..N-13 | Shell / TabBar / AppBar / MiniPlayer / BottomSheet / ActionSheet / Library·Home / Search 页体 / Setting L1 / Setting L2 / longPress / swipeDismiss | 新增 | **N** | `porting/js/ui/**` | — | 见 §2.6 |

**工作量对照（回应"533 文件 / 46k 行"的担忧）**

| 项 | 数量 | 说明 |
|---|---|---|
| 需要读并复制的源文件 | **4**（O-1..O-4） | 合计约 **620 行**源文件（238+179+5+200），改写后估计 +35% = 837 行 |
| 全局样式表 | **1** 个（`mobile.less`，估 700–900 行） | 覆盖 §1.4 的 20 个崩坏点中的 17 个 |
| 新增文件 | **13** 个（估 2,000–2,600 行） | 全部是新写，无上游耦合 |
| **合计新增/改动** | **≈ 18 个文件 / 3,500–4,200 行** | 占 `view-main` 46k 行的 **约 9%** |

#### 9.3.3 你需要在 alias 里加的两条（当前 alias 列表缺 `@/` 前缀映射）

`view-main` 内部全部用 `@/xxx` 引用（`vite.config.js:57-60` 的 `'@'` alias）。你当前的 alias 只有 `view-main/(.*)`，**没有 `@/`**，SPA 内部 import 会全部解析失败。建议（**specific 在前，顺序不能反**）：

```js
// ① UI 覆盖优先（放在最前）
{ find: /^@\/components\/common\/MusicList\/List\/index\.svelte$/,
  replacement: path.resolve('porting/js/ui/overrides/MusicList.List.index.svelte') },
{ find: /^@\/views\/Library\/index\.svelte$/,
  replacement: path.resolve('porting/js/ui/overrides/Library.index.svelte') },
{ find: /^@\/views\/Search\/index\.svelte$/,
  replacement: path.resolve('porting/js/ui/overrides/Search.index.svelte') },
{ find: /^@\/components\/layout\/PlayDetail\/RightLyric\/LyricPlayer\.svelte$/,
  replacement: path.resolve('porting/js/ui/overrides/LyricPlayer.svelte') },
// ② 基础映射（放在覆盖之后）
{ find: /^@\/(.*)$/, replacement: `${SRC}/view-main/src/$1` },
```
另需 `virtual:svg-icons-register`（`vite-plugin-svg-icons`，图标目录 `${SRC}/view-main/src/assets/svgs`）——覆盖版组件用 `SvgIcon` 时依赖它，请确认插件已挂。

#### 9.3.4 全局样式注入点（零侵入）

`main.ts` 里 `import './app.less'` 是**相对路径**，alias 拦不到。既然 `entries/main.ts` 是我们自己的文件，直接追加一行即可：

```ts
// porting/js/entries/main.ts
import { mount } from 'svelte'
import 'virtual:svg-icons-register'
import MobileApp from './ui/MobileApp.svelte'
import './ui/mobile.less'        // ← 我们的全局覆盖表，必须在 view-main 样式之后
// 注意：不要 import view-main 的 main.ts（它会 mount 桌面版 App）
mount(MobileApp, { target: document.getElementById('root')! })
```
但 `app.less` 仍需生效（reset / `#root` 背景 / `@layer reset` / 主题变量挂载）——二选一：① `import `${SRC}/view-main/src/app.less``（路径别名或相对路径均可，Vite 允许）；② `mobile.less` 里 `@import` 它。**推荐 ①**，保持上游样式与我们的覆盖分离。

### 9.4 411dp 信息密度结论与字号默认值（A-09 正式答复）

**信息密度结论：不可接受，必须重排。** 量化依据（§1.4）：歌名列在 411dp 下仅剩约 **140px ≈ 8 个汉字**（4 列表格 + 22%/22%/9% 固定占比）；图标按钮 32dp / 25.6dp；设置导航行高 36px；播放条 72dp 内塞 11 个元素。

**最小触控目标：44×44dp**（411dp 宽 ≈ 68mm，44dp ≈ 7.3mm、48dp ≈ 8mm，均满足指尖 7–9mm 的经验下限）。相邻可点元素间距 **≥8dp**。

**必须放大的控件（12 项，全部走 S）**

| 控件 | 源文件:行 | 现状 | 目标 |
|---|---|---|---|
| 图标按钮 `.btn.icon` | `base/Btn.svelte:113` | 32dp | 44dp（svg 24dp + padding 10dp） |
| 小图标按钮 `.btn.icon.min` | `base/Btn.svelte:122` | 25.6dp | 44dp |
| 小按钮 `.btn.min` | `base/Btn.svelte:138` | 高 ≈19dp | 44dp，`font-size:13px`，`padding:0 16px` |
| 弹层按钮 `PopupBtn` | `material/PopupBtn.svelte:122` | 25.6dp | 44dp |
| Tab 项 | `base/Tab.svelte:152` | 高 ≈30dp | 44dp，`gap:8px` |
| 菜单项 | `base/Menu.svelte:145` | 34px | 56dp |
| 复选框方框 | `base/Checkbox.svelte:111` | 14dp（视觉） | 20dp 视觉 + 整行 56dp 可点 |
| 进度条 | `common/PlayerProgressBar.svelte:114` | 5px | 44dp 触控带 + 16dp thumb |
| 滑块 | `base/SliderBar.svelte:168,188` | 宽 100px / 高 5px | 宽 = 屏-64dp；44dp 触控带 + 16dp thumb |
| 设置项行 | `AppSetting/SettingList.svelte:69` | 36px | 56dp |
| 弹窗关闭按钮 | `material/Modal.svelte:232,245` | 18×25dp | 44dp（header 56dp） |
| 分页/搜索输入 | `material/Pagination.svelte` / `SearchInput.svelte` | 见文件 | ≥44dp |

**字号与相关默认值（正式冻结）**

| 设置项 | 桌面默认 | **移动默认** | 理由 |
|---|---|---|---|
| `common.fontSize` | 16 | **16（不变）** | 它就是"1 CSS px = 1 dp"的基准；改它 = 全局缩放，会把 44dp 目标一起缩放掉。**仅做 clamp 13–21** 防止桌面配置同步过来炸版 |
| `common.langId` | null(跟随系统) | 不变 | — |
| `playDetail.style.fontSize` | 80 | **100**（语义改为屏宽百分比，见 §9.1） | — |
| `playDetail.style.align` | `left` | **`center`** | 小屏歌词居中更易读（桌面左对齐是为配合 50% 左栏封面） |
| `playDetail.coverStyle` | `cd` | **`square`** | 旋转 CD 在 411dp 上信息量低，且持续 `transform` 动画在 WebView 上是无谓的合成层开销（A-01 音频链路已够紧张） |
| `playDetail.isDynamicBackground` | true | **false** | 动态背景 = 全屏 `backdrop-filter: blur(30px)`（`PlayDetail/index.svelte:133`），在 WebView 上是**最贵的一帧**；移动端默认关，设置里可开 |
| `player.playbackRate` / `volume` | 1 / 1 | 不变 | — |
| `common.playBarProgressStyle` | `centerControl` | **固定 `mini`**（隐藏该设置项） | 6 种播放条变体在手机只保留 1 种（MiniPlayer） |
| `list.isShowActionBtn` | true | 不变（但改为常显，不再 hover） | — |

### 9.5 音效面板呈现方式

**决策：BottomSheet 内「预设 chips + 4 个折叠组（Accordion）」，EQ 用 3 段 Tab 分组横滑块。不单页平铺，不单独占一个设置分组。**

```
播放页 🎛 音效 → BottomSheet（max-height 80dvh，可滚动）
┌ ▁▁▁ 音效                          [关闭全部] ┐   顶部 grabber + 标题 56dp
│ 预设  [关闭][流行][摇滚][古典][人声][自定义]  │   横滚 chips，44dp
├──────────────────────────────────────────────┤
│ ▸ 均衡器                            已启用  › │   折叠标题行 56dp
│   （展开后）[低频][中频][高频] ← Segmented 44dp│
│    31Hz  ─────●──────  0 dB                   │   每组 3–4 条横滑块
│    62Hz  ───────●────  0 dB                   │   触控带 44dp，值右侧 56dp 宽
│   125Hz  ────●───────  0 dB                   │
│   250Hz  ─────────●──  0 dB                   │
├──────────────────────────────────────────────┤
│ ▸ 卷积混响                          已关闭  › │
│   （展开后）音源 [客厅 ▾]（→ ActionSheet）      │   14 个内置 IR（assets/medias/filters/*.wav）
│    主增益  ────────●─ +10 dB                  │
│    发送增益 ──●───────   0 dB                  │
├──────────────────────────────────────────────┤
│ ▸ 3D 环绕                           已关闭  › │
│    开关 / 转速 ──●──── / 声场 ────●──          │
├──────────────────────────────────────────────┤
│ ▸ 变调                              已关闭  › │
│    速率 ────●──── 1.00× / 保持音高 [● ]        │
└──────────────────────────────────────────────┘
```

**为什么不是竖排 10 段 EQ**：411dp 屏上 10 条竖滑块每条仅 24dp 宽（<44dp 命中），且中文 Hz 标签必需 9sp 才放得下。分 3 Tab 后每条横滑块可占满 `屏-64dp` 宽，精度与命中同时达标。

**17 项设置项 → 面板控件映射（功能 100% 保留，不做设置项迁移，只搬 UI 入口）**

| 折叠组 | 覆盖的 `player.soundEffect.*`（17 项） |
|---|---|
| 均衡器 | `biquadFilter.hz31/62/125/250/500/1000/2000/4000/8000/16000`（10） |
| 卷积混响 | `convolution.fileName` / `convolution.mainGain` / `convolution.sendGain`（3） |
| 3D 环绕 | `panner.enable` / `panner.soundR` / `panner.speed`（3） |
| 变调 | `pitchShifter.playbackRate`（1） |

→ 对 arch 的影响：**不需要为这 17 项做"设置项分组迁移"**，它们仍留在 `config.json` 原位置，只是 UI 入口从「设置页」搬到「播放页 BottomSheet」。`settings.ts` 里对应的 section 在移动端过滤掉即可。

**能力位驱动（配合你的 `getCapabilities()`）**

- 不支持时**置灰 + 一行灰字说明**，不要整块消失（消失会让用户以为功能被砍）。整组不可用 → 折叠组标题右侧显示「设备不支持」并禁用展开。
- 我需要你**再加 4 个能力位**（现有 8 个不够精确）：
  1. `pitchShifter: boolean` —— `audioWorklet === true` 不代表 pitch-shifter 的 AudioWorklet 模块加载成功（它加载的是 `ola-processor.js`/`phase-vocoder.js`，失败是静默的）；`engine === 'native'` 时恒 false。
  2. `playbackRateRange: [number, number]` —— 决定变速滑块范围（WebView 常见 0.5–2.0，原生可能 0.25–4.0）。缺省按 `[0.5, 2]` 处理。
  3. `supportsPreservesPitch: boolean` —— 决定"保持音高"开关是否可见（HTMLMediaElement 的 `preservesPitch` 在 Android WebView 上行为不完全一致）。
  4. `convolverIrLoadable: boolean` —— 14 个 IR 是 `assets` 里的 wav（最大 `matrix-reverb2.wav` 需确认体积），能否加载决定"音源"下拉是否可见；与 `maxConvolverIrBytes` 配合筛选可选项。
- `setSinkId === false` → 隐藏 `player.mediaDeviceId` 与 `player.isMediaDeviceChangedPausePlay`（这 2 项在我 §4.3 里本来就在"隐藏 61 项"里，正好闭环）。
- `backgroundAudio !== 'ok'` → 设置页「后台与通知」分组顶部显示一条黄色提示「当前设备后台播放可能被系统中断」，**不要**因此禁用播放功能。

### 9.6 我这边因你的结论而修订的 3 处

| 修订 | 原设计 | 现设计 | 影响 |
|---|---|---|---|
| 悬浮歌词窗 | P2 可选（`SYSTEM_ALERT_WINDOW`） | **不做**（接受你的结论） | §4.1 从"三方案对比"收敛为"方案 A 单点"；R-05 从 [高]→[低]（无需任何特殊权限）；`:app` 不需要 `WindowManager` 模块。**诚实的代价**：丢失"跨应用置顶看歌词"这一桌面独有能力，Android 侧等价位只有"通知栏歌词（任意界面可见但仅 1 行）"。这是形态差异，不是能力缺失，可接受 |
| `desktopLyric.*` 处置 | 隐藏 44 项（保留 key 以备互通） | **丢弃 44 项 + 新增 1 项 `lyricView.style.lineGap`**；`playDetail.*` 复用 5 项 | §5.4 第三类从"改语义保留 12 项"简化为"丢弃 44 + 新增 1"，你的迁移代码量下降 |
| 设置三项可见性 | 「后台与通知」分组含"悬浮歌词开关" | 该分组只保留：通知栏歌词（↔ `player.isShowMediaSessionLyric`）、电池优化白名单引导、音频焦点策略、锁屏控制 | — |

### 9.7 还需你确认的 2 件小事

1. **`contextmenu` 在 Android WebView 上是否正常派发**（长按 ~500ms）。这是 §9.3.1 杠杆 2 的前提——若你的 `MainActivity` 给 WebView 设了 `setOnLongClickListener` 或 `isLongClickable=false`，34 处右键菜单就全部失效，我必须退回"在 O-1 里用 Pointer Events 自实现长按并手动调 `menu.show()`"。**建议你保持 WebView 默认长按行为**（不要拦截），并在 Phase 4 第一天做 1 小时 spike 验证。
2. **`minSdk 29` 我这边无异议**（不涉及 UI 特性），但请在 `:app` 里确保 `WebView` 开启 `setSupportZoom(false)`、`setTextZoom(100)`（防止系统"字体大小"设置二次放大我们的 rem 体系，导致 44dp 目标被破坏）。这条对 UI 是硬要求：`textZoom` 非 100 时，我们的 `rem` 与 `dp` 约定全部失准。

---

*文档结束。所有尺寸单位：CSS px ≡ dp（依据 `pxtorem rootValue:16` + `html{font-size:16px}` 恒等映射，**不是**缩放）。*
