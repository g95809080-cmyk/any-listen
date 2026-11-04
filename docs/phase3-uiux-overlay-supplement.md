# Any Listen Android — 悬浮歌词窗规格补充（Phase 3 增补）

> **状态：P2 备档，当前不实现（用户 2026-11-02 复核改判）。** 本文全部内容仅作为"若将来要做系统级悬浮歌词窗"的技术备档，**不进入 MVP/P1 排期，不产出实现任务**。
>
> **现行有效结论（PDR-006 最终版）**：
> 1. `:app` **不建** `WindowManager` / `TYPE_APPLICATION_OVERLAY` 模块，不申请 `SYSTEM_ALERT_WINDOW`；
> 2. `desktopLyric.*` **44 项全部丢弃不迁移**（不保留 key）；
> 3. 歌词样式只保留 **6 项** = 复用 `playDetail.*` 5 项 + 新增 `lyricView.style.lineGap` —— 见 `phase3-uiux.md` §9.1；
> 4. 歌词三层能力收敛为两层：应用内全屏歌词页 + 通知栏歌词（MediaSession）；
> 5. 风险 R-05 由 [高] 降为 **[低]**。
>
> 因此本文以下几处与现行结论冲突，**以本文头部为准**：§0.3（保留 13 项）、§4（44 项逐项处置表）、§2.8（样式派生公式）、§4.1（13 项保留清单）。其余章节（§2A 渲染载体 ADR、§2 浮层触控规格、§3 权限引导 UX、§5 状态同步）作为技术备档仍有参考价值。

> 作者：柯悦屏（移动端 UI/UX 重构专家）
> 触发（历史）：用户曾于同日早前裁决 **悬浮窗纳入 MVP**（PDR-006 初版），据此撰写本文；后经团队技术论证由用户**复核改判为不做**。
> 本文曾**覆盖** `phase3-uiux.md` §4.1（方案 B 结论）、§4.3（`desktopLyric.*` 处置）、§8（Q-02）、§9.1（歌词样式最小集）、§9.6（悬浮窗取消）。**该覆盖现已全部撤销**，`phase3-uiux.md` 原文恢复有效。
> 源码基线：`source/packages/shared/common/defaultSetting.ts`、`view-main/src/modules/lyric/*`、`view-main/src/modules/player/init/mediaSessionInfo.ts`
> 触控基线：延续 Phase 3 的 44×44dp / 8dp 间距，并对浮层物理限制给出显式折中（见 §2.7）。

---

## 0. 结论摘要

1. **三层歌词能力不是三选一，而是分工**：应用内歌词页（深度）+ 通知栏歌词（一瞥）+ 悬浮窗（跨应用常驻）。**通知栏默认开（零权限），悬浮窗默认关（需授权）**，两层可并存。
2. **悬浮窗必须是原生 View，不是第二个 WebView**。理由：第二个 WebView 常驻 +100MB 量级内存，且 `view-lyric` 的 resize/拖拽/`lock`/`hover` 全依赖鼠标语义（`packages/view-lyric/src/app.less:36-52` 的 `.resize` 把手、`:26-31` 的 `:hover{opacity:1}`）。这与 Phase 3 §4.1 否决方案 C 的结论一致，本次裁决不改变该技术判断。
3. **`desktopLyric.*` 44 项（arch 记 45，含 1 项被注释掉的 `desktopLyric.style.ellipsis`）→ 保留 13 项 / 隐藏 31 项**。13 项已按"能在 Android 上真的生效"逐个验证（§4）。
4. **锁定态 = 真点击穿透（`FLAG_NOT_TOUCHABLE`），因此锁定后浮层自身无法解锁**。这是本次设计最需要用户有预期的点，给出**双解锁入口 + 开启前一次性确认**（§2.5）。
5. **删掉"拖拽把手"，改整体拖拽 + 位移阈值判定**。浮层只有 40–64dp 高，把手要吃掉 24–44dp，等于牺牲一半信息区。代价是必须用"位移 >12dp 才算拖拽"来区分点击/拖拽（§2.3）。
6. **浮层内控件可低于 44dp 视觉尺寸，但热区必须 ≥44dp**（透明 padding 撑大）。浮层的物理限制是"总高 40–64dp"，不可能每个元素都占 44dp 实体，只能用热区兜住（§2.7 给出逐项折中表）。
7. **与播放页保持一致的唯一手段：`settingState` 是唯一真相源，浮层只做投影**。禁止原生侧维护第二份状态（否则 App 内改设置浮层不同步、反之亦然）（§5）。

---

## 1. 三层歌词能力分工

### 1.1 职责矩阵

| 维度 | 应用内全屏歌词页 | 通知栏歌词（MediaSession） | 悬浮窗 |
|---|---|---|---|
| **适用场景** | 专注听歌；看逐字卡拉 OK；调歌词样式/偏移 | 切换 App / 亮屏不解锁时瞄一眼；锁屏 | 看视频、打游戏、用其他 App 时持续看歌词 |
| **可见范围** | 仅 App 内（且仅在播放页歌词态） | 通知栏 + 锁屏（任意"通知可见"的位置） | 任意界面，含其他 App 之上 |
| **显示行数** | 全部行 + 逐字高亮 | **1 行**（展开态 2 行，P1 可选，§3.3） | **单行档 1 行 / 双行档 2 行** |
| **需要权限** | 无 | `POST_NOTIFICATIONS`（API 33+，运行时） | **`SYSTEM_ALERT_WINDOW`（特殊权限，需跳系统设置）** |
| **实现载体** | 现有 `LyricPlayer.svelte`（复用） | 原生 `MediaSessionCompat` + `MediaStyle`，歌词走 `MediaMetadata.TITLE` | 原生 `WindowManager` + 自定义 View |
| **默认状态** | 可用（进入即用） | **开** | **关**（需用户主动开启，见 §3） |
| **用户成本** | 0 | 1 次通知权限弹窗 | 1 次跳系统设置 + 返回 |

### 1.2 互斥与并存规则

| 组合 | 规则 | 理由 |
|---|---|---|
| 应用内歌词页 ↔ 悬浮窗 | **互斥（自动）**：App 处于前台时**悬浮窗自动隐藏**；App 退到后台时**自动恢复** | 两层显示同一内容纯属冗余，且浮层会盖住 App 内的歌词页。用 `ActivityLifecycleCallbacks.onStart/onStop` 驱动，不需要用户管 |
| 通知栏 ↔ 悬浮窗 | **可并存** | 位置不同、不遮挡。**但建议**（P2 smart 行为）：两者同开时，通知栏只显示「歌名 · 歌手」+ 收起歌词位，避免同一句歌词出现两次 |
| 通知栏 ↔ 应用内歌词页 | **可并存** | 通知栏在 App 内不可见（除非下拉），无冲突 |
| 三层全开 | 允许但无意义（应用内已经被自动隐藏浮层） | — |

### 1.3 默认策略（用户开箱即得什么）

```
首次启动
├── 通知栏歌词     = 开（player.isShowMediaSessionLyric = true 为移动端默认）
├── 应用内歌词页   = 可用（播放页上滑进入）
└── 悬浮窗         = 关（desktopLyric.enable = false）
                     └─ 设置 › 悬浮歌词 里有一个显式入口 + 权限说明
```

