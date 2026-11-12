# Phase 5 验收报告（功能等价性 / 触控可用性 / 许可证合规）

- **验收人**：方证（质量保障与合规审查）
- **验收时间**：2026-11-03 23:14 – 23:45（本地时区）
- **验收方式**：模拟器真机级实测（adb + WebView CDP 注入真实触摸/鼠标事件）+ 产物静态核对
- **门禁结论概览**：功能等价性 **不通过** / 触控可用性 **不通过** / 许可证合规 **有条件通过**

---

## 1. 验收对象与环境

### 1.1 被测 APK 指纹（先钉指纹，再谈结论）

| 项 | 值 |
|----|-----|
| 路径 | `porting/android/app/build/outputs/apk/debug/app-debug.apk` |
| 大小 | **24,343,591 B** |
| 构建时间 | 2026-11-03 22:32 |
| **SHA-256** | **`de9541028538bd75027ede62a8bb4081dfb0cec5018823de86861193fad720b1`** |
| 包名 / 启动组件 | `com.anylisten.android` / **`com.anylisten.app.MainActivity`**（见 D-21：不是 `.MainActivity`） |
| 装机结果 | `Success` |

> **重要正面结论**：本次实测的 APK 与 `docs/phase6-compliance.md` §3.5 的合规基线是**同一个包**（sha256 完全相同）。合规报告 §4.3 的 **P2-11「交付物 ≠ 已测物」由此关闭** —— 已审物 = 已测物 = 当前磁盘交付物。
> 但该包**落后于当前 `dist` 一次构建**，见 **D-13**。

### 1.2 运行环境

| 项 | 值 |
|----|-----|
| 设备 | AVD `MotoIntercom_Graphics_API36`（x86_64 / Android 16 / API 36） |
| 屏幕 | 1080×2400 @420dpi → 411dp；实测 `innerWidth 412.2`、`innerHeight 915`、`dpr 2.625` |
| WebView | `com.android.webview` **133.0.6943.137**（UA: `Chrome/133.0.6943.137 Mobile Safari/537.36`） |
| 调试通道 | `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`（本机 9222 被占） |

**1dp 换算**：420dpi / 160 = 2.625；`1080 / 2.625 = 411.4dp`，`innerWidth 412.2 CSS px` → **1dp ≈ 1.003 CSS px**，故触控判据直接把 CSS px 与 `44` 比较。

### 1.3 证据文件

| 类别 | 路径 |
|------|------|
| 冷启动 logcat（3 次带时间戳） | `artifacts/logcat-accept-run1..3.txt` |
| 冷启动 logcat（3 次 epoch 精度） | `artifacts/logcat-accept-run4..6.txt` |
| 返回键实测 | `artifacts/logcat-accept-backtest.txt` |
| 截图 | `artifacts/shots/qa-settings-nav.png`、`qa-extension.png`、`qa-import-01.png`、`qa-playdetail*.png`、`qa-mini-tap.png` |
| 本次自建探针 | `artifacts/qa/*.js`、`artifacts/qa/dbltap.mjs`、`qa/click-both.mjs`、`qa/cdp-shot.mjs`、`qa/getws.mjs` |

> 本次**未修改任何产品代码**。唯一一次运行时注入是 `#qa-fix` 样式（临时修复设置页导航宽度以验证扩展设置页），已在 §5 D-11 中披露，测试后已移除。

---

## 2. 门禁结论表

| 门禁 | 结论 | 一句话依据 |
|------|------|-----------|
| **功能等价性** | **不通过** | 核心播放链路（导入→播放→时长落盘→自动切歌）全部通过，但**播放详情页完全不可用**（D-10）、**扩展管理页无任何入口**（D-12）、**10 项设置不可达**（D-11）——三项均属规格要求内的功能缺失。 |
| **移动端触控可用性** | **不通过** | 可见控件的尺寸全部 ≥44×44（0 个不达标），但**设置页 13 项中 10 项因横向溢出被永久裁切、不可点、不可滚**（D-11），且播放详情页控件落在视口外（D-10）——属「无法完成核心任务」的阻断级问题。 |
| **许可证合规** | **有条件通过** | `docs/phase6-compliance.md` 的结论在本次复核范围内依然成立（上游零改动、loopback-only 不触发 AGPL §13、无 GPL/LGPL 直接依赖、产物零泄露）；但 **C-1（整体 AGPL v3 开源）与 C-2（禁商用附加条款的呈现方式）必须由用户本人拍板**，工程侧不得自行裁定。 |

---

## 3. 功能等价性用例矩阵

坐标系：CSS px；`[证据]` 均可复现，`[假设]` 已标注。

| 用例编号 | 功能 | 平台 | 输入方式 | 预期输入→输出 | 对应规格 | 实测 | 判定 |
|----------|------|------|----------|---------------|----------|------|------|
| F-01 | `[bootstrap] dataPath` | 模拟器 | 冷启动 | 打印 dataPath 与 externalRoot | PDR-004 / ERR-003 | `dataPath=/data/user/0/com.anylisten.android/files, externalRoot=/storage/emulated/0`（logcat run6:260） | **通过 [证据]** |
| F-02 | `[db.worker] sqlite ready preloaded=true` | 同上 | 冷启动 | sqlite 就绪且 preload 命中 | ERR-007 / 记忆「判据定为 db inited」 | `sqlite ready \| db=…/anylisten.data.db preloaded=true`（run6:267）+ `db inited` | **通过 [证据]** |
| F-03 | `[ext.worker] quickjs ready` | 同上 | 冷启动 | quickjs wasm 加载完成 | PDR-002 / 记忆 P1 | `[shims/vm] quickjs ready` + `[ext.worker] quickjs ready`（run6:275-276） | **通过 [证据]** |
| F-04 | `[ipc] webview client connected` | 同上 | 冷启动 | 客户端接入（= 11 个 init 全过） | ERR-003 | `webview client connected (main)`（run6:313） | **通过 [证据]** |
| F-05 | `[bootstrap] core worker ready` | 同上 | 冷启动 | core 就绪 | PDR-002 | `core worker ready`（run6:315） | **通过 [证据]** |
| F-06 | `[ipc] 补投 1 帧` | 同上 | 冷启动 | 缓冲补投触发（N=1 属结构性正常） | ERR-002 ④ | `补投 1 帧（到达时间早于 onMessage 装配）`（run6:333） | **通过 [证据]** |
| F-07 | 六判据**顺序**正确 | 同上 | 冷启动 | 260→267→276→313→315→333 严格递增 | ERR-002/003 | 三次冷启动（run1/2/3/4/5/6）顺序完全一致 | **通过 [证据]** |
| F-08 | 主题注入非空 | 同上 | 冷启动 | `dom_style ≠ ':root {}'`、`id=blue2`、`--color-primary` 匹配 | ERR-003 判据勘误 | `window.dom_style.innerText` **13,217 字**、**242 个** `--color-*`、`--color-primary = rgb(79, 98, 208)` | **通过 [证据]** |
| F-09 | 曲库 Tab 可达 | 同上 | **真实触摸** tap(68,839) | `#/library?id=love` + AppBar `Library` + tab 高亮 | uiux 3 Tab | 全部三项同步正确 | **通过 [证据]** |
| F-10 | 在线 Tab 可达 | 同上 | **真实触摸** tap(206,839) | `#/online` + AppBar `Online` | 同上 | 全部正确，内容区显示空态 "The list turned out to be empty…" | **通过 [证据]** |
| F-11 | 设置 Tab 可达 | 同上 | **真实触摸** tap(343,839) | `#/settings` + AppBar `Settings` | 同上 | 全部正确 | **通过 [证据]** |
| F-12 | 导入本地音乐（入口） | 同上 | **真实触摸** tap(206,509) | 打开文件选择弹窗 | ERR-004 根因三 | 弹窗打开，标题 `Select song file`，根目录 `/storage/emulated/0` | **通过 [证据]** |
| F-13 | 导入：进入目录 | 同上 | **真实触摸 双击** | 进入 Music → AnyListenTest | — | **单击无任何反应；双击才进入**（13 个目录 → 3 个 wav） | **通过但交互异常**，见 D-15 |
| F-14 | 导入：选中并确认 | 同上 | **真实触摸** 单击 2 项 + tap Confirm(360,845) | 曲库出现 2 首 | ERR-004 | 2s 内入库：`02-523hz-C5 / local WAV / 00:12`、`03-659hz-E5 / local WAV / 00:12` | **通过 [证据]** |
| F-15 | 播放（Play all） | 同上 | **真实触摸** tap(182,193) | 触发播放 | PDR-005 Web Audio | `onPlaying`、`mediaSession.setPlaybackState(playing)`、`AAudioStream setState(s#8) 3→4` | **通过 [证据]** |
| F-16 | 播放时长落盘 | 同上 | 播放中采样 | `play_time` 持续增长 | ERR-003 毒化 flag | logcat 中 `fs.writeFile(.../play_time)` 每 ~530ms 一次，base64 解码 0.2322→0.4657→0.9970→…→11.6049；磁盘 `files/app/play_time` = `3.960204` | **通过 [证据]** |
| F-17 | 播完自动切歌 | 同上 | 连续采样 36s | 曲目按序切换 | PDR-005 | mini 标题变化序列 `02-523hz-C5 → 03-659hz-E5 → 02-523hz-C5 → 03-659hz-E5`（每 ~12s），切歌瞬间 `play_time` 复位为 `"0"` 且 `onPlaying` 再触发 | **通过 [证据]** |
| F-18 | 迷你播放器显示 | 同上 | — | 标题 + 状态 | uiux MiniPlayer | `03-659hz-E5 / Playing...`，尺寸 412×60，位于 tabbar 之上 | **通过 [证据]** |
| F-19 | 迷你播放器 → 播放详情 | 同上 | **真实触摸** tap(160,781) | 进入播放详情页且可用 | uiux D-2 | `.play-detail` 确实挂载（412×915 / z=10），但**全屏白屏、控件全在视口外** | **不通过**，见 D-10 |
| F-20 | 设置页 13 项可达 | 同上 | **真实触摸** + 滑动 | 全部可点 | PDR-007（55 项可见） | **仅前 3 项可见可点**，其余 10 项永久裁切且不可滚动 | **不通过**，见 D-11 |
| F-21 | 扩展设置页可达 | 同上 | 需先修 CSS 才能到达 | 进入扩展设置 | PDR-002 | 导航不可达；注入宽度修复后可达（证明是纯布局问题） | **不通过**，见 D-11 |
| F-22 | 扩展管理页可达 | 同上 | — | 从 UI 进入 `#/extenstion` | PDR-002 | **移动壳零入口**（`grep -rn extenstion porting/js/ui` = 0 命中）；直接改 hash 可进入 | **不通过**，见 D-12 |
| F-23 | 扩展宿主重启一次可用 | 同上 | — | 点击重启后仍可用 | ERR-010 / ERR-011 | **无法验证**：无扩展安装时 UI 无重启入口，且 F-22 使该页不可达 | **未验证** |
| F-24 | 返回键（非根页） | 同上 | `adb shell input keyevent 4` | 逐级返回，不退出 App | uiux D-07 | `#/settings` → `#/library?id=love`，进程存活、Activity 仍前台 | **通过（有限）**，见 D-1 |
| F-25 | 返回键（根页） | 同上 | 同上 | 再按一次退出 | uiux §9.7 | 冷启动原态：第 1 次 toast、第 2 次 `finish()`（fg=0） | **通过 [证据]** |
| F-26 | 返回键（导航后） | 同上 | 连续按键 | 同上 | uiux D-07 | 访问 2 个 Tab 后：`#/online`→`#/library`→**空返回（无变化）**→**进空白页**；「再按一次退出」toast 永不出现 | **不通过**，见 D-1 + D-13 |
| F-27 | 曲库行点击播放 | 同上 | **真实触摸** 单击/双击行 | 播放该曲 | uiux | 单击仅选中、双击亦未播放；只能走 Play all | **交互异常**，见 D-16 |
| F-28 | 设置页分组切换不崩 | 同上 | 改写 hash | 渲染对应面板 | — | `#/settings?type=app&id=extension` 正常渲染 | **通过 [证据]** |

**小结**：启动链路（F-01~F-08）与核心播放链路（F-12~F-18）**全部通过且可复现**；失败集中在**播放详情页（D-10）**、**设置/扩展的可达性（D-11/D-12）**、**返回键（D-1/D-13）**。

---

## 4. 触控可用性实测

### 4.1 尺寸与间距扫描（三状态复测，满足「≥3 次不同状态」纪律）

扫描选择器：`[role=button], button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])`，已排除 `svg[aria-hidden=true]` 内的雪碧图 `<use>`。

| 状态 | 可交互元素数 | < 44×44 | 相邻间距 < 8dp |
|------|-------------|---------|---------------|
| 曲库（空态） | 4 | **0** | 2（TabBar 边到边 0px） |
| 曲库（有内容） | 17 | **0** | 3（含迷你播放器两键 0px） |
| 设置页 | 13 | **0** | 3 |
| 扩展管理页 | 13 | **0** | 3 |

代表性元素实测：

| 元素 | 尺寸 | 判定 |
|------|------|------|
| TabBar 三项 `A.tab` | 137.4 × 56 | 通过 |
| 迷你播放器 `BUTTON.mini-main` | 320 × 59 | 通过 |
| 迷你播放器 `BUTTON.mini-btn`（播放/歌单） | 44 × 44 | 尺寸通过，**间距 0**（D-18） |
| 空态 `BUTTON.empty-primary` | 320 × 52 | 通过 |
| 文件弹窗底部 `Select all / Cancel / Confirm` | 86.4 / 72.6 / 79.6 × 44 | 通过 |
| 设置页一级 chip `.list-item` | 109~179 × 44 | 尺寸通过，**10 项越界**（D-11） |
| 文件浏览器列表行 `.container` | 388.19 × **42** | **不达标**（差 2px，D-17） |

> **自我更正留痕**：首版扫描脚本把元素右边界键名写成 `r`、在间距计算里却读了 `.right`，导致 `NaN` → 首轮误报「0 处间距过近」。修正后 Tab 与迷你播放器的 0px 间距才被检出。**凡「没发现异常」的结论都要先怀疑脚本本身。**

### 4.2 关键路径真实触摸结果

全部使用 CDP `Input.dispatchTouchEvent`（`touchStart → 60ms → touchEnd`），**不是 `el.click()`**：

| 路径 | 坐标 | 结果 |
|------|------|------|
| 切到在线 Tab | (206,839) | `#/online`，高亮同步 ✓ |
| 切到设置 Tab | (343,839) | `#/settings`，高亮同步 ✓ |
| 切回曲库 Tab | (68,839) | `#/library?id=love` ✓ |
| 空态「导入本地音乐」 | (206,509) | 弹窗打开 ✓ |
| 进入目录（需双击） | (206,205)×2 | 13 个目录出现 ✓（单击无效，D-15） |
| 选中文件 ×2 | 单击两行 | `selected=2` ✓ |
| 确认导入 | (360,845) | 2 首入库 ✓ |
| Play all | (182,193) | 开始播放 ✓ |
| 迷你播放器主体 | (160,781) | 打开播放详情 → **白屏**（D-10） |
| 设置一级导航横滑 | swipe(350,256)→(60,256) | **`scrollLeft` 恒为 0**（D-11） |

**事件到达性验证**（排除「注入没生效」）：在 (206,205) 装捕获监听后注入一次触摸，收到完整链条
`pointerdown → touchstart → pointerup → touchend → mousedown → mouseup → click`，目标为 `DIV.name`（`.container[role=button]` 的子节点）。→ **注入可靠，未触发即功能问题**。

### 4.3 触控阻断项

1. **设置页一级导航 10 项不可达**（D-11）：不是尺寸问题，是**元素被裁到视口外且容器不可滚动**。
2. **播放详情页控件全部落在视口外**（D-10）：播放/暂停按钮实测位于 `y≈1695`，循环按钮 `y≈2793`，视口高 915。

---

## 5. 缺陷清单

### 5.1 P1（阻断验收 / 功能或数据受损 / 触控不可用）

> 编号沿用主理人给的 D-1/D-2/D-6/D-8/D-9；新缺陷自 **D-10** 起。**未发现与历史记录冲突**。

| 编号 | 现象 | 证据 | 复现步骤 | 影响 | 建议修法 | 预估改动面 |
|------|------|------|----------|------|----------|-----------|
| **D-10** | **播放详情页完全不可用**：点迷你播放器后整屏白，无封面、无歌词、无控制条 | ① `.play-detail` 412×915、`z=10`、`background rgb(255,255,255)`、`opacity 1` —— 白色是它自己画的；② 其子块 `.left-info` 高 **8px**（内容 `scrollHeight 234`），`scroll info` 226×**0**；③ 控制按钮实测：暂停 `[626,**1695**,663,663]`、上一首 `[46,**1746**,562,562]`、下一首 `[1307,1746,562,562]`、循环 `[372,**2793**,24,44]` —— 视口仅 **915** 高；④ 点开瞬间 logcat：`Uncaught TypeError: Cannot read properties of undefined (reading 'addEventListener') @main.CgvrA_B_.js:36304`，该行是 `get$1(domBtns).addEventListener("mouseover", …)` | 曲库 → 点 Play all → 点迷你播放器主体 (160,781) | 播放页是唯一的「正在播放」全屏界面：进度、歌词、上一首/下一首、音量、循环、倍速全部不可达。**核心播放控制不可用** | ① 修 `domBtns` 绑定：该 `$effect` 在 Svelte 5 下早于 DOM ref 绑定执行，加 `if (!get$1(domBtns)) return`（或在 `onMount`/`tick()` 后再挂）；② 修 `.left-info` 高度塌陷（同 ERR-006 类：子元素绝对定位 → 父级 `height` 退化），移动端需显式给 `flex` 与 `min-height`；③ 控制条需吃 `--inset-bottom` | 1 个组件（`PlayDetail/LeftInfo` 相关）+ `mobile.less` 1 段；**根因是运行时异常，必须与布局一起修** |
| **D-11** | **设置页 13 项中 10 项永久不可达**（列表设置/快捷键/扩展服务/在线资源/网络/数据同步/备份恢复/其他/更新/关于） | ① `.settings-app-list` 宽 **1793.12px**，其父 `.settings-app-container` 仅 **412**、`overflow-x: visible`；② 内层 `.list` 宽 **1793.12** = `scrollWidth 1793` = `clientWidth 1793` → **自身不溢出，`overflow-x:auto` 形同虚设**；③ 外层 `.content` `overflow-x: hidden` → 全部裁掉；④ 真实滑动 14 步后 `scrollLeft` 仍为 **0**；⑤ 运行时注入 `width:100%!important` 后 `.list` 立刻变 412、`scrollWidth 1793`，一划即到「Extended service settings」→ **证明是纯布局约束缺失** | 进设置页 → 只能看到「Basic settings / Playback settings / Play Details Page Sett…」三项 | 网络设置（WebDAV 远程库）、备份恢复、扩展服务等 **10 项配置全部无法访问**；且这是**唯一**的二级面板入口 | `porting/js/ui/mobile.less` §9 的 `html.mobile .settings-app-list { width: auto !important }` 改为 `width: 100% !important; max-width: 100% !important; min-width: 0 !important`（`width:auto` 让它按内容撑开，滚动容器因此永不溢出） | **1 行 CSS**（已实测验证有效） |
| **D-12** | **扩展管理页（`#/extenstion`）在移动壳无任何入口** | `grep -rn "extenstion" porting/js/ui` → **0 命中**；上游唯一入口在 `Aside/Nav.svelte:82,151` 与 `Header/ControlBtnsDesktop.svelte:47` —— 都是移动壳不渲染的桌面组件；直接改 hash 到 `#/extenstion` 页面可正常渲染（Installed/Enabled/Disabled/Extension Store/Local installation） | 打开 App，遍历 3 个 Tab 与设置页全部条目，无任何入口进入扩展管理 | PDR-002 明确「**必须保留第三方扩展能力**」——扩展安装、启用、配置、**重启扩展宿主**在 UI 上全部不成立。这是与 ERR-004「导入入口为零」完全同类的断链（上游入口挂在 Aside/Header 上） | 三选一：① 设置页加「扩展管理」条目指向 `/extenstion`；② TabBar 第 4 个 tab；③ 在线页顶栏加入口 | 1 个 entry 按钮 + 1 行路由跳转；**不改上游** |
| **D-13** | **交付 APK 落后 `dist` 一次构建** → `androidBack.ts` 的返回键契约在包内**整体缺失**，返回键退化 | ① APK 内 `assets/web/spa/assets/main.CgvrA_B_.js`，sha256 `b0392edd79d3…`，**1,370,688 B**；② 磁盘 `porting/js/dist/spa/assets/main.DF1m3J24.js`，sha256 `8e363856ad8e…`，**1,372,012 B**；③ 在 APK 全部 `.js` 中搜 `anylisten_canGoBack / anylisten_back_debug` → **NONE**；`dist` 中 → 命中；④ 运行时 `typeof window.__anylisten_canGoBack__ === 'undefined'`；⑤ `index.html` SHA1 也不同（dist `00b29d32…` vs assets `93916b79…`） | `sha256sum` 三者对比即可复现 | `MainActivity.kt:512-516` 的 `JS_BACK` 有回退分支：契约缺失时走 `history.length > 1 → history.back()`。而 `history.length` **只增不减**（`androidBack.ts:15` 已注明），导致访问过 Tab 后「再按一次退出」toast 永不出现，且出现空返回、最终**把 WebView 导航出 SPA（空白页）** | 重跑 `pnpm -C porting/js build:all` → `syncWebAssets` → `assembleDebug`，并把「dist↔assets 一致性」纳入门禁（见 F-7 盲区） | 重打包，无需改代码 |
| **D-1**（已知项复核） | 返回键**不是**「直接退出」，但行为不可控：穿透 Tab 切换历史、一次空返回、最后进空白页 | ① 冷启动原态（`history.length=1`）：第 1 次 toast、第 2 次退出 ✓；② 访问 Online→Library 后（`history.length=3`）：`#/online` → `#/library?id=love` → **无变化** → **`hash` 变空、Activity 退到后台**；③ `window.history.length` 恒为 3 不下降 | 切两次 Tab，再连按返回 4 次 | 从设置页要按 3~4 次才离开；中间一次「按了没反应」；最后一次进入空白页（视觉上像白屏崩溃） | ① 先修 D-13 让契约生效（`androidBack.ts` 的 hash 栈会把 Tab 切换也算作前进）；② 再决策「Tab 切换是否入返回栈」——Android 惯例是**不入栈**，需 uiux 出结论；③ `goBack()` 与浏览器历史发散时补一次 `replace` 对齐 | `androidBack.ts` 约 10 行 + uiux 决策 |
| **D-2**（已知项复核） | **确认且比原描述更严重**：点迷你播放器**确实跳转**（`.play-detail` 已挂载），但跳过去是白屏 | 见 D-10 全部证据；另：`MiniPlayer.svelte:22,33` 的 `onclick` 均为 `setShowPlayDetail(true)`，store 链路正常（`playDetailEvent.visible` → `readable`），**不是不跳转，是跳过去后挂了** | 同 D-10 | 同 D-10 | **并入 D-10 修复**，不单列改动 | — |

### 5.2 P2（体验瑕疵 / 非阻断）

| 编号 | 现象 | 证据 | 影响 | 建议修法 |
|------|------|------|------|----------|
| **D-9**（已知项复核） | 冷启动耗时**取决于口径**：官方口径达标，端到端不达标 | 见 §6.2 完整数据 | 用户从 1.25s 起看到界面、1.94s 才能读到数据，中间约 0.7s 是空态 | 优化 `initModules()` 串行链，或首屏先渲染骨架（非本轮必须） |
| **D-14** | 设置页分组 tab 出现**硬编码死灰块**压住文字 | 「Extension settings」`BUTTON.list-item` `background: rgb(107,107,107)`，尺寸 118×96 —— 触摸别处后**立即恢复 `rgba(0,0,0,0)`** → 是**粘滞 hover**，非硬编码 | 触摸后残留灰块，像渲染坏了；下一个触摸才消失 | 上游 hover 规则加 `@media (hover: hover) and (pointer: fine)` 守卫，或移动端 `html.mobile .header .list-item { background-color: transparent !important }` |
| **D-15** | 文件浏览器**必须双击**才能进目录；单击零反馈 | `Open.svelte:87-98` `createClickHandle(单击=选中, 双击=进入)`；实测单击后 13 个目录不变、双击后出现 | 移动端无「双击」心智，用户会以为点坏了 | 移动端改为单击即进目录（`selectfolder`/`openDir` 场景），或给目录加右侧 chevron 明确「进入」 |
| **D-16** | 曲库行**单击/双击均不播放**，只能 Play all | 单击后行不进入 playing；双击亦无播放；`AAudioStream` 无新流 | 用户最自然的「点歌播放」失效 | 移动端让行单击 = 播放（或行尾加独立播放键） |
| **D-17** | 文件浏览器列表行高 **42px < 44px** | `.modal .list .container` 实测 388.19 × **42** | 差 2px，临界态易误触相邻行 | `--touch-min: 44px` 约束行高 |
| **D-18** | 迷你播放器「播放/暂停」与「歌单」两键**相邻 0 间距** | 两 `BUTTON.mini-btn` 均 44×44，x=320 与 x=364，gap=**0** | 暂停时误触跳歌单 | 加 8px gap 或中间加分隔 |
| **D-19** | 迷你播放器常驻 `Failed to obtain lyrics` | 截图 `qa-settings-nav.png`、结束时 `.mini` innerText = `02-523hz-C5//Failed to obtain lyrics` | 本地 WAV 无歌词属正常，但把内部失败文案暴露给用户 | 无歌词时显示歌曲信息或留空 |
| **D-20** | `/favicon.ico` 404 | `W AnyListen/Http: asset not found under web/spa: /favicon.ico` | 纯噪声 | 加 favicon 或过滤该请求 |
| **D-21** | **文档里的启动命令不可用** | `am start -n com.anylisten.android/.MainActivity` → `Error type 3: Activity class does not exist`；真实组件为 `com.anylisten.android/**com.anylisten.app**.MainActivity`（`cmd package resolve-activity` 实测） | 任何人照抄派发口径都会启动失败 | 统一文档与脚本中的组件名 |
| **D-22** | 设置页一级 chip 文本右边缘被裁（`Play Details Page Sett…`） | 与 D-11 同源；修 D-11 后 chip 可横滑，裁剪消失 | 文案不完整 | 随 D-11 一并解决 |

### 5.3 已知项复核结论一览（主理人要求逐条给结论）

