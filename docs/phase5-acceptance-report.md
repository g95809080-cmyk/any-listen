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

两处都在 `porting/` 覆写层，`source/` 零改动（覆写表见 README A-13 / A-18）。

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