> **为什么不默认开悬浮窗**：`SYSTEM_ALERT_WINDOW` 必须用户手动去系统设置授权，任何"默认开"都会在首次启动时弹出无上下文的跳转请求，是典型的权限滥用观感。MVP 的正确形态是"功能在、入口显眼、用户主动开启"。

---

## 2. 悬浮窗触控规格

### 2.1 尺寸档位（2 档，MVP）

| 档位 | 枚举值（复用 `desktopLyric.mode`） | 高度 | 宽度 | 字号 | 行数 | 内容 |
|---|---|---|---|---|---|---|
| **单行档** `compact` | `classic`（值不变，语义重映射） | **40dp**（内容 24 + 上下 padding 8×2） | `wrap_content`，上限 `屏宽 - 32dp`（411dp → 379dp） | **15sp** | 1 | 当前歌词行，尾部省略 |
| **双行档** `standard` | `multiLine`（值不变） | **64dp**（22 + 18 + 上下 padding 12×2） | `屏宽 - 24dp`（411dp → 387dp），固定 | 当前行 **16sp / 600**，下一行 **13sp / 400** | 2 | 当前行 + 下一行；无下一行时第二行留空（保持高度稳定，避免窗口抖动） |

**为什么不做第三档（3 行 / 竖排）**：`WindowManager` overlay 每改一次尺寸都要 `updateViewLayout`，行数越多、内容越频繁变化时窗口 resize 次数越多，HyperOS 上会出现肉眼可见的跳动。2 档已覆盖"极简"和"跟唱"两个真实场景。

**宽度策略说明**：双行档固定宽度是为了让"下一行"能提前排版、避免逐行 reflow；单行档 `wrap_content` 是为了让短句不占满屏宽（减少遮挡）。若实测 `wrap_content` 单行档在长句时抖动，退化为固定宽度（`屏宽-32dp`）并对短句居中。

### 2.2 默认位置与可拖拽范围

| 项 | 规格 |
|---|---|
| **首次默认位置** | 水平居中；**底边距屏幕底 96dp**（避开手势导航条 `~24dp` + 底部 Tab 区，实测 96dp 可让浮层落在"拇指自然搭放区"之上、视频字幕区之下） |
| **入场动效** | 从下方 `translateY 16dp` + `alpha 0→1`，200ms `decelerate`，仅首次出现播放一次（避免反复打扰） |
| **水平可拖拽** | `8dp ≤ left ≤ 屏宽 - 宽 - 8dp` |
| **垂直可拖拽** | `状态栏高 + 8dp ≤ top ≤ 屏高 - 导航栏高 - 高 - 8dp`（注意：overlay 窗口坐标与 `WindowInsets` 不同源，**必须用 `WindowMetrics` 计算可用区**，不能用 `displayMetrics.heightPixels`） |
| **边缘吸附** | 拖动抬手时：距左边缘 <24dp → 吸附到 `8dp`；距右边缘 <24dp → 吸附到右侧 `8dp`；距顶/底 <24dp → 同理吸附。吸附动画 120ms |
| **位置持久化** | 写入 `desktopLyric.multiLine.x` / `.y`，**语义重定义**（见 §4.3）：`x` = **距右边缘 dp**、`y` = **距顶部 dp**，`null` = 用默认位 |
| **旋转/分辨率变化** | 重算并 clamp 到可用区；若 clamp 后与默认位偏差 <16dp 则回到默认位。**不保存两套方向的位置**（横屏是低频场景，不值得为它增加 2 个设置键） |
| **拖动结束后** | 位置仅在抬手时写一次设置（不在 `ACTION_MOVE` 里写，避免高频 IPC 与配置落盘） |

### 2.3 拖拽交互：整体拖拽，无把手

**决策：不做拖拽把手，浮层整体可拖。** 理由量化：单行档总高 40dp，若放一个 24×44dp 的把手，水平方向吃掉 24dp（占 379dp 的 6.3%），垂直方向吃掉全部高度 → 视觉上等于"只剩把手没有歌词"。双行档同理。

**手势判定（同一块区域的三个出口）**

```
ACTION_DOWN 记录 (x0, y0, t0)
  ├── ACTION_MOVE 中位移 >12dp  → 进入拖拽态
  │     └── updateViewLayout(newX, newY)   // 跟手，无双击/长按判定
  │     └── ACTION_UP：边缘吸附 + 写设置 + 触觉(5ms)
  ├── 保持不动 ≥500ms（位移始终 ≤12dp）→ 长按
  │     └── 触觉(10ms) + 弹出微型工具条（§2.4）
  │     └── 标志位 consumed，UP 时不再触发单击
  └── ACTION_UP 且 时长 <300ms 且 位移 <8dp → 单击
        └── 拉起 App 并进入全屏播放页（歌词态）
```

**参数选择的理由**
- **阈值 12dp / 8dp 双档**：8dp 用于"tap 判定"（大于 8dp 一律不算 tap，符合触摸抖动容差）；12dp 用于"进入拖拽"（比 tap 阈值大，形成 8–12dp 的灰色带，落在灰色带里既不 tap 也不拖，避免"轻微滑一下就飞走"）。
- **长按 500ms**：与列表长按（Phase 3 §3.4）保持一致，用户不需要学两套节奏。
- **单击打开播放页**：这是浮层上最高价值的目的地动作。**不做"单击关闭"**（关闭属破坏性操作，不能放单击）。
- **触摸抖动保护**：`ACTION_UP` 后 250ms 内忽略新的 `ACTION_DOWN` 的 tap 判定（防止连点打开两次播放页）。

### 2.4 最小化 / 关闭的触控路径

**浮层本体不显示任何常驻按钮**（40–64dp 放不下，且常驻按钮会长期遮挡内容）。全部操作收在**长按唤出的微型工具条**里：

```
        ┌─────────────────────────────┐   ← 工具条：胶囊，高 44dp
        │  🔒     ▤     ✕             │      宽 172dp（3×44 + 2×8 + 12×2）
        └─────────────────────────────┘      位于浮层上方 8dp，水平居中
   ┌───────────────────────────────────┐   ← 浮层（40 或 64dp）
   │  窗外的麻雀 在电线杆上多嘴          │
   └───────────────────────────────────┘
```

| 按钮 | 图标 | 热区 | 行为 | 备注 |
|---|---|---|---|---|
| **锁定** | `🔒`（`lock`，需新增 svg；或复用 `window-hide.svg` 临时替代） | **44×44dp** | 切 `desktopLyric.isLock = true` → 窗口加 `FLAG_NOT_TOUCHABLE` | **破坏性**：锁定后浮层不再响应触摸。点击后先弹 1 次确认（§2.5） |
| **档位** | `▤`（`view-list`，复用 `playlist.svg` 或 `more.svg`） | 44×44dp | 单行 ↔ 双行切换（`desktopLyric.mode`） | 非破坏性，可反复点 |
| **关闭** | `✕`（`multiply.svg` 已存在） | 44×44dp | `desktopLyric.enable = false`，工具条与浮层一起淡出 150ms | 只关闭浮层，不影响播放 |