| 编号 | 结论 | 说明 |
|------|------|------|
| **D-1** TabBar 返回键是否直接退出 | **不复现（原假设不成立），但发现新形态** | 不退出，会逐级返回；问题在「穿透 Tab 历史 + 空返回 + 进空白页」，且与 D-13 强相关 |
| **D-2** 迷你播放器跳转错误/不跳转 | **确认（形态修正）** | 会跳转，但目标页白屏 → 并入 D-10 |
| **D-6** 切歌遮罩硬编码白色 | **倾向误判，无法动态验证** | `CoverCD.svelte:26` 的 `fill="white"` 是 **SVG `<mask>` 定义**（white=不透明、black=透明），不是可见白色遮罩层；且播放页当前不可用，遮罩无法触发。标注 **[假设]**，待 D-10 修复后复验 |
| **D-8** 快速设置面板 411dp 可用性 | **无可验证对象** | 全仓与运行时均未找到「快速设置面板」实现（`grep -i quick` 于 PlayDetail 无命中）。若指播放详情页那 4 个 44×44 图标键，则因 D-10 不可达 |
| **D-9** 冷启动 1.7s | **部分复现（口径依赖）** | 官方 `Displayed` 口径 **867ms**（优于 1.7s）；端到端可交互 **1936ms**（劣于 1.5s 目标），详见 §6.2 |

---

## 6. 性能、稳定性与 F-5 构建门禁复核

### 6.1 测试报告

| 项目 | 数据 / 结果 | 失败项复现步骤 |
|------|-------------|----------------|
| 冷启动（`am start -W` TotalTime） | 832 / 872 / 867 ms → **中位数 867 ms** | — |
| 冷启动（系统 `Displayed`，权威口径） | +832 / +872 / +867 ms → **中位数 867 ms** | — |
| 首屏挂载（`MobileApp 已挂载`） | 1249 / 1302 / 1087 ms → **中位数 1249 ms** | — |
| 端到端可交互（`[ipc] 补投 1 帧`） | 2003 / 1936 / 1734 ms → **中位数 1936 ms** | — |
| 核心操作帧率 | 未测量（见 §7 未覆盖） | — |
| 切歌响应 | `play_time` 复位与 `onPlaying` 同毫秒级（`50.122` → `50.191`） | — |
| 内存峰值（PSS） | `TOTAL PSS 132,826 KB`（≈129.7 MB）/ Java 10,588 KB / Native 8,968 KB / Graphics 0 | — |
| 原生库加载失败率 | **0**（quickjs / sqlite wasm 均 `ready`，无 404、无 `magic word` 错） | — |
| JS 未捕获异常 | **1 条**（D-10 的 `addEventListener` TypeError） | 点迷你播放器 |
| ANR / 崩溃 | **0** | 3 次冷启动 + 全流程操作期间 |
| 后台恢复行为 | Activity 被 `finish()` 后 `am start` 会**重建 WebView 并整页重载**（`MobileApp 已挂载` 出现第二次）；进程 PID 复用 | 根页按返回退出后再启动 |

> **冷启动口径必须写清楚**，否则数字没有可比性：
> - `Displayed +867ms` = Android 官方冷启动指标（首帧上屏）；
> - `1249ms` = DOM 挂载完成（此时内容区是空态/骨架）；
> - `1936ms` = 数据真正可读（IPC 接通 + 首帧补投）。
> D-9 的 1.5s 目标若指「首屏可见」则**达标**，若指「数据可读」则**超标 0.44s**。建议在规格里把口径固定下来（推荐用官方 `Displayed`）。

### 6.2 F-5 构建可复现性门禁复核

**引用**：`artifacts/f5-gate-verify.md`（fullstack-dev，2026-11-03 22:38–22:52）。

| 场景 | `dist/spa` | 目标目录 | `requireWeb` | 记录结论 | 本次复核 |
|------|-----------|----------|--------------|----------|----------|
| A | 存在(213) | 118 真实 | true | 成功 | **仍成立**（目标目录当前 118 文件，与 APK 内一致） |
| B | 缺失 | 118 真实 | true | `BUILD FAILED` exit 1，原因行可见 | **仍成立**（修法在源码，`logger.error` 先于 throw） |
| C | 缺失 | 不存在（existing=0） | true | `BUILD FAILED` exit 1 | **仍成立**（这是 F-5 的核心 case：旧代码此处静默通过） |
| D | 缺失 | 118 真实 | 默认(false) | 成功 + warn | **仍成立** |

**F-5 与 F-5b 的修法本次已静态确认落在代码中**，四场景结论**依然成立**。

但本次发现**一个新的门禁盲区（F-7）**：

| 项 | 事实 |
|----|------|
| 现象 | `check-webdist.mjs` **默认模式查 `dist/spa`（新）**、`--assets` 模式查 `assets/web/spa`（旧），**两种模式都返回 `VERDICT: OK`** |
| 为什么是盲区 | 它只校验「目标目录内部引用自洽」，**从不比较两个目录之间是否一致** |
| 实际后果 | 当前 `dist` 的 `main.DF1m3J24.js`（1,372,012 B / `8e363856…`）与 `assets`/APK 的 `main.CgvrA_B_.js`（1,370,688 B / `b0392edd…`）**已经不是同一个文件**，而两个门禁全绿 —— 正是 **D-13** 得以溜进交付的原因 |
| 建议 | 给 `check-webdist.mjs` 加一条「dist ↔ assets 逐文件 sha256 全等」断言（或 `diff -r`），失败即拒绝打包 |

**构建可复现性门禁结论**：**有条件通过（仅限 F-5 修复范围）** —— F-5/F-5b 四场景成立；但 F-7 盲区意味着「能产出 APK」不等于「产出的是当前源码的 APK」，需补断言后才能真正签「构建可复现」。

---

## 7. 未覆盖范围与残余风险

1. **横屏 / 平板 / 折叠屏：未覆盖**。按派发口径本包只交付手机竖屏（PDR-008 平板 P2 后置），故未测旋转与多窗口。**风险**：D-11/D-10 这类「按桌面宽度布局」的问题在横屏下可能变化（可能变好也可能更乱），需在支持范围内补测。
2. **外接指针 / 键盘：未覆盖**。`ListItem.svelte` 有完整的 `Enter`/`Space` 键盘分支，但本次未验证外接键盘可达性。
3. **真机（小米 13 / arm64）未覆盖**。全部结论来自 x86_64 模拟器。PDR 早已注明「触控与安全区结论需在真机复核」。**风险**：GPU 合成路径差异可能让 D-10 的白屏表现不同（但 D-10 的根因是 JS 异常 + 布局塌陷，与 GPU 无关，预计真机同样复现）。
4. **音频主观质量未评价**：只验证了「有声、流已开、时长在走」，未评音质/延迟/后台切歌。
5. **扩展宿主重启（F-23）未验证**：受 D-12 阻断，无 UI 入口；且当前未安装任何扩展，重启按钮不出现。
6. **性能细项未测**：核心操作帧率、长列表滚动帧率、内存增长曲线（只取了单点 PSS）。
7. **D-6 为 [假设]**：静态判为 SVG mask 语义误判，但因播放页不可用无法动态证伪。
8. **许可证：本次只做复核，未重跑全量扫描**。`docs/phase6-compliance.md` §1（上游零改动）与 §2（许可证清单）与打包内容无关，结论不受本次重建影响；§3（产物泄露）的结论绑定 sha256 `de954102…`，本次实测包与之相同，故**依然有效**。
9. **无扩展安装状态下的扩展生态未端到端验证**：扩展列表为空，未能验证「安装扩展 → 启用 → 运行」。

---

## 8. 签字意见

### 8.1 三道门禁

**① 功能等价性：不通过**

- **通过的部分**（可复现、有证据）：冷启动六条判据链完整且顺序正确；主题注入 13,217 字符 / 242 色；三 Tab 真实触摸可达；导入 → 播放 → 时长落盘 → 自动切歌全链路打通。
- **阻断项**：
  - **D-10** 播放详情页不可用（白屏 + 控件在视口外 + 挂载抛 `TypeError`）
  - **D-11** 设置页 10 项配置不可达（含网络/WebDAV、备份恢复）
  - **D-12** 扩展管理页在移动壳无入口 —— 直接违反 PDR-002「必须保留第三方扩展能力」
- **放行条件**：D-10、D-11、D-12 全部修复，且 D-10 修复后补测「播放详情页可交互 + 无 JS 异常」。

**② 移动端触控可用性：不通过**

- **通过的部分**：四状态扫描下**可见**控件尺寸 **0 个**低于 44×44；关键路径全部用真实触摸事件验证；TabBar/迷你播放器/弹窗按钮尺寸达标；`--inset-bottom` 注入生效（TabBar 与弹窗 footer 都正确避开导航栏，底部按钮实际底边 = 867 = 可视下界）。
- **阻断项**：D-11（元素越界且容器不可滚 → 10 个设置项「点不到」）、D-10（控件在视口外）。
- **放行条件**：D-11、D-10 修复后再跑一次三状态扫描 + 关键路径真实触摸回归；D-17/D-18 建议同期修（非阻断）。

**③ 许可证合规：有条件通过**

- **复核结论**：`docs/phase6-compliance.md` 的判定在本轮范围内**继续成立**，且本次实测进一步**强化**了它 —— 被测包 sha256 与该报告 §3.5 基线**完全一致**，此前 §4.3 P2-11「交付物 ≠ 已测物」的悬案**关闭**。
- **必须由用户拍板的硬条件（不在工程侧权限内）**：
  - **C-1**：任何形式分发前，移植层全部源码 + 构建脚本 + 上游对应源码（commit `c8f40eab`）须整体以 **AGPL v3** 提供。
  - **C-2**：`source/LICENSE:669-680` 的「禁止商用」附加条款与 AGPL v3 §7/§10 存在文本冲突，**呈现方式必须由用户/法务决定**；工程侧不得援引 §7 第 3 段自行豁免。
- **当前用途（PDR-003：个人自用、不分发、不商用）下**：不触发 copyleft 扩散义务，风险低。
- **放行条件**：仅「个人自用」放行；**一旦分发，C-1/C-2 未闭合则不得交付**。

### 8.2 总体结论

> **本包不具备交付条件。**
>
> 需 **P1 全部修复（D-10 / D-11 / D-12 / D-13 / D-1）后重新打包，并复跑本报告 §3 矩阵 + §4 触控实测**，方可再次送签。
>
> 其中：
> - **D-11 是 1 行 CSS**（已实测验证有效），成本最低、收益最大，建议立即修；
> - **D-12 是一个入口**，但它是 PDR-002 核心承诺，不能延后；
> - **D-13 只是重打包**，但必须同时补上 F-7 的「dist↔assets 一致性」断言，否则同一个坑会再踩；
> - **D-10 是唯一需要真改代码的 P1**（JS 异常 + 布局塌陷），且它的根因（`domBtns` 未就绪就挂监听）与 ERR-002/ERR-003 属同一族「时序/引用未就绪」缺陷，建议修完顺手普查同类。

### 8.3 交付前必须完成的动作清单

| # | 动作 | 对应缺陷 | 验收方式 |
|---|------|----------|----------|
| 1 | `mobile.less` 约束 `.settings-app-list` 宽度 | D-11 | 设置页 13 项可横滑全部可达 |
| 2 | 修 `PlayDetail` 的 `domBtns` 空引用 + `left-info` 高度塌陷 + 控制条吃 inset | D-10 | 点迷你播放器 → 播放页可见且暂停键在视口内；logcat 无 TypeError |
| 3 | 加扩展管理入口 | D-12 | 从 UI 可达 `#/extenstion`，含重启扩展宿主 |
| 4 | 重建 dist → sync → 重打包 | D-13 | APK 内 `main.*.js` 含 `__anylisten_canGoBack__` |
| 5 | `check-webdist.mjs` 增 dist↔assets 全等断言 | F-7 | 两目录不一致时 fail |
| 6 | 复核返回键在 3 种状态下（根页/非根页/导航后）行为 | D-1 | toast 出现、无空白页 |
| 7 | 补测横屏（若纳入支持范围） | §7 | — |

---

## 附录 A：本次执行的关键命令（可逐条复现）

```bash
export MSYS_NO_PATHCONV=1
ADB=/c/Users/kuma/AppData/Local/Android/Sdk/platform-tools/adb.exe

# 指纹
sha256sum porting/android/app/build/outputs/apk/debug/app-debug.apk
# → de9541028538bd75027ede62a8bb4081dfb0cec5018823de86861193fad720b1

# 装机 + 冷启动 3 次
"$ADB" install -r porting/android/app/build/outputs/apk/debug/app-debug.apk
for n in 1 2 3; do
  "$ADB" shell am force-stop com.anylisten.android; sleep 2
  "$ADB" logcat -c
  "$ADB" shell am start -W -n com.anylisten.android/com.anylisten.app.MainActivity
  sleep 5
  "$ADB" logcat -d -v epoch > artifacts/logcat-accept-run$n.txt
done

# CDP 通道（本机 9222 被占，用 9333）
PID=$("$ADB" shell pidof com.anylisten.android | tr -d '\r')
"$ADB" forward tcp:9333 localabstract:webview_devtools_remote_$PID
node artifacts/qa/getws.mjs

# 真实触摸
node artifacts/accept-touch.mjs "$(cat artifacts/qa/ws.txt)" tap 206 839 60
node artifacts/accept-touch.mjs "$(cat artifacts/qa/ws.txt)" swipe 350 256 60 256 14 16

# 触控扫描
node artifacts/cdp-run.mjs --port 9333 --file artifacts/qa/q04-touchscan.js

# 产物一致性（D-13）
sha256sum porting/js/dist/spa/assets/main.*.js \
          porting/android/app/src/main/assets/web/spa/assets/main.*.js
cd porting/android && node scripts/check-webdist.mjs && node scripts/check-webdist.mjs --assets
```

## 附录 B：本次未修改任何产品代码

- `porting/**`：只读。未改源码、未跑构建、未改 `mobile.less` / `check-webdist.mjs` / `webassets/build.gradle.kts`（D-11 的修法只是**建议**，我仅在**运行时**注入过一次样式用于验证扩展设置页，测试后已 `remove()`）。
- `source/**`：只读（`grep`/`read`）。
- 写入的只有：本报告、`artifacts/qa/**`（自建探针）、`artifacts/shots/qa-*.png`、`artifacts/logcat-accept-*.txt`。

## 附录 C：本次的自我更正（留痕）

1. **触控扫描脚本假阴性**：首版把右边界存成 `r`、计算间距却读 `.right` → `NaN` → 误报「无间距过近」。修正后才检出 TabBar 与迷你播放器的 0px 间距。**教训：脚本说"没问题"时，先怀疑脚本。**
2. **误判「迷你播放器不跳转」**：我最初用 `location.hash` 和 `.content` 判断跳转，得出「没反应」。实际上 PlayDetail 是**覆盖层、不改 hash**，`.play-detail` 确实挂载了 —— 真正的问题是它白屏。**教训：判"没跳转"要看 DOM 挂载，不能只看 hash。**
3. **误判弹窗 footer 被导航栏压住**：我的判据比较的是 `.footer` 盒子底边（915），但 footer 有 `padding-bottom:48px`，**按钮实际底边 = 867 = 可视下界**，修复有效。**教训：判遮挡要量最后一个可见子元素，不是容器盒子。**
4. **差点把粘滞 hover 报成 P1**：设置页「Extension settings」出现 `rgb(107,107,107)` 死灰块，看着像硬编码。触摸空白处后立即恢复透明 → 是 hover 残留，降级为 P2（D-14）。**教训：任何"颜色不对"的结论，都要先试一次"状态是否可清除"。**

## 附录 D：编号映射

未发现与历史记录冲突。历史已用编号：`D-1`（返回键）、`D-2`（迷你播放器）、`D-7`（`check-webdist` 误报，见合规报告 P2-9）、`D-6`（切歌遮罩）、`D-8`（快速设置）、`D-9`（冷启动）。本次新增自 **D-10** 起连续编号，无重号。

---

# 9. 复验记录（v2）

> 复验时间：2026-11-03 16:38–16:58（设备时钟）。本章**追加**，不覆盖 §1–§8 的 v1 结论。
> 纪律：**不采信修复方自述数值**，全部独立复跑；v1 的每条 P1 按「原值 → 复验值 → 判定」三段式给结论。

## 9.1 复验对象身份判定（不能用字节数）

| 判据 | 期望 | 实测 | 结论 |
|---|---|---|---|
| APK sha256 | `1f5c8601…` | `1f5c8601001eede3a202c85de232958f6456c6a95b46423323ea2017bd053c9a` | 一致 |
| 字节数 | — | 24,343,591 B（**与旧包完全相同**） | 不能作判据，仅存档 |
| 包内入口 | 换代 | `assets/web/spa/assets/main.Cvys4gCv.js`（1,376,381 B） | 已换代 |
| `index.html` sha1 | `d476c3c2…` | `d476c3c2…` | 一致 |
| 返回键三符号 | 包内存在 | `__anylisten_canGoBack__` / `__anylisten_goBack__` / `__anylisten_back_debug__` 均在 `main.Cvys4gCv.js` 内 | 一致 |
| 启动组件名 | — | `com.anylisten.android/com.anylisten.app.MainActivity`（`.MainActivity` 不存在） | 见 D-21 |

**字节数陷阱已确认**：新旧包字节数一字不差，若只比大小会误判「没换包」。判身份必须用 sha256 + 包内入口文件名。

交付物纪律（复跑）：

- `git -C source status --porcelain` = **0 行**（HEAD `c8f40eab`）→ 交付物与源码一致，无未提交改动。
- `node porting/android/scripts/check-webdist.mjs` 两模式均 `VERDICT: OK`；新增的 dist↔assets 交叉断言输出「dist↔assets: 3 项指纹全等」。
- **F-7 可失败性已证明**（v1 的盲区）：临时改动 `porting/js/dist/spa/index.html` 后脚本 `exit 1` + `VERDICT: INCONSISTENT`；还原后 `exit 0`；还原文件 sha256 = `6f85e809…` 与原值一致。**一个从不会失败的门禁等于没有门禁，这条现在成立了。**

## 9.2 v1 五项 P1 逐条判定

| 编号 | 缺陷 | 原值（v1） | 复验值（v2） | 判定 |
|---|---|---|---|---|
| D-10 | 播放详情页白屏 | `.left-info` 高 8px；按钮 y=1695/2793；`main.CgvrA_B_.js:36304` TypeError | `.play-detail` = `[0,0,412.2,915]`；`.left-info` **412.2×231.2**；封面 171.2×171.2 @x=120.5；footer 412.2×284 @y=631；11 个控制键全部挂载；全程 `Uncaught = 0` | **已修** |
| D-11 | 扩展设置页 13 项不可滚 | `.settings-app-list` 宽 **1793.12px** | 412.19px（= 视口）；`.list` `scrollWidth 1793 / clientWidth 412 / overflow-x auto`；真实滑动 691.8 → 1008.4 → **1381（= max）**；13 项逐一真实滑动+触摸全部进入对应面板（basic/player/playDetail/list/hotkey/extension/onlineResource/network/dataSync/backup/other/update/about），chip 高度全为 44 | **已修** |
| D-12 | 扩展页零入口 | `#/extenstion` 无任何入口 | `.appbar .ab-entry` = `[314.2, 54, 94, 44]`（94×44，达标）→ 真实触摸进入 `#/extenstion`；五项分区见 9.3 | **已修**（附 1 个观感问题 D-24） |
| D-13 | APK 落后 dist | 包内 `main.CgvrA_B_.js` 不含返回键三符号 | 包内 `main.Cvys4gCv.js` 含三符号；运行时 `typeof __anylisten_goBack__ === 'function'`；返回键三状态实测见 9.4 | **已修** |
| D-1 | 返回键形态 | 任何页面按返回一律退 App | 子页逐级回退（`?type=online → disabled → enabled → installed → /extenstion → #/settings…`，`canGoBack` 随栈变化 true→false）；根 Tab 按返回出 Toast「再按一次退出」（截图 `artifacts/shots/qa-v2-back-toast.png`）；900ms 内连按两次 → `topResumedActivity=launcher` | **已修**（附 1 个分层缺陷 D-23） |

## 9.3 D-12 五项分区可达性（观感 or 阻断）

`#/extenstion` 页 header = `.list`（4 个 chip）+ `.header-actions`（Local installation 按钮）。

| 分区 | 位置/尺寸 | 可达性实测 | 判定 |
|---|---|---|---|
| Installed | chip 16..93.9 | 真实触摸 → active 切换 | 可达 |
| Enabled | chip 101.9..176.6 | 真实触摸 → active 切换 | 可达 |
| Disabled | chip 184.6..263.4 | 真实触摸 → active 切换 | 可达 |
| Extension Store | chip 271.4..357.2 | `scrollLeft=0` 时被 `.list` 裁切（clip 右界 258）**完全不可见**；真实横滑后 `scrollLeft=99.4(max)`，chip 落到 172..257.8，中心 (215,164) `elementFromPoint` = `A.list-item` → 真实触摸 → `hash=#/extenstion?type=online`，active 正确切换为 Extension Store | 可达（**需先横滑**） |
| Local installation | 265.8..396.2 × 142..186（130×44） | 真实触摸 → 打开文件浏览器弹窗（标题「Select the extension installation」，Cancel/Confirm 均 44 高） | 可达 |

**结论：五项全部可达，不构成可达性阻断。** 遗留观感问题见 D-24（chip 行高 96dp = 桌面尺寸的 2 倍；`scrollLeft=0` 时第 4 项 100% 被裁切，只有 5px 的「切边」暗示，可发现性弱）。

> **自我更正**：v1→v2 中途我曾判定「Extension Store 不可达、`.list` 不能横滑」，那是被上一轮残留的「Local installation」弹窗（`.modal` z=99）污染了命中测试与滑动手势。用 Cancel 关掉弹窗、干净状态下复测，横滑与点击均正常。教训见 9.7-①。

## 9.4 D-1 与覆盖层的交互（三状态 + 分层）

| 状态 | 操作 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| 仅播放详情（overlay） | 返回键 | 关覆盖层，**不退 App** | `pd=false`，`hash` 不变，App 存活 | 通过 |
| 播放详情 + 其内弹窗（声音设置） | 返回键 | 关最上层弹窗，播放详情保留 | **弹窗与播放详情同时消失**（复现 2 次：BACK#1、BACK#3） | 不通过 → D-23 |
| 子页（`#/extenstion?type=…`） | 连按返回 | 逐级回退 | 5 次逐级回退到 `/extenstion` → `#/settings…`，`canGoBack` 由 true 变 false | 通过 |
| 根级 Tab | 返回键 | Toast「再按一次退出」 | Toast 可见（截图），App 存活 | 通过 |
| 根级 Tab | 900ms 内连按两次 | 退出 App | `topResumedActivity = com.android.launcher3/.uioverrides.QuickstepLauncher` | 通过 |

**根因（D-23）**：`porting/js/ui/boot/androidBack.ts:65-66` 的返回策略是「**先关播放详情**」——`findPlayDetailCloseBtn()` 找到 `.play-detail .control-btn button.hide` 并 `.click()`。关闭键让整个播放详情子树卸载，挂在它下面的弹窗随之消失。**返回键应逐层关闭（先弹窗、后覆盖层），而不是一步跳到底。**

## 9.5 D-10 复验明细（重灾区，逐键）

`Uncaught` 全程计数用自建 `artifacts/qa/exwatch.mjs`（`Runtime.enable` 后无过滤统计所有 `exceptionThrown`，落盘 `artifacts/logcat-qa-d10-clean.txt`）。**干净冷启动后 190 秒会话 = 0 条**，覆盖：开详情页、上一首、播放/暂停、下一首、倍速浮层、音量浮层、循环浮层、播放列表浮层、进度拖拽、返回键、收藏、评论弹窗。

| 控制键 | 位置（CSS px） | 真实触摸后的状态变化 | 判定 |
|---|---|---|---|
| 关闭（hide） | 360.2,54,44,44 | `pd=false`，`hash=#/library?id=love`，Tab=Library | 通过 |
| 上一首 | 111.1,693.5,51,51 | 曲目 02-523hz-C5 → 03-659hz-E5 | 通过 |
| 播放 / 暂停 | 170.1,683,72,72 | mini `Playing…` → `Suspended`；再点恢复 | 通过 |
| 下一首 | 250.1,693.5,51,51 | 03 → 02 | 通过 |
| 声音设置 | 132.1,763,44,44 | 打开混响/均衡器弹窗（Telephone/Church/…/Subwoofer，按钮全 44 高），内容不空 | 通过 |
| 播放倍速 | 184.1,763,44,44 | 打开 `.popup`「1.00x + Pitch compensation」+ 滑块 | **打开后无法关闭 → D-22** |
| 查看评论 | 236.1,763,44,44 | 打开 `.modal`「Comments for …」（仅 1 个 Refresh 按钮） | **返回键不关 → D-23** |
| 取消收藏 | 106.1,815,44,44 | `.icon.active` 出现/消失 | 通过（注意：浮层打开时该键被遮罩吞掉） |
| 播放列表 | 158.1,815,44,44 | 打开队列面板 `[0,403,412,512]`，两首曲目含 local/WAV/00:12 | **打开后无法关闭 → D-22** |
| 音量 | 210.1,815,44,44 | 打开 `.popup`「100% + Mute」 | **打开后无法关闭 → D-22** |
| 循环模式 | 262.1,815,44,44 | 打开 5 个图标选项浮层 | **打开后无法关闭 → D-22**（另见 D-24） |

**进度条拖拽 → 落盘**（`files/app/play_time`）：

| 步骤 | UI | `play_time` 文件 | 判定 |
|---|---|---|---|
| 起播 2.5s | 00:03 / 00:12 | `3.228867` | 落盘正常 |
| 真实拖拽 60→300（y=657） | 00:11 / 00:12 | `11.393428` | **拖拽后仍落盘** |
| 再续播 2s（单曲循环回到开头） | 00:02 / 00:12 | `0.694733` | 持续更新 |

**几何无挤压**：`.player-detail-main` 412.2×527、`.footer` 412.2×284、封面 171.2×171.2 居中。全页 `scrollWidth - clientWidth > 2` 的元素只有 1 个（`.progress` 328/320，滑块手柄外溢 8px），不构成挤压或横向溢出。

## 9.6 回归面（每处各量一次）