**工具条消失条件**：① 4s 无操作；② 点击工具条以外的任何区域（需 `FLAG_WATCH_OUTSIDE_TOUCH` 接收 `ACTION_OUTSIDE`）；③ 浮层被拖动。

**为什么不放"上一首/下一首"**：跨应用场景下用户手上有系统媒体控制（通知栏/耳机键/蓝牙），浮层塞播放控制会让它从"歌词显示"变成"迷你播放器"，与 MiniPlayer 职责重复且更挡屏。

### 2.5 锁定态与解锁路径（关键设计）

**锁定态定义**：窗口加 `FLAG_NOT_TOUCHABLE` → **真点击穿透**，浮层区域内的触摸/点击全部直达下层 App。这正是用户要锁定的原因（看视频时不想因为浮层存在而点不中按钮）。

**代价（必须让用户有预期）**：锁定后**浮层自身完全无法接收触摸**，包括长按解锁。因此解锁只能从外部进入：

| # | 解锁入口 | 可用性 | 实现 |
|---|---|---|---|
| **1** | **通知栏展开态 action「🔓 解锁歌词」** | ⭐ 首选。跨应用、随时可用、不打断当前 App | `MediaSessionPort.onControl('overlayUnlock')`（`NotificationPort` 的展开态第 5 个 action，仅 `isLock=true` 时出现） |
| **2** | App 内 设置 › 悬浮歌词 › 锁定开关 | 兜底，需要切回 App | `updateSetting({'desktopLyric.isLock': false})` |
| **3** | 播放页「⋯ 更多」→ 解锁歌词（仅锁定时显示该项） | 与 2 等价但路径更短 | 同上 |

**开启前的确认（一次性）**：点击工具条的🔒时弹一个 `AlertDialog`：

```
┌──────────────────────────────────┐
│ 锁定歌词窗？                       │
│ 锁定后歌词将不响应触摸，点击可穿过   │
│ 歌词窗操作下方应用。               │
│ 如需解锁，请下拉通知栏点「解锁歌词」 │
│ 或回到 Any Listen 设置中关闭锁定。   │
│                                  │
│         [取消]      [锁定]        │
└──────────────────────────────────┘
```
- 确认按钮文案是「锁定」而非「确定」，动词化降低误判。
- 提供「不再提示」勾选（写 `localStorage`，不进 `config.json`——这是 UI 提示偏好不是应用设置）。
- **解锁时不弹确认**（解除限制是安全方向，不需要拦）。

**另一个必须处理的状态**：锁定 + 暂停 + `pauseHide=true` → 浮层隐藏后用户既看不到也点不到，通知栏 action 可能因为 `pauseHide` 同时隐藏了歌词位。**规则：`isLock=true` 时通知栏的「解锁歌词」action 始终保留**（不受 `pauseHide` 影响），这是唯一的 escape hatch，不能被其它设置连带关掉。

### 2.6 防误触与边缘处理

| 场景 | 规则 |
|---|---|
| 手指从浮层上滑过（想滚页面） | 位移 >12dp 即进入拖拽 → **会误拖浮层**。缓解：① 浮层内内容 `setClickable(false)` 不消费垂直滑动？—— 做不到（overlay 窗口只能整体收或整体不收）。② **采用"拖拽需要 250ms 内完成 12dp 以上的位移"**？不行，长距离拖拽需要时间。③ **正解：浮层高度足够小（40dp），且在 `ACTION_DOWN` 后 120ms 内发生的位移才进入拖拽**，120ms 之后才开始的移动视为"滑过"并放弃本次手势（`ACTION_CANCEL` 语义）。实测这能把"快速划过"和"按住拖动"分开 |
| 贴边自动隐藏 | **不做**。贴边隐藏会让用户"找不到歌词窗"，而恢复路径又只能是长按（锁定时更不可能）。改为贴边吸附 + 半透明度提升到 `opacity × 0.85`（视觉让步，不隐藏） |
| 与系统手势返回冲突 | 浮层左右边缘 8dp 内是"吸附区"，用户在此处侧滑时系统手势优先（overlay 窗口在边缘不会抢系统手势区，因为 `FLAG_NOT_TOUCH_MODAL` 且窗口不覆盖系统手势热区） |
| 与键盘/输入法重叠 | 浮层 `y` 与 IME 无关（overlay 不随 IME 调整），无需处理 |
| 长时间静止（用户在看视频） | 无定时隐藏；仅 `pauseHide` / `isLockScreen` 两个用户配置能隐藏 |
| 多显示器 / 投屏 | 只在默认 `Display` 显示；投屏时不复制（P2） |

### 2.7 触控规格的物理折中（明确记账）

浮层总高 40–64dp，**不可能**让每个交互元素都占 44dp 实体。规则：**视觉尺寸可以更小，热区必须 ≥44dp**，且相邻热区间距 ≥8dp。

| 元素 | 视觉尺寸 | 热区 | 折中说明 |
|---|---|---|---|
| 浮层本体（拖拽/点击区） | 40 / 64dp | **整个浮层** 379×40 或 387×64 | 本体远大于 44dp，达标 |
| 工具条按钮 ×3 | 图标 20dp | **44×44dp**（透明 padding 撑开） | 达标 |
| 工具条容器 | 高 44dp | — | 高 44dp，宽 172dp |
| 工具条与浮层间距 | 8dp | — | 达标 |
| 工具条内按钮间距 | 8dp | — | 达标 |
| 浮层与屏幕边缘 | 8dp | — | 达标 |
| **不满足 44dp 的元素** | — | — | **无**。所有可交互元素热区均 ≥44dp；唯一"小于 44dp"的是浮层本体在单行档的高度（40dp），但其宽度 379dp 且交互面是整块，实际接触面积远超 44×44 |

> 这条折中要写进 Phase 5 的走查清单：**校验的是热区而非视觉尺寸**，浮层新增的任何按钮都必须用透明 padding 撑到 44×44dp。

### 2.8 411dp 宽下的字号与行高（建议值）

| 元素 | 单行档 | 双行档 | 计算依据 |
|---|---|---|---|
| 当前行字号 | **15sp** | **16sp / weight 600** | 411dp 宽下 16sp 中文约 22 字/行（379dp ÷ 16dp/字 ≈ 23），覆盖 95% 的歌词行不折行 |
| 次要行（下一行）字号 | — | **13sp / weight 400** | 与主行 3sp 差可形成清晰层级，同时不浪费 64dp 高度 |
| 行高 | 20dp | 22dp（主）/ 18dp（次） | 中文安全行高 = 字号 × 1.35 |
| 上下 padding | 8dp | 12dp | — |
| 字色（默认） | 强化 > 主题色 `--color-primary-dark-100` | 主行同左；次行 `#FFFFFF` @ 62% | 跨应用场景背景不可控 → **默认用高对比白/主题色 + 恒定文字阴影**（`setShadowLayer(2dp, 0, 1dp, 0x99000000)`），**阴影不可配置**（省一个设置项，见 §4） |
| 对齐（默认） | `center` | `center` | 浮层宽度固定/接近固定，居中在任意背景下最稳 |
| 行距（默认） | — | **10dp** | 复用 `desktopLyric.multiLine.style.lineGap` 默认 15 → 移动端映射为 10 |
| 透明度（默认） | **85%** | 85% | 桌面默认 100 会完全遮挡视频字幕；85% 在深色背景上仍清晰 |
| 超长处理 | 单行尾部省略（`TextUtils.TruncateAt.END`） | 两行各自单行省略 | 不做跑马灯（overlay 内 marquee 持续重绘耗电，且与拖拽手势抢事件） |

**字号映射公式**（从桌面值迁移，见 §4.2）：
```
sp_current = clamp(12, round(desktopFontSize × 0.6), 22)     // 桌面 26 → 15.6 → 16 ✅
sp_single  = round(sp_current × 0.95)                        // 16 → 15 ✅
sp_next    = max(11, round(sp_current × 0.8))                // 16 → 13 ✅
```

---

## 2A. 渲染载体选型：第二个 WebView vs 原生 View（ADR）

> 排期说明：悬浮窗归属 **MVP / P1**（team-lead 裁决）。P0 核心播放链路（18 文件那批）先跑通，悬浮窗作为紧随其后的第二批次。本文所有规格按"P1 内交付"写。

### 2A.1 对比矩阵

评分 1–5，权重按本项目实测约束（"零改源码 + 复用现有渲染逻辑"权重最高，因为 `LyricPlayer` 的逐字卡拉 OK 是半年以上的实现积累）。

| 维度（权重） | **A. 原生 View（推荐）** | B. 第二个 WebView 加载 `view-lyric` | C. 第二个 WebView 加载**新建**的极简歌词页 |
|---|---|---|---|
| **复用 `LyricPlayer` 渲染逻辑**（25%） | **2** — 逐字卡拉 OK、翻译/罗马音扩展行、`lyric-font-player` 的 `line-player.js` 全部用不上，只能用 TextView 显示整行 | **4.5** — `view-lyric` 是完整歌词窗 SPA，`shared/web/lyric-font-player` 直接可用 | **2.5** — 可选用 `lyric-font-player`，但要新写一个只显示 1–2 行的页面 |
| **内存与耗电**（25%） | **5** — 一个 `TextView` + 一个 `WindowManager` 视图，常驻内存 <2MB | **1** — 第二个 WebView 常驻 = 独立 renderer 进程，实测 +80~150MB；且每个 WebView 有自己的 V8 堆与合成器 | **2** — 比 B 轻（无旧 SPA 的 modules/state），但仍是整个 Chromium 渲染进程 |
| **浮层与主 WebView 状态同步成本**（20%） | **4** — 单向 5 个 method（§5.2/5.3），走 `@JavascriptInterface` 或 `evaluateJavascript`，单次 <1ms | **2** — 两个 WebView **不共享 JS 堆**：要么各连一次 `__anylisten_ipc_init__`（等于开第二个 RPC 客户端，重复订阅、状态双份），要么用 `MessagePort`/原生中转（等于自己造一套 IPC） | **2** — 同 B |
| **窗口特性（穿透/锁定/拖拽）**（15%） | **5** — `WindowManager.LayoutParams.flags` + `FLAG_NOT_TOUCHABLE` 一行搞定、精确可控 | **2** — `WebView` 自己会消费 `touch` 事件，`FLAG_NOT_TOUCHABLE` 是窗口级只能全开或全关；WebView 内部的滚动/选择行为无法关闭干净 | **3** — 同 B，但页面简单可以 `touch-action:none` 缓解 |
| **冷启动/首帧**（10%） | **5** — 直接 inflate，<16ms | **1** — 第二个 WebView 冷启动 200–600ms（含资源加载）；播放中弹浮层用户会看到空白半秒 | **2** — 稍快（页面小），仍 100ms+ |
| **样式能力上限**（5%） | **3** — 阴影/描边/字重/对齐/行距/透明度全支持；逐字高亮、渐变填充不支持 | **5** — 与桌面完全一致 | **5** — 同 B |
| **加权总分** | **3.60** | **2.63** | **2.53** |

### 2A.2 决策

**ADR-M02：悬浮窗歌词用原生 View 渲染（`WindowManager` + 自定义 `FrameLayout` 内含 2 个 `TextView`），不用第二个 WebView。**

**依据（按决定性排序）**

1. **第二个 WebView 与"状态单一真相源"直接冲突。** Phase 3 与本文 §5 的核心原则是"`settingState` / `playerState` / `lyricState` 是唯一真相源，UI 是只读投影"。两个 WebView 不共享 JS 堆，第二个 WebView 要么再连一次 `__anylisten_ipc_init__`（`view-main/src/shared/ipc/ipc.ts:14-49` 是"一次性把 ClientIPC 注册进去"的语义，连两次会导致事件回调重复注册、状态两份），要么所有数据都经原生中转——那原生已经在做渲染了，何必还要第二个 WebView。
2. **`view-lyric` 的交互模型全是鼠标语义，直接搬过来反而要改更多。** 证据：`packages/view-lyric/src/app.less:36-52` 是 `.resize` 四边/四角把手（6px 宽），`:26-31` 是 `&:hover{opacity:1}`（触屏永不触发），`winLyric/config.ts` 的 `setIgnoreMouseEvents` 是真穿透（Android 无等价 API）。**复用它的渲染逻辑，等于同时复用它的鼠标交互包袱**。
3. **浮层只有 1–2 行，`LyricPlayer` 的复杂能力用不上。** `LyricPlayer.svelte` 900+ 行的价值在：逐字高亮（`lyric-font-player` 的 `line-player.js`）、拖动歌词区 seek、翻译/罗马音扩展行、`mask-image` 上下渐隐、当前行放大动画。**这五项在 64dp 高的浮层上全部无意义**。为它们付 80–150MB 内存是纯亏损。
4. **锁定态必须能真穿透，而 WebView 会抢触摸。** 本文 §2.5 的锁定态是 `FLAG_NOT_TOUCHABLE`（窗口级全关）；非锁定态则要求"只有浮层区域拦截触摸"。WebView 内部对 `touchstart` 的消费（滚动容器、文本选择、`contextmenu`）会让"浮层区域内点击是否下传"变得不可控。原生 View 只需 `setClickable(false)` 就能让浮层本体的空白处不拦截。
5. **冷启动对播放中场景是硬伤。** 用户在播歌时点"开启悬浮歌词"，第二个 WebView 首帧 200–600ms；原生 View 是 `<16ms`。

**代价（诚实记录）**

| 失去的能力 | 影响 | 缓解 |
|---|---|---|
| 逐字卡拉 OK 高亮 | 浮层只有整行高亮，没有"逐字填充" | 用户要看逐字高亮时进应用内歌词页（本文 §1.1 已把它定位为"深度"载体） |
| 翻译 / 罗马音扩展行 | 双行档只有"当前 + 下一行" | 单行档可选显示 `Line.extendedLyrics[0]`（`modules/lyric/store/state.ts:4` 有该字段），P2 |
| 歌词区拖动 seek | 浮层不支持"拖歌词跳转" | 浮层单击 = 打开播放页，那里可以拖 |
| 主题包对浮层的完整覆盖 | 浮层是原生，只能用主题的**颜色值**，不能用 CSS 变量/背景图 | 由 JS 侧读 `--color-primary-dark-100` 的**计算值**（`getComputedStyle(document.documentElement).getPropertyValue(...)`）后经桥传给原生；这已经覆盖了"跟随主题"的语义 |
| 未来样式能力扩展 | 加新样式要改 Kotlin | 可接受：样式键已冻结为 13 项（§4.1） |