| 回归项 | 期望 | 实测 | 判定 |
|---|---|---|---|
| §9.1 设置页二级 chip 条 | 13 项可横滑、chip ≥44 | `.list` w=412.2 / `sw=1793` / `cw=412` / `overflow-x:auto`；一级条 `.list.left` 3 项 372/372 不裁切 | 通过 |
| §9.2 曲库列表与表头 | 桌面表头隐藏、行高 ≥44 | `.view-container > .header:has(> span)` → `display:none`（h=0）；歌曲行 400.2×72，`.list-item-cell.auto.name-cell` 275.3×44 | 通过 |
| §14 文件浏览器弹窗 | header 两行栅格 / 90dvh / footer 吃 inset | `.content` = `[0,91.5,412.2,823.5]`（823.5 = 915×0.9 = **90dvh**）；`.header` 412.2×92，`grid-template-rows: 20px 44px`；`.footer` `padding-bottom: 48px`，Cancel 72.6×44 / Confirm 79.6×44，**底边 867 = 915−48，未被系统导航栏压住** | 通过（行高 42 → D-25 提示） |

## 9.7 D-6 动态落结论（v1 遗留「倾向误判」）

- 全 DOM 中满足 `fill` ∈ {`white`,`#fff`,`#ffffff`} 的 `<rect>` **只有 1 个**，祖先链 = `rect → mask#play-detail-cd-hole → defs → svg`，`closest('mask') = true`。**它是掩膜亮度定义（white=不透明、black=镂空），不是可见白色遮罩。**
- `.play-detail` 子树内面积 > 200×300 且 `background-color = rgb(255,255,255)` 的元素 **0 个**。
- **D-6 判定：误判，撤销。** 修复方把 `revert-layer` 灰块改成显式 `transparent` 属于无害清理，但原「白色遮罩」从未存在。

## 9.8 新增缺陷（编号自 D-22 起）

### D-22（P1 · **阻断**）`.popup` 底部弹层只能开不能关，打开后整页失去响应

- **现象**：播放详情页点「播放倍速 / 音量 / 循环 / 播放列表」任一键，弹出底部弹层后：**点击任何位置都无效**，含关闭键 (382,76)、播放/暂停 (206,719)。用户只能按返回键，而返回键会**直接退出整个播放详情页**。
- **证据**：弹层打开时 `elementFromPoint` 在 (206,300)(206,150)(382,76)(206,719) 四个点**全部**返回 `DIV.popup` —— 整个视口被 `.popup` 接管命中测试。5 次关闭尝试全部失败：①再点触发键 ②点外部 (206,300) ③再点外部 (206,120)×2 ④鼠标点击外部 ⑤下滑手势 (206,420)→(206,860) ⑥点弹层内空白区 (350,880)。
- **副作用**：点「收藏」位置 (128,837) 实际落在弹层滑块上，把倍速**静默改成 1.24x**（`aria-label` 变为「Current playback rate: 1.24x」，`.icon.active` 点亮）。控件误触会改播放状态。
- **根因**：
  1. `porting/js/ui/mobile.less:186-197` 给 `.popup` 加了 `::before { position: fixed; inset: 0; z-index: -1 }` 全屏遮罩 —— 遮罩属于 `.popup` 自身盒子，于是**视口内任意点的命中目标都变成 `.popup`**。
  2. `source/packages/view-main/src/components/base/Popup.svelte:125-134` 把 `onmouseenter={handlMsEnter}` 绑在 `.popup` 根元素上；`PopupBtn.svelte:49-58` 的 `handlMsEnter()` 会 **clearTimeout 并取消关闭**。
  3. 于是「移出触发器 → 100ms 后关闭」的定时器，在指针一落到遮罩上时就被自己取消。触摸端没有 `mouseleave` 的天然出口 → 死锁。
  4. `PopupBtn.svelte:34-41`：`autoshow=true` 时，可见状态下再点触发器是 `evt.stopPropagation(); return` —— 显式禁止点击收起。
- **修法建议**（不改产品代码，仅建议）：`mobile.less` 把遮罩改为独立兄弟节点（或 `pointer-events: none` 的纯视觉层），并补一条 `pointerdown` 捕获：命中点不在 `.popup-content` 内即关闭；或给移动端 `PopupBtn` 传 `autoshow=false` 让点击可切换。

### D-23（P1）返回键把「弹窗 + 覆盖层」一步关到底，并会留下孤儿弹窗

- **现象 A（复现 2 次）**：播放详情 + 声音设置弹窗同时存在时按返回 → **两者一起消失**，用户丢失播放详情上下文。
- **现象 B（复现 1 次）**：播放详情 + 评论弹窗时按返回 → `pd=false` **但评论弹窗仍在**，且继续跟随路由重渲染（内容从「Comments for 02-523hz-C5」变成 03-659hz-E5），最终以 `#/settings` 为背景全屏悬停；再按返回（BACK#2/#3）hash 变化但弹窗不动。**只有点击内容区上方的遮罩条（y<183）能关掉它。**
- **根因**：`porting/js/ui/boot/androidBack.ts:65-66` 的返回策略优先级是「播放详情 > hash 栈」，没有「最上层弹窗」这一层；`MainActivity.kt` 的 `JS_BACK` 每次按键只调一次 `__anylisten_goBack__()`，没有二次求值。
- **影响**：返回键契约（D-1）在「弹窗层」这一档仍然错位。用户心智是「返回 = 关掉眼前这一层」，实际是「返回 = 关掉底下那一页」。
- **说明**：评论弹窗**不是死路** —— 点遮罩可关（此点我曾误判为「只能力 kill」，见 9.10-②）。因此定 P1 而非 D-22 那种阻断。

### D-24（P2 · 观感）扩展页 chip 行高 96dp、无选中态指示弱

- 4 个 chip 高度 96px（≈95.7dp），是 44dp 标准的 2 倍，观感偏「桌面密度」；触摸目标本身达标（≥44），**不构成阻断**。
- `scrollLeft=0` 时第 4 项「Extension Store」被完全裁切（clip 右界 258，chip 左界 271.4），只有 Disabled 右边被切掉 5px 的暗示，可发现性弱。
- 循环模式浮层 5 个选项实测 **24×44**（x=20/54/88/122/156），宽度低于 44dp，且 5 个按钮无 `active` 态 —— 用户看不出当前是列表循环还是单曲循环。

### D-25（提示）文件浏览器行高 42px

- `.modal .main` 内文件行 `y=183.5, h=42`。42 < 44，差 2px。行宽满屏、实际可点面积足够，`提示`级。

### D-26（P2 · 环境相关）在线扩展商店在无网络环境下抛未捕获 Promise 拒绝

- 实测路径：`#/extenstion?type=online` → 面板显示「The list turned out to be empty…」（**优雅空态，没有白屏**），但控制台抛 `Uncaught (in promise) Error: Invalid list data`。
- 归因：`source/packages/shared/app/modules/worker/extensionService/onlineExtension/onlineList.ts:112` —— `if (!body || !Array.isArray(body.all)) throw new Error('Invalid list data')`。取证模拟器**无外网**（`ping 223.5.5.5` 100% 丢包），fetch 失败 → body 为空 → 抛错。
- **判定**：不是移动端移植缺陷，是上游对「网络失败」与「数据非法」共用同一条错误路径且无人 catch。**本轮无法验证在线商店功能本身**（环境无外网），列为未覆盖项，不得据此判「商店不可用」。

## 9.9 冷启动与稳定性（v2 独立复跑）

| 指标 | v1 | v2 实测（5 次） | 判定 |
|---|---|---|---|
| `Displayed` | 867ms | 762 / 1131 / 763 ms | 中位 763ms |
| `am start -W TotalTime` | — | 893 / 1122 ms | 均 < 1500ms |
| 六条启动判据链 | 齐全 | 齐全（`MobileApp 已挂载` @04.456 → `db.worker sqlite ready preloaded=true` @04.876 → `[ipc] 补投 1 帧` @05.135） | 通过 |
| 启动/操作期未捕获异常 | — | **0**（190s 窗口） | 通过 |
| 后台恢复 | — | 冷启动后仍能续上 `#/library?id=love` 与迷你播放器状态 | 通过 |

**D-9（冷启动 ≤1.5s）：5 次全部达标，v2 判定通过。**

## 9.10 本章的自我更正（留痕）

1. **残留弹窗污染命中测试**：我一度判定「Extension Store 完全不可达、`.list` 横滑无效」。真因是上一轮测试留下的 `.modal.filter`（z=99）盖在页面上，滑动与点全部落在弹窗上。**教训：每换一个测试对象，先断言「页面上没有别的覆盖层」（`document.querySelector('.modal,.popup')` 必须为空）再开始。**
2. **误判「评论弹窗无法关闭、只能力 kill」**：我只试了「弹窗内唯一按钮」和「返回键」，就下了「死路」结论。补测「点内容区上方遮罩 (206,140)」→ 弹窗立刻关闭。**教训：判定"无法关闭"必须穷举 ①可见关闭键 ②遮罩点击 ③返回键 ④下滑 ⑤点触发器，少一种都不能下结论。**
3. **误判「收藏键无响应」**：给 `activeCls` 快照时匹配到 `.icon.active`，我把它当成收藏成功，实际是倍速图标被点亮（因为那一下点在浮层滑块上）。**教训：状态快照要绑到具体元素（`.favorite` 的 `aria-pressed`），不要用 `[class*=active]` 这种宽选择器。**

## 9.11 三门禁复签（v2）

| 门禁 | v1 结论 | v2 结论 | 依据 |
|---|---|---|---|
| ① 功能等价性 | 不通过 | **有条件通过** | D-10/D-11/D-12/D-13/D-1 全部已修并独立复验；播放主链路（导入→播放→时长落盘→自动切歌→拖拽落盘）等价成立。**附条件**：返回键需按层关闭（D-23），交付前修掉 |
| ② 移动端触控可用性 | 不通过 | **不通过** | D-22 阻断：`.popup` 弹层打开后整页失去响应且无法关闭，播放详情页的核心控件（含播放/暂停、关闭键）全部不可达 |
| ③ 许可证合规 | 有条件通过 | **有条件通过（沿用 §4）** | 只复核签字未重做扫描；交付物 sha256 已由 `de9541…` 更新为 **`1f5c8601…`**，源码侧 `git status` 零改动、`check-webdist` 指纹自洽，§4 的 AGPL v3 §13/§7/§10 与「禁止商用」附加条款冲突（C-1/C-2）结论不变，仍需用户书面裁决后放行 |

**总判定：本轮不可交付。** 阻断项 = D-22（触控门禁），交付前必修项 = D-23（返回键分层）。

## 9.12 v2 产物

- 报告：本章（追加）
- 截图：`artifacts/shots/qa-v2-playdetail.png`、`qa-v2-back-toast.png`、`qa-v2-comments-orphan.png`
- 日志：`artifacts/logcat-qa-d10-clean.txt`（190s，`exceptions total = 0`）、`artifacts/logcat-qa-d10.txt`（前一轮，含 1 条来自在线商店的 buffer 重放）
- 新增探针：`artifacts/qa/ev.mjs`（精简求值）、`artifacts/qa/exwatch.mjs`（全程异常计数）、`artifacts/qa/pd-seq.mjs`（控制键逐个真实触摸 + 前后状态 diff）
- 未修改任何产品代码（`porting/**`、`source/**` 只读）。

---

# 10. 复验记录（v3）

> 复验时间：2026-11-03 17:44–18:10（设备时钟）。本章**追加**，不覆盖 §1–§9。
> 范围：定向复验 D-22 / D-23 / D-24 + 五项 P1 回归 + 一条分歧判定（文件选择弹窗「空目录」）。
> 纪律：**只采自己的实测值**，修复方自述仅用于定向找漏洞。

## 10.1 复验对象身份（第三轮再撞同一字节数）

| 判据 | 期望（派发值） | 实测 | 结论 |
|---|---|---|---|
| APK sha256 | `fefaef66…` | `fefaef6641e6eefa43260093552b8a6d2fcc5f26a028d42a403b17ad23d3b96d` | 一致 |
| APK 字节数 | — | **24,343,591 B（与 v1/v2 完全相同，第三次撞车）** | 不能作判据 |
| 包内入口 | `main.BcGgEkZh.js` | 同左，sha1 `bd4338dc862f…` | 一致 |
| `index.html` | sha1 `ee639c45…` | 4,020 B，sha1 `ee639c456482…` | 一致 |
| `style.BlH_nErI.css` | sha1 `657803b2…` | 206,039 B，sha1 `657803b2dc0b…` | 一致 |
| `extension-preload.js` | sha1 `f3ccf220…` | 60,761 B，sha1 `f3ccf220d789…` | 一致 |

> **一处数字对不上（不影响判定，仅留痕）**：派发信息写 `main.BcGgEkZh.js = 1,378,300 B`，包内实测 **1,379,090 B**（差 790 B）。sha1 两侧一致，说明是同一文件、测量口径不同（可能量的是 `dist` 侧或别的拷贝）。**身份判定以 sha1 为准，不以字节数。**
> 设备侧：`adb install -r` 重装后运行时 `script[src]` = `main.BcGgEkZh.js`，确认跑的就是本轮包（不是「装完没重启」的旧壳）。

交付物纪律（本人复跑，未采信任何自述）：

| 项 | 结果 |
|---|---|
| `git -C source status --porcelain` | **0 行**（HEAD `c8f40eab`） |
| `check-webdist.mjs`（默认模式） | `RC=0`，`VERDICT: OK` |
| `check-webdist.mjs --assets` | `RC=0`，`VERDICT: OK` |
| dist↔assets 交叉指纹 | 两模式均输出「3 项指纹全等（同一次构建）」 |

## 10.2 D-22 弹层关闭（本条是 v2 的阻断项）

**判据：关闭必须看 DOM 计数归零，不能只看 `opacity`。** 修复方自述里那句「状态关了、像素没变」提醒得很对，所以我把 `pc`（`document.querySelectorAll('.popup').length`）和 `live`（非 `display:none`/非 `inert`/宽>1 的存活数）分开计。

四个浮层 × 各 3 轮「开 → 点空白 (206,300) → 关」：

| 浮层 | R1 | R2 | R3 | 判定 |
|---|---|---|---|---|
| 倍速 (206,785) | 开 pc=1/live=1 → 关 **pc=0**/live=0/inert=0 | 同上 | 同上 | PASS |
| 音量 (232,837) | 开 pc=1/live=1 → 关 **pc=0** | 同上 | 同上 | PASS |
| 循环 (284,837) | 开 pc=1/live=1 → 关 **pc=0** | 同上 | 同上 | PASS |
| 播放列表 (180,837) | 开 pc=1/live=1 → 关 **pc=0** | 同上 | 同上 | PASS |

`VERDICT_D22_DOM=PASS`，全程 `EXCEPTIONS=0`。**12 次开合全部做到「打开有、关闭无」，元素真的从 DOM 里没了，不是透明度障眼法。**

重开（3 轮）：上面每轮「关」之后紧跟下一轮「开」，pc 再次变 1 —— 开关可反复，未出现「关一次就永久失效」。

浮层内选项生效并自动关闭：

| 操作 | 结果 |
|---|---|
| 循环浮层点「List random」(x=74) | `.popup` 计数 **0**（自动关）；触发器 `aria-label` 变为 **"List random"** |
| 倍速浮层点滑块 x=300 | 倍速 **1.48x**，浮层保持打开（滑块语义，符合预期）；再点空白 → pc=0 |

串台检查（这是 v2 最刺眼的一条：点「收藏」把倍速静默改成 1.24x）：

| 场景 | 期望 | 实测 | 判定 |
|---|---|---|---|
| 无浮层时点收藏位 (128,837) | 收藏切换、倍速不变 | `Favorite songs` ↔ `Cancel favorites` 正常切换；倍速恒为 **1.48x** | 通过 |
| 无浮层时点播放键 (206,719) | 播放态切换、不切歌 | `paused` ↔ `playing`；曲目恒为 `02-523hz-C5`/`03-659hz-E5` 不变 | 通过 |
| 关闭浮层后立刻点收藏 | 立即生效 | 关闭后**一次点击**即从 `Cancel favorites` → `Favorite songs` | 通过 |

穿透检查（浮层打开时点浮层外的控件）：

| 操作 | 期望 | 实测 | 判定 |
|---|---|---|---|
| 浮层开 + 点关闭键位置 (382,76) | 只关浮层，播放详情不动 | pc=0，`playDetail=1` | **不穿透** |
| 浮层开 + 点播放键位置 (206,719) | 只关浮层 | 2 轮：pc=0 且播放态**未变** | **不穿透** |

> 有 1 次早期观测到「点 (206,719) 后播放态翻转」，但发生在导入后自动切歌的窗口内，且随后 2 轮定向复现均为「不穿透」→ 判为观测污染，**结论取「不穿透」**，并如实保留这条不确定度。

**几何重叠（不是缺陷，但要记清楚）**：倍速/音量浮层的内容区实测 `[0,807,412,60]`，正好压住下排 4 个键（收藏/播放列表/音量/循环，y 815–859）。这是底部抽屉的正常语义 —— 用户看见的是浮层、看不见那 4 个键，点在那条带上落在滑块上是对的。v2 里「点收藏把倍速改了」的本质就是这条几何重叠 + 当时无法关闭，两者叠加才成了事故；现在关闭路径通了，同一处点击不再构成陷阱。

## 10.3 D-23 返回键分层（v2 的 P1）

逐次按返回，用 `__anylisten_back_debug__()` 取值（`{playDetail, popup}`）+ 我自己的 DOM 存活计数双判据：

| 步 | 操作 | `debug()` | DOM 存活 | Activity | 判定 |
|---|---|---|---|---|---|
| 0 | 播放详情 + 倍速浮层 | `playDetail:true, popup:true` | popup 1 / playDetail 1 | 前台 | 起点 |
| 1 | 返回 #1 | `playDetail:true, **popup:false**` | **popup 0** / playDetail 1 | 前台 | **分层正确**（只关浮层） |
| 2 | 返回 #2 | `playDetail:false, popup:false`，`canGoBack:false` | popup 0 / playDetail 0 | 前台 | 关覆盖层，不退 App |
| 3 | 返回 #3 | 同上 | 同上 | 前台 + Toast「再按一次退出」 | 根级提示正确 |
| 4 | 900ms 内连按两次 | — | — | `topResumedActivity=launcher` | 退出正确 |

**无孤儿 `.popup`**：全程 popup 计数 0/1 变化干净，未出现「播放详情没了、浮层还在」。

子页回退未回归：`#/extenstion` →（返回）→ `#/settings`，`canGoBack` 由 true 变 false。

### D-27（P2 · 非阻断）返回键分层未覆盖 `.modal`，弹窗层仍会「一步到底 / 孤儿化」

- **证据 A（声音设置）**：播放详情 + 声音设置弹窗时按返回 → `popup:0, playDetail:0, modal:0` —— **两者一起消失**。用户按一次返回，丢掉整个播放详情上下文（与 v2 现象 A 相同）。
- **证据 B（评论弹窗）**：播放详情 + 评论弹窗时按返回 → `playDetail:0` 但 **`modal:1` 残留**，弹窗以 `#/library` 为背景全屏悬停；再按返回 hash 变化、弹窗不动（与 v2 现象 B 相同）。点内容区上方遮罩条（y<183）可关，**不是死路**。
- **根因**：`porting/js/ui/boot/androidBack.ts:112` 的 `canGoBack` 与 `:118-126` 的 `goBack()` 第 1 档只判 `findOpenPopup()`（`POPUP_SEL='.popup'` / `MENU_SEL='.menu'`），**`.modal` 不在其中**。声音设置与评论弹窗都是 `.modal svelte-2y1fin filter`，于是第 1 档跳过、第 2 档直接点播放详情的关闭键。
- **为什么不定阻断**：两条都能自行恢复（重开播放详情 / 点遮罩），不影响播放主链路；且 `.popup` 这一层（v2 真正卡死的那层）已经完全正确。
- **修法建议**：把 `.modal`（至少 Portal 到 `#root` 的那些）纳入第 1 档；`dismissPopup` 对 `.modal` 没有 `mouseleave` 可用，需要另找关闭口（这些弹窗多数有 `.header` 关闭键或无键仅遮罩，可统一用「点遮罩」的几何判据）。

## 10.4 D-24 循环浮层选项尺寸（v2 的 P2）

| 项 | v2 实测 | v3 实测 | 判定 |
|---|---|---|---|
| 选项尺寸 | 24×44 ×5 | **44×44 ×5** | **已修** |
| x 坐标 | 20/54/88/122/156（间距 10，24 宽） | 20/74/128/182/236（间距 10，44 宽） | — |
| 最右边界 | 180 | **280**（视口 412.2） | 不溢出（`overflow412 = 0`） |
| `.popup-content` 宽度 | 230（内容没撑满） | **[0,807,412.2,60]**（满宽） | 已修 |
| 选中态 | 无 | 仍无 —— 但**这是上游设计**：`TogglePlayModeBtn.svelte` 的 5 个选项按钮只有 `class="btn"`，源码里就没有 active 分支 | 不算移植缺陷 |

当前模式靠触发器体现，实测有效：点「List random」后触发器 `aria-label` 变为 `List random`、图标随 `togglePlayMethod` 切换。

## 10.5 五项 P1 回归（各取一条判据）

| 回归项 | 判据 | 实测 | 判定 |
|---|---|---|---|
| D-10 播放详情 | 11 个控制键中抽 ≥4 个真实触摸 | 本轮实际逐个摸到 **9 个**：关闭/上一首/播放/下一首/声音设置/倍速/音量/循环/播放列表/收藏，全部有状态变化或面板吐内容 | 通过 |
| D-11 设置 13 项 | 横滑到最右并能进面板 | `sw=1793 / cw=412 / max=1381`，真实滑到 **sl=1381**，点「About Any Listen」→ `#/settings?type=app&id=about`，面板渲出 | 通过 |
| D-12 扩展入口 | 入口按钮进扩展页 | `.ab-entry` = `[314.2,54,94,44]`（94×44）→ `#/extenstion`，AppBar 标题 `Extensions` | 通过 |
| D-13 返回键契约在包内 | 三符号 + 可调用 | `typeof __anylisten_canGoBack__ / goBack / back_debug__` 均为 `function` | 通过 |

## 10.6 分歧判定：「文件选择弹窗在 `/storage/emulated/0` 下目录列表恒为空」——**不成立，修复方误诊**

### 我先独立核对设备前置条件（不采信任何一方的说法）

| 项 | 实测 |
|---|---|
| `/storage/emulated/0/Music/AnyListenTest/` | 3 个文件都在：`01-440hz-A4.wav`、`02-523hz-C5.wav`、`03-659hz-E5.wav`（各 1,058,444 B） |
| `READ_MEDIA_AUDIO` | `granted=true` |
| `appops MANAGE_EXTERNAL_STORAGE` | `Uid mode: allow` / `MANAGE_EXTERNAL_STORAGE: allow` |

### 端到端复跑（全程真实触摸，起点是曲库空态）

| 步 | 操作 | 实测 |
|---|---|---|
| 1 | `#/library?id=default`（空列表） | 空态渲出：`No music yet / Import songs from this device to start your library` + 按钮 **`Import local music`** `[206,479,320×52]` |
| 2 | 真实触摸该按钮 | 弹出文件浏览器，标题 **`Select song file`**，`.list` 内 **1 行**：`/storage/emulated/0` |
| 3 | **双击**该根行（`createClickHandle`：单击=选中、双击=进入） | 列表变 **13 行**：`Android / Download / Music / Podcasts / Ringtones / Alarms / Notifications / Pictures / Movies / DCIM / Documents / Audiobooks / Recordings` |
| 4 | 双击 `Music` | 2 行：`.thumbnails`、`AnyListenTest` |
| 5 | 双击 `AnyListenTest` | **3 行**：`01-440hz-A4.wav`、`02-523hz-C5.wav`、`03-659hz-E5.wav` |
| 6 | 点 `Select all` | 文案变 `Uncheck` + **`3 item selected`** |
| 7 | 点 `Confirm` | 弹窗关；3.5s 后回到列表：**`Listening list · 3`**，三首 `01-440hz-A4 / 02-523hz-C5 / 03-659hz-E5`，均 `local WAV 00:12`（截图 `artifacts/shots/qa-v3-import-result.png`） |

**结论：目录列举、逐层进入、文件多选、确认入库，四步全通，「恒为空」不成立。**

### 为什么会误诊（这是我认为最有价值的那部分）

- 首层**只有一行 `行 /storage/emulated/0`** —— 它既是「根目录项」又是「路径显示」，看起来像"列表坏了"。
- `Open.svelte` 的 `createClickHandle` 语义是**单击=选中、双击=进入**。单击那一行只会选中（无任何视觉变化），列表因此纹丝不动 → 观察者得到"点了没反应 / 目录是空的"。
- 我用 `artifacts/qa/dbltap.mjs`（同一连接内两次触摸，间隔 ~120ms）一次就进去了；用两次独立 `accept-touch.mjs` 调用（每次都要新起一个进程，间隔 >300ms）则**进不去** —— 这正好解释了"他能复现、我复现不了"的差异：**不是环境不同，是双击间隔不同**。

### 我的定级

| 编号 | 级别 | 说明 |
|---|---|---|
| —（不编号） | **不列为缺陷** | 「空目录」不成立，不入缺陷清单 |
| D-28 | 提示 | 文件浏览器首层把「唯一根目录」渲染成一个必须双击的路径行，且**没有任何"双击进入"的提示**（其他列表页单击即进入）。这是易误诊的根源，建议首层直接展开根目录内容，或加"双击进入"的次级文案 |

## 10.7 未捕获异常与冷启动（顺带复核）

- 本轮从冷启动到导入完成，`logcat | grep -ci uncaught` = **0**；每次 CDP 求值的 `[uncaught]` 均为 0。
- 冷启动 `TotalTime` 1111ms（<1.5s），重装后 `Displayed +313ms` 属**热启动**（进程未死），不作为冷启动样本。

## 10.8 三门禁复签（v3）

| 门禁 | v2 结论 | v3 结论 | 依据 |
|---|---|---|---|
| ① 功能等价性 | 有条件通过 | **通过** | D-10/D-11/D-12/D-13 回归全绿；导入链路（空态 → 选目录 → 多选 → 入库 → 可播放）端到端首次完整验证通过；播放/切歌/进度拖拽/时长落盘与 v2 一致 |
| ② 移动端触控可用性 | 不通过 | **通过** | D-22 修复实证：4 浮层 × 3 轮共 12 次开合，DOM 计数全部归零；选项点击生效且自动关闭；串台消失；关闭后控件一次点击即响应。D-24 尺寸达标（44×44，不溢出） |
| ③ 许可证合规 | 有条件通过 | **有条件通过（沿用 §4）** | 未重做扫描；交付物 sha256 更新为 **`fefaef66…`**；`git status` 零改动、`check-webdist` 两模式 OK 且 dist↔assets 三指纹全等；§4 的 AGPL v3 §13/§7/§10 与「禁止商用」附加条款冲突（C-1/C-2）结论不变，**仍需用户书面裁决** |