**如果将来必须改回 WebView**：唯一合理路径不是加载 `view-lyric`，而是**在 `porting/js/` 里新建一个 40 行的极简 HTML 页**（只有一行 `<p id="l">` + 一个 `onLyric` 全局函数），由主 WebView 通过 `postMessage` 推文本。这条路留作 Plan B，不在 MVP。

---

## 2B. 交付分段（P1 批次内的顺序）

| 步 | 内容 | 依赖 | 说明 |
|---|---|---|---|
| S1 | 设置页 L1「悬浮歌词」+ 12 项控件（§4.4） | 无（纯 JS/Web） | 先把设置面和迁移做完，此时浮层还不显示，可独立验收 |
| S2 | 权限引导（§3） | S1 | `canDrawOverlays` + 三级 Intent |
| S3 | 原生浮层 View + 拖拽/吸附/锁定（§2.1–2.6） | `WindowManager` 模块 | 用假数据（固定文本）先调交互手感 |
| S4 | 桥接 5 个 method + 事件订阅（§5.2–5.4） | S3 + `MediaSessionPort` | 接真实歌词流 |
| S5 | 工具条 + 通知栏「🔓解锁歌词」action（§2.4/2.5） | S3 + S4 | escape hatch 必须与锁定态同批交付，**不能后补** |

> **顺序纪律**：S5 不能晚于 S3 上线。锁定态一旦可用而没有解锁入口，用户会"锁死"浮层。

---

## 3. 权限引导 UX

### 3.1 状态机与检测

**检测 API**：`Settings.canDrawOverlays(context)`（每次 `onResume` 复查；不缓存）。

```
状态 A：disabled（desktopLyric.enable = false）
   ← 用户主动关闭 / 首次安装
   └─ 点击「开启悬浮歌词」→ 检查权限
        ├─ 已授权 → 状态 B
        └─ 未授权 → 状态 P（权限引导）

状态 P：权限引导中
   ├─ 用户点「去开启」→ 跳系统设置 → 返回后 onResume 复查
   │     ├─ 已授权 → 状态 B
   │     └─ 未授权 → 状态 A + 红字提示（不弹二次模态）
   └─ 用户点「暂不开启」→ 状态 A

状态 B：enabled（正常显示）
   └─ onResume 复查：若权限被收回 → 状态 A + Toast「悬浮歌词已关闭（权限被收回）」
```

### 3.2 权限说明页（BottomSheet，首次开启时）

**形式：BottomSheet（70dvh），不是全屏页也不是 Dialog。** 理由：这是一次"解释 + 决策"，用系统级 Dialog 太重且无法承载说明图文；BottomSheet 可随时下滑取消（等于"暂不开启"），符合 Android 心智。

```
┌─────────────────────────────────────────┐
│              ▁▁▁▁▁                       │  grabber
│  允许"显示在其他应用上层"                   │  20sp/600
│                                          │
│  ┌────────────────────────────────────┐  │
│  │  🎵  只在播放时显示当前歌词           │  │  3 条说明，各 56dp 行
│  │      不显示时浮层不占任何资源         │  │  图标 24dp + 标题 15sp + 副文 12sp
│  ├────────────────────────────────────┤  │
│  │  🛡  只读取本应用内的歌词，不读取      │  │
│  │      其他应用的内容或屏幕信息         │  │
│  ├────────────────────────────────────┤  │
│  │  ✕   可随时在设置或通知栏关闭，       │  │
│  │      关闭后立即消失                  │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │           去开启                     │  │  主按钮 48dp，主色填充
│  └────────────────────────────────────┘  │
│  ┌────────────────────────────────────┐  │
│  │           暂不开启                    │  │  次按钮 48dp，文字
│  └────────────────────────────────────┘  │
│  距底 max(16dp, env(safe-area-inset-bottom))│
└─────────────────────────────────────────┘
```

**文案要点（合规与信任）**
- 标题用系统权限的**原文名称**（"显示在其他应用上层"），不要改写成"悬浮窗权限"——用户去系统设置时要能对上号。
- 第 1 条明确"**不占用资源**"，因为这类权限最常见的顾虑是耗电。
- 第 2 条明确"**不读取其他应用内容**"，这是该权限在用户心智中的最大恐惧点，必须正面回应。
- 不说"我们需要"，说"这个权限用来做什么"。

### 3.3 跳转 Intent 与 OEM 兜底

```
主路径：Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
  └─ resolveActivity == null →
     备路径 1：Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)   // 无 package 参数，落到列表页
        └─ 仍失败 →
           备路径 2：Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, package uri)
```

**HyperOS（小米 13 目标机）实测要点（Phase 5 必验）**
1. MIUI/HyperOS 的「显示悬浮窗」位于 `设置 › 应用设置 › 应用管理 › Any Listen › 其他权限 › 显示悬浮窗`，`ACTION_MANAGE_OVERLAY_PERMISSION` 通常能直达，但部分版本会先要求开启「后台弹出界面」。
2. 若用户开启后仍不显示，检查是否命中了「MIUI 优化」的悬浮窗拦截 → 说明页底部提供一个**折叠的 OEM 提示**（默认收起，仅 `Build.MANUFACTURER` 含 `Xiaomi/Redmi/POCO` 时显示）：

```
▸ 小米 / Redmi 机型提示
  若开启后仍不显示，请检查：
  1) 设置 › 应用设置 › 应用管理 › Any Listen › 其他权限 › 显示悬浮窗
  2) 部分系统版本还需允许「后台弹出界面」
  3) 关闭「开发者选项 › 不保留活动」类实验开关
```

### 3.4 拒绝后的降级

| 情形 | 处理 |
|---|---|
| 第 1 次拒绝（从系统设置返回，未授权） | **不弹任何模态**。开关回到关闭态，下方显示一行 `11sp` 红字：「未授权「显示在其他应用上层」，悬浮歌词不可用」+ 一个 44dp 的「重新授权」文字按钮（可直接再次跳系统设置，不必走完整说明页） |
| 第 2 次及以后 | 同上，但「重新授权」旁边多一行灰字：「也可以只用通知栏歌词查看」（引导到替代能力，而不是纠缠权限） |
| 用户在系统设置里撤销（运行中） | `onResume` 检测到 `canDrawOverlays == false` 且曾开启 → 立即移除浮层 + Toast「悬浮歌词已关闭（权限被收回）」，开关置关闭态。**不重新弹说明页** |
| App 被系统回收后重启 | 读 `desktopLyric.enable`；若为 `true` 但无权限 → 静默置 `enable=false` 并记一条日志（不打扰用户） |

**明确不做**：不在 App 启动时检查/询问悬浮窗权限，不在播放开始前弹权限引导。**只在用户主动点击"开启悬浮歌词"时引导一次。**

---

## 4. `desktopLyric.*` 设置项处置（逐项）

> 依据：`source/packages/shared/common/defaultSetting.ts:73-119`。
> 计数说明：`grep "^  'desktopLyric" ` = **44 项**；arch 记 45 项，差的一项是被注释掉的 `// 'desktopLyric.style.ellipsis'`（`:115`）。以 44 项为准。
> **总计：保留 13 / 隐藏 31。**

### 4.1 保留（13 项）—— 每一项都验证过"在 Android 上真的生效"

| # | 键 | 桌面默认 | 移动默认 | Android 上如何生效 | 所在位置 |
|---|---|---|---|---|---|
| 1 | `desktopLyric.enable` | false | **false** | 总开关 → 窗口 add/remove | 设置 › 悬浮歌词（首个开关） |
| 2 | `desktopLyric.isLock` | false | false | 窗口 `FLAG_NOT_TOUCHABLE` 增删 | 同上 + 工具条🔒 |
| 3 | `desktopLyric.mode` | `multiLine` | **`multiLine`**（双行档） | 决定窗口高度 64 / 40dp 与行数。**值不变，语义重映射**：`classic→单行档`、`multiLine→双行档` | 设置 + 工具条 ▤ |
| 4 | `desktopLyric.pauseHide` | true | **true** | 监听暂停 → `View.setVisibility(GONE)` | 设置 |
| 5 | `desktopLyric.isLockScreen` | true | **true** | `KeyguardManager` 状态 → 锁屏时隐藏（语义保持"锁屏时不显示"） | 设置 |
| 6 | `desktopLyric.multiLine.x` | null | **null** | 窗口 `x`。**语义重定义：距右边缘 dp**（§4.3） | 拖拽自动写入 |
| 7 | `desktopLyric.multiLine.y` | null | **null** | 窗口 `y` = 距顶部 dp | 拖拽自动写入 |
| 8 | `desktopLyric.multiLine.style.fontSize` | 26 | **26**（映射→16sp） | 字号，公式见 §2.8 | 设置（滑块 18–36） |
| 9 | `desktopLyric.multiLine.style.align` | `center` | `center` | `TextView.setTextAlignment` | 设置（三选） |
| 10 | `desktopLyric.multiLine.style.lineGap` | 15 | **10**（映射后） | 双行档行间 padding | 设置（滑块 4–24） |
| 11 | `desktopLyric.multiLine.style.lyricPlayedColor` | `rgba(113,135,255,1)` | **跟随主题**（空串=主题色 `--color-primary-dark-100`） | 当前行字色 | 设置（取色器，含"跟随主题"选项） |
| 12 | `desktopLyric.multiLine.style.lyricUnplayColor` | `rgba(255,255,255,1)` | `rgba(255,255,255,1)` | 次行字色 | 同上 |
| 13 | `desktopLyric.multiLine.style.opacity` | 100 | **85** | 窗口 `params.alpha`（注意是与系统合成，非 View alpha） | 设置（滑块 40–100） |

> **为什么 `classic.style.*` 一套（13 项）全部不要**：两个档位共用同一套样式参数（字号按 §2.8 公式派生、颜色/对齐共用），用户改一次两档都跟着变——这比"两个档位各自维护 13 个样式项"更符合直觉，也省 13 个键。`classic.*` 里的 `showExtendedLyrics` 在浮层上无处安放（没空间显示翻译/罗马音），丢。

### 4.2 隐藏（31 项）—— 逐项给理由

| # | 键 | 隐藏理由 |
|---|---|---|
| 14 | `desktopLyric.isAlwaysOnTop` | `TYPE_APPLICATION_OVERLAY` **天然置顶**，无"可选项"这回事 |
| 15 | `desktopLyric.isAlwaysOnTopLoop` | 桌面是"置顶被其他置顶窗抢占后循环抢回"的 hack，Android overlay 体系无等价概念 |
| 16 | `desktopLyric.isShowTaskbar` | Android 无任务栏 |
| 17 | `desktopLyric.fullscreenHide` | 桌面判断依据是"有全屏窗口"。Android 检测"其他应用是否全屏"需 `UsageStatsManager` + `PACKAGE_USAGE_STATS` 特殊权限，**不可靠且要第 2 个特殊权限** → 不做 |
| 18 | `desktopLyric.isHoverHide` | 触屏无 hover |
| 19 | `desktopLyric.classic.x` | 单行档位置与双行档共用 `multiLine.x/y` |
| 20 | `desktopLyric.classic.y` | 同上 |
| 21 | `desktopLyric.classic.widthByFontNum` | 单行档宽度用 `wrap_content` / 屏宽派生，不需要"按字数定宽"（Android 有 `measureText`） |
| 22 | `desktopLyric.classic.showExtendedLyrics` | 浮层无空间显示翻译/罗马音扩展行 |
| 23 | `desktopLyric.classic.style.font` | **R-11：Android 无法枚举系统字体文件**（`font-list` 仅桌面）。字体族统一用系统默认 |
| 24 | `desktopLyric.classic.style.fontSize` | 与 `multiLine.style.fontSize` 合并（§4.1-8） |
| 25 | `desktopLyric.classic.style.opacity` | 与 `multiLine.style.opacity` 合并（§4.1-13） |
| 26 | `desktopLyric.classic.style.align` | 与 `multiLine.style.align` 合并 |
| 27 | `desktopLyric.classic.style.alignX` | 桌面 `default/left/right` 的水平微调，已被 `align` + 吸附覆盖 |
| 28 | `desktopLyric.classic.style.lyricUnplayColor` | 合并到 §4.1-12 |
| 29 | `desktopLyric.classic.style.lyricPlayedColor` | 合并到 §4.1-11 |
| 30 | `desktopLyric.classic.style.lyricShadowColor` | **改用恒定阴影**（`setShadowLayer(2dp,0,1dp,0x99000000)`），不开放配置。理由：跨应用可读性是"必要功能"而非"偏好"，让用户把阴影调成 0 会直接导致浅色背景上看不清 |
| 31 | `desktopLyric.classic.style.isFontWeightFont` | 合并为"主行 600 / 次行 400"的固定层级，不单独配 |
| 32 | `desktopLyric.classic.style.isFontWeightLine` | 同上 |
| 33 | `desktopLyric.classic.style.isFontWeightExtended` | 无扩展行 |
| 34 | `desktopLyric.multiLine.width` | 宽度由档位决定（§2.1），用户不手调 |
| 35 | `desktopLyric.multiLine.height` | 高度由档位 + 行数决定 |
| 36 | `desktopLyric.multiLine.isDelayScroll` | 浮层只有 1–2 行，"延迟滚动"无意义（那是多行歌词列表的行为） |
| 37 | `desktopLyric.multiLine.scrollAlign` | 无滚动 |
| 38 | `desktopLyric.multiLine.direction` | 浮层恒为水平单列，不做竖排 |
| 39 | `desktopLyric.multiLine.style.font` | 同 #23（R-11） |
| 40 | `desktopLyric.multiLine.style.lyricShadowColor` | 同 #30 |
| 41 | `desktopLyric.multiLine.style.isZoomActiveLrc` | 当前行放大需要每行重新测量/布局，overlay 窗口 resize 成本高且会闪；用**颜色**（#11）而非**放大**做当前行强调 |
| 42 | `desktopLyric.multiLine.style.isFontWeightFont` | 固定 600 |
| 43 | `desktopLyric.multiLine.style.isFontWeightLine` | 同上 |
| 44 | `desktopLyric.multiLine.style.isFontWeightExtended` | 无扩展行 |
| — | `desktopLyric.style.ellipsis`（已注释，不在 44 内） | 不存在 |