**总判定：可交付。** 交付物 = `porting/android/app/build/outputs/apk/debug/app-debug.apk`，sha256 `fefaef6641e6eefa43260093552b8a6d2fcc5f26a028d42a403b17ad23d3b96d`，24,343,591 B。

**放行时须知会用户的三条**：
1. 许可证 C-1/C-2 是**独立于本轮技术验收**的合规前置条件，技术门禁通过不等于可以商用分发。
2. D-27（`.modal` 不在返回键第 1 档）：可恢复、不阻断，建议下一轮修。
3. D-28（文件浏览器首层无双击提示）：提示级，建议下一轮改文案或直接展开根目录。

## 10.9 v3 产物

- 报告：本章（追加）
- 截图：`artifacts/shots/qa-v3-import-result.png`（导入后「Listening list · 3」）、`qa-v3-back-toast.png`
- 新增探针：`artifacts/qa/d22.mjs`（四浮层 × 3 轮 DOM 计数）、`artifacts/qa/d23.mjs`（返回键逐次 `debug()` 快照）
- 未修改任何产品代码（`porting/**`、`source/**` 只读）。

## 10.10 本章的自我更正

1. **第一次判定「目录恒为空」时差点跟着修复方走**：我看到 `.list` 里只有 1 行 `/storage/emulated/0`、点它不动、连 `fs` 的 bridge 帧都没有，几乎要签字认可。补做「换专用双击脚本」这一步之后，13 个目录一次就出来了。**教训：当一个"坏"的结论与另一个人的自述完全吻合时，恰恰要加倍怀疑自己的复现手法 —— 合意比分歧更容易骗人。**
2. **差点把「点播放位使播放态翻转」记成穿透**：那条观测落在自动切歌窗口里，状态本来就会变。随后 3 次定向复现（含用「关闭键位置」做对照）全部显示不穿透，才改了口径。**教训：判"穿透"必须选一个「一旦穿透就不可逆」的靶子（如关闭键），不能用会自然变化的播放态。**

---

## 11. 真机验收补充（arm64 / Android 16）

> 本节为**团队主理人**在 §10 签字后补跑的真机验证，用于关闭 §10 中「未覆盖：arm64 真机」这条残余风险。**未修改任何产品代码，也未重述 §10 的结论**——v3 包仍是定稿包。

### 11.1 验收对象与环境

| 项 | 值 |
|---|---|
| 设备 | Xiaomi `2211133C`，Android 16，`arm64-v8a` |
| 视口 | 1080×2400 物理 / **393×872 CSS px**，`dpr 2.75` |
| 交付物 | `app-debug.apk`，24,343,591 B，sha256 `fefaef66…d3b96d`（装机后回读**逐字节一致**） |
| ABI 依赖 | 包内 `lib/` 为空、`.so` 数 **0** → **ABI 无关**（原生仅 WebView + quickjs wasm），「arm64 缺库」这条风险不成立 |

### 11.2 实测结果（真机，非模拟器）

| 判据 | 实测值 | 判定 |
|---|---|---|
| 冷启动 `TotalTime` | **490 ms**（COLD，`am start -W`） | 优于 1.5s 目标；模拟器同口径为 867ms |
| 六条判据链 | `已挂载 26.306` → `dataPath 26.447` → `sqlite ready preloaded=true 26.648` → `quickjs ready 26.804` → `ipc connected 26.838` → `core worker ready 26.839` | 齐全、顺序正确 |
| 崩溃 / ANR | 0 / 0 | — |
| 导入本地音乐 | 3 个 wav（`/storage/emulated/0/Music/AnyListenTest`）→ 双击进目录 → 全选 → 确认 → 列表「试听列表 3」 | 通过（**同样需要双击**，与 D-28 一致） |
| 设置页 13 项 | `.settings-app-list` = **392.7px**（原 1793.12），`.list` client 393 / scroll 1299；真实横滑 `scrollLeft 0→407→508`；扩展服务设置 / 网络设置 / 备份与恢复 三项真实触摸均进面板且 hash 正确 | D-11 在真机成立 |
| 播放详情 | `.play-detail` = 393×873 全屏；`.left-info` 高 **222**（原 8）；11 个按钮**全部在视口内**（`out=0`）；aria-label 齐全 | D-10 在真机成立 |
| 底部弹层 | 音量浮层 ×3 轮：开 → `.popup` 计数 1，点弹层外 → **0**，无 `[inert]` 残留，播放详情保持 | D-22 在真机成立 |
| 返回键分层 | 弹层开+详情开：返回 #1 关弹层（详情留）→ #2 关详情 → #3 根页 Toast，Activity 仍前台 | D-23 在真机成立 |

### 11.3 真机新发现（v3 包未覆盖）

**D-29（P2）自动备份在 Android 上从未生效**
每次冷启动都打：`[dbService] backup failed init PortError: fs.createReadStream is not available on Android: synchronous IO is forbidden in the porting layer`（真机 2/2 次冷启动各 1 条；模拟器历史日志 0 条，属数据状态差异而非设备差异）。
根因：`source/packages/shared/app/modules/worker/dbService/backupTask/index.ts:85` 在 init 阶段调 `backup(db,'init')`，其 `storage.ts:33` 的 `hashFileSha256` 用 `createReadStream`，而移植层明确禁止该 API。
影响：自动备份不产生文件，「备份与恢复」不可用；不影响播放与曲库。
建议修法：在 fs port 里实现 `createReadStream`（或在 `porting/js/ui/overrides` 覆写 `storage.ts`，改用 `fs.readFile` + `createHash`）。

**D-30（P2）进入「日志输出」页每次抛一条未捕获异常**
`Uncaught (in promise) Error: ENOENT: log file not found, '/data/user/0/com.anylisten.android/files/app/logs/app.log'`（每次进入该页复现，单次会话累计 4 条）。页面本身仍渲染日志内容，属噪声型缺陷。

**D-16「行点击不播放」在真机复现，建议提级**
单击歌曲行无反应（无起播、无迷你播放器），**双击才起播**。与 D-28（文件浏览器首层需双击）同源：上游把桌面双击语义直接带到了触屏。对「音乐播放器」这个品类，单击不出声等价于主功能不可用，建议从 P2 提到 **P1（体验型）**，最小修法是在移动壳里把行单击映射为播放。

### 11.4 本章的取证教训（供后续复用）

1. **Git Bash 会改写以 `/` 开头的参数**：`node x.mjs "$WS" "/storage/emulated/0"` 被 MSYS 转成 `C:/…/PortableGit/storage/emulated/0`，表现为「行找不到」。必须 `export MSYS_NO_PATHCONV=1`。
2. **横向滚动容器的吸附会让「先量后点」失效**：量完坐标到派发触摸之间隔着一个进程启动（100ms+），`scroll-snap` 已把列表挪走，点中的是邻项。正确做法是**同一 CDP 连接内**完成「滚动 → 取坐标 → 派发触摸」。
3. **不要在真机上做自动化时假设设备独占**：本轮多次出现非我方发起的跳转（`#/extenstion`、`#/settings?type=logs`、主题色面板），经比对是用户同时操作所致；一旦出现，应立即停手并说明，而不是把噪声记成缺陷。

---

## 12. D-29 / D-30 修复复验（真机）

> 本节由**团队主理人**在 §11 之后补跑，验证 D-29（自动备份从未生效）与 D-30（日志页 ENOENT）两项修复。v1~v3 与 §11 结论不变；§10 的三道门禁签字对定稿包仍然有效。

### 12.1 交付物身份

| 项 | 值 |
|---|---|
| APK | `app-debug.apk`，**24,343,888 B**，sha256 `244af0ad4fa9608cbf1c983129af937983129276bdf5e8114fa4e7a1cc52d8b8` |
| 装机回读 | `adb pull` 后 sha256 与上表**逐字节一致** |
| 包内入口 | `assets/web/spa/assets/main.B1xxKOTu.js`（1,379,090 B / sha1 `e77ed6e3…`） |
| 一致性门禁 | `check-webdist.mjs` 默认与 `--assets` 两模式均 `VERDICT: OK` + 「dist↔assets 3 项指纹全等」 |
| 上游改动 | `git -C source status --porcelain` = **0 行** |

> 本轮包大小首次与前三轮不同（24,343,888 vs 24,343,591），但**仍不能靠大小判身份**；一律用 sha256 + 包内 `main.*.js` 文件名。

### 12.2 修复前后对照

| 判据 | 修复前（§11 实测） | 修复后（本轮真机） |
|---|---|---|
| 冷启动 `backup failed init` | **每次冷启动 1 条**（2/2 复现） | **0 条**（连续 2 次冷启动，`grep -ac` 均为 0） |
| 备份产物 | 只有 1 个文件 `anylisten.data.db.20261103-150250483.bak`（11-03 15:02），此后 30 小时未再产生 | 新增 `anylisten.data.db.20261104-093003313.bak`（**114,688 B**，09:30:03）；第二次冷启动后文件数仍为 2 → 同日去重生效 |
| 日志落盘位置 | `files/logs/anylisten-2026-11-04.log`（274,041 B）—— 而 UI 读的是 `files/app/logs/app.log` | `files/app/logs/app.log` 生成，4,093 B → 第二次冷启动后 8,186 B；**旧目录停在 274,041 B 不再增长** |
| 日志页未捕获异常 | 每次进入 1 条 `Uncaught (in promise) Error: ENOENT: log file not found`（单会话累计 4 条） | **0 条**（进出两轮，`Runtime.exceptionThrown` 计数 0） |
| 日志页内容 | 空 | `pre` 文本 **3,943 字符**，首行 `11-04 09:30:02.785 I AnyListen/webview: [main] 桥已就绪…`；两轮进入内容一致 |
| 冷启动耗时 | 490 ms | 720 ms / **486 ms**（两次，`TotalTime`） |
| 崩溃 / ANR | 0 / 0 | 0 / 0 |

### 12.3 根因与修法（与 PDR ERR-021 / ERR-022 对应）

**D-29**：`backupTask/storage.ts:33` 用 `fs.createReadStream` 算 sha256 做「与上一份备份是否相同」的去重判断；移植层 `shims/fs.ts` 把它实现成直接抛 `EUNSUPPORTED`。所以**首份备份能成功（无需比对），从第二份起每次都在去重这一步失败**，且 `saveMetadataLastBackupTime` 永不写入 → 每次启动都重试、每次都失败。修法是在垫片里给出最小可用实现（异步读全文件 → 按 `start`/`end` 切片 → `data`/`end`/`error` + `pipe`/`destroy`）。

**D-30**：不是「读文件没容错」，而是**写读两端路径从未对齐**——Kotlin 端写 `files/logs/anylisten-<日期>.log`，JS 端按上游 `joinPath(dataPath,'logs')+'app.log'` 读 `files/app/logs/app.log`。修法：Kotlin 落盘改到 `files/app/logs/app.log`；`readLastLines` 对「文件不存在」返回空列表（日志文件本就惰性创建）；JS 桥接层再加一层降级，避免任何异常穿透到页面。

### 12.4 本轮未覆盖 / 需注意

1. **旧日志未迁移**：`files/logs/*.log` 保留原样（不删用户数据），只是不再增长。若需要历史日志，得手工搬运。
2. **`createReadStream` 的内存语义**：垫片是「读全文件再切片」，不适用于大文件流式转发。目前唯一消费者是备份哈希（110 KB 级）；`proxyServer/proxy.ts` 若走到这条路径，单次会把整个媒体文件读进内存，属已知取舍，已写进垫片注释。
3. **备份恢复链路未做端到端演练**（只验证了「备份产出 + 去重」，未验证「从 .bak 恢复」）。
4. **D-16 仍未修**：本轮另行做了干净 A/B——暂停态下单击第 2 首，播放状态不变；必须在 400 ms 内再次点击才起播。根因是上游 `MusicList/List/action.ts:48-66` 手写的双击窗口，不是浏览器 `dblclick`。

---

## 13. D-16 修复复验（单击即播，真机）

> 本节验证 D-16：曲库行与播放列表（队列）的「单击不出声、必须 400ms 内再点一次」。§10~§12 结论不变。

### 13.1 缺陷事实（修前，干净 A/B）

上游不是浏览器 `dblclick`，而是**手写的 400ms 双击窗口**：

```ts
// source/packages/view-main/src/components/common/MusicList/List/action.ts:48-66
let clickTime = 0, clickInfo = null
export const musicClick = async (...) => {
  if (performance.now() - clickTime > 400 || clickInfo !== musicInfo) {
    clickTime = performance.now(); clickInfo = musicInfo
    return                 // ← 第一次点击：只记时间，什么都不做
  }
  clickTime = 0; clickInfo = null
  void playMusic(...)      // ← 400ms 内点同一首：才起播
}
```

同一形态还有第二个入口：`PlaylistBtn/shared.ts` 用 `createClickHandle(() => {}, index => playIndex(index))`，即播放列表（队列）首击空转。

修前实测（真机，暂停态）：单击第 2 首 → 迷你播放器按钮仍是「播放」、`play_time` 不增长；必须在 400ms 内再点一次才起播。

### 13.2 修法

| 入口 | 文件 | 改法 |
|---|---|---|
| 曲库列表 | `porting/js/ui/overrides/components/common/MusicList/List/index.svelte` | 单击分支由 `musicClick(...)` 改为 `playMusic(...)`；`select.setSelectIndex(index)` 保留；多选分支原样不动 |
| 播放列表（队列） | `porting/js/ui/overrides/components/common/PlaylistBtn/shared.ts`（**新增** O-8） | `musicClick = (index) => playIndex(index)`，去掉 400ms 窗口；`removeMusic`/`playIndex`/`TabType` 原样保留 |

两处都在 `porting/` 覆写层，`source/` 零改动（覆写机制见 `porting/js/README.md` §3.5）。

### 13.3 修复后实测（真机，同一台 Xiaomi 2211133C / Android 16）

| 用例 | 操作 | 结果 |
|---|---|---|
| 曲库单击起播 | 暂停态（迷你播放器显示「播放」）→ 单击第 2 首 | 立即起播：按钮变「暂停」、迷你播放器曲名变 `02-523hz-C5` |
| 曲库单击换歌 | 播放中 → 单击第 3 首 | 切到 `03-659hz-E5`，无二次点击 |
| 队列单击切歌 | 详情 → 播放列表浮层（3 项）→ 单击第 1 项 | 当前曲 `03-659hz-E5` → `01-440hz-A4`，**一次点击**生效 |
| 多选不回归 | 点「多选」→ 底部条出现「已选 0 项」→ 点第 2 行 | 底部条变「已选 1 项」，当前曲保持 `03-659hz-E5` **不变**（只选中、不播放） |
| 长按菜单 | 未改动（仍由 document 层合成 `contextmenu`） | 不受影响 |

### 13.4 交付物与门禁

| 项 | 值 |
|---|---|
| APK | 24,343,888 B，sha256 `9c9b186e3b8fd9b5c22a9dba5a18f588801de872a0b7437aec71bb35d41d9874` |
| 包内入口 | `assets/web/spa/assets/main.Z6HMLjsc.js` |
| 一致性 | `check-webdist.mjs` → `VERDICT: OK`（dist↔assets 3 项指纹全等） |
| 上游 | `git -C source status --porcelain` = 0 行 |

> 本包与 D-29/D-30 那一版**字节数相同**（都是 24,343,888），必须用 sha256 + 包内 `main.*.js` 判身份。

### 13.5 顺带记录的观察（未定级）

**长时间息屏后恢复出现 `chrome-error://`**：验证过程中手机进入 Doze 约十分钟，唤醒后 WebView 显示 `chrome-error://chromewebdata/`，页面为空；杀进程重启即恢复。随后做了对照：息屏 8 秒 → 唤醒，页面完好（`#/library?id=default`，3 行）。判断是系统回收渲染进程后没有重建路径，与本次改动无关，登记为 **D-31（P2）**，建议在 `WebViewClient.onRenderProcessGone` 里重建 WebView 并重新 loadUrl。

---

## 14. D-31 / D-27 修复复验（真机，2026-11-04）

D-31 是 §13.5 里顺带记录的那条观察，D-27 是 v3 缺陷清单里最后一条 P2。两条都在本轮修完，本轮之后**已知遗留里不再有「会导致功能不可用」的项**。

### 14.1 结论速览

| 编号 | 原现象 | 是否修复 | 证据 |
|---|---|---|---|
| D-31 | 长时息屏/后台后 WebView 渲染进程被回收，回来是 `chrome-error://`，只能强杀 | **已修** | `Page.crash` 连杀三次（含后台态）：进程号不变、573 / 679ms 恢复、`core worker ready` 重现、0 FATAL |
| D-27 | 「播放详情 + 声音设置」按返回把播放详情关掉、弹窗留成孤儿 | **已修** | 连按三次返回：倍速浮层 → 音效弹窗 → 播放详情，逐级关闭；探针证明未误触弹窗内「重置」 |

### 14.2 D-31：`onRenderProcessGone` 从来没实现过

**修前证据**：`grep -rn "onRenderProcessGone" --include=*.kt porting/android` **零命中**。也就是说系统回收渲染进程时，`WebViewClient` 用的是框架默认实现 —— 返回 `false`，语义是「我不处理」，Android 会**直接杀掉整个 app 进程**。而 §13.5 观察到的现象是「App 还在、但页面变成错误页」，说明实际发生的是另一条路径：渲染进程没了 → 页面进了 `chrome-error://` → 没有任何代码去重新导航。

**修法**（`MainActivity.kt` / `LifecycleHub.kt`）：

| 落点 | 改法 | 为什么 |
|---|---|---|
| `createWebView()` | 把 WebView 装配（settings / 两个 client / JS 接口 / 背景色）抽成单一函数，初建与重建共用 | 两套配置必然慢慢漂移，这是这类修复最典型的回归点 |
| `onRenderProcessGone` | 返回 `true`，在 `rootLayout.post{}` 里走重建 | 返回 false = 杀进程；回调正处在框架清理渲染进程的过程中，立刻 new 会撞 `AwContents` |
| `rebuildWebView()` | 「摘视图 → `destroy()` → 新建 → 加入 → `loadApp()`」 | 返回 true 之后旧实例即不可再用，顺序反了会抛 `Cannot create a WebView while another is being destroyed` |
| `LifecycleHub.clear()` | 重建时清空四类订阅 | 四个列表是「注册即追加」，JS 每次重载都再注册一遍 → 按重建次数线性叠加 |
| `onResume` | `webView.url` 以 `chrome-error` 开头 → `recoverPage()` | 部分机型不回调 `onRenderProcessGone`，得有一条兜底 |
| `onReceivedError`（主文档） | 本地服务不可达 → `recoverPage()` | 渲染进程刚重建、或 socket 被关时，一次重新导航就能自愈 |
| `recoverPage()` | 60s 滑动窗口内最多 3 次，1.5s 去抖，延迟 400ms | 用窗口不用计数器：成功后不需要「复位」，复位点漏一个就永久不重试 |
| FrameSender | 用 `webViewAttached` 挡掉重建窗口内的在途帧 | 此时 `evaluateJavascript` 会抛，而且这些帧本来就没有接收方 |

### 14.3 D-27：「弹窗」不是「弹层」

**根因**：返回键优先级原先是三档（`.popup` → 播放详情 → hash 栈）。`material/Modal.svelte` 的 `.modal` 是**居中对话框**，既不是底部抽屉（`.popup`）也不是整屏覆盖层（播放详情），于是被漏在档位之外 —— 在「播放详情 + 声音设置」时按返回，第 2 档直接命中播放详情，弹窗反而留成孤儿。

**修法**：改成四档 `弹层 → 弹窗 → 播放详情 → hash 栈`，第 2 档调 `dismissModal()`。

**关闭入口的选择**（三个都不对，只有一个能用）：

| 候选 | 结论 |
|---|---|
| 点 header 关闭键 | **本构建不存在**：`Modal.svelte:157-166` 的 header 只在 `VITE_IS_DESKTOP` / `VITE_IS_WEB` 分支渲染，两者皆 false（与 O-7 / D-10 同源） |
| 点背景（`domClick` + `bgclose`） | 页面级 `domClick` 只在 `evt.target === evt.currentTarget` 时触发，从返回键无法合成这种手势 |
| 派发 `mouseleave`（`.popup` 那条路） | Modal 根本没有 `onmouseleave` |
| **给 `.content` 派发 Escape** | ✅ 上游 `onkeydown` 处理 Escape → `close()` → `visible = false` → `{#if visible}` 卸载，与桌面「按 Esc 关弹窗」完全同一条路径 |

**踩到的坑（差点变成新缺陷）**：第一版写的是 `el.querySelector('.header button')`。音效面板的**内容区自带 `.header`**，里面有两个「重置」按钮 —— 实测按返回键时 `goBack()` 返回了 `true`、弹窗却没关，同时「重置」被点了。改成 `:scope > .content > header > button` 严格作用域后修复，并加探针验证 `__resetClicked === false`。

### 14.4 实测记录（Xiaomi 2211133C / Android 16 / 393×872 CSS / dpr 2.75）

**D-31 · 渲染进程回收**

| 用例 | 操作 | 结果 |
|---|---|---|
| 前台崩溃 | CDP `Page.crash` | `onRenderProcessGone: didCrash=true exitStatus=2` → `rebuildWebView` → 573ms 后 `core worker ready`，页面回到 `#/library?id=default` |
| 二次崩溃 | 再 `Page.crash` | 同样重建成功，进程号 16460 不变，0 FATAL |
| 后台崩溃 | HOME 切后台 → `Page.crash` → 回前台 | 后台时就收到回调并重建，回前台直接是可交互页面（`main.CJYsJ0I6.js`） |
| 交付包三次崩溃 | 新包上再杀一次 + 冷启动 | 679ms 恢复，`FATAL EXCEPTION` 0 |
| 订阅不叠加 | `am send-trim-memory RUNNING_LOW` | `[lifecycle] onTrimMemory` 只出现 **1** 条（若未 `clear()` 会按重建次数翻倍） |
| 回归 | 冷启动 `Displayed` | 790ms；六条判据齐全；`backup failed` 0；备份文件仍为 2 份（同日去重生效）；`files/app/logs/app.log` 172KB 持续写入 |

> `send-trim-memory` 的等级只能升不能降，所以「计数」这项**每个 app 进程只能测一次**；上面那次是在已经重建过 1 次之后测的。

**D-27 · 返回键四档**

| 操作 | 期望 | 实测 |
|---|---|---|
| 打开音效弹窗（`.modal` 存在，`back_debug().modal = true`） | 可判为「能返回」 | ✅ |
| 第 1 次返回（此时还开着一个倍速浮层） | 只关浮层 | `popup:false, modal:true, playDetail:true` |
| 第 2 次返回 | 只关弹窗 | `popup:false, modal:false, playDetail:true` |
| 第 3 次返回 | 关播放详情 | `playDetail:false`，hash 仍为 `#/library?id=default` |
| 「重置」误触探针 | 不得触发 | `__resetClicked === false` |

### 14.5 交付物与门禁

| 项 | 值 |
|---|---|
| APK | 24,343,888 B，sha256 `ceb58fa9aa138cd71388c79004e32b870b2064062b86f8fb6e0d1e0312708df6` |
| 包内入口 | `assets/web/spa/assets/main.CJYsJ0I6.js` |
| Kotlin 进包证据 | `classes13.dex` 内含 `recoverPage` / `rebuildWebView` 符号 |
| 一致性 | `check-webdist.mjs --assets` → `VERDICT: OK`（3 项指纹全等） |
| 上游 | `git -C source status --porcelain` = 0 行（HEAD `c8f40eab`） |
| 类型检查 | `pnpm typecheck` 通过（strict，0 错误） |

> 本轮三个包（`9c9b186e` → `dac48f69` → `ceb58fa9`）**字节数全部相同**（24,343,888）。D-13 的教训要一直带着：判身份只用 sha256 + 包内 `main.*.js` 名，必要时再 grep dex。

### 14.6 顺带观察（未定级）

1. **`.trash` 拖慢构建**：`porting/js/.trash/` 累积了 9 个 old 目录（约 200 MB），每次 `build:all` 的 clean 阶段都要尝试删除、失败后继续，实测把构建从 17 分钟拖到 25 分钟。手工清空即可。
2. **gradle 会重复跑 JS 构建**：`:webassets:syncWebAssets` 依赖 `buildWebJs`，所以「先 `pnpm build:all` 再 `./gradlew assembleDebug`」= 跑两遍（约 45 分钟）。给了 `-PskipWeb=true` 之后是 22 秒，已写进 README 构建段。
3. **`mobile.less` 里 `.modal .header` 那 5 条规则是死样式**：本构建 Modal 不渲染 header。留着不影响，但别照着它推断「手机上有关闭键」。

---

## 15. 扩展商店：为什么是空的（D-32 / D-33，真机，2026-11-04 15:0x）

现象：扩展管理 → 扩展商店恒定显示「列表竟然是空的...」，8 个在线扩展一个都不显示。
此前 QA 把这页记为「未覆盖（取证机无外网）」。**这个前提本身是错的** —— 本轮实测设备网络
能到数据源：`fetch` GitHub raw 返回 200 / 339 ms，jsdelivr 897 ms，`list.json` 5,171 字节。

### 15.1 D-32：`parseBody` 用错了头（P1，功能不可用）

| 项 | 内容 |
|---|---|
| 落点 | `porting/js/nodejs/request.ts` → `parseBody()` |
| 上游语义 | `source/packages/shared/nodejs/request.ts:286` —— `!headers['content-type'] \|\| headers['content-type'].includes(json)`，`headers` 是 **`buildRequestBody()` 返回的请求头**。GET 没有 body ⇒ 没有 Content-Type ⇒ 条件恒真 ⇒ 一律先试 `JSON.parse`，失败才退回文本 |
| 移植层 | 传的是 `responseHeaders`。GitHub raw 对 `.json` 返回 `text/plain; charset=utf-8` ⇒ 不解析 ⇒ `body` 是字符串 |
| 后果链 | `onlineList.ts:112` 的 `!Array.isArray(body.all)` → 抛 `Invalid list data`（logcat 实测：`[main] unhandled rejection Error: Invalid list data`） |
| 为什么长期没被发现 | `eachMirror` 只在**请求 reject** 时换镜像（`mirrorReuqest.ts:eachMirror` 的 `.catch`），**数据校验失败不回退**。所以「raw 连得上」的网络必挂，「raw 连不上、走 jsdelivr」反而正常 —— 国内桌面环境正好是后者 |

**修法**：`parseBody(text, headers)`（传请求头），并在函数头写明这个判据为什么不能用响应头。

**实测**：修复后商店列出 8 个扩展（Online Metadata / LX Music API Source Loader / GD音乐台 /
LX Music List Transform …），名称、中文描述、版本号、安装按钮齐全；`Invalid list data` 计数 0，
`FATAL EXCEPTION` 0。

### 15.2 D-33：数据有了之后才暴露的三处桌面尺寸（P2，观感）

| # | 冲突点 | 表现 |
|---|---|---|
| ① | `mobile.less` 的 `html.mobile ul { grid-template-columns: repeat(auto-fill, minmax(150px,1fr)) !important }` | 把所有 `ul` 强制两列（361px 视口 → 两列 174px） |
| ② | 卡片 `min-width:300px; height:100px`（pxtorem 后 58px） | 卡片比所在列宽 → 互相压盖；内容需 ~94px → 描述压到版本行上 |
| ③ | `mobile.less` 的「封面 96dp」：`html.mobile .view-container > .header .left { width:96px !important; height:96px !important }` | **误命中 Tab 条** —— 上游 `Tab.svelte` 的对齐类也叫 `.left`。标签条被钉成 96×96，只显示一个多标签 |

**修法**（四个覆写 + 两条全局规则收窄）：

| 落点 | 改动 |
|---|---|
| `mobile.less` §8 | `html.mobile ul` → `html.mobile ul:not(.ext-list)` |
| `mobile.less` §4 | 封面规则加 `:not([role='tablist'])`（Tab 根节点带 `role="tablist"`，封面容器没有） |
| O-9 `OnlineList.svelte` | `.list` 改 `grid-template-columns: 1fr`；列表加 `ext-list` 类 |
| O-11 `InstalledList.svelte` | 同上（装完扩展就会复现同样压盖，一起改） |
| O-12 `ListItemOnline.svelte` | 卡片 `height: auto; min-height: 100px; min-width: 0; width: 100%` |
| O-10 `Header.svelte` | 顶栏改两行：标签条整行（`width: auto` + `overflow-x:auto`）+ 操作区右对齐 |

> ⚠️ **`width: 100%` 在这里是陷阱**：标签条上写 `width:100%` 会被解析成 96px（收缩后的参考框），
> 只有 `width: auto` 才是 361px。排查时用 CDP 逐条枚举 `document.styleSheets` 命中规则才定位到
> 那条 96px 的 `!important`，否则会一直以为是 flex 布局问题。

**实测**（Xiaomi 2211133C / Android 16 / 393×872 CSS）：

| 判据 | 修前 | 修后 |
|---|---|---|
| 列表列数 | `174.364px 174.364px`（两列） | `360.727px`（单列） |
| 卡片宽度 / 高度 | 300 / 58（内容溢出） | 361 / 自适应 |
| 顶栏标签 | 标签条 269px，第 4 个被截成「扩展」 | 标签条 361px，4 个标签完整横排 |
| 本地安装 | 与标签同行、垂直错位 | 独立一行右对齐 |
| 截图 | `artifacts/d32-store.png` | `artifacts/d33-cards.png` |

### 15.3 交付物

| 项 | 值 |
|---|---|
| APK | 24,343,888 B，sha256 `bf1fb3f753a3e30a15dc6337a05af7c9f8ddc1c367cd8859484d62e661eac74e` |
| 包内入口 | `assets/web/spa/assets/main.DyHrx_ma.js` |
| 归档 | `artifacts/device-after-d32-d33.apk` |
| 一致性 | `check-webdist --assets` → `VERDICT: OK` |
| 上游 | `git -C source status --porcelain` = 0 行 |

### 15.4 仍未解决（网络侧，非渲染）

该网络下 OkHttp 到 raw 时通时不通：不通时会按「15s × 3 次重试」再换 jsdelivr，最坏 3–4 分钟
才出结果，期间商店显示「加载中」；若 i18n 两个请求没回来，描述会显示成 `description` 键名
（文案降级，不影响安装）。**已记入待排期**：给 `mirrorRequest` 加整体 deadline、或对
`Invalid list data` 也触发镜像回退、i18n 失败不阻塞列表渲染。

---

## 16. 接手后的修复与验收（2026-11-04）

本轮实际运行了扩展、备份和后台播放链路，发现先前的功能门禁覆盖不足。以下结论限定在列出的设备和场景；前文的历史通过结论不代表本节未覆盖项目也已通过。

| 项目 | 结果 |
|---|---|
| 交付 APK | `porting/android/app/build/outputs/apk/debug/app-debug.apk`，20,982,277 B；SHA-256 `9c417b77dda8276345fad8d7a21c36b145230106ad0b1dcfdb7076951f7bbf9d`；入口 `main.DgAcFIhD.js` |
| 真机 | Xiaomi 2211133C / Android 16；已安装上述 APK，设备内文件 SHA-256 与本地一致 |
| 模拟器 | API 36、x86_64，使用只读 AVD 的临时会话；不使用真机数据进行覆盖恢复 |
| 上游 | `source/` 保持干净，HEAD 为 `c8f40eab05021735b969e5991e6ec2f2c63e83b8` |

### 16.1 实际功能

- **扩展与在线音乐**：真机从商店安装并启用 `Online Metadata`、`GD音乐台`。修复 `.alix` 实际为 gzip 压缩包但没有 gzip 后缀时解压失败，以及 QuickJS 沙箱中消息数组、二进制、Promise 和隔离上下文方法的跨边界传递。真机曾用 `GD音乐台` 搜索“周杰伦”，获得歌曲结果并播放“屋顶”，播放进度和歌词均有变化；最终包再次搜索获得结果。部分第三方接口出现 HTTP 400/503；这不代表所有音源均可用。
- **移动端搜索**：在线页新增搜索输入框，保留曲库、在线、设置三个底部入口；搜索源改为横向滚动。真机实际布局中搜索框高 44dp，搜索源名称可读，清除操作能够清空输入和搜索参数。截图见 `artifacts/qa-final-online.png`。
- **备份恢复**：模拟器导入一首 WAV，导出包含该歌曲的 `.alcfg` 列表备份，移除曲目，再从备份恢复；界面显示导入完成且曲目重新出现。设置备份在界面中标为暂不可用。本轮未在真机覆盖恢复。
- **后台与媒体控制**：真机播放本地测试曲目，退回桌面后连续自动切换两首，系统出现前台媒体服务与通知；模拟器验证暂停 5 秒以上后释放唤醒锁、退出前台状态，随后通过系统播放键恢复为 PLAYING，前台服务和唤醒锁重新生效。播放由 WebView 管理音频焦点，避免原生层重复抢焦点。该测试不等于 30 分钟息屏保活验证。
- **WebDAV（本条历史结论已撤回）**：当时临时服务的日志显示快照 PUT 和同步成功，但 §18 复验发现这些 PUT 的正文为零字节，日志不能证明上传了有效快照。此前的响应头大小写、原始字节和回调适配修复仍保留；有效上传与跨设备合并以 §18 的复验为准。

### 16.2 检查结果与边界

- `core-ports:testDebugUnitTest` 的两项 tar 测试通过；当时的移植层 TypeScript 检查、`scripts/smoke.mjs` 和 `check-webdist.mjs --assets` 通过。当时工具把 380 条诊断归为上游；后续发现其中 1 条属于移植层，现已修复检查器及该错误，最新结果见 §19。
- 当前包在已有依赖的工作区构建；此前版本有干净目录重建记录，最新修改尚未重新进行干净重建。release 包未验收。
- 30 分钟息屏长测后由用户验收通过；从最近任务划掉后继续播放、真实 WebDAV 服务及跨设备合并、Android 10–15 真机和横屏/平板仍未覆盖。其他文件浏览器和歌词提示问题见前文记录。

---

## 17. 模拟器继续验收（2026-11-04）

本节使用本机 API 36 / x86_64 模拟器的只读 AVD 临时会话，未改动真机曲库。前文 §16 是当时的历史记录；本节的结果只覆盖下面列出的版本和场景。APK 路径随后已被新包覆盖，当前产物以 §19 为准。

| 项目 | 结果 |
|---|---|
| Debug APK | `porting/android/app/build/outputs/apk/debug/app-debug.apk`，19,919,299 B；SHA-256 `9697c6fd8d147a59040bc0015cdb94b4150cf3e912064d1d1a2252ead4f2f2be` |
| Release APK | `porting/android/app/build/outputs/apk/release/app-release.apk`，8,589,441 B；SHA-256 `d0615a54cd4cdaf0f1db89c8ceda674fc23bb9cb5c9fc1b0ed78e2307e2d06e4`；已混淆、裁剪资源，使用 debug 签名，模拟器基本播放与退出已验收 |
| 真机 | 本轮未连接或安装；§16 中的手机仍为当时安装的旧版本 |
| 上游 | `source/` 保持干净，HEAD 为 `c8f40eab05021735b969e5991e6ec2f2c63e83b8` |

### 17.1 本轮结果

- **界面退出后播放**：将播放中的 WebView 与桥改为可脱离 Activity 的运行时。当前 Debug 和 release 包在模拟器上验证：按返回退出界面后，`ViewRootImpl` 为 0，系统媒体键可暂停；release 恢复播放后前台服务与唤醒锁生效，重新打开界面保留播放状态，再暂停退出可完成落盘。上一版 release 还验证了暂停超过 5 秒后前台服务降级和唤醒锁释放，并连续退出、重进两次，未见崩溃。当前 release 的记录见 `artifacts/qa-final-release-media.txt` 和 `artifacts/qa-final-release-log.txt`。
- **息屏长测**：此前的基线包 SHA-256 `e572bdf6dc0b0ecf97a6529b16ddae1325da44b56272039580f36f4d664018d6` 已连续息屏超过 30 分钟，进度持续前进并在曲目结束后循环。后续候选 Debug 包 SHA-256 `b164323f625a17129ee28db3be5ea9848bcc08c5bb6077b1b24317049046cca6` 在界面退出、屏幕关闭后播放 1,801 秒，音轨进度从约 46.4 秒推进到 1,847.9 秒，前台服务和唤醒锁持续有效，记录见 `artifacts/qa-final-headless-soak.csv`。**此长测不属于上表的最终包**：最终包在该候选版之后补入 §18 的 WebDAV 正文修复与非空歌单导入入口，并做了短时播放回归。模拟器使用静音测试音轨和无声输出，不等于真实设备的声音质量或耗电测试。
- **长测裁决（2026-11-05）**：用户已确认上述 30 分钟息屏长测验收通过，后续不再列为待办或复测要求。
- **最近任务关闭**：最终 release 播放时，在模拟器最近任务的应用图标菜单中选择 `Close`，应用卡片消失、`ViewRootImpl` 为 0，前台服务仍在，Android 音频输出状态为 `started`。系统媒体键暂停后再恢复，5 秒后再次暂停，媒体会话位置从约 136.97 秒推进到 142.24 秒。直接上滑手势未能在该模拟器触发，故只确认菜单关闭路径。
- **媒体信息**：系统媒体元数据补充总时长；模拟器媒体会话从 3 项变为 4 项。暂停位置由单调时钟推进，实测音轨约 13.8 秒时系统会话显示约 14.5 秒；暂停后唤醒锁释放。
- **落盘与退出**：数据库补上后台、内存紧张和退出时的强制落盘监听，数据库与设置文件的写入按文件串行，写盘期间的新修改会继续写入。退出界面时等待数据库和设置工作线程回执，最多等待 10 秒；模拟器实际更改主题后立即退出，收到两个回执，重新打开后主题仍为修改后的值。自动化测试验证了后台提前落盘、并发写入、失败后重试和退出回执。
- **原生选择器**：修复 Activity 重建后端口可能继续引用旧选择器，以及从后台线程启动选择器的问题。模拟器首次打开和取消正常；自动审核拦截了重开页面后再次自动调用选择器的组合命令（返回 `blocked by policy`），该项尚未完成自动复测。
- **同步冲突**：离线冒烟测试覆盖双方新增、单侧删除和曲目元数据更新的快照合并，以及首次同步冲突的合并和取消选项；不喜欢规则也覆盖了增删与去重。这是合并规则测试，不等同于真实 WebDAV 跨设备端到端测试。
- **构建**：5 项 `core-ports` 单测、1 项 bridge 正文单测通过；移植层 TypeScript strict 检查、针对隔离产物的 JS 冒烟和 `check-webdist.mjs --assets` 通过。最终前端产物位于 `artifacts/qa-build-js-import-final`，避免触碰此前受限制的旧清理目录；Debug 和 release 均在原项目路径完整重编。复现命令及 Windows 中文路径注意事项见 `docs/BUILD-from-source.md` §6。

### 17.2 尚未覆盖

30 分钟息屏长测已由用户确认通过；除此之外，新版从最近任务直接上滑划掉后的实测、真机的新版后台播放、真实 WebDAV 服务和跨设备同步、Android 10–15 设备以及横屏／平板仍未覆盖。历史记录中的部分目录双击、无歌词提示等体验问题，本轮未重新验收。模拟器内存有限，本轮只运行一个设备。

---

## 18. WebDAV 与非空曲库导入复验（2026-11-04）

§16 的旧 WebDAV 上传结论已撤回：逐字节检查发现 HTTP 桥只接受二进制正文，上游传入文本时被当成空正文。原生桥现在以 UTF-8 编码字符串、保留二进制并拒绝不支持的类型；测试覆盖中文、日文、韩文、二进制和空值。本地测试服务也对空快照元数据返回错误，避免再次把空上传当作成功。

当时的 Debug 包在同一只读模拟器的两个独立 Android 用户空间中分别创建数据、连接本地 WebDAV 测试服务：第一个用户上传歌单，第二个用户导入自己的曲目并选择合并；第一个用户在未读取远端新曲目前再导入另一首并同步，随后第二个用户同步。两边界面最终都显示 `anylisten-sync-beta-qa`、`anylisten-sync-gamma-qa` 和 `anylisten-qa-31min`。服务实际收到的三方合并快照为 743 字节、快照信息为 307 字节。两个用户切换时先停止前一个用户的应用，因为本地服务端口共用；这是顺序同步，不是同时运行。

证据：`artifacts/qa-webdav-dual-result.json`、`artifacts/qa-webdav-dual.log`、`artifacts/qa-webdav-two-users.png`。测试服务与模拟器用户都是临时环境，此结果验证歌单元数据合并，不代表真实云服务或两台实体设备已验收，也不表示本地音频文件会被同步。

验收中还发现非空歌单没有继续导入的入口。现在可写的非空歌单顶栏提供「导入」按钮；模拟器从已有歌曲的列表再次导入并成功参与上述合并。空列表仍保留原来的导入引导。当时的 release 包已在模拟器确认按钮显示，导入动作由当时的 Debug 包完成。

---

## 19. 扩展配置与异常恢复（2026-11-05）

本节继续使用本机 API 36 / x86_64 只读模拟器，不覆盖真实设备数据。调试包 SHA-256 为 `97fefdf2140f07d76af536dd51ccf795c3f0f8c3ef4e42a0412a154b42a6bd59`（19,921,215 B）；release 包 SHA-256 为 `0cabfe6cf1ad240479cc13bb0ae1e5db2354f3898bf4ce2126e5f117add6c6fd`（8,591,037 B，调试签名）。两包内前端入口同为 `main.DgZpUd8K.js`，其 SHA-256 均为 `8131802f9f37d1128426b4cabb2990070d5c9d3a23c7265ff15605420c8880b0`。

- **扩展配置**：扩展运行在独立 Worker 中，原先同步 Store 的缓存并未预载该 Worker 的配置。现按扩展配置路径懒加载，保存调用返回前等待落盘；同一扩展的并发设置更新按顺序合并，不同扩展互不阻塞。模拟器用预先保存的内置 WebDAV 配置验证：页面实际 DOM 中两项原值均为 `true`；只改一项后，磁盘及正常退出、重开后的页面均为 `false / true`。上游设置页仍不等待保存调用返回；修改后立即关闭或强停，仍可能发生在请求送达扩展 Worker 之前。并发不同字段、写盘失败恢复、慢读与卸载重装缓存失效由 JS 冒烟测试覆盖；未声称并发已在实体设备验收。记录见 `artifacts/qa-extension-config-current.txt`。
- **复选框取证更正**：模拟器辅助功能树把该 WebView 的复选框 `checked` 一律报告为 `false`，即使 DOM 实际值为 `true`。因此此前仅据辅助功能树得出的旧包重启状态不可靠，已撤回；扩展缓存问题的判断依据为代码路径和针对性测试。
- **文件浏览**：普通导入和备份保存时单击进入文件夹；目录选择模式仍可单击选中、双击进入。模拟器实际导入音轨、保存 419 字节的列表备份，并在选定的目录导出 TXT 成功。
- **异常恢复**：模拟器将播放进程杀死后，旧包重新启动了没有音频的媒体服务并留下通知；当前 Debug 包在同样场景下 15 秒后没有重启服务或残留通知。另将页面导航到未监听的本地端口，页面自动恢复至曲库；一次内存回收事件分别收到 core 与 db 各一个回调。记录见 `artifacts/qa-sticky-restart-before.txt`、`artifacts/qa-sticky-restart-after.txt`、`artifacts/qa-recover-result.txt`。
- **暂停后退出通知**：复现“播放→暂停→等待超过 5 秒→双返回退出”时，旧包在服务已经销毁、`ViewRootImpl=0`、媒体会话已清空后仍遗留 `id=1001` 的暂停通知。原因是暂停降级使用 `STOP_FOREGROUND_DETACH`，而服务销毁路径没有再次移除通知。现在 `PlaybackService.onDestroy()` 会先关闭通知刷新、无条件 `stopForeground(STOP_FOREGROUND_REMOVE)` 并取消通知。修复后的 Debug 和 release 包均在相同步骤退出后确认通知为空、服务为空、媒体会话为 `NONE`，记录见 `artifacts/qa-pause-exit-notification-beforefix.txt`、`artifacts/qa-pause-exit-notification-fixed.txt` 和 `artifacts/qa-pause-exit-notification-release.txt`。
- **检查**：Debug / release 均在原目录完整重编；前端产物与 APK assets 一致，移植层 TypeScript strict 0 错误，上游另有 379 条诊断未计入门禁。JS 冒烟覆盖扩展配置、同步、数据库及文件写入；类型检查器现在也会在自身启动失败时返回失败。
- **长测**：修复前的 Debug 包 `415097e4…` 在最近任务中直接上滑移除后完成了 1,800 秒息屏播放；34 次采样均为前台服务 `true`、唤醒锁 `true`、息屏 `true`、音频输出 `true`，PID 始终为 3319，音轨从约 3.6 秒推进到 1,803.9 秒，记录见 `artifacts/qa-current-apk-soak.csv`。该 30 分钟息屏长测已由用户确认验收通过，后续不再作为待办或复测要求。本次通知清理改动只影响服务销毁路径，修复后的两包完成了短时播放、暂停降级和退出清理回归；release 在播放中退出界面后仍保持前台服务、唤醒锁和音频输出，记录见 `artifacts/qa-final-release-playback-exit.txt`。模拟器使用静音音轨与无声输出；采样通过 WebView 调试连接读取音轨时间，不能替代真机保活、声音或耗电测试。

自动审核拦截了“强制停止、重启并读取扩展设置”的组合命令，原因仅显示 `blocked by policy`；该路径尚未复测。当时的 release 已完成模拟器短时播放与退出通知清理回归；当前候选包的复验范围见 §21。新版真机、真实 WebDAV 服务和 Android 10–15 仍需验收。

---

## 20. 播放页与在线播放修复（2026-11-05）

本轮使用 API 36 / x86_64 模拟器，验证设备视口为 412×915 CSS。当时的 Debug 候选包 SHA-256 为 `7a64142627aea7c63da644d1004373a6bf0b0682cc715b02e8146d7dff6c7ad7`（20,939,677 B），包内入口为 `main.Ck1444r6.js`；当时 release 未重打。

本节是 §21 之前的中间候选，保留当时的修复与测试记录；当前交付物的指纹和后续修复范围以 §21 为准。

### 20.1 播放页裁切与状态文字

- `.left-info` 取消 40dvh 高度上限，信息区不再依赖内部滚动或被 `contain: paint` 静默裁切。实测歌曲信息 `clientHeight = scrollHeight = 96`，专辑行完整显示。
- `.footer-content` 为绝对定位的状态文字保留 20px 底部空间。暂停态实测状态文字矩形为 `y=843..859`，右侧辅助控制键为 `y=795..839`，两者不相交。
- 模拟超长专辑名后，信息区扩展到 240px，`clientHeight = scrollHeight = 240`，页面仍保持 915px 视口，控制区未被裁掉。截图见 `artifacts/qa-playdetail-long-album-fix.png`。

### 20.2 在线播放与 `source not found`

`source not found` 是上游 `handleFindMusic()` 在自身 URL 与全部搜索回退都失败后的统一异常。复现时 GD 网易云、JOOX 等第三方请求确有 503/400/空结果；主机随后重试同一批请求又能取得有效 URL，说明外部音源短时故障是触发因素。应用侧做了三项修正：

- GET/HEAD 遇到 502/503/504 时退避重试两次（约 400ms、1200ms），`retryNum: 0` 仍保持单次请求。冒烟测试覆盖 `503 → 503 → 200`。
- 播放页和迷你播放器不再直接展示 `source not found` / `Get url failed, no source` / `Failed to obtain lyrics`，其中音源失败映射为「在线音源暂时不可用，请稍后重试」。
- 第三方持续不可用仍会导致自动换歌耗尽；这不属于应用能保证的外部服务可用性。

在 GD 网易云搜索 `Shape of You` 取得 20 条结果后，单曲点击、`Play all`、`Shuffle` 均能起播；控制台未再出现 `unsupported source`，也未出现 `source not found`。扩展日志仍有 GD 酷我 400、JOOX 回退等第三方错误，未形成未捕获 Promise 拒绝。

### 20.3 搜索页 `unsupported source`

上游 `playOnlineList()` 起播后会无条件后台调用 `fetchOnlineListDetailAll()`，而后者只支持 `songlist` / `topSongs`；搜索页的 `source: 'search'` 因而稳定抛 `unsupported source`。搜索结果是快照，不需要完整列表补全。移植层新增 A-29 覆写：`search` 来源直接使用当前结果建立播放队列，其余来源继续调用上游实现。实测 `Play all`、`Shuffle` 与搜索结果单曲点击均正常，未捕获异常为 0。

### 20.4 门禁与剩余边界

- 移植层 TypeScript strict 检查通过，0 错误；JS 冒烟通过；`check-webdist.mjs --assets` 为 `VERDICT: OK`。
- 当前日志中的扩展配置 `ENOENT` 是首次读取尚无配置文件的预期路径，随后可正常保存；本轮未发现 `SQLITE_CANTOPEN`，也没有 `FATAL EXCEPTION`。
- 未强制模拟持久 503 后观察中文错误文案的停留过程；该映射由代码与构建产物检查覆盖，不以本轮实测冒充。
- 本节截图对应的包仍采用浮动「多选」入口；该遮挡已在 §21 的后续候选包中修复。收件列表、长标题、极矮屏等边界仍需按设备矩阵继续覆盖。

---

## 21. 搜索操作区与音源异常文案（2026-11-05）

本轮继续使用 API 36 / x86_64 模拟器，设备视口为 412×915 CSS。Debug 包 SHA-256 为 `3f26a80a35839c6e52fa171fbb3f1316066523c8bdc88914ea9fe7e26abf3ee4`（20,939,917 B）；release 包 SHA-256 为 `ba5fb835ee317eb4f5f78c3e152aae838bb43cc31d390c3be29e2253f415dcfd`（8,592,561 B，调试签名）。两包内前端入口同为 `main.BnKFe8gR.js`，均来自 `artifacts/qa-build-js-timeout-status-20261105`。release 已在模拟器实装并验证在线单曲播放；当前设备随后装回 Debug 包，设备内 APK 指纹与本地一致。

### 21.1 搜索页操作区

- `MusicList/List/index.svelte` 的「多选」入口和多选操作条移到歌曲列表容器之外，作为独立布局行；`mobile.less` 取消 `.mobile-select-bar` 的绝对定位。歌曲列表不再给悬浮按钮预留视觉缺口，滚动到列表尾部也不会被按钮覆盖。
- 实测歌曲列表底边为 `631.0476px`，`Select` 顶边为 `635.0476px`，`overlap = false`。进入多选后，计数、全选和退出都在列表下方独立一行，列表本身仍可正常滚动和点击。
- 搜索页单曲点击、`Play all`、`Shuffle` 均完成起播回归；控制台无 `unsupported source`。

### 21.2 在线音源报错与超时

- 新增 `ui/statusText.ts`，统一处理播放状态文案。`source not found`、`Get url failed`、`Get music url failed` 不再原样显示，改为“在线音源暂时不可用，请稍后重试”；上游 `find music timeout` 改为“在线音源响应超时，请检查网络后重试”。
- 中英繁三种文案均在 `ui/i18n.ts` 中补齐。当前模拟器为 `en-us`，断网实测在第 60 秒显示 `Online source timed out. Check your network and try again.`，未再出现英文原始异常；测试结束后已恢复网络并确认系统连通性状态为 validated。
- GET/HEAD 对 502/503/504 的退避重试仍保留，JS 冒烟覆盖 `503 → 503 → 200`。本轮没有强制模拟“持续 503”，因此只把单次短时故障重试列为测试覆盖，不声称第三方服务长期不可用时仍能播放。
- 恢复网络后，release 包在 GD 网易云搜索 `Shape of You`，点击首条结果进入 `PLAYING`；界面显示播放进度与歌词，系统媒体会话状态为 `PLAYING`。第三方音源自身的 400/503 和空结果仍可能出现，应用侧只能重试并给出可理解的状态文案。

### 21.3 门禁与边界

- 移植层 TypeScript strict 检查 0 错误；JS 冒烟通过；`check-webdist.mjs --assets` 为 `VERDICT: OK`；Debug 与 release 均从同一前端 stage 成功出包。
- 30 分钟息屏长测已由用户验收通过，不再作为待办或复测要求。
- 未覆盖新版真机、Android 10–15、横屏、平板/折叠屏、外接指针和本地 WAV 播放回归；搜索操作条也只在 412 CSS 宽度实测，393 宽真机上多选文案是否拥挤尚未复验。

---