### 4.3 语义重定义清单（arch 做 migration 时注意）

| 键 | 桌面语义 | Android 语义 | 迁移动作 |
|---|---|---|---|
| `desktopLyric.mode` | `classic` / `multiLine` 两种**窗口类型** | 单行档 / 双行档 | **值不变**，直接沿用 |
| `desktopLyric.multiLine.x` | 窗口左上角绝对 x（px） | **距右边缘 dp**（`null` = 默认居中） | **丢弃桌面值 → null**（绝对坐标跨分辨率无意义） |
| `desktopLyric.multiLine.y` | 窗口左上角绝对 y（px） | 距顶部 dp | **丢弃桌面值 → null** |
| `desktopLyric.multiLine.style.fontSize` | 26 = 桌面浮层像素字号 | 26 = 中间值，映射为 16sp | **值不变**，移动端读取时套 §2.8 公式 |
| `desktopLyric.multiLine.style.lineGap` | 15 px | 10 dp | **值不变**，移动端读取时 `clamp(4, v` 若 >20 则 `round(v*0.67)`, 24)` |
| `desktopLyric.multiLine.style.opacity` | 100 | 85 默认 | 保留值但 `clamp(40, v, 100)` |
| `desktopLyric.isLockScreen` | 锁屏时"显示/隐藏" | 同（默认 true = 锁屏不显示） | 值不变 |
| `desktopLyric.enable` | 桌面歌词窗开关 | 悬浮窗开关 | 值不变。**但迁移时强制置 false**（新设备无权限，开着会导致状态不一致） |

### 4.4 设置页落位（新增 L1 分组）

Phase 3 §4.3 的 16 个分组中，**新增或改写**一个 L1 分组：

```
设置 › 悬浮歌词（L2 页，取代原计划里"后台与通知"中的悬浮歌词项）