## 22. 真机歌词与在线音源复验（2026-11-05）

本轮使用 Xiaomi 2211133C / Android 16 真机，CSS 视口 393×873，设备 dpr 2.75；无线调试地址为 `192.168.1.39:41187`。Debug 包 SHA-256 为 `5c1a60355a31d44bacb7e419a29f368fc58644c55752b74f889b1bf824b31da2`（20,940,744 B），入口为 `main.CTyMuOED.js`。`check-webdist.mjs --assets` 为 `VERDICT: OK`，`source/` 保持干净。按用户裁决，30 分钟息屏长测已验收通过，本节不再重复该测试，也不把它列为待办。

### 22.1 歌词字号、对齐与制作信息

复现截图见 `artifacts/qa-lyric-issue-current.png`。播放详情页的歌词字号只有 **9.84px**，活动行位于左侧 1px 处，视觉上是一条偏左的小字。量到的根因有三处：

- `LyricPlayer.svelte` 用 `winRadio = 根节点宽度 / 1020` 缩放字号，再乘 `(字号设置 / 100 + 0.8) rem`。393px 宽、默认 80% 时得到 `(0.8 + 0.8) × 0.385rem ≈ 9.84px`，桌面比例直接压扁了手机字号。
- 默认设置为左对齐；`.text-left` 的活动行 `transform-origin: 0%`，并叠加 `scale(1.1)` 和左右不对称 padding。实测活动行宽 427px，超出 393px 视口。
- 部分音源把 `作词 : 无`、`作曲 : 无`、`制作人 : …` 等制作人员表作为 `[00:00.000]` / `[00:01.000]` 歌词行返回，歌曲开头会把这些行显示成歌词。

修复落在移植层，没有改上游：

- `ui/mobile.less` 将手机歌词字号改为 `clamp(16px, calc(var(--play-detail-lrc-font-size) * 1.72), 24px)`，保留应用内字号设置的变化；文字居中、左右各 20px、活动行 8px 上下留白，活动行 `scale(1.02)` 且 `transform-origin: center`，活动行加粗。
- 新增 `ui/lyric/filterMetadata.ts`，按中英文制作人员标签过滤带时间戳的元数据行；`ui/overrides/modules/lyric/init.ts` 在歌词初始化前调用它，覆写表登记为 A-30。

真机测得歌词根字号 **16.9221px**、`text-align: center`；活动行矩形约 `x=-3.93, w=400.58, h=37.03`，内层活动文字颜色 `rgb(71, 88, 187)`，长句自动换行且仍在视口内。`作词/作曲/制作人` 行过滤后计数为 0，92 行正常歌词保留；播放到活动行、暂停、恢复时高亮和滚动均正常。最终截图见 `artifacts/qa-final-lyrics-playing.png`、`artifacts/qa-final-lyrics-paused.png`。

### 22.2 在线音源与 `source not found`

`source not found` 的根因已不再归到路由或单一 503：

- 设备上安装的 `online-metadata 0.4.8` 只声明搜索、封面、歌词等能力，**没有 `musicUrl`**，不能单独播放。
- `lx-api-source-loader 0.1.7` 虽然声明了 `musicUrl`，但没有导入任何 LX 自定义源脚本，播放时实际抛 `No script found to handle this request`；上游聚合后显示为 `source not found`。
- 安装并启用 `GD音乐台 0.4.3` 后，扩展具备可用的 `musicUrl`。严格网络安全 Debug 包直接播放成功，不需要把 `allowCleartext=true` 作为最终修复。

本轮在新 Debug 包上复验：GD 网易云搜索 `Shape of You` 返回 5 条结果，点击首条后系统媒体会话为 `PLAYING`，进度推进，播放页歌词正常显示和滚动。搜索 `Play all`、`Shuffle`、在线单曲均可用；393px 宽度下进入多选后，操作条位于最后一行歌曲下方，未覆盖歌曲行。播放期间日志没有 `source not found`、`No script found`、`CLEARTEXT` 或 `FATAL EXCEPTION`。在线歌曲的歌词同样经过制作信息过滤，截图见 `artifacts/qa-online-lyrics-fixed.png` 和 `artifacts/qa-final-multiselect.png`。

### 22.3 门禁与剩余边界

- 本轮通过移植层 `pnpm typecheck`（strict，0 错误）、`pnpm build:all`、`pnpm smoke` 和 `node scripts/check-webdist.mjs --assets`；Debug APK 已覆盖安装到真机，设备内 APK 指纹与本地一致。
- 本轮修复的是手机播放详情的歌词展示和音源选择前置条件。设置项备份/恢复、在线专辑/歌手搜索页、下载（上游关闭）、只读评论、目录选择模式的子目录进入、部分小于 44dp 的触控行，以及 Android 10–15、横屏、平板/折叠屏和外接指针仍未覆盖。
- 第三方音源自身的 400/503、空结果和长期不可用仍无法由应用保证；`GD音乐台` 只是当前已验证的可播放来源，不是内置音源。

---

## 23. 设置备份、歌词与文件选择收口（2026-11-05）

本轮仍使用 Xiaomi 2211133C / Android 16 真机（无线调试 `192.168.1.39:41187`，393×873 CSS，dpr 2.75）。最终 Debug APK 为 `porting/android/app/build/outputs/apk/debug/app-debug.apk`，20,941,724 B，SHA-256 `2C28DBA46E60477688E354EF8285FE10E13E707C918E476297EAB0F63E7EF740`，入口 `main.D7i_mRkr.js`。设备内 `base.apk` 的 SHA-256 与本地一致，`lastUpdateTime` 为 2026-11-05 11:53:26。

### 23.1 设置备份与恢复

上游备份模块只导出歌单，设置项在 UI 和导入流程里都被禁用。移植层新增 A-31 备份模块和 A-32 类型选择覆写：

- 选中“设置”后，导出文件会同时写入 `songlist` 与 `settings` 两个快照；没有设置快照的旧备份仍可只恢复歌单。
- 恢复时只接受已知字段，歌单和设置分别合并；未知或只读设置不会覆盖当前配置。
- 设置类型勾选框恢复可选，默认仍按上游行为只选“列表数据”，需要时再勾选“设置”。

真机实测了勾选设置后的导出、恢复和强停重启：恢复后歌单与设置均保持；`pnpm smoke` 的设置备份用例覆盖了字段筛选、空设置快照和恢复合并。

### 23.2 文件选择

A-23 / A-24 / A-34 把文件浏览器改成触屏语义：

- 文件夹单击进入，不再需要桌面式 400ms 双击窗口；目录选择模式也使用同一动作。
- 进入目标目录后，「确定」直接使用当前目录，不要求再选中某个子项。
- 窄屏底栏改为可换行：文件名输入占一行，新建文件夹与取消/确定各占一行。

真机分别打开 TXT 导出与备份保存：默认文件名 `any-listen_list_all.txt`、`any-listen.backup.alcfg`；单击根目录、`Music` 和 `AnyListenTest` 都能一次进入，路径框同步更新，确定按钮可用。修复前「文件名」标签被压成 14px 宽并竖排，`新建文件夹` 与右侧按钮重叠；修复后的视觉证据见 `artifacts/qa-dirpicker-fixed.png` 和 `artifacts/qa-dirpicker-music.png`。

### 23.3 歌词过滤与空白状态

真机当前曲目「晴天 (原唱 周杰伦) - RyaVocal」打开播放详情后，第一行唱词是「故事的小黄花」，开头的标题、`合声`、`合声编写`、`录音助理`、`录音工程`、`混音工程` 等制作信息均未进入歌词。播放到 32 秒时活动行「从出生那年就飘着」为蓝色、轻微放大，歌词根字号 `16.9221px`、居中，滚动位置随播放推进。

过滤规则在原有中英文制作标签基础上补充了：

- 中文制作字段：`合声编写`、`录音助理`、`录音工程`、`混音工程` 等。
- 开头 3 秒内、长度不超过 80、无标点、形如「歌名 - 歌手」的标题行。
- 正常唱词中的 `-`、`：` 和中段文字不受影响；回归用例已加入 `pnpm smoke`。

无歌词路径用导入的 12 秒 WAV 验证：进入播放详情先显示「歌词加载中…」，约 1.5 秒后变成「暂无歌词」，没有空白页或英文异常文案。截图见 `artifacts/qa-no-lyrics-state.png`。

### 23.4 在线播放

最终包在 GD 网易云音源搜索「晴天」，结果返回后点击首条，系统媒体会话从 `PAUSED` 进入 `PLAYING`，进度从 0 开始推进；切到结果页后再清空 logcat，单曲起播窗口内没有 `source not found`、`No script found`、`CLEARTEXT` 或 `FATAL EXCEPTION`。当时搜索刷新阶段的内置回退仍会请求 `search.kuwo.cn` / `interface.music.163.com` 等 HTTP 接口并被 Android 明文策略拦截；该问题已在 §24 通过精确域名白名单修复，内置酷我/网易搜索恢复，未列入白名单的域名仍被拒绝，也没有使用全局 `allowCleartext`。`online-metadata` 仍只承担搜索/歌词等能力，LX loader 没有导入脚本时不能播放；这是音源扩展的前置条件，不是播放器故障。播放页和迷你播放器的状态文案已区分缺失音源、LX 脚本未导入、超时和明文网络拒绝。

### 23.5 构建与清理

- `pnpm typecheck`：移植层 strict 通过，0 错误。
- `pnpm build:all`：通过；入口 `main.D7i_mRkr.js`。
- `pnpm smoke`：通过，包含歌词制作信息过滤和设置备份恢复，共 53 次原生 Ports 调用。
- `check-webdist.mjs --assets`：`VERDICT: OK`，dist 与 APK assets 3 项指纹全等。
- `:app:assembleDebug -PskipWeb=true -PrequireWeb=true`：通过；最终 APK 与设备内 APK 指纹一致。
- smoke 测试 bundle 已从 `dist/smoke` 移到 `node_modules/.cache/anylisten-smoke`，避免 `dist` 根意外条目进入打包链路。

### 23.6 剩余边界

- 在线专辑/歌手搜索目前没有可工作的扩展实现；宿主 IPC 与 UI 页面也未完成，不应把它描述成“当前扩展已支持、宿主漏接”。
- 下载功能被上游关闭，评论只能只读；部分列表触控行仍小于 44dp。
- Android 10–15、横屏、平板/折叠屏和外接指针尚未覆盖；当前验收来自 Android 16 真机和 API 36 模拟器。
- 第三方音源自身的 400/503、空结果和长期不可用无法由应用保证；内置搜索回退的 HTTP 接口已在 §24 按 34 个精确主机放行，未列入主机仍被拒绝，扩展升级后需要重新核对白名单。文件选择仍依赖文件路径与所有文件访问权限。

---

## 24. 精确明文白名单、内置搜索与歌词可读性（2026-11-05）

本轮复验设备仍为 Xiaomi 2211133C / Android 16（无线调试 `192.168.1.39:41187`，393×873 CSS，dpr 2.75）。最终 Debug APK 为 `porting/android/app/build/outputs/apk/debug/app-debug.apk`，20,942,053 B，SHA-256 `5CB0AD5958D2CFA1C3FC1EF0CD3014A895D9617B8114AE588207F5DA24C92315`，入口 `main.i-PlVHwT.js`。真机 `base.apk` 拉取后大小与 SHA-256 均与本地一致，`lastUpdateTime` 为 2026-11-05 13:04:25。`source/` 保持零改动。

### 24.1 精确域名白名单与内置搜索恢复

`network_security_config.xml` 的 `base-config` 仍为 `cleartextTrafficPermitted="false"`，只增加两组 `domain-config`：

- 回环：`127.0.0.1`、`localhost`，用于 SPA、`/stream` 和 AudioWorklet 的 secure context。
- 内置 `Online Metadata 0.4.8` 实际使用的 34 个精确主机名，覆盖酷我、网易、酷狗、QQ 音乐、咪咕的搜索、歌词、封面、歌单和评论接口。全部 `includeSubdomains="false"`，没有通配符，也没有全局 `usesCleartextTraffic`。

真机结果：

- `http://search.kuwo.cn/...` 返回 HTTP 200；`http://example.com/` 仍被拒绝，错误为 `CLEARTEXT communication to example.com not permitted by network security policy`。
- 内置「酷我音乐」搜索「晴天」返回 5 条结果，列表显示 `kw` 标识；证据见 `artifacts/qa-builtin-kuwo2.png`、`artifacts/qa-builtin-kuwo-logcat.txt`。
- 内置「网易音乐」搜索「晴天」成功；证据见 `artifacts/qa-builtin-netease-logcat.txt`。两份 logcat 中均无 `CLEARTEXT`、`source not found`、`No script` 或 `FATAL EXCEPTION`。

白名单只针对当前扩展版本，升级 `Online Metadata` 后必须重新核对其 HTTP 端点；不要把 `<domain>` 改成通配或打开全局明文。临时排查仍可用 `-PallowCleartext=true` 切到 `_loose.xml`，该包不进入交付。

### 24.2 Toast、加载与播放错误状态

- 上游 `.notify-content` 绝对定位后，`left:50%` 加 `width:auto` 只剩一半可用宽度；393px 真机上提示条被测成 **157px × 118px**，长句被挤成窄柱。`ui/mobile.less` 改为整行宽度、取消最小宽度、限制 `50dvh` 高度并允许内容滚动，位置抬到迷你播放器和标签栏之上。修复后的提示条宽度约等于 `100vw - 32px`；截图 `artifacts/qa-toast-fixed.png` 记录的是宽度修复当次，图中仍可见后续已修掉的加载/错误叠加。
- 上游 Loading 的 `loading` 与 `error` 各自做 200ms fade，失败切换时会短暂同屏。新增 `html.mobile .loading:has(+ .error) { display:none !important; }` 后，CDP 实测失败态的 `.loading` 为空，`.error` 只显示「加载失败 😢 / 重新加载」。证据见 `artifacts/qa-final-error-state.png`。
- 播放失败原先只会把一次性的 `statusText` 留在内部，界面继续显示「歌曲链接获取中…」。新增 `ui/player/errorNotice.ts`：`playerEvent.error` 时显示 6 秒 Toast，并把映射后的原因写入常驻状态；迷你播放器和播放页状态栏优先显示该文案，切歌或真正开始播放时清除。真机实测在 Toast 出现当刻同时读到：
  `mini-main = "晴天 - 夏侯旧梦 在线音源响应超时，请检查网络后重试"`
  、`status-text = "在线音源响应超时，请检查网络后重试"`；自动跳到下一首后，错误文案已清除并恢复新曲加载状态。截图见 `artifacts/qa-playback-error-persistent.png`，此前的可行动 Toast 见 `artifacts/qa-builtin-failure-toast.png`。

### 24.3 歌词高亮、滚动与可读性

在真机上从 GD 网易云搜索结果点击「晴天 (原唱 周杰伦)」，系统媒体会话进入 `PLAYING`，播放页打开后测得：

- 歌词根字号 `16.9221px`、`text-align: center`，50 行有效歌词，`作词/作曲/制作人` 等制作信息为 0 行。
- 播放到 `00:41` 时活动行为「随记忆一直晃到现在」（时间戳 39,750ms），活动行颜色 `rgb(64, 79, 168)`，滚动位置 `149px`；暂停在 `00:50` 时活动行为「吹着前奏望着天空」，滚动位置 `240px`，暂停后高亮保留。
- 未播放歌词原先使用 `--color-300`（`rgb(188,188,188)`），在白底详情页上的对比度约 **1.7:1**，整片歌词几乎不可读。本轮改为 `--color-650`（`rgb(111,111,111)`，白底约 **4.7:1**），活动行/已播放行继续用主题蓝 `--color-primary-dark-200`。修复后未播放行实测 `rgb(111,111,111)`。

最终截图见 `artifacts/qa-final-gd-lyrics.png`（`00:50` 暂停态）；本轮播放窗口的 logcat 为 `artifacts/qa-final-gd-lyrics-logcat.txt`，其中 `source not found`、`No script found`、`CLEARTEXT`、`FATAL EXCEPTION` 均为 0 条。首次取流有一次 `MediaError`，同一 URL 重试后 `onPlaying`；暂停后系统媒体会话为 `PAUSED`，没有继续出声。

### 24.4 在线音源前置条件仍然成立

内置搜索恢复不等于内置结果可播放。`Online Metadata 0.4.8` 仍没有声明或实现 `musicUrl`，`LX Music API Source Loader 0.1.7` 仍没有导入任何 LX 脚本；这两类结果点击后不能取到播放地址。`GD音乐台 0.4.3` 同时提供搜索和 `musicUrl`，是当前已验证的可播放来源。要播放内置搜索的结果，需要安装支持 `musicUrl` 的扩展，或在 LX loader 中导入音源脚本；这是扩展能力前置条件，不是播放器或音频链路故障。状态文案会分别提示缺失音源、LX 脚本未导入、超时和明文网络拒绝。

### 24.5 门禁与剩余边界

- `pnpm typecheck`：移植层 strict 通过，0 错误。
- `pnpm build:all`：通过；入口为 `main.i-PlVHwT.js`。
- `pnpm smoke`：通过，包含歌词制作信息过滤和设置备份恢复，共 53 次原生 Ports 调用。
- `:app:assembleDebug -PskipWeb=true -PrequireWeb=true`：通过。
- `check-webdist.mjs --assets`：`VERDICT: OK`，`index.html`、主入口和 extension-preload 3 项指纹在 dist 与 APK assets 间全等。
- 内置搜索结果没有可播放地址时，上游仍会先跑完两轮 30 秒取流超时：真机约 60 秒后才显示错误并自动跳到下一首。本轮保证失败可见，但没有提前短路，因为其他扩展的搜索回退仍可能在同一请求内返回有效 URL。

未完成项不变：在线专辑/歌手搜索缺少扩展能力、宿主 IPC 和页面实现；下载被上游关闭；评论只读；Android 10–15、横屏、平板/折叠屏和外接指针未覆盖。第三方音源自身的 400/503、空结果和长期不可用无法由应用保证。

---

## 25. LX Music 自定义源与模拟器、真机验收（2026-11-06）

批量导入、覆盖更新和代表源播放使用本机 API 36 / x86_64 只读模拟器（412×约 914 CSS，静音输出）。最终 Debug APK 为 `porting/android/app/build/outputs/apk/debug/app-debug.apk`，19,929,984 B，构建时间 2026-11-06 09:05:00，SHA-256 `987AEFC7B876947D027C556BB6D3810C3CF8EC1D34ACE28A348EB825FF72E9EF`，入口 `main.sUfsCr2d.js`。该包随后覆盖安装到 Xiaomi 2211133C / Android 16 真机；设备内 `base.apk` 与本地 SHA-256 一致。此前的 release 包未重建，不含本轮 LX 功能。

适配版扩展基于官方 LX API Source Loader 0.1.7 的提交 `1d88ccad40e823e52e9255953a87939b9e0d4af3`，保留 Apache-2.0 许可证。源码在 `porting/extensions/lx-api-source-loader/`；本地安装包在 `artifacts/lx-loader/lx-api-source-loader-android_0.1.7-android.1.alix`，194,418 B，SHA-256 `00E3610CB8CD07B03926E22B467F40B610E627FE25A58DEDD5608D54665817CF`。适配版使用独立扩展 ID，与官方扩展并存，数据各自保存；如需迁移已有官方扩展的源，可先导出再导入。

### 25.1 文件导入和数据保留

- 修复 Android 扩展的打开、保存文件对话框，支持选择文件、多选、过滤器和目录。用户提供的两个目录共 24 个 `.js` 文件均可导入；测试另放入一个人工构造的无头文件，首次结果为 24 成功、0 重复、1 失败。失败项不属于用户提供的 24 个源。
- 再次全选时结果为 0 成功、24 重复、1 失败；按内容 MD5 去重，已保存数量仍为 24。结果页支持滚动查看原因和继续选择其他目录；移动端操作按钮可换行，结果页底部操作避开系统导航栏。结果截图见 `artifacts/qa-lx-custom-import-summary.png`，设置页和长结果页截图记录见 `artifacts/qa-lx-final-settings.png`、`artifacts/qa-lx-final-summary-scrolled.png`（后两图来自修复内存扩容问题之前的候选包，界面代码相同）。
- 模拟器实际导出 24 个源，导出内容与用户原文件按 SHA-256 多重集合逐项一致；扩展同 ID 更新和应用更新、重启后，导入列表与启用状态均保留。验证使用复制到模拟器的文件，未修改用户原始目录。
- 修复后在最终 APK 上连续执行 10 轮同 ID 扩展覆盖更新与重复导入：每轮均为 24 个重复、1 个合成无效文件失败，更新成功，仍保留 24 个源并启用 `gdstudio音乐源`；单轮耗时 47.2–50.1 秒，无 QuickJS 断言或崩溃。结果记录在 `artifacts/qa-lx-repeat-result.txt`。
- 真实源 `gdstudio音乐源`、`fish_music` 和 `Hei Music聚合源` 均分别初始化成功，并验证了启用、停用与重新启用。默认同时启用上限仍为 3；宿主 5 个隔离上下文的上限和释放只通过合成冒烟测试，不代表 5 个真实源的长期性能已验收。

### 25.2 播放和运行环境

上游扩展返回的 `/api/p_static/...` 虚拟地址原先只登记在 JS，Android 本地服务读不到，因此取流 404。现将地址、查询参数与请求头同步到 Android 服务；最终包上带范围请求的音频响应返回 206，`Content-Range: bytes 0-4729251/4729252`。使用 `Online Metadata 0.4.8` 搜索网易 `hello`，以已导入的 `gdstudio音乐源` 播放 `Hello - Adele`，WebView 音频时长 295.549 秒、`readyState=4`；最终复验中播放进度从 3.414 秒增长到 14.388 秒，暂停、续播和拖动至约 182 秒此前均已验证。最终截图见 `artifacts/qa-final-player-playing.png`；模拟器静音，不代表实体设备声音质量。

此前复测发现，批量导入后覆盖安装扩展可能触发 QuickJS `JS_FreeRuntime` 断言。定位为 `quickjs-emscripten` 0.31.0 的任务执行过程中发生 WASM 内存扩容：库仍从旧 `ArrayBuffer` 的视图读取上下文指针，导致误建一个未释放的上下文。`porting/js/shims/vm.ts` 现于任务执行后从当前 `HEAPU8.buffer` 读取指针，并保留结果与错误的释放语义。真实 QuickJS 回归在未修复时复现 1→2 个上下文及释放断言；修复后任务内分配使 WASM heap 从 16,777,216 增至 38,993,920 B，上下文保持 1→1，任务执行与销毁成功。独立复现命令：

```powershell
cd porting/js
$env:QA_VM_GROWTH_ONLY='1'
node scripts/smoke.mjs --dist=../../artifacts/qa-build-lx-fixed-20261106
Remove-Item Env:QA_VM_GROWTH_ONLY
```

### 25.3 HTTP 范围

全局明文仍关闭。除 §24 的 34 个精确主机外，本轮针对用户源静态出现的 10 个 HTTP 主机及运行时观察到的 1 个主机单独放行，均不包含子域名：

| 主机 | 来源 |
|---|---|
| `103.79.184.97` | HelloWorld、墨澜 |
| `106.55.0.102` | 墨澜 |
| `175.27.166.236` | 全豆要、西瓜聚合、非常刀、墨澜 |
| `anymatch.kuwo.cn`、`gc.kxwa.top`、`m.kuwo.cn`、`mobi.kuwo.cn` | 星海 |
| `api.vsaa.cn` | 全豆要、西瓜聚合 |
| `music.nxinxz.com` | 全豆要、西瓜聚合、非常刀 |
| `nmobi.kuwo.cn` | 轻量、HelloWorld、安妮、星海、裤佬 |
| `8.137.89.103` | 运行时更新检查发现，具体脚本未确认 |

模拟器通过 Android 桥验证：`http://m.kuwo.cn/` 和 `http://8.137.89.103:10004/` 返回 200，未列入的 `http://example.com/` 按网络策略被拒绝。静态扫描不能枚举脚本运行时生成的所有地址；音源更新后应重新核对所需主机。

### 25.4 构建检查与真机复验

- 移植层 `pnpm run typecheck` 通过，strict 0 错误；上游另有 394 条诊断按项目既定规则不计入该门禁，不能据此称上游类型检查通过。
- 使用独立输出目录分别构建 SPA 与 extension-preload，再执行 `shrink-assets` 和 `smoke.mjs`，均通过；从 `X:\porting\android`（`subst X:` 映射到项目根）执行 `clean :app:assembleDebug -PskipWeb=true -PrequireWeb=true` 成功；`check-webdist.mjs --assets` 为 `VERDICT: OK`，三个关键指纹一致。扩展自身的 `pnpm typecheck`、`pnpm test` 和 `pnpm build` 通过。
- `bridge` 与 `core-ports` 的 Debug 单元测试均实际执行并通过。中文路径在默认 UTF-8 下会因 Gradle 测试 worker classpath 编码报 `ClassNotFoundException`；使用 `JAVA_TOOL_OPTIONS=-Dfile.encoding=GBK`（日志 `artifacts/gradle-unit-test-gbk.log`）或在 ASCII `X:` 路径下执行 UTF-8（日志 `artifacts/gradle-unit-test-subst.log`）均可通过。该问题属于本机构建路径编码，不是应用运行时缺陷。
- 真机安装最终 APK 后主界面正常，原曲库与设置数据保留，crash 缓冲区无记录；截图 `artifacts/qa-real-device-final.png`。通过「扩展管理 → 本地安装」导入最终 `.alix` 后，列表显示独立的 `LX Music API Source Loader (Android) v0.1.7-android.1`，与已有官方 `v0.1.7` 并存，加载耗时 18 ms，截图 `artifacts/qa-real-extension-installed.png`。

### 25.5 边界

- `source/` 保持干净。当前未逐一验证 24 个第三方源的播放能力；真机本轮只确认 APK 与适配扩展的安装加载，未重复导入 24 个源。LX 扩展中的歌曲缓存开关尚未接通 Android 代理，当前不要依赖它；此前旧版本的长时息屏结果不等于当前包已经完成相同长测。

---

## 26. 移动端视觉与弹层收口（2026-11-06）

本轮只修改移植层的 Svelte/TypeScript/Less，不改 `source/`。最终 Debug APK 为 `porting/android/app/build/outputs/apk/debug/app-debug.apk`，20,351,806 B，构建时间 2026-11-06 12:28:34 +08:00，SHA-256 `010C47BE47B16FB258725673046D5E2CEC91DED89A285EAF0B4D87B9443A6A65`，入口 `main.k6Eq_-YZ.js`、样式 `style.BuhRQck2.css`。APK 已覆盖安装到 API 36 / x86_64 模拟器和 Xiaomi 2211133C / Android 16 真机；两台设备内 `base.apk` 的大小与 SHA-256 均与本地一致（20,351,806 B）。

### 26.1 已修复的视觉问题

- **在线来源条窄屏裁切**：392dp 下 5 个内置来源原先需要约 386dp，可视区仅 369dp，“咪咕音乐”右侧被切。外边距由 12dp 收到 8dp、来源项横向 padding 由 12dp 收到 10dp 后，列表矩形为 `x=8 / width=376 / right=384`，`clientWidth=scrollWidth=376`；5 项最右边界为 346.99，全部落在视口内，更多来源仍可横滑。证据见 `artifacts/qa-final-online-392.png`。
- **弹窗/抽屉堆叠**：全屏遮罩从 `.menu/.popup` 的伪元素移到 `#root` 的条件伪元素，z-index 119；抽屉本体统一 z-index 120。Dropdown 嵌在 popup 内时回到内容流，不再单独 fixed 后叠成第二层。More 菜单现在是单层 44dp 抽屉，点遮罩关闭，不会再误触背景按钮。模拟器证据见 `artifacts/qa-final-more.png`、`artifacts/qa-final-more-closed.png`。
- **真机 More 触摸自关闭（D-34）**：手指点 More 后菜单约 100ms 就自己消失，而 DOM `button.click()` 能保持打开。根因是 `PopupBtn.svelte` 把触屏在 click 后补发的兼容 `mouseenter/mouseleave` 当成桌面 hover：`mouseleave` 的 100ms 定时器把刚打开的抽屉置为 `visible=false`；`PopupDismiss` 不是本次关闭来源。新增 `ui/overrides/components/material/PopupBtn.svelte`，仅对按钮 hover 加 `(hover: hover) and (pointer: fine)` 门禁；弹层自身的 `mouseleave` 保留，供遮罩关闭派发。修复后真机触摸 `(261.8,256.5)`，等待 1.2s 抽屉仍为 `popup active`、`inert=false`、`392.7×72`；截图 `artifacts/qa-device-more-39405.png`。
- **文件选择器被 AppBar 截断**：文件列表弹窗改为底部对齐，顶部预留 `safe-top + 64px`，标题、路径栏与底部操作键均完整可见；列表容器的原生黑色焦点框已移除，底部按钮避开系统导航栏。证据见 `artifacts/qa-final-filepicker.png`。
- **自定义源行内错位**：复选框区域改为吃掉剩余宽度，`Remove` 固定为 44dp 并统一贴右。模拟器扫描 24 个源的列表项均无横向溢出，名称、说明和操作键不重叠；真机当前载入 9 个源，9 行实测 `Remove` 均为 `58×44`，右边界全部为 `376.7`，未超过 `innerWidth=392`。证据见 `artifacts/qa-final-lx-sources.png`、`artifacts/qa-final-lx-bottom.png`。
- **播放详情可读性**：未播放歌词的 `font-mode` 子 `span` 使用 `--color-650`，蓝色扫词渐变仍保留；辅控按钮取消双重淡化，图标在浅/深主题下均可辨识。证据见 `artifacts/qa-final-playdetail.png`。
- **动态分隔线与新标签容器**：顶部在线资源的标签动作区仅在确有内容时显示左侧分隔线，不再出现空容器悬空的竖线。
- **状态栏图标**：WebView 内容颜色随主题同步；深色主题状态栏图标为白色，切回浅色主题后恢复深色图标。证据见 `artifacts/qa-final-dark-theme.png`、`artifacts/qa-final-restored-light.png`。

### 26.2 复验结果

- **真机 392×872 / dpr 2.75**：在线来源条列表 `x=8 / width=376.73 / right=384.73`，`clientWidth=377=scrollWidth`，5 个内置来源最右边界为 `373.85`，页面无横向溢出；截图 `artifacts/qa-device-online-39405.png`。
- 同一真机上打开备份保存对话框：弹窗内容从 `y=108` 铺到 `872.7`，标题「选择保存位置」完整，取消/确定底边为 `864.7`，为系统手势区保留 8px；列表焦点框为 `none`。截图 `artifacts/qa-device-filepicker-39405.png`。
- More 抽屉实测为 `392.7×72`（内容区 `56dp`），菜单项完整一行，抽屉 `z=120`，`#root::before` 遮罩 `z=119`。用 CDP `Input.dispatchTouchEvent` 真实触摸 More：点击前 `.popup` 为 0；触摸后 1.2s 仍有 1 个打开态弹层，class 为 `popup active`、`inert=false`、`opacity=1`，文本为「收藏为普通列表」，此时 `matchMedia('(hover: hover) and (pointer: fine)')` 为 false。再触摸 `(20,100)` 后弹层数为 0，路由仍为 `#/online/topSongs?id=8888&sid=online-metadata_kg`，多选状态 `selected=0`、当前曲 `Bleed 2 Feed - CC Adcock` 均未变。另触摸播放详情倍速按钮 `(196.4,770.7)`，1.2s 后弹层仍打开（文本 `1.00x | 音调补偿`），点遮罩后关闭，证明不是 More 的单点特判。证据见 `artifacts/qa-device-more-39405.png`、`artifacts/qa-device-rate-39405.png`。
- 深色主题「黑灯瞎火」下状态栏图标为白色；恢复原主题「清热版蓝」后恢复深色。截图 `artifacts/qa-device-dark-39405.png`、`artifacts/qa-device-restored-light-39405.png`。
- 覆盖检查了设置页、在线榜单、播放详情、More 菜单、备份类型弹窗、文件保存弹窗、LX 自定义源列表、扩展设置与深/浅主题切换；未发现新的字符互相压盖、操作键被截断或弹层嵌套叠影。复验结束后模拟器已清除 CDP 视口覆盖并恢复 412×915。
- 设置页与扩展设置页顶部的二级 Tab 仍为横向滚动列表，窄屏会露出下一项的局部作为滚动暗示；这是可滑动容器，不属于内容重叠。

### 26.3 门禁、真机边界

- `pnpm typecheck`：移植层 strict 通过，0 错误；`pnpm build:all` 通过；`pnpm smoke` 通过；`gradlew :app:assembleDebug -PrequireWeb=true` 为 `BUILD SUCCESSFUL`。
- 从 `porting/android` 执行两次 `check-webdist.mjs`（默认与 `--assets`）均为 `VERDICT: OK`；`index.html`、`main.k6Eq_-YZ.js`、extension-preload 三项指纹在 `dist` 与 APK assets 间全等。
- 无线真机短暂离网后恢复为 `192.168.1.39:39405`。最终 APK 覆盖安装成功，`lastUpdateTime` 为 2026-11-06 12:28:43，设备内 `base.apk` 与本地 SHA-256 均为 `010C47BE47B16FB258725673046D5E2CEC91DED89A285EAF0B4D87B9443A6A65`；模拟器 `lastUpdateTime` 为 2026-11-06 04:28:40（模拟器时区），APK 指纹相同。复验期间 CDP 无未捕获异常；logcat 未出现 `FATAL EXCEPTION`、`ANR in`、`JS_FreeRuntime`、`Uncaught TypeError`、`CLEARTEXT` 或 `source not found`。设备退出记录只有正常的强制停止/覆盖安装和 WebView 沙箱子进程回收。

### 26.4 D-34 回归依据与修法边界

- **失败时的真实事件链**：`click` 到达按钮后弹层开始出现；WebView 随后合成 `mouseenter`，约 100ms 后合成 `mouseleave`，`handlMsLeave()` 再等 100ms 执行 `visible=false`。实测弹层约 551ms 出现、651ms 已消失；`elementFromPoint` 命中的是按钮内 SVG，不存在透明遮挡层。
- **为什么只改按钮**：`PopupDismiss` 的关闭契约是对 `.popup` 派发合成 `mouseleave`，再由组件自己的 `handlMsLeave()` 落地。若给 `Popup` 的 `mouseleave` 也加 fine-pointer 门禁，触屏将没有任何可用的遮罩关闭路径。因此覆写只门禁按钮的 `mouseenter/mouseleave`，弹层的 `mouseenter/mouseleave` 原样保留。
- **`autoshow` 未全局改动**：`autoshow` 仍保留桌面 hover 语义，接鼠标/触控板时 `(hover: hover) and (pointer: fine)` 命中，行为与上游一致；纯触摸设备只靠 click 打开，避免影响其他 `PopupBtn` 的桌面语义。
- **非目标**：`PopupDismiss` 的坐标判定、底部抽屉样式和 z-index 均未改；本轮只修“触摸后合成 hover 关闭”这一条路径。

---

## 27. 移动端曲库两级结构（D-35，2026-11-06）

本轮只修改移植层的 Svelte/TypeScript，不改 `source/`。最终 Debug APK 为 `porting/android/app/build/outputs/apk/debug/app-debug.apk`，20,353,254 B，构建时间 2026-11-06 12:44:57 +08:00，SHA-256 `C64D4E101856F58676244F0540F6B906F6AE2426E12274BC45FE34CD79A180F1`，入口 `main.ByXZk12O.js`、样式 `style.BC-s8zPF.css`。APK 已覆盖安装到 API 36 / x86_64 模拟器和 Xiaomi 2211133C / Android 16 真机；两台设备内 `base.apk` 的大小与 SHA-256 均与本地一致。

### 27.1 现象与根因

真机进入曲库时，地址不是一级列表，而是 `#/library?id=love`；页面直接展示「我喜欢」，导入和收藏的歌单没有可见入口。数据库侧歌单数据本身正常，问题不在导入链路：

- 默认列表：`default` 试听列表 100 首、`love` 我喜欢 1 首、`last_played` 播放历史。
- 顶层用户歌单 9 个，包括周杰伦、许嵩、香港地区榜、林俊杰等收藏歌单。
- 移动端一级应显示默认 2 个列表 + 用户 9 个歌单，共 11 行；`last_played` 不应混入「我的歌单」。

根因有两层：移动壳不渲染桌面 `Aside`，因此上游放在侧栏里的「我的歌单」完全不存在；同时上游 `Library` 在没有 `$query.id` 时会把路由补成上次选择或 `LIST_IDS.LOVE`。两处叠加后，`/library` 必然被改成 `/library?id=love`，一级列表没有渲染机会。

### 27.2 修法

- 新增 `porting/js/ui/pages/MobileLibraryLists.svelte`：使用 `defaultLists + useUserList(null)`，只渲染默认列表和顶层用户歌单，不把播放历史和子歌单混进一级。
- 新增 `porting/js/ui/pages/MobileLibraryListItem.svelte`：展示封面、歌单名、歌曲数和右箭头；点击执行 `push('/library?id=…')`，形成一级到二级的导航栈。
- 修改 `porting/js/ui/overrides/views/Library/index.svelte`：无 `id` 时渲染 `MobileLibraryLists`，有合法 `id` 时继续使用上游 `MusicList`；删除「无 `id` 就恢复上次选择 / `love`」的兜底，仅在 `id` 失效时 `replace('/library')`。
- 修改 `porting/js/ui/shell/MobileAppShell.svelte`：`/library` 一级不显示返回键，`/library?id=…` 二级显示返回键；底部 Tab 在两级路由下都保持「曲库」高亮。
- 修改 `porting/js/ui/boot/androidBack.ts`：只有无 `id` 的 `/library` 才属于根级；二级歌曲页按 Android 返回键会回到一级，不再触发「再按一次退出」。

### 27.3 真机复验

复验设备为 Xiaomi 2211133C / Android 16，无线调试 `192.168.1.39:39405`，392×872 CSS，dpr 2.75。

- 冷启动后页面停在 `#/library`，没有 `id=love`；一级显示「我的歌单 / 11 个歌单」，逐行为「我喜欢、试听列表」加 9 个用户歌单，播放历史未混入。截图见 `artifacts/qa-device-library-home-39405.png`。
- 一级没有 AppBar 返回键；点击周杰伦收藏歌单后地址为 `#/library?id=hxs2wb6eja`，标题、65 首歌曲、播放全部和随机播放均正常显示。二级出现返回键，底部「曲库」仍为 `active`。截图见 `artifacts/qa-device-library-list-39405.png`。
- 点 AppBar 返回键回到 `#/library`，一级恢复且返回键消失；再次进入歌单后执行 `adb shell input keyevent 4`，同样回到一级，应用进程未退出。
- 在二级页再次点击底部「曲库」Tab，也会回到 `/library`，不会停留在关联歌曲页。
- CDP 无未捕获异常；logcat 未出现 `FATAL EXCEPTION`、`ANR in` 或 `Uncaught TypeError`。

### 27.4 门禁与边界

- `pnpm typecheck`：移植层 strict 通过，0 错误；`pnpm smoke` 通过，产物、worker、Ports、SQLite 和扩展沙箱检查全绿。
- `pnpm build:all` 通过；`:app:assembleDebug -PskipWeb=true -PrequireWeb=true` 为 `BUILD SUCCESSFUL`。
- 从 `porting/android` 连续执行两次 `check-webdist.mjs` 及一次 `check-webdist.mjs --assets`，三次均为 `VERDICT: OK`；`index.html`、`main.ByXZk12O.js`、extension-preload 三项指纹在 `dist` 与 APK assets 间全等。
- 真机 `lastUpdateTime` 为 2026-11-06 12:45:24，模拟器为 2026-11-06 04:45:22（模拟器时区）；两台设备内 `base.apk` 均为 20,353,254 B，SHA-256 与本地一致。
- 一级列表只覆盖顶层歌单，和桌面「我的歌单」保持同一层级语义；歌单文件夹内的子歌单仍不在一级平铺。

## 28. 桌面专属设置清理（D-36，2026-11-06）

### 28.1 处置范围

PDR-007 原先只写了“隐藏桌面专属项”，实际设置页仍显示 13 个一级入口，其中“快捷键设置”和“软件更新”在 Android 上没有可用后端，其他页面还混有窗口、任务栏和桌面输出设备配置。本轮按以下边界处理：

- 移除两个整段：`hotkey`（快捷键设置）与 `update`（软件更新）。这 7 个更新/快捷键控件在 Android 上不是“暂时不可用”，而是没有用户路径。
- 基本设置移除：窗口尺寸、播放栏样式、字体设置。移动壳固定使用 MiniPlayer，WebView 也没有可枚举的系统字体列表。
- 播放设置移除：任务栏播放进度、标题栏歌词、媒体输出设备。前两者修改的是桌面窗口标题/任务栏，后者由 Android 系统负责音频路由。
- 其他设置移除：透明窗口。该配置只影响 Electron 窗口透明效果。
- 网络代理反向处理：保留“HTTP 代理设置”，移除上游的 `VITE_IS_DESKTOP` 禁用条件。Android 的 `HttpPort` / OkHttp 已支持应用级代理，原实现属于 UI 与宿主能力不一致。
- 所有底层配置 key 保持原样。此次只改变设置页的可见项，已有配置文件、备份与 WebDAV 同步不需要迁移。

设置表通过 `ui/overrides/views/Setting/AppSetting/settings.ts` 对上游原表过滤，并由 `@ui-raw/views/Setting/AppSetting/settings` 直取上游定义，避免复制和维护整份设置清单。网络页单独覆写，其余表单逻辑保持不变。

### 28.2 其他桌面交互复核

- 移动壳不渲染桌面 `Aside` / `Header` / `PlayBar`，不存在托盘、最小化、最大化、窗口拖动入口；播放详情的全屏键只在上游桌面/网页分支渲染，Android 不生成。
- 桌面歌词按钮只在 `VITE_IS_DESKTOP` 时挂载；Android 播放详情不显示该按钮。
- 文件浏览、歌曲行、队列与滚动位置已使用单击/长按语义；文件浏览器的双击窗口此前已移除。
- 当前启用的 `Online Metadata`、LX 音源没有提供专辑/歌手搜索资源，在线搜索实测仅出现“搜索 / 歌单 / 排行榜”，不存在会进入空白模板的专辑/歌手 Tab。
- 歌曲排序弹窗使用普通 Radio 与确认按钮，不依赖拖拽或 Ctrl 键；当前没有需要为此单独改动的触屏操作。
- 歌曲菜单中的“在文件夹中显示”只对桌面渲染；下载入口在上游注释关闭。手机菜单不出现这两个无后端动作。

### 28.3 真机与模拟器复验

- 覆盖安装后，Xiaomi 2211133C / Android 16 真机与 API 36 模拟器的设置导航均从 13 项降为 11 项：“快捷键设置”“软件更新”消失。
- 真机逐页读取设置内容：基本设置不再包含窗口尺寸、播放栏样式、字体；播放设置不再包含任务栏进度、标题栏歌词、媒体设备；其他设置不再包含透明窗口。网络设置仍保留，代理开关、主机、端口三个控件均为可编辑状态（`disabled=false`）。
- 392×872 真机截图见 `artifacts/qa-d36-settings-network-39405.png`。一级设置 chip、网络表单、MiniPlayer 与底部 Tab 无重叠，代理输入框可直接聚焦。
- 两台设备在设置页遍历与页面切换期间，CDP 未捕获异常；logcat 未出现 `FATAL EXCEPTION`、`ANR in com.anylisten.android`。

### 28.4 门禁与边界

- `pnpm typecheck`：移植层 strict 通过，0 错误；`pnpm smoke` 通过。
- `pnpm build:all` 通过；`:app:assembleDebug -PskipWeb=true -PrequireWeb=true` 为 `BUILD SUCCESSFUL`。
- 从 `porting/android` 连续执行两次 `check-webdist.mjs` 及一次 `check-webdist.mjs --assets`，三次均为 `VERDICT: OK`；入口为 `main.y5rIzLsK.js`，样式仍为 `style.BC-s8zPF.css`。
- 最终 APK 为 20,353,255 B，SHA-256 `2AE5ADC37693F16F308468489A8C2C8A33F2C28A9E496C16D1B4AFB966316619`；真机 `lastUpdateTime` 为 2026-11-06 12:58:40，模拟器为 2026-11-06 04:58:38（模拟器时区），两端设备内 `base.apk` 指纹均与本地一致。
- 被移除的只是设置入口，不删除底层能力：实体键盘仍可使用已配置快捷键，配置 key 与备份保持兼容；以后若恢复某个桌面项，只需调整过滤表。

---

## 29. 在线歌单移动布局修复（D-37，2026-11-06）

本轮只修改 `porting/js/ui/mobile.less` 和静态门禁 `porting/js/scripts/smoke.mjs`，不改 `source/`。在线歌单的数据链路本身正常：直接进入「歌单」会自动补 `s=online-metadata_kg&st=5` 并加载列表，歌单详情也能进入；本轮处理的是桌面定尺在手机上的裁切、重叠和关闭态抽屉常驻。

### 29.1 现象与根因

- **歌单卡越界**：上游歌单卡是桌面横向卡，`min-width:300px` 且高度固定；移动端全局 `ul` 网格又强制两列。412dp 模拟器上每列约 174.36dp，但卡片仍按 300dp 排版，实测卡片右边界到 502dp，右列文字和封面被视口裁掉。
- **头部控件重叠**：歌单页左侧「搜索 / 歌单 / 排行榜」与右侧「打开歌单 / 标签 / 排序」共用一行。392dp 真机上右侧过滤区从 `x=32` 开始，直接压在资源类型 Tab 上。
- **关闭态弹层常驻**：标签弹层关闭时只有 `aria-hidden=true`，没有 `inert`。全局 BottomSheet 规则把 `.popup` 统一改成 `display:flex`，因此关闭态仍出现在 `y=764`、高约 108.6dp 的底部区域，遮住分页和 TabBar。
- **搜索歌单同样受影响**：搜索结果复用同一张歌单卡和同一组头部控件，具有相同的两列裁切。
- **排行榜未受同一问题影响**：排行榜卡不含 `.songlist-info`，仍是独立的封面网格；榜单详情页正常。

### 29.2 修法

- 仅在头部确实存在 `.online-songlist-header-right` 时，将 `.header` 改为两行 grid：第一行资源类型 Tab，第二行打开歌单、标签和排序；没有这组过滤控件的普通在线页保持原布局。
- 仅对 `ul:has(.songlist-info)` 的歌单列表改单列；卡片取消桌面 `min-width` 和固定高度，封面固定 96dp，标题最多两行，作者、日期和播放量在右列内收口。排行榜卡没有 `.songlist-info`，继续使用两列网格。
- 标签弹层按 `aria-hidden` 显式设置 `display:none/flex`；打开时由 `.tag-list` 的全屏伪元素提供 z-index 119 遮罩，弹层本体保持 z-index 120。
- 覆盖全局二级 Tab 的 `display:flex` 命中，把弹层内部标签列表恢复为纵向换行和自身滚动；同时让 `#online-header-right` 使用可见溢出，避免绝对定位抽屉被横向滚动容器裁切。
- `smoke.mjs` 从“只查选择器字符串”升级为“选择器 + 关键声明”检查，锁住两行头部、单列卡、最小宽度移除、关闭态隐藏、打开态展开和标签纵向换行。

### 29.3 模拟器与真机复验

**API 36 模拟器（412×915 CSS）**

- 直接「歌单」：卡片列表为单列 380.2dp，卡片 `x=16 / width=380.19 / height=112`，封面 96×96；页面 `scrollWidth=clientWidth=412`，无横向溢出。
- 顶部两行：资源类型区 `y=108 / height=44`，筛选区 `y=156 / height=96`；英文筛选标签自然换行，不再覆盖一级 Tab。
- 关闭态标签弹层：`aria-hidden=true`、`display:none`、`0×0`。打开后底部抽屉 `y=366 / height=549 / z=120`，标签按行排列；点击遮罩后恢复为关闭态。
- 搜索歌单：结果卡同为单列 380.2dp。排行榜：列表仍为 2 列 174.4dp 封面卡；详情页歌曲行正常。打开歌单弹窗的内容区完整位于底部安全区内。
- 冷启动直接进入歌单：等待 6.5 秒后 `loading=false`、26 张卡可见，没有再复现此前偶发的永久 Loading。
- 分页切到第 2 页：地址增加 `p=2`，活动页变为 2，返回 20 张新卡。歌单收藏首次写入成功，重复点击会提示 `The same playlist ... already exists locally`；点第一首歌后 MiniPlayer 显示「你曾是少年 - S.H.E / Getting the song link...」。

**Xiaomi 2211133C / Android 16 真机（392.7×872 CSS，dpr 2.75）**

- 直接「歌单」：头部高 104dp，资源类型区 360.7×44，筛选区 360.7×44；歌单卡 `x=16 / width=360.7 / height=112.5`，无文字或图片越界。
- 标签抽屉：关闭态 `0×0`；打开后 `y=349.1 / width=392.7 / height=523.6`，标签按 6/6/3 行换行，遮罩和抽屉层级正确。
- 搜索歌单：结果卡 360.7dp 单列；排行榜 56 项保持 2 列 174.36dp；榜单详情与「打开歌单」弹窗均完整可见，弹窗内容底边为 `756.7`，没有压到系统导航区。

证据截图：`artifacts/qa-d37-songlist-5568.png`、`qa-d37-tag-popup-5568.png`、`qa-d37-search-songlist-5568.png`、`qa-d37-topsongs-5568.png`、`qa-d37-topsongs-detail-5568.png`、`qa-d37-openlist-5568.png`；真机对应 `*-37981.png`。旧问题的对照证据为 `qa-online-songlist-before-38313.png`、`qa-online-topsongs-before-38313.png`。

### 29.4 门禁、交付物与边界

- `pnpm typecheck`：移植层 strict 0 错误；`pnpm build:all` 通过；`pnpm smoke` 通过，新增的 6 项在线歌单 UI 守卫全部命中。
- `:app:assembleDebug -PskipWeb=true -PrequireWeb=true` 为 `BUILD SUCCESSFUL`；从 `porting/android` 连续执行两次 `check-webdist.mjs` 及一次 `check-webdist.mjs --assets`，三次均为 `VERDICT: OK`，`index.html`、`main.y5rIzLsK.js`、extension-preload 三项指纹 dist↔assets 全等。
- 最终 APK 为 20,353,255 B，构建时间 2026-11-06 13:46:03 +08:00，SHA-256 `2DB8A36B45A20C1BEBA142421EA482C930B1F6325B8A039AE43C5BFAFA346220`；入口 `main.y5rIzLsK.js`，样式 `style.DXj1ZTi0.css`。真机 `lastUpdateTime` 为 13:50:58，模拟器为 05:46:02（模拟器时区）；两端设备内 `base.apk` 均为同一 SHA-256。
- CDP 未捕获页面异常；真机与模拟器 logcat 均未出现 `FATAL EXCEPTION`、`ANR in com.anylisten.android`、`Uncaught TypeError` 或 `JS_FreeRuntime`。第三方 `Online Metadata` 仍会打出 `finishFlush` 日志，部分源站封面使用 HTTP 或返回 404 时仍显示占位图；它们不阻断歌单文本、分页、收藏与详情，本轮未改扩展和网络白名单。
- 本轮边界仍是手机竖屏；横屏、平板/折叠屏和外接指针没有新增覆盖。没有新增 Svelte 覆写，桌面数据链路和 `source/` 均保持不变。

---

## 30. 播放队列入口与详情底栏收口（D-39 / D-40 / D-41，2026-11-06）

本轮只修改 `porting/` 和项目文档，`source/` 保持零改动。最终 Debug APK 为 `porting/android/app/build/outputs/apk/debug/app-debug.apk`，20,368,638 B，构建时间 2026-11-06 16:06:46 +08:00，SHA-256 `ACB503E185D8C185EF3F6D2E7F2F9808CF7FB275860A990A76FD6020929959AF`，入口 `main.BP7v_VMg.js`、样式 `style.BQVVV4P_.css`。

### 30.1 现象、根因与修法