┌ AppBar: ‹ 悬浮歌词 ┐
│ 显示悬浮歌词            [●  ]     │ 56dp，desktopLyric.enable
│ ─────────────────────────────── │
│ 「未授权」提示行（仅未授权时）      │ 44dp 红字 + [重新授权] 44dp 按钮
│ ─────────────────────────────── │
│ 尺寸档位      双行          ›    │ 56dp，点开 → ActionSheet（单行/双行）
│ 字号          26            ──●──│ 滑块
│ 对齐          居中          ›    │ ActionSheet（左/中/右）
│ 行距          10            ─●───│ 滑块（仅双行档可用，单行档置灰）
│ 不透明度      85%           ───●─│ 滑块
│ 当前行颜色    跟随主题       ›    │ 取色器 + "跟随主题"项
│ 次行颜色      白色 62%       ›    │ 取色器
│ ─────────────────────────────── │
│ 暂停时隐藏              [●  ]     │ 56dp
│ 锁屏时隐藏              [●  ]     │ 56dp
│ 锁定（点击穿透）         [  ]     │ 56dp，开启时弹确认（§2.5）
│ ─────────────────────────────── │
│ ▸ 小米 / Redmi 机型提示            │ 折叠，仅 Xiaomi 系显示
└──────────────────────────────────┘
```

**关键约束**：这一页的所有滑块/开关改完立即生效（写 `updateSetting` → `settingEvent` 广播 → 浮层投影），**不需要"确定"按钮**。原因：浮层调整是即时视觉反馈，加确认步骤反而打断。

---

## 5. 与播放页 / 主界面的状态同步

### 5.1 原则

**`settingState` + `playerState` + `lyricState` 是唯一真相源；浮层与通知栏都是只读投影。** 任何一方改动都必须写回 `settingState`（经 `updateSetting`），再通过事件广播到所有消费者。**禁止原生侧缓存第二份设置**。

### 5.2 事件驱动表（JS → 原生）

| 事件源（已存在，无需改源码） | 触发点 | 桥调用 | 频率/节流 |
|---|---|---|---|
| `lyricEvent.on('lineChanged')` | `modules/lyric/store/commit.ts:13` 无条件 emit | `overlay.setLyric(current, next)` —— `next` 从 `lyricState.lines[line+1]?.text` 读（`store/state.ts:8-17` 是普通对象，可直接读） | 行级（3–5s/行）+ **100ms 合并**（快速跳行时合并） |
| `lyricEvent.on('linesChanged')` | 换歌/加载歌词 | 清空 `next`，避免显示上一首的残留行 | 低频 |
| `playerEvent.on('play' / 'pause' / 'stop')` | `modules/player/store/event.ts` | `overlay.setState(isPlaying)`（配合 `pauseHide`） | 低频 |
| `playerEvent.on('musicChanged')` | 换歌 | `overlay.setMeta(name, singer)`（单行档无歌词时回落显示歌名） | 低频 |
| `settingEvent.on('updated', keys)` | 任一设置变更（**App 内改、通知栏改、浮层改都走这里**） | 命中 `desktopLyric.*` 则 `overlay.setStyle({...})` / `overlay.setVisible()` | 低频 + **16ms 合并**（滑块拖动） |
| `playerEvent.on('playerError')` | 播放失败 | `overlay.setLyric('', '—')` 或隐藏（按 `desktopLyric.enable`） | 低频 |
| 歌词为空（纯音乐） | `line.text === ''` | 单行档显示 `name - singer`；双行档两行都留空但**保持窗口尺寸**（避免抖动） | — |

### 5.3 事件驱动表（原生 → JS）

| 用户动作 | 原生侧 | 桥调用 | JS 侧落点 |
|---|---|---|---|
| 单击浮层 | 拉起 App + 进入播放页歌词态 | `nav.openPlayDetail()` | `setShowPlayDetail(true)` |
| 工具条🔒/▤/✕ | 直接改窗口 + 通知 JS | `overlayAction('lock'|'mode'|'close')` | `updateSetting({...})` → `settingEvent` 广播 → 浮层收 `setStyle`（**闭环，浮层不自行改状态**） |
| 通知栏「🔓 解锁歌词」 | `MediaSessionPort.onControl('overlayUnlock')` | 同上 `overlayAction('unlock')` | `updateSetting({'desktopLyric.isLock': false})` |
| 拖拽结束 | 计算吸附后坐标 | `overlayMoved(x, y)` | `updateSetting({'desktopLyric.multiLine.x/y': ...})` |
| 权限被撤销 | `onResume` 检查失败 | `overlayPermissionLost()` | `updateSetting({'desktopLyric.enable': false})` + Toast |

> **闭环的重要性**：浮层按钮**不直接改窗口状态**，而是"请求 JS 改设置 → 设置广播回来 → 浮层按新设置调整"。多一跳 IPC（<16ms），换来的是"App 内设置页 / 浮层工具条 / 通知栏"三处永远一致。这是避免"浮层关了但设置里还开着"这类经典 bug 的唯一可靠做法。

### 5.4 App 前后台切换

| 事件 | 浮层行为 |
|---|---|
| `ActivityLifecycleCallbacks.onStart`（App 进前台） | 浮层 `GONE`（避免与 App 内歌词页/播放页重叠；也避免用户在 App 内操作时被浮层挡） |
| `onStop`（App 退后台） | 若 `desktopLyric.enable && canDrawOverlays` → 浮层 `VISIBLE` |
| 屏幕熄灭 | 依 `isLockScreen` 决定 |
| 播放暂停 | 依 `pauseHide` 决定 |
| 播放停止（队列结束） | 浮层显示 `name` 或直接隐藏（建议：保持显示歌名 3s 后隐藏，避免"歌词窗突然消失"） |

### 5.5 与"通知栏歌词"的一致性

两者都消费同一个 `lineChanged` 流（通知栏走 `titleLyricChanged` → `MediaMetadata.TITLE`，浮层走 `lineChanged` → 桥），**行内容天然一致**。唯一需要对齐的是**开关语义**：
- `player.isShowMediaSessionLyric` → 通知栏歌词
- `desktopLyric.enable` → 浮层
两个开关独立，互不连带。**例外**（已在 §2.5 记录）：`isLock=true` 时通知栏必须保留「解锁歌词」action，不受 `pauseHide`／`isShowMediaSessionLyric` 影响。

---

## 6. 对 arch 三项待回填项的答复

| # | 问题 | 答复 |
|---|---|---|
| 1 | 通知栏歌词：单行 + 省略号，不做滚动？ | **认可单行 + 省略号 + 不滚动**。补充：① MVP 折叠态 1 行（走 `title`，免费）；② 展开态 2 行（当前 + 下一行）**列为 P1 可选**，需 RemoteViews，**不是 MVP 阻塞项**——如果 MVP 排期紧可以只做单行。③ 节流 ≤4Hz；④ 新增字段 `lyricNext`（仅展开态第 2 行）、`lyricEnabled`（对应 `player.isShowMediaSessionLyric`），`lyricLine` 保留。⑤ 你提到的"免费得到"我确认：`mediaSessionInfo.ts:44-47` 已把整句歌词写进 `title`，只需把开关默认值在移动端改为 `true` |
| 2 | `html.mobile` 的布局断点值（预置 640px） | **用 `600px`，不要 640px**。依据 Material 3 window size class：`compact < 600 ≤ medium < 840 ≤ expanded`。411dp 落 compact。用 640 会让 600–639dp 的设备（部分小平板/折叠折叠态）错误落进 compact。CSS 侧写 `@media (max-width: 599.98px)`（用 599.98 避免 600.0 的浮点争议），JS 侧 `matchMedia('(max-width: 599.98px)')` |
| 3 | Tab 切换是否计入返回栈？ | **不计入。Tab 切换用 `replace`，不产生历史**。理由：① Android 惯例（bottom nav 切换不堆积历史）；② 我们的 5 级返回链（ActionSheet → PlayDetail → 二级页 → Tab 首页 → 退出）如果掺进 Tab 历史会变成 8–9 级，用户按 5 次才退出，体感极差。**具体规则**：任意 Tab 的根页面按返回 → 若当前不是「曲库」Tab 则切到「曲库」（`replace`）→ 在「曲库」根页面按返回 → 弹一次 Toast「再按一次退出」→ 2s 内再按才 `finish()`。**PlayDetail 走 `pushBackHandler`**（你的判断正确，它是 overlay 不是路由） |

---

## 7. 附：同期需要补的 3 个 UI 状态标记（不在悬浮窗范围，但会一起进 Phase 4）

| # | 标记 | 触发条件 | UI 呈现 |
|---|---|---|---|
| 1 | **本地歌曲「需重新扫描」** | arch D-04 提到的 `getMusicUrl` 仅在 `meta.deviceId === machineId` 时返回 URL（`web-server/src/app/modules/music/local.ts:20`），迁移后 deviceId 不匹配会让本地歌"点了没反应" | ① 曲库「本地」入口 chip 上显示 `⚠ + 数量`；② 歌单行右侧 `⚠` 12dp 图标；③ 歌单详情顶部一条 44dp 提示条「N 首本地歌曲需重新扫描 · [立即扫描]」；④ 点击该歌时若 URL 为空 → Snackbar「该歌曲需要重新扫描本地目录」+ 直接给跳转。**不做**静默失败 |
| 2 | **SAF 路径不显示完整路径** | arch D-03 约束（`content://` 长串） | 所有涉及目录的位置只显示 `displayName`（如「音乐」），不显示 `content://com.android.externalstorage...`。若 `rename` 返回 `EUNSUPPORTED` → 提示「该系统文件夹不支持重命名」，不弹通用错误 |
| 3 | **能力位置灰** | `getCapabilities()` 返回 false | 音效面板顶部一条 40dp 提示条 + 不支持项置灰（保留可见）+ 灰字「当前设备不支持」。**不整块隐藏**（避免切引擎时面板布局跳动） |

---

## 8. 门禁自检（本补充文档）

| # | 项 | 结论 |
|---|---|---|
| 1 | 所有可交互元素热区 ≥44×44dp | ✅ 浮层本体 379×40 / 387×64；工具条 3 按钮各 44×44；无例外（§2.7 逐项列出） |
| 2 | 相邻可点元素间距 ≥8dp | ✅ 工具条按钮间 8dp、工具条与浮层 8dp、浮层与屏幕边缘 8dp |
| 3 | 无鼠标精度依赖 | ✅ 拖拽有 12dp 阈值 + 120ms 时间窗；无 hover；无可滚轮控件 |
| 4 | 破坏性操作有二次确认或可撤销 | ✅ 锁定（弹确认 + 双解锁入口）；关闭（可重新开启，无需确认） |
| 5 | 权限引导有降级路径 | ✅ 三级 Intent 兜底 + 拒绝后不纠缠 + 撤销后静默降级（§3.3–3.4） |
| 6 | 状态单一真相源 | ✅ 浮层按钮不直接改窗口，一律 `updateSetting` 闭环（§5.3） |
| 7 | 不假设音频能力可用 | ✅ 浮层只消费歌词文本，不依赖 AudioWorklet；能力位置灰见 §7-3 |
| 8 | 与 Phase 3 规格一致 | ✅ 复用 13 项 / 隐藏 31 项；触控令牌（44/8/56）与 Phase 3 §3.1 同源；断点 600 与 §5.5 一致 |

---

*文档结束。单位约定：CSS px ≡ dp（1 CSS px = 1 dp）；字号用 sp（Android 会按用户字体缩放二次放大，但浮层字号以 sp 声明以尊重无障碍设置——这是浮层唯一有意允许缩放的地方，因为它是独立窗口，不参与 App 内的 rem 体系）。*