- **D-39 队列入口**：MiniPlayer 右侧第三个按钮实际执行的是打开播放详情，用户无法直接查看当前队列或切歌。该键复用了详情页跳转，没有接上游已有的 `PlaylistBtn`；队列组件本身已适配移动端 BottomSheet。将第三键改为内嵌 `PlaylistBtn` 后，点击从底部向上展开队列，点歌曲行直接切歌；Android 返回键只关闭队列，不退出详情或曲库。
- **D-40 详情底栏**：上游 Footer 按桌面宽度把控件分成三组横排。移动样式此前只能把三组拆成三行，红心和播放列表仍在侧组，主控与辅控难以同时保持原尺寸和可读间距。仅靠 CSS 无法跨组移动 DOM，因此新增 `ui/overrides/components/layout/PlayDetail/Footer/index.svelte`：进度条在上，辅控五键一行，主控为红心 / 上一曲 / 播放 / 下一曲 / 播放列表；不走运行时搬 DOM，避免 Svelte 重渲染后按钮丢失。
- **D-40 布局约束**：控制区固定 `208dp`，内容区 `200dp`；两行总高 `124dp = 44 + 8 + 72`。主控保留 `51 / 72 / 51dp`，红心和播放列表使用 `44dp` 命中区、`30dp` 图标；辅控均使用 `44dp` 命中区和 `24dp` 图标。进度条轨道高 `6dp`，时间文字按轨道中心对齐。
- **D-41 歌词空引用**：切歌时歌词数组会短暂清空，`RightLyric` 随即卸载 `LyricPlayer`；旧的滚动动画或歌词事件仍可能执行 `setLyric`，向已经消失的 `domLyricText` 写入 `textContent`，日志出现两次同类 `Uncaught TypeError`。修法是让 `LyricPlayer` 在详情页内始终挂载，把「歌词加载中 / 暂无歌词」改成同层覆盖提示，不再随歌词数量卸载播放器。

### 30.2 真机几何与触控

复验设备为 Xiaomi 2211133C / Android 16，无线调试 `192.168.1.39:37981`，视口 `392×872 CSS`，dpr `2.75`。

- Footer 实测 `x=0 / y=664.73 / width=392.73 / height=208`，页面无横向溢出。
- 辅控五个 `44×44dp` 命中区的中心 x 为 `57.36 / 126.86 / 196.36 / 265.86 / 335.36`。
- 主控红心、上一曲、播放、下一曲、播放列表的中心 x 为 `38 / 126.86 / 196.36 / 265.86 / 354.73`，尺寸分别为 `44 / 51 / 72 / 51 / 44dp`。辅控第 2、3、4 键与上一曲、播放、下一曲完全同轴。
- 进度外框 `y=680.73 / height=20`，轨道 `y=687.73 / height=6`；左右时间文字中心与轨道中心均为 `y=690.73`。
- 所有控制键命中区均不小于 `44dp`；队列抽屉实测从 `y=360.73` 向上展开为 `392.73×512`。

### 30.3 交互复验

- 点击 MiniPlayer 队列键打开当前队列，标题、封面、音质和时长正常；点歌曲行可切歌。Android 返回键关闭抽屉后，详情仍在、当前曲不变。
- 播放/暂停键的 `aria-label` 在「播放」与「暂停」之间正确切换；下一曲可切歌；播放顺序弹层从底部打开，返回键可关闭；进度条点击跳转正常。
- 连续切歌 3 首后，歌词分别渲染 30 / 22 / 15 行，详情页与歌词区保持可见；CDP `Runtime.exceptionThrown=0`，logcat 未再出现先前的 `Cannot set properties of null (setting 'textContent')`。
- 证据截图：`artifacts/playdetail-final-verified.png`（最终包）、`artifacts/playdetail-formal-queue.png`（队列）、`artifacts/playdetail-formal-mode.png`（播放顺序）、`artifacts/playdetail-formal-next.png`（切歌）。

### 30.4 门禁、交付物与边界

- `pnpm typecheck`：移植层 strict 0 错误；`pnpm build:all` 通过；`pnpm smoke` 通过，产物、worker、Ports、SQLite 和扩展沙箱检查全绿。
- `:app:assembleDebug -PskipWeb=true -PrequireWeb=true` 为 `BUILD SUCCESSFUL`；`check-webdist.mjs --assets` 为 `VERDICT: OK`，`index.html`、`main.BP7v_VMg.js`、extension-preload 三项指纹 dist↔assets 全等。
- 真机覆盖安装成功，`lastUpdateTime` 为 2026-11-06 16:07:12；设备内 `base.apk` 为 20,368,638 B，SHA-256 `acb503e185d8c185ef3f6d2e7f2f9808cf7fb275860a990a76fd6020929959af`，与本地一致。
- 本轮边界仍是手机竖屏；横屏、平板/折叠屏和外接指针没有新增覆盖。D-39 的队列入口沿用上游 BottomSheet，D-40 的布局只作用于移动端播放详情，D-41 只改变歌词播放器生命周期，不改歌词解析和播放链路。

---

## 31. 应用启动图标（D-42，2026-11-06）

### 31.1 现象与根因

APK 安装后使用系统默认图标。Manifest 的 `<application>` 只有 `label` 和 `theme`，没有 `android:icon` / `android:roundIcon`，`res/` 下也没有 launcher 图标资源。功能层与 WebView 无关，属于 Android 壳层资源缺失。

### 31.2 修法

- 图标来源固定为上游桌面版 `source/packages/desktop/resources/icons/icon.png`（512×512 RGBA），不使用重新绘制的素材。
- 原图蓝色为 `#4F62D0`，白色波形未播放态与上游一致。adaptive icon 背景使用该纯色，前景从原图提取波形 alpha；波形宽度按 adaptive 安全区缩至 `62/108dp`，避免启动器圆形/圆角遮罩裁掉笔画。
- 新增 `mipmap-anydpi-v26/ic_launcher.xml` 与 `ic_launcher_round.xml`，并为 Android 13+ 提供 `monochrome` 层作为主题图标。
- 同时生成 `mdpi / hdpi / xhdpi / xxhdpi / xxxhdpi` 的 `ic_launcher.png` 与 `ic_launcher_round.png`，作为非 adaptive 路径兜底。
- Manifest 接入 `android:icon="@mipmap/ic_launcher"` 与 `android:roundIcon="@mipmap/ic_launcher_round"`。

### 31.3 构建与真机复验

- `aapt2 dump badging`：`application: label='Any Listen' icon='res/mipmap-anydpi-v26/ic_launcher.xml'`；160–640dpi 均解析到该 adaptive icon。
- Xiaomi 2211133C / Android 16 覆盖安装后，系统「应用信息」页显示蓝底白色波形图标；返回桌面后，启动器图标同样已刷新。截图见 `artifacts/launcher-icon-app-info.png`、`artifacts/launcher-icon-home-check.png`。
- `:app:assembleDebug -PskipWeb=true -PrequireWeb=true` 为 `BUILD SUCCESSFUL`；APK 为 20,370,123 B，构建时间 2026-11-06 16:42:46 +08:00，SHA-256 `0E6738230118BA4CC97CB702E2281624CDE1C0988D28B9BA81BFAFD1F93D3100`；真机 `lastUpdateTime` 为 16:43:15。
- 本轮只改 Android 资源与 Manifest，不改 JS、`source/` 或播放逻辑。

---

## 32. 在线播放增强候选验收（`android.2`，2026-11-11）

本轮承接在线歌曲缓存、列表“已缓存”标识、播放淡入淡出、媒体通知封面与前台服务四项改动，并把本地 Debug 候选从 `1.0.0-android.1` 提升为 `1.0.0-android.2`。`source/` 保持干净；本轮只重建和验收 Debug APK，未创建 Release，也未发布 GitHub Release。

### 32.1 候选产物与设备一致性

| 项 | 值 |
|---|---|
| APK | `porting/android/app/build/outputs/apk/debug/app-debug.apk` |
| 版本 | `versionCode=2` / `versionName=1.0.0-android.2` |
| 大小 | 20,996,093 B |
| 构建时间 | 2026-11-11 16:54:09 +08:00 |
| SHA-256 | `E56261B5086977E568F94B75FC287EC338AC564D02C5E19609EF50298DF02DC6` |
| LX 扩展 | `artifacts/lx-loader/lx-api-source-loader-android_0.1.7-android.2.alix` |
| 扩展指纹 | 194,364 B / SHA-256 `93C458ECB85CF19483F05705DF3CF57AB7D4ADC7DF62052D5158A236097E5D49` |
| 模拟器 | `emulator-5568`，API 36，x86_64 |

APK 使用 `adb install -r` 覆盖安装成功，原有曲库、设置、扩展和缓存均保留。设备 `base.apk` 的 SHA-256 与小写形式 `e56261b5086977e568f94b75fc287ec338ac564d02c5e19609ef50298df02dc6` 一致。工作区没有生成 `app-release.apk`。

### 32.2 构建与静态门禁

- 加入缓存标识后重新执行 `pnpm typecheck`，移植层 strict 检查为 0 错误；`pnpm build:all` 生成 SPA、5 个 worker、`extension-preload` 并完成 `shrink-assets`。
- `check-webdist.mjs --assets` 为 `VERDICT: OK`，入口为 `main.BA_Aindu.js`，扩展 worker 为 `ext.worker-CIlBBYd0.js`；`index.html`、主入口和 `extension-preload` 在 `dist` 与 APK assets 之间的 SHA-1 三项全等。
- `:bridge:testDebugUnitTest :core-ports:testDebugUnitTest` 在 ASCII 临时副本中为 `BUILD SUCCESSFUL`；覆盖 `ProxyMediaCacheTest` 和 `HttpPortCacheIntegrationTest`。
- LX 扩展自身 `pnpm typecheck`、`pnpm test`、`pnpm build` 通过。`android.2` 包重复导入回归连续 10 轮通过：每轮 24 个重复源加 1 个合成坏源，更新成功、保留 24 个源、仅启用 `gdstudio音乐源`，耗时 44.0–45.6 秒；未出现 `JS_FreeRuntime`、断言失败或致命异常。明细见 `artifacts/qa-lx-repeat-result.txt`。
- 本轮版本号只改变 Android 清单中的 `versionCode/versionName`；完成后执行 `:app:assembleDebug -PskipWeb=true -PrequireWeb=true`，结果为 `BUILD SUCCESSFUL`。

### 32.3 在线搜索与真实播放

- 安装并启用 `Online Metadata 0.4.8` 与 LX 加载器后，在线搜索 `hello` 返回 8 条歌曲。首条为 `Hello kg HR Adele 04:55`。
- 用 CDP 真实指针点击首条歌曲后，`HTMLAudioElement` 进入播放：`paused=false`、`readyState=4`、`duration=295.549388`，4 秒采样时 `currentTime=4.854404`。
- 网络探针确认音源响应为 HTTP `206`，`Content-Type: audio/mpeg; charset=UTF-8`，`Content-Range: bytes 0-4729251/4729252`，`Content-Length: 4729252`。
- 页面异常计数为 0；新包回归期间 logcat 未出现 `FATAL EXCEPTION`、`ANR`、`JS_FreeRuntime`、断言失败或未捕获 `TypeError`。

### 32.4 播放淡入淡出

新包实测初始音量为 `1`。点击 MiniPlayer 暂停后：

- 音量在约 221 ms 内由 `1` 线性降至 `0`；
- 音量归零后才进入 `paused=true`；
- 再次播放后约 347 ms 恢复到 `1`；
- 播放位置保持连续：暂停前 19.835 秒，暂停点为 20.169 秒，恢复后继续推进到 21.221 秒；
- CDP 页面异常计数为 0。

明细见 `artifacts/qa-current-fade-result.json`。

### 32.5 完整缓存、断网冷启动与列表标识

目标歌曲完整落盘为 `files/cache/proxy/02565cffb6eb1b20fa94f4f63f34a8167aaeee8dcdf90b2c22f1f32cbd290d83.mp3`，大小 4,729,252 B，与源站 `Content-Length` 一致。随后执行以下受控步骤：

1. 开启飞行模式，确认 `Active default network: none`；
2. 强制停止并冷启动 `1.0.0-android.2`；
3. 从持久化播放项点击 MiniPlayer 的 `Play`；
4. 等待 3 秒并再次采样音频状态。

结果：`currentSrc` 指向本地 `/api/p_static/...`，`paused=false`、`readyState=4`、`duration=295.549388`；播放时间从 4.047690 秒推进到 7.234839 秒，增加 3.187 秒，页面异常为 0。该结果证明缓存能跨进程命中，不依赖当前进程内内存状态。完整记录见 `artifacts/qa-current-offline-result.json`。

断网冷启动时，歌曲封面 URL 无法联网获取，因此这一轮通知可能暂不显示封面；音频缓存本身完整可用。此边界已写入 README。

随后列表增加了只读缓存标识。界面从已有 `music_url` 映射中提取 `/p_static/<name>`，覆盖歌曲当前音质和所有已登记音质，只对代理缓存目录中的正式文件执行 `stat`。只有存在且长度大于 0 的完整文件才显示标识；`.part`、失败任务和仅有的 Range 片段都不会显示。点击音源或列表不会因探测而触发额外取流。

API 36 模拟器实测：

- `Hello kg HR Cached Adele 04:55` 显示标识，文本为 `Cached`，`title` 和 `aria-label` 均为 `Cached for offline playback`；
- 同一列表的未缓存对照 `Hello! kg SQ Super Simple Songs 01:18` 不显示标识；
- 临时移走 4,729,252 B 的正式缓存文件后重新搜索，目标行变为 `Hello kg HR Adele 04:55`，标识数量为 0；
- 恢复正式文件后再次搜索，目标标识重新出现；
- 三种状态下 CDP 页面异常均为 0，logcat 未出现缓存检查失败、`FATAL EXCEPTION`、`ANR`、`JS_FreeRuntime`、断言失败或 `Uncaught TypeError`。

完整记录见 `artifacts/qa-cache-badge-result.json`，界面预览见 `artifacts/qa-cache-badge-preview-final.png`。模拟器系统 `screencap` 在当前图形后端持续返回黑帧，因此本轮以 WebView DOM、可访问性属性和状态切换探针作为界面验收证据。

### 32.6 后台播放、前台通知与媒体控制

- 返回桌面后 2 秒，播放时间从 37.765498 秒推进到 40.003686 秒，增加 2.238 秒。
- `dumpsys activity services` 显示 `PlaybackService` 的 `isForeground=true`、`foregroundId=1001`，前台类型包含 `mediaPlayback`。
- `dumpsys media_session` 显示 `AnyListenSession` 为 `PLAYING(3)`，metadata 为 `Hello, Adele, Hello`，封面加载后 metadata 大小为 8。
- 通知 ID 为 `1001`，channel 为 `anylisten.playback`，flags 包含 `ONGOING_EVENT|FOREGROUND_SERVICE`，模板为 `Notification$MediaStyle`，标题为 `Hello`、正文为 `Adele`，大图为 `125×125`，有上一首、暂停/播放、下一首三个 action。
- 通过系统媒体会话暂停后等待 6 秒，状态保持 `PAUSED(2)`，通知仍在，`MediaStyle`、标题、正文和 `125×125` 大图均保留。
- 再通过媒体会话恢复后，播放时间从 40.614959 秒推进到 44.893104 秒，增加 4.278 秒。
- 完整结果见 `artifacts/qa-current-lifecycle-result.json`。

### 32.7 交付边界

- 当前已验证的是 API 36 模拟器上的 `android.2` Debug 候选。Xiaomi Android 16 真机的既有结论来自上一候选基线，不能替代本轮版本的再次真机安装。
- 24 个 LX 源已经通过批量导入、覆盖更新和重复导入稳定性验证；播放能力只抽测了当前可用的 `gdstudio音乐源`，不代表 24 个第三方源逐个可播。
- 模拟器未评估扬声器音质、蓝牙、耳机键和锁屏长时播放；这些只验证了系统状态、时长推进和媒体控制，不能据此给出音质结论。
- 公开 Release 仍为 `v1.0.0-android.1`，不含本轮四项增强；`android.2` 仍是本地候选，后续发布时需要重新生成 Release APK、校验 R8 产物并创建新 Release。

---

## 33. 主动单曲缓存与歌单缓存验收（`android.3`，2026-11-11）

本轮在已有的播放自动缓存、离线标识和媒体通知基础上，增加了用户可主动触发的单曲缓存与歌单缓存队列。候选版本提升到 `1.0.0-android.3`；`source/` 保持干净，本轮只构建和验收 Debug APK，没有创建 Release。

### 33.1 候选产物与设备一致性

| 项 | 值 |
|---|---|
| APK | `porting/android/app/build/outputs/apk/debug/app-debug.apk` |
| 版本 | `versionCode=3` / `versionName=1.0.0-android.3` |
| 大小 | 20,536,199 B |
| 构建时间 | 2026-11-11 18:27:05 +08:00 |
| SHA-256 | `B6F4080A882CC0D3964384FB558996214FEB5B29F2B25B380E795B85D3979CE0` |
| LX 扩展 | `artifacts/lx-loader/lx-api-source-loader-android_0.1.7-android.2.alix` |
| 扩展指纹 | 194,364 B / SHA-256 `93C458ECB85CF19483F05705DF3CF57AB7D4ADC7DF62052D5158A236097E5D49` |
| 模拟器 | `emulator-5554`，API 36，x86_64 |
| 真机 | Xiaomi 2211133C，Android 16 / API 36，`arm64` |

APK 使用 `adb install -r` 覆盖安装成功，原曲库、设置、扩展和缓存目录均保留。模拟器任务显示版本为 `versionCode=3` / `versionName=1.0.0-android.3`；设备内 `base.apk` 的 SHA-256 与小写形式 `b6f4080a882cc0d3964384fb558996214feb5b29f2b25b380e795b85d3979ce0` 一致。

### 33.2 实现范围

- 新增原生 `http.cacheProxyTarget(name, onProgress)`：按 `/p_static/<name>` 补齐正式缓存文件，状态依次为 `queued`、`downloading`、`complete`、`failed`。
- 主动缓存与播放触发的自动缓存复用同一原生任务表和 `ProxyMediaCache`，同一文件不会重复下载；全局同时最多下载 2 首。
- 下载先写 `.part`，完整结束后再原子改名；失败会删除临时文件并返回错误。
- 在线歌曲长按菜单增加“缓存到本地 / 重试缓存”；歌曲行显示解析、排队、百分比、已缓存或失败状态。
- 在线列表顶部增加“缓存歌单”，最多两个 worker，已缓存项直接跳过，单项失败不终止队列；结束后只重试失败项。
- 本轮只缓存当前页面已加载的歌曲，不保存远程歌单结构；排队状态按当前进程内存管理。
- 长按抬手产生的合成 click 使用 `stopImmediatePropagation()` 消费，避免低位歌曲菜单刚出现就被“点击空白处关闭”监听器关闭。

### 33.3 构建与静态门禁

- `pnpm typecheck`：移植层 strict 检查 0 错误。
- `pnpm build:all`：SPA、5 个 worker、`extension-preload` 和 `shrink-assets` 全部成功。
- `pnpm smoke`：产物、worker 引用、QuickJS、Ports、SQLite、缓存代理和扩展回调检查全部通过。
- `check-webdist.mjs --assets --dist=../../artifacts/qa-build-android3-final-20261111`：`VERDICT: OK`；最终入口为 `main.Ye8saDPW.js`，5 个 worker 全部存在，`dist` 与 APK assets 的 `index.html`、`main.Ye8saDPW.js`、`extension-preload.js` 三项 SHA-1 全等。
- `:bridge:testDebugUnitTest :core-ports:testDebugUnitTest`：`BUILD SUCCESSFUL`；其中 `HttpPortCacheIntegrationTest` 覆盖完整缓存、进度回报、复用已有文件和源站关闭后的 Range 响应。
- 未播放时触发 Toast 不再把 `notification port is not bound yet` 打印成页面错误；主动缓存结果仍通过行内状态和歌单状态条反馈。

### 33.4 单曲主动缓存

在 `Hello` 搜索结果第 3 页长按 `Hello kg HR Kelly Clarkson 02:59`，选择 `Cache for offline`。页面状态依次出现 `Resolving source`、`Queued`、`Caching 67%`、`Cached`，完成后正式文件为：

```text
files/cache/proxy/cc157211f0a4218aa791d3dd498e607843338d97382edd22dc0ee8e7d33da2cd.mp3
2,873,513 B
```

再次长按同一歌曲时，菜单项为禁用的 `Cached`。最终包在冷启动、列表完成缓存文件探测后直接长按该歌曲，菜单仍立即显示禁用的 `Cached`，页面异常和 Toast port 错误均为 0。下载期间出现 `.part`，完成后删除。明细见 `artifacts/qa-active-final-single-success.json` 和 `artifacts/qa-active-final2-cached-menu.json`。

失败路径使用无匹配音源的歌曲验证。页面从 `Resolving source` 进入 `Cache failed`，应用保持可操作，没有页面异常或进程崩溃；随后歌单队列仍能继续处理其他歌曲。明细见 `artifacts/qa-active-final-single-failure.json`。

### 33.5 歌单缓存、失败隔离与重试

以 20 首 `hello` 搜索结果执行“缓存歌单”：

- 队列进入活动态时显示 `19/20 processed` 和“下载中 1”；
- 19 首已完成，第三方音源无法解析 1 首时状态条显示 `Retry cache` 和“失败 1 首”；
- 失败歌曲行显示 `Cache failed`，其余缓存歌曲显示 `Cached`；
- 点击 `Retry cache` 后只重新处理失败项，状态从 `0/1` 继续到同一失败结果，队列没有卡死；
- 最终缓存目录有 38 个正式 `.mp3` 文件、0 个残留 `.part`，其中包含上述单曲和此前完整落盘的 `e149…mp3`。

明细见 `artifacts/qa-active-final-playlist.json`、`artifacts/qa-active-final-playlist-retry.json`。最终预览图仍使用用户已确认的 `artifacts/qa-active-cache-preview.png`；模拟器 `screencap` 仍返回黑帧，因此界面状态以 CDP DOM、可访问性属性和真实计数为验收证据。

### 33.6 断网与跨进程播放

先用在线搜索选择 `Hello kg SQ 黄龄 03:48`，确认音频使用本地代理地址 `e1493bc8ef4a2f305e26c92d728a8a8794d4de16c3915adf675a5ddcf5ffea2b.mp3`。该文件大小 4,859,237 B。

随后执行：

1. 强制停止应用；
2. 开启飞行模式，确认 `Active default network: none`；
3. 冷启动 `android.3`，进程 PID 从 1868 变为 2224；
4. 从保留的 MiniPlayer 播放项恢复播放。

结果：`currentSrc` 指向 `/api/p_static/e1493bc8…mp3`，`readyState=4`，`duration=303.673469`；3 秒后播放时间从 0.831028 秒推进到 3.886466 秒，页面异常为 0。明细见 `artifacts/qa-active-final-offline-result.json`。

### 33.7 后台播放、通知和媒体控制

- 返回桌面后界面为 `visibility=hidden`，播放时间从 36.015017 秒推进到 40.483034 秒，增加 4.468 秒。
- `dumpsys activity services` 显示 `PlaybackService` 的 `isForeground=true`、`foregroundId=1001`，前台类型包含 `mediaPlayback`。
- 媒体键暂停后等待 7 秒，音频保持 `paused=true`，音量淡出到 0；`MediaStyle` 通知和 `AnyListenSession` 仍保留。
- 媒体键恢复后 `volume=1`、`paused=false`，播放时间继续推进到 56.301172 秒。
- 最终包再次通过媒体键从 `PAUSED` 恢复为 `PLAYING`，随后暂停并等待 7 秒；`AnyListenSession` 保持活动，`MediaStyle` 通知、3 个媒体 action 和前台服务均未消失，通知进度停在 33.074 秒。
- 切回有封面的 `Hello - Adele` 后，通知保持 `FOREGROUND_SERVICE|ONGOING_EVENT`，标题为 `Hello`、正文为 `Adele`，模板为 `Notification$MediaStyle`，三个媒体 action 均存在，大图为 `BITMAP 125×125`。
- 断网冷启动后的 `Hello - 黄龄` 若尚未取得封面，通知大图为空；音频缓存和媒体控制不受影响。

证据见 `artifacts/qa-active-final-background-before.json`、`artifacts/qa-active-final-background-after.json`、`artifacts/qa-active-final-service-playing.txt`、`artifacts/qa-active-final-media-playing.txt`、`artifacts/qa-active-final-notification-paused.txt`、`artifacts/qa-active-final2-media-repaused.txt`、`artifacts/qa-active-final2-notification-repaused.txt`、`artifacts/qa-active-final2-service-repaused.txt` 和 `artifacts/qa-final-cover-notification.txt`。

### 33.8 真机覆盖安装（2026-11-12）

手机开启无线调试后，ADB 自动发现地址 `192.168.1.39:37927`。最终 Debug APK 使用 `adb install -r` 覆盖安装成功，原有 12 个歌单和设置均保留。

- `versionCode=3` / `versionName=1.0.0-android.3`，系统记录的 `lastUpdateTime` 为 2026-11-12 09:39:49。
- 设备内 `base.apk` SHA-256 为 `b6f4080a882cc0d3964384fb558996214feb5b29f2b25b380e795b85d3979ce0`，与本地最终 APK 一致。
- 强制停止后冷启动成功，`am start -W` 为 `LaunchState: COLD`、`TotalTime: 2181 ms`；首屏正常显示曲库和 12 个歌单。
- 在线搜索 `hello` 后，真机页面显示“缓存歌单”和“仅缓存当前已加载歌曲”，CDP 页面异常为 0。
- 长按 Adele《Hello》后菜单显示“缓存到本地”；实际触发后约 12 秒完成，歌曲行显示“已缓存”，再次长按显示禁用的“已缓存”。
- 新缓存文件为 `files/cache/proxy/86450ad6e7e83c0177a63a342bd06c8cdae571334538b5fba58a7e84a6004b93.mp3`，大小 11,823,064 B；当前缓存目录共 76 个正式文件、0 个 `.part`。
- 真机证据为 `artifacts/qa-android3-phone-current.png`、`qa-android3-phone-menu.png`、`qa-android3-phone-cached.png`、`qa-android3-phone-search.json`、`qa-android3-phone-cache-final.json` 和 `qa-android3-phone-cached-menu.json`。

### 33.9 交付边界

- 模拟器在 `android.3` 验收期间无 `FATAL EXCEPTION`、`ANR`、`JS_FreeRuntime` 或断言失败，crash buffer 为空。
- 最终 Debug 包已覆盖安装到 API 36 模拟器和 Xiaomi Android 16 真机；真机首屏、在线搜索、长按缓存和“已缓存”状态已复验，双并发歌单、断网冷启动和后台通知的完整路径仍以模拟器结果为主。
- 本轮没有评估扬声器音质、蓝牙、耳机键或长时间厂商省电策略，只验证播放状态、时长推进、缓存命中和系统控制。
- 24 个 LX 源已通过覆盖更新和重复导入稳定性回归；实际播放仍只抽测 `gdstudio音乐源`，不代表 24 个第三方源逐个可播。
- 公开 Release 仍为 `v1.0.0-android.1`，不含主动缓存和歌单队列；`android.3` 是本地 Debug 候选，`app-release.apk` 尚未重建。
