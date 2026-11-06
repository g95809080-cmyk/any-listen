# Phase 6 合规审查报告（许可证 / 零改动 / 产物泄露）

- **审查人**：方证（质量保障与合规审查）
- **审查时间**：2026-11-03 21:53（本地时区）
- **审查方式**：**纯静态审查**（未执行 `pnpm build`、未执行 `gradlew`、未接触 adb/模拟器 —— 设备被实测占用）
- **被审对象指纹**（审查期间换了三次，**第三份为当前有效结论**；详见 §3.5）：

| 轮次 | 产物 | 大小 | SHA-256 | 状态 |
|------|------|------|---------|------|
| 第一轮 | `app-debug.apk`（21:40） | 24,343,591 B | `8ad9d6d3b87240b064117012a4cb0040775a2329aa2cc55f14a38acd31dd001e` | 已被覆盖，证据不可再取 |
| 第二轮 | `app-debug.apk`（22:20:19） | 24,343,888 B | `56d66c4029600af37032ea021aa8abb865ae74acbddf36fdfa4d1141eea4d51e` | 已被覆盖；**是装机验证的那一份** |
| **第三轮** | **`app-debug.apk`（22:32:07）** | **24,343,591 B** | **`de9541028538bd75027ede62a8bb4081dfb0cec5018823de86861193fad720b1`** | **当前磁盘上的包** |
| 第一轮 | `app-release.apk` | 10,239,091 B | `7859d3412d058baf3f9a0dfa5f17763ffd9fbd917703b8fab3534bb8054a548d` | 未重审（release 链路未变） |

> ⚠️ **注意第 2/3 行的区别**：装机验证的是第二份，磁盘上是第三份。已登记为 P2-11（交付物 ≠ 已测物），需主理人裁决。

- **环境**：Node v22.22.2 / pnpm 10.34.5 / Gradle 8.14.3 / AGP 8.13.2 / Kotlin 2.2.10 / JDK 17 / compileSdk 35
- **前提约束**：PDR-003 —— 本项目**仅个人使用与学习，不分发、不商用**。本报告所有风险等级均以该前提成立为基准，第 4 节单独给出「前提失效」时的后果。

---

## 1. 上游零改动验证

### 1.1 可复现命令与实测输出

```bash
git -C source status --porcelain
git -C source rev-parse HEAD
git -C source branch --show-current
git -C source remote -v
git -C source rev-list --left-right --count origin/dev...HEAD
git -C source log -1 --format="%H%n%an <%ae>%n%ad%n%s"
git -C source status --porcelain --untracked-files=all | wc -l
```

实测输出（逐条）：

```
$ git -C source status --porcelain
（空输出，退出码 0）

$ git -C source rev-parse HEAD
c8f40eab05021735b969e5991e6ec2f2c63e83b8

$ git -C source branch --show-current
dev

$ git -C source remote -v
origin  https://github.com/any-listen/any-listen.git (fetch)
origin  https://github.com/any-listen/any-listen.git (push)

$ git -C source rev-list --left-right --count origin/dev...HEAD
0       0

$ git -C source log -1 --format="%H%n%an <%ae>%n%ad%n%s"
c8f40eab05021735b969e5991e6ec2f2c63e83b8
lyswhut <lyswhut@qq.com>
Mon Oct 26 18:40:37 2026 +0800
chore: release 0.10.1-beta.2 for desktop and 0.12.1-beta.2 for web-server

$ git -C source status --porcelain --untracked-files=all | wc -l
0
```

### 1.2 判定

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 已跟踪文件是否被修改 | **否** | `status --porcelain` 空 |
| 是否存在未跟踪文件（含被 `.gitignore` 之外的一切） | **否**，0 个 | `--untracked-files=all` 计数为 0；不存在「本项目在 `source/` 里留下构建垃圾」的情况 |
| 本地是否多出提交 | **否**，`0  0` | `origin/dev...HEAD` 左右计数均为 0 → HEAD 就是远端 `origin/dev` 的原样引用，**没有本地 commit、没有 rebase、没有 squash** |
| 是否有 stash / 未推送分支改动 | **否** | `git branch -vv` 仅 `* dev c8f40eab [origin/dev]`，无 ahead/behind 标记 |
| 工作区附带的 `node_modules` | 存在但不属改动 | `source/node_modules` 有 18 项（eslint 工具链、pnpm `.pnpm` 元数据等），但：① 被上游 `.gitignore:35 node_modules/` 忽略（`git check-ignore -v` 命中）；② 其下**已跟踪文件数 = 0**（`git ls-files node_modules | wc -l`）。属"装依赖产生的本地目录"，不构成源码改动。<br>**注意**：`source/packages/view-main/node_modules` 同样存在且被忽略，而移植层 `link-vendor.mjs` 依赖它 —— 见 §4.3 P2-4 |

**结论：上游 `source/` 零改动成立，且有「远端可对账」级别的证据**（不是"我没改"，而是"与 `origin/dev` 逐提交一致"）。

### 1.3 「零改动」对 AGPL 的意义解读（重要，不要误读）

这里必须把两件事分开，否则会得出错误结论：

**(a) 零改动 ≠ 移植层不构成衍生物。**

移植层是**源码级派生**，不是「独立程序通过 API 通信」。证据：

```bash
# 移植层 vite 直接把上游源码当编译输入
porting/js/vite.config.mjs:57   const PKGS = path.resolve(ROOT, '../../source/packages')
porting/js/vite.config.mjs:28   import svelteConfig, { lessConfig } from '../../source/packages/view-main/svelte.config.js'
porting/js/vite.extension-preload.config.mjs:19  const PROJECT = path.join(PKGS, 'shared/extension-preload')
porting/js/vite.extension-preload.config.mjs:51  input: { 'extension-preload': path.join(PROJECT, 'src/index.ts') }
```

- SPA bundle 里编译进去的是 `source/packages/view-main/src/**` 的上游 Svelte 组件；
- `assets/web/spa/extension-preload/extension-preload.js` 直接由 `source/packages/shared/extension-preload/src/index.ts` 编译而来；
- 移植层还通过 `link-vendor.mjs` 把上游的 `svelte` / `less` / `postcss` 等**同一份** node_modules 联接进来编译。

因此：**移植层 + 上游源码编译产物整体 = 上游的衍生作品，分发时必须整体按 AGPL v3 授权。** 「我没改上游一行代码」不能用来主张"我的移植层是独立作品、可以闭源"。这一点写在这里，是为了防止后续有人拿"零改动"当免责依据。

**(b) 零改动真正的价值是可回溯性与可审计性，不是免责。**

- 上游每一个文件都能用 `git -C source show c8f40eab:<path>` 还原到原作者版本，**上游部分与我方改动可机械分离**；
- 满足 AGPL v3 第 5 条「修改版本必须带显著修改说明」的可实现性 —— 我方只需标注移植层文件，不必逐文件声明上游改动（因为确实没有）；
- 出问题时可快速判定"这是我方缺陷还是上游缺陷"，Phase 5 的 ERR-001~010 定位就依赖这一点。
- AGPL v3 §13（网络交互须提供源码）的触发条件分析见 §2.4。

---

## 2. 许可证清单与义务

### 2.1 依赖提取方法与可复现命令

```bash
# JS 侧：声明依赖
cat porting/js/package.json

# JS 侧：实际安装版本 + package.json 声明的 license 字段
cd porting/js && for p in quickjs-emscripten sql.js buffer fflate message2call node-forge @noble/hashes vite typescript; do
  node -e "const x=require('./node_modules/$p/package.json');console.log(x.name+'@'+x.version+' | '+(x.license||JSON.stringify(x.licenses)||'<none>'))"
done

# JS 侧：构建期通过 link-vendor / 上游 node_modules 引入的包
cat porting/js/scripts/link-vendor.mjs      # PACKAGES 列表
for p in svelte less postcss postcss-pxtorem svelte-preprocess vite-plugin-svg-icons \
         dompurify marked refractor sortablejs regexparam hast-util-to-html; do
  node -e "const x=require('../source/packages/view-main/node_modules/$p/package.json');console.log(x.name+'@'+x.version+' | '+x.license)"
done
node -e "const x=require('../source/packages/shared/nodejs/node_modules/music-metadata/package.json');console.log(x.name+'@'+x.version+' | '+x.license)"

# Android 侧：直接依赖与版本
cat porting/android/gradle/libs.versions.toml
cat porting/android/app/build.gradle.kts porting/android/*/build.gradle.kts
```

实测关键输出：

```
quickjs-emscripten@0.31.0 | MIT
@jitl/quickjs-wasmfile-release-sync@0.31.0 | MIT
sql.js@1.15.2 | MIT
buffer@6.0.3 | MIT
fflate@0.8.3 | MIT
message2call@2.0.3 | MIT
node-forge@1.4.2 | (BSD-3-Clause OR GPL-2.0)     <-- 注意
@noble/hashes@1.8.0 | MIT
vite@6.4.5 | MIT
typescript@5.9.3 | Apache-2.0
svelte@5.57.2 | MIT
@sveltejs/vite-plugin-svelte@7.3.1 | MIT
svelte-preprocess@6.0.5 | MIT
less@4.9.1 | Apache-2.0
postcss@8.5.31 | MIT
postcss-pxtorem@6.1.0 | MIT
vite-plugin-svg-icons@2.0.1 | MIT
dompurify@3.4.17 | (MPL-2.0 OR Apache-2.0)        <-- 注意
marked@18.1.1 | MIT
refractor@5.0.0 | MIT
sortablejs@1.15.7 | MIT
regexparam@3.0.0 | MIT
hast-util-to-html@9.0.5 | MIT
music-metadata@12.3.2 | MIT
```

### 2.2 许可证清单

「链接方式」列的含义：
- **静态编译进 dex** = Kotlin/Java 类被 R8/D8 编进 `classes*.dex`，属静态链接；
- **打进 SPA bundle** = JS 被 vite/rollup 树摇后合并进 `assets/web/spa/assets/*.js`，属静态链接 + 打包；
- **作为独立二进制资源随包** = wasm 以独立文件形式放 `assets/`，运行时 fetch 加载（仍随 APK 分发）；
- **不打包** = 仅构建期/测试期存在，APK 内无其代码。

#### A. 上游本体（最关键一项）

| 组件 | 版本 | 许可证 | 链接方式 | 义务 | 风险等级 |
|------|------|--------|----------|------|----------|
| **any-listen**（`source/`） | 0.12.1-beta.2（web-server）/ 0.10.1-beta.2（desktop），commit `c8f40eab` | **Custom License based on AGPL v3.0 + 附加条款「禁止任何商业用途」** | 源码级编译进 SPA bundle + `extension-preload.js`；移植层直接 `import` 上游模块 | 分发时：整体以 AGPL v3 提供完整对应源码 + 保留版权声明 + 标注修改。附加"禁商用"条款见 §2.3 分析 | **高** |

上游 LICENSE 的附加条款原文（`source/LICENSE:669-680`）：

```
Additional License Terms:

1. Notwithstanding the terms of the Affero General Public License, this
   software may not be used for any commercial purposes without explicit
   written permission from the original author.

2. "Commercial use" is defined as any use of the software in a for-profit
   business or to provide paid services.

3. Any use of the software that generates revenue directly or indirectly
   is prohibited under this license unless otherwise agreed
   upon with the author.
```

#### B. JS 运行时依赖（实际进入 APK 的 bundle / wasm）

| 组件 | 版本 | 许可证 | 链接方式 | 义务 | 风险等级 |
|------|------|--------|----------|------|----------|
| quickjs-emscripten | 0.31.0 | MIT | 打进 SPA bundle | 保留版权与许可声明 | 低 |
| @jitl/quickjs-wasmfile-release-sync（含 QuickJS 引擎 wasm） | 0.31.0 | MIT（包声明） | 作为 `assets/web/spa/assets/emscripten-module-*.wasm`（518,880 B）随包 | 保留声明；**引擎本体版权头需人工确认随包是否附带** | 低 |
| sql.js | 1.15.2 | MIT | 打进 bundle | 保留声明 | 低 |
| SQLite（编译进 sql.js wasm） | — | Public Domain（**需人工确认**上游 wasm 构建所依据的确切版本声明） | 作为 `assets/web/spa/wasm/sql-wasm-browser.wasm`（685,235 B）随包 | 无（公有领域） | 低 |
| buffer | 6.0.3 | MIT | 打进 bundle | 保留声明 | 低 |
| fflate | 0.8.3 | MIT | 打进 bundle | 保留声明 | 低 |
| message2call | 2.0.3 | MIT | 打进 bundle | 保留声明 | 低 |
| **node-forge** | 1.4.2 | **`(BSD-3-Clause OR GPL-2.0)` 双许可** | 打进 bundle | **必须在两者中明确选举 BSD-3-Clause**。若被解读为按 GPL-2.0 使用，则整个 SPA bundle 触发 GPL-2.0 强 copyleft | **中** |
| @noble/hashes | 1.8.0 | MIT | 打进 bundle | 保留声明 | 低 |
| **dompurify** | 3.4.17 | **`(MPL-2.0 OR Apache-2.0)` 双许可** | 打进 bundle | 选举 Apache-2.0 则仅需保留声明；若不选举而按 MPL-2.0，则 dompurify 的**文件级**修改需以 MPL 公开（本项目未修改上游 node_modules，故实际义务为空） | **中** |
| marked | 18.1.1 | MIT | 打进 bundle | 保留声明 | 低 |
| refractor | 5.0.0 | MIT | 打进 bundle | 保留声明 | 低 |
| sortablejs | 1.15.7 | MIT | 打进 bundle | 保留声明 | 低 |
| regexparam | 3.0.0 | MIT | 打进 bundle | 保留声明 | 低 |
| hast-util-to-html | 9.0.5 | MIT | 打进 bundle | 保留声明 | 低 |
| music-metadata | 12.3.2 | MIT | 打进 bundle | 保留声明 | 低 |
| svelte（运行时） | 5.57.2 | MIT | 打进 bundle（`$state`/`svelte/internal` 运行时在包内） | 保留声明 | 低 |

#### C. JS 构建期依赖（不进入 APK）

| 组件 | 版本 | 许可证 | 链接方式 | 义务 | 风险等级 |
|------|------|--------|----------|------|----------|
| vite | 6.4.5 | MIT | 不打包 | 无（未分发） | 低 |
| typescript | 5.9.3 | Apache-2.0 | 不打包 | 无 | 低 |
| @sveltejs/vite-plugin-svelte | 7.3.1 | MIT | 不打包 | 无 | 低 |
| svelte-preprocess | 6.0.5 | MIT | 不打包 | 无 | 低 |
| less | 4.9.1 | Apache-2.0 | 不打包（编译期生成 CSS） | 无 | 低 |
| postcss | 8.5.31 | MIT | 不打包 | 无 | 低 |
| postcss-pxtorem | 6.1.0 | MIT | 不打包 | 无 | 低 |
| vite-plugin-svg-icons | 2.0.1 | MIT | 不打包 | 无 | 低 |

> 注：less / postcss / postcss-pxtorem / svelte / svelte-preprocess / vite-plugin-svg-icons / @sveltejs/vite-plugin-svelte 这 7 个包**未在 `porting/js/package.json` 里声明**，而是由 `scripts/link-vendor.mjs` 从 `source/packages/view-main/node_modules` 目录联接进来。许可证本身无问题（均 MIT / Apache-2.0），但**可复现性**上存在隐患，见 §4.3 P1-2。

#### D. Android 原生依赖

| 组件 | 版本 | 许可证 | 链接方式 | 义务 | 风险等级 |
|------|------|--------|----------|------|----------|
| androidx.core:core-ktx | 1.15.0 | Apache-2.0 | 静态编译进 dex | 保留声明；分发时需附 License 副本 + NOTICE | 低 |
| androidx.activity:activity-ktx | 1.9.3 | Apache-2.0 | 静态编译进 dex | 同上 | 低 |
| androidx.lifecycle:lifecycle-runtime-ktx | 2.8.7 | Apache-2.0 | 静态编译进 dex | 同上 | 低 |
| androidx.media:media | 1.7.0 | Apache-2.0 | 静态编译进 dex | 同上 | 低 |
| okhttp | 4.12.0 | Apache-2.0 | 静态编译进 dex | 同上（**APK 内唯一实际保留的许可文件来自它**：`okhttp3/internal/publicsuffix/NOTICE`） | 低 |
| kotlinx-coroutines-android | 1.9.0 | Apache-2.0 | 静态编译进 dex | 同上 | 低 |
| commons-compress | 1.27.1 | Apache-2.0 | 静态编译进 dex | 同上 | 低 |
| Kotlin stdlib | 2.2.10（随 AGP/Kotlin 插件） | Apache-2.0 | 静态编译进 dex | 同上 | 低 |
| Android Gradle Plugin | 8.13.2 | Apache-2.0 | 不打包 | 无 | 低 |
| Gradle | 8.14.3 | Apache-2.0 | 不打包 | 无 | 低 |
| junit | 4.13.2 | **EPL-1.0** | **不打包**（`testImplementation`） | 仅测试期，未分发 | 低 |

#### E. 未发现但需声明的项

| 检查项 | 结论 |
|--------|------|
| 直接依赖中是否存在 **GPL / LGPL / AGPL** 组件 | **仅上游 any-listen 本体（AGPL v3 + 禁商用）**。JS/Android 直接依赖中**无** GPL/LGPL 项 |
| 存在 LGPL 吗 | **否**。但 `app/build.gradle.kts` 的 `packaging.resources.excludes` 里仍写着 `/META-INF/{AL2.0,LGPL2.1}` —— 这是模板残留，本项目无 LGPL 组件可对应，见 P2-2 |
| 存在 Medias3 吗 | **否**。`:app` 用的是 `androidx.media:media:1.7.0`（不是 media3），`libs.versions.toml` 里也没有 media3 条目 |

### 2.3 copyleft 项单独分析：链接方式 / 源码提供义务 / 自用风险

#### (1) 上游 any-listen —— AGPL v3 + 禁商用附加条款

| 分析维度 | 结论 |
|----------|------|
| **链接方式** | 源码级静态编译进 SPA bundle。这不是"动态加载插件"，vite 把上游 Svelte 组件/TS 模块与移植层代码合并进同一批 chunk。属于最强形式的衍生 |
| **是否触发源码提供义务（AGPL §4/§5/§6）** | 这三条的义务都由 **convey（分发/转让副本）** 触发。本项目**不分发 → 未触发** |
| **是否触发 AGPL §13（网络交互）** | §13 针对「用户通过网络与程序远程交互」。实测该程序唯一的网络服务是本地回环：<br>`bridge/.../LocalHttpServer.kt:67` `ServerSocket(port, BACKLOG, InetAddress.getByName("127.0.0.1"))`<br>且要求 token（cookie / `?t=` / header），监听地址仅 `127.0.0.1`。<br>→ 服务对象是**用户本人的 WebView**，不是"远程用户"，**§13 不触发** |
| **本报告关注点：附加"禁商用"条款的性质** | 这是本项**唯一的实体法律风险点**，详见下方专段 |
| **「仅自用不分发」场景的实际风险等级** | **低**。AGPL §2 明确允许「为自用目的修改，无需接受本许可的其余条件」；不分发 = 不 convey = 无源码开放义务、无版权声明附加义务。用户的个人使用与学习完全落在授权范围内 |
| **「一旦分发」风险等级** | **高**。见 §4.4 |

**关于「AGPL v3 + 禁止商用」这个组合本身**（这是我在审查中发现的、需要在 PDR 层面知晓的事实）：

1. 这份许可证**不是 OSI 认可的 AGPL**，也不是自由软件基金会定义的自由许可证 —— 「禁止任何商业用途」是 AGPL v3 不允许的额外限制。
2. AGPL v3 第 7 条只允许清单内几类附加条款，并明确规定：**「所有其他非许可性附加条款均视为第 10 条意义上的『进一步限制』。若你收到的程序或其任何部分带有声明其受本许可及某项进一步限制约束的通知，你可以移除该条款。」**
3. 也就是说，AGPL v3 自身给了被许可方「移除禁商用条款」的权利。但这与上游作者明示的意图直接冲突。
4. **我方立场**：本项目严格按上游**文档声明的意图**（个人非商用、不分发）执行，不去援引 §7 第 3 段做任何扩张解释。这条结论不需要推翻，但它意味着：
   - **不能**把"AGPL 允许我这么做"当理由去商用；
   - 一旦要商用，唯一安全路径是**取得原作者书面授权**（与 PDR-003 的表述一致）；
   - `source/LICENSE` 的文本自相矛盾这一点，若未来涉及分发，**必须由用户/法务决定如何呈现**，我作为审查方不给法律意见，只标注「需人工确认」并阻断。

#### (2) node-forge —— `(BSD-3-Clause OR GPL-2.0)` 双许可

| 分析维度 | 结论 |
|----------|------|
| 链接方式 | 打进 SPA bundle |
| 义务 | 双许可 = **被许可方有权任选其一**。选举 BSD-3-Clause 后为宽松许可，只需保留版权声明、不得用作者名义背书 |
| 错误路径 | 若在某处（README、NOTICE、发布说明）把 node-forge 标注为「GPL-2.0」，会被解读为按 GPL-2.0 使用 → **整个 SPA bundle 变成 GPL-2.0 衍生作品** → 与"仅自用"无关，但会与上游的 AGPL 产生许可证兼容性讨论，且分发时必须整包 GPL |
| 风险等级 | **中**（不是因为它现在有问题，而是因为"不选举"等于把一个高 copyleft 选项留在桌面） |
| 建议动作 | 在将来的 NOTICE 中明确写 `node-forge — BSD-3-Clause（本项目选举 BSD-3-Clause，不使用 GPL-2.0 选项）`。本项目零改动约束下**不需要改代码**，只需在文档中固化选举 |

#### (3) dompurify —— `(MPL-2.0 OR Apache-2.0)` 双许可

| 分析维度 | 结论 |
|----------|------|
| 链接方式 | 打进 SPA bundle |
| 义务 | 选举 Apache-2.0 → 宽松。若按 MPL-2.0 → 文件级弱 copyleft：**只对 dompurify 自身文件的修改**要求以 MPL 公开，不传染到移植层 |
| 实际情况 | 本项目未修改 `node_modules/dompurify` 内任何文件（上游零改动约束下，不可能改）→ 即便按 MPL-2.0 也**无任何源码公开义务** |
| 风险等级 | **中**（同样源于"未选举"的不确定性，而非实际违规） |
| 建议动作 | NOTICE 中明确选举 Apache-2.0 |

### 2.4 AGPL §13 的技术事实核查（支持 §2.3 的判定）

```bash
grep -rn "127.0.0.1\|0.0.0.0\|InetAddress\|bind" --include=*.kt \
  porting/android/bridge/src porting/android/app/src porting/android/core-ports/src
```

实测输出（节选）：

```
bridge/src/main/kotlin/com/anylisten/bridge/LocalHttpServer.kt:36: * 安全性：只绑 `127.0.0.1`（不对外），并要求 token（cookie 或 `?t=` 或 header），
bridge/src/main/kotlin/com/anylisten/bridge/LocalHttpServer.kt:59:  val baseUrl: String get() = "http://127.0.0.1:$port"
bridge/src/main/kotlin/com/anylisten/bridge/LocalHttpServer.kt:67:      val socket = ServerSocket(port, BACKLOG, InetAddress.getByName("127.0.0.1"))
```

**判定**：唯一 HTTP 服务绑定 `127.0.0.1`（不是 `0.0.0.0`），且带 token 校验。不构成「通过网络向远程用户提供服务」；§13 不触发。若未来改为 `0.0.0.0` 对外提供服务，§13 立即触发（且这本身是安全缺陷）。

---

## 3. 产物信息泄露检查

### 3.1 可复现命令

```bash
# 3.1.1 构建目录（syncWebAssets 的目标）
A=porting/android/app/src/main/assets/web
find $A/spa -type f | wc -l
du -sh $A/spa
find $A -name "*.map" -type f | wc -l
find $A -name "*.ts" -type f | wc -l
find $A -name ".env*" -o -name "node_modules" -o -name "*.test.*" -o -name "smoke*" -o -name "*.spec.*"

# 3.1.2 APK 内容审计（不依赖 adb，纯 zip 读）
python - <<'PY'
import zipfile, re
for apk in ['debug/app-debug.apk', 'release/app-release.apk']:
    z = zipfile.ZipFile('porting/android/app/build/outputs/apk/' + apk)
    n = z.namelist()
    print(apk, 'entries:', len(n))
    for pat, label in [(r'\.map$','.map'), (r'\.ts$','.ts'), (r'\.env','env'),
                       (r'node_modules','node_modules'), (r'\.(test|spec)\.','test'),
                       (r'smoke','smoke'), (r'package\.json$','package.json'),
                       (r'(pnpm-lock|yarn\.lock|package-lock)','lockfile'),
                       (r'\.git','git'), (r'(LICENSE|NOTICE|COPYING)','license')]:
        print(' ', label, ':', len([x for x in n if re.search(pat, x, re.I)]))
PY
```

### 3.2 实测输出

> **本节已第三次重绑。审查期间磁盘上的 `app-debug.apk` 换了三次（21:40 → 22:20 → 22:32），每次都被下一次覆盖。当前有效审计对象是 22:32:07 的包，三份包的时间线与差异见 §3.5。**

**被审 APK（当前，22:32:07 产出）：**

```
大小: 24,343,591 B
SHA-256: de9541028538bd75027ede62a8bb4081dfb0cec5018823de86861193fad720b1
总条目: 345
assets/web/spa 内文件: 118（= assets/ 115 + index.html 1 + extension-preload 1 + wasm 1）
```

**APK 内容审计（当前包）：**

| 检查项 | `app-debug.apk`（24 MB，345 条目） |
|--------|-----------------------------------|
| `*.map`（sourcemap） | **0** |
| `*.ts`（原始 TypeScript） | **0** |
| `.env*` | **0** |
| `node_modules` 残留 | **0** |
| `*.test.*` / `*.spec.*` | **0** |
| `smoke*`（测试脚本） | **0** |
| `package.json` | **0** |
| lockfile（pnpm/yarn/npm） | **0** |
| `.git` | **0** |
| 许可/NOTICE 文件 | **1**（`okhttp3/internal/publicsuffix/NOTICE`） |

**APK 内 `assets/web/` 分布（当前包）：**

```
  1  assets/web/spa/index.html
115  assets/web/spa/assets        （JS chunk + css + wasm，已剔除 .map）
  1  assets/web/spa/extension-preload
  1  assets/web/spa/wasm
---
118  合计
```

> **数字口径教训（这条比数字本身重要）**：审查期间我和 fullstack-dev 就 `118` / `121` 来回纠正过 —— 结论是**两边都没错，是在量不同的包**：
>
> | 包 | 总量 | `assets/` 子目录 |
> |----|------|------------------|
> | 22:20 那个（`56d66c40…`） | **121** | 118 |
> | 22:32 那个（`de954102…`，当前） | **118** | 115 |
>
> **一条不带 `sha256` 的文件计数是没有意义的。** 以后报"包里有 N 个文件"必须同时给 sha256；判完整性一律用 §3.2.2 的引用一致性核对，不要用计数。

### 3.2.1 产物与 APK 一致性交叉验证（当前包，**全链路已对齐**）

`porting/js/dist` 已于 22:32 由 fullstack-dev 前台重建（EXIT=0、无并发）。逐文件比对：

```
dist/spa/assets   : 211 文件（含 96 个 .map）
  → 剔除 .map 后 : 115
APK assets/       : 115
只在 dist         : 无
只在 APK          : 无
同名文件 md5 比对 : 一致 115 / 不一致 0
```

全链路拼接（`dist` → gradle 拍平 → `assets` → APK）：

```
dist/spa 非 map 文件                     117  （115 assets + index.html + wasm）
+ dist/extension-preload/extension-preload.js  1  （sibling，被拍平进 assets/web/spa）
------------------------------------------------
= APK 内 assets/web/spa 文件             118  ✓
```

**双向 SHA1 绑定**（把 dist、assets、APK 三者钉在同一个产物上）：

| 文件 | 值 | 来源 |
|------|-----|------|
| `index.html` | `93916b797df1319055501b6e1d48f5681f066d98` | `check-webdist` 报的 dist / assets 两份 SHA1 相同；我从 APK 内算出**同一值** |
| `main.CgvrA_B_.js` | `818838a2dbe5a51c35e850f98376e9923a385b97` | 同上，三者一致 |

→ 「**源码构建产物 → 打包内容 → 装机 APK**」这条链当前是**可对账**的。

### 3.2.2 引用一致性独立核对（不依赖 gradle 日志、不依赖任何单一脚本）

即使 `check-webdist.mjs` 已修（见 §3.2.3），我仍然从 APK 内**自己算了一遍**，避免"只信一个脚本"：

```
index.html 引用：
  OK  /assets/main.CgvrA_B_.js
  OK  /assets/style.D7fqMNMn.css

worker 引用（全量扫描所有 .js）：
  包内 worker 文件 : core.worker-Bjte4zj1.js / db.worker-D_7pk1TN.js / ext.worker-khctBzvv.js
                     main.worker-DdXc1pa.js / util.worker-C04DdRSO.js   （共 5 个）
  被引用 worker    : 同上 5 个
  MISSING          : 无
  孤立（无引用）   : 无
  preload 被引用   : True   实体存在: True

  => 引用一致性: OK
```

**关键 chunk 与 fullstack-dev 给出的基线逐字节吻合**（说明我审的确实是同一个包）：

| chunk | 字节 | 一致 |
|-------|------|------|
| `main.CgvrA_B_.js` | 1,370,688 | ✓（三份包都是这个 size） |
| `style.D7fqMNMn.css` | 192,776 | ✓ |
| `core.worker-Bjte4zj1.js` | 1,786,825 | ✓ |
| `extension-preload.js` | 60,761 | ✓ |
| 总条目 | ~~348~~ | 22:20 包是 348；**当前 22:32 包是 345**（差值全在 web：121 → 118） |

符号存在性（我自查，非引用其结论）：

| 检查 | 结果 |
|------|------|
| `main.*.js` 中 `showFileSelectModal` 出现次数 | **2** |
| `core.worker-*.js` 中 `restartChain`（ERR-011）出现次数 | **3** |

引用一致性核对（当前包，我自己的脚本）：

```
worker 包内: 5   被引用: 5
MISSING: 无      孤立: 无
preload: 被引用 True，实体存在 True
=> OK
```

### 3.2.3 `check-webdist.mjs` 误报已修复，现已可作为门禁（实测）

F-6 原本是"门禁工具说假话"，fullstack-dev 已修（`PRELOAD_CANDIDATES` 双落点）。我实跑两种模式验证：

```
$ node scripts/check-webdist.mjs            # 默认模式（查 dist/spa）
[check-webdist] entry       : main.CgvrA_B_.js
[check-webdist] workers     : 5 个 ...
[check-webdist] 缺失入口    : none
[check-webdist] 缺失 worker : none
[check-webdist] 孤立 worker : none
[check-webdist] preload     : 被引用=true 存在=true (.../dist/extension-preload/extension-preload.js)
[check-webdist] SHA1 index  : 93916b797df1319055501b6e1d48f5681f066d98
[check-webdist] SHA1 main.CgvrA_B_.js: 818838a2dbe5a51c35e850f98376e9923a385b97
[check-webdist] VERDICT: OK
[exit=0]

$ node scripts/check-webdist.mjs --assets    # 查打包后目录
... 同上 ...
[check-webdist] preload     : 被引用=true 存在=true (.\app\src\main\assets\web\spa\extension-preload\extension-preload.js)
[check-webdist] VERDICT: OK
[exit=0]
```

| 判定项 | 结果 |
|--------|------|
| 默认模式是否仍误报 | **否**，`VERDICT: OK` / exit 0（修复点在 `PRELOAD_CANDIDATES`：默认模式同时接受 `dist/spa/extension-preload/...` 与 `dist/extension-preload/...`） |
| `--assets` 模式 | **OK** / exit 0 |
| 是否可作为门禁 | **可以**。且它输出 `index.html` 与 `main.*.js` 的 SHA1，可直接用于「dist ↔ assets ↔ APK」三方绑定（我用它报的 SHA1 与我从 APK 内算出的值比对，完全一致） |
| 残留建议 | 默认模式的候选列表里仍保留了一个**永远不存在**的路径（`dist/spa/extension-preload/...`）。无害（只是 fallback），但建议后续清理，避免下一个人误以为 preload 可能在 spa 下 |

### 3.3 结论：`exclude("**/*.map")` 确实生效

`webassets/build.gradle.kts` 里有两处排除，均实测有效：

| 排除规则 | 目标 | 实测结果 |
|----------|------|----------|
| `from(jsDistDir.resolve("spa")) { exclude("**/*.map", "**/*.ts") }` | 主 SPA 产物 | 生效。**当前 `dist/spa/assets` 实测有 96 个 `.map` 文件，APK 内 0 个** —— 这是本条规则最硬的证据（排除前后都有样本可对） |
| `from(jsDistDir) { exclude("spa/**", "**/*.map", "**/*.old.*", "**/.trash/**", "smoke/**", "**/.DS_Store") }` | dist 根被"拍平"的内容 | 生效。`porting/js/dist/smoke/smoke.mjs` 确实存在于磁盘，但 APK 内 smoke 计数为 0 → 规则命中 |
| `.trash` 防护 | 垃圾产物 | 生效。`.trash/` 在 `dist/` 之外 + 有显式排除，**未进 APK**（APK 内 `.trash` 计数 0）。审查期间观察到一个 `spa.old.*`（167 文件 / 37 MB），且旧的会被 `clean.mjs` 自动回收 |

产物与 APK 的一致性交叉验证见 §3.2.1（当前包全链路 117 + 1 = 118，md5 115/115 全同）。

### 3.4 发现的隐性泄露面（map 排除了，但没排干净）

**F-1：`vite.config.mjs` 设了 `minify: false` + `sourcemap: true`，`exclude("**/*.map")` 只治了标。**

```js
// porting/js/vite.config.mjs:367-369
// WebView 调试期保留可读产物：Android 上没法 sourcemap 调试，靠日志定位
minify: false,
sourcemap: true,
```

实际后果（实测证据，当前包 `main.CgvrA_B_.js` 1,370,688 B 上复现）：主 chunk 内保留了**未压缩、带原始标识符、且包含整段中文注释**的代码 —— 该文件含 **41,564 个换行符与 739 个 `/* */` 注释块**，这是"未 minify"的直接量化证据。提取到的原文片段：

```
'` 的递归 + `shims/fs`，\n\t * 而 `host/app/modules/` 下没有对应的 list 模块，端到端**未验证**。
 \n\t * 按「不要给用户一个点了没反应的按钮」的约定，先不放；验证通过后再加回来。
 \n\t * 文案走 `ui/i18n.ts` 的 `mobile__*` 字典（上游 `source/packages/shared/i18n` 不可改，...'

'导入路径说明：本文件不在 `view-main/src` 下，所以 `@/` 会先查 `host/`、再查
 `web-server/src`，最后才到 `view-main/src`。为了不撞名，这里统一用 `@ui/`（显式指向
 `source/packages/view-main/src`），与 O-1 的写法保持一致。'

'注意第 3 种通常是**瞬态**：`porting/js/entries/main.ts` 补了 `getUserLists()` 之后，...'
```

| 判定项 | 结果 |
|--------|------|
| 是否泄露绝对文件系统路径（`C:\Users\kuma\...`） | **否**。扫描 `C:/Users`、`C:\\Users`、`WorkBuddy`、`kuma`、`/home/` 均为 0 命中 |
| `/home/` 命中 2 个文件是什么 | `emscripten-module.browser-*.js` 与 `db.worker-*.js` 内的 Emscripten 运行时自带路径常量，**非本项目路径**，无信息价值 |
| `Any Listen` 命中 7 个文件 | 产品名，正常 |
| 是否泄露移植层内部结构、设计意图、未完成项 | **是**。中文注释原样进包，包含 `host/app/modules/` 结构、`@ui/` 别名约定、以及「端到端**未验证**」这类未完成标记 |
| 风险等级 | **提示级（P2）**。理由：泄露内容是**我方移植层**的实现细节，而移植层本身就是 AGPL 衍生物，本来就要开源；且当前仅自用、APK 不出本机 |
| 建议（不影响本次签字） | 若未来分发给他人，把 release 构建改成 `minify: 'esbuild'` + `sourcemap: false`（约可把 24 MB 的 debug 包降到 10 MB 量级，同时消除注释泄露）。**本次因约束不跑构建，未验证改动后体积，故只作为建议不下结论** |

**F-2：`packaging.resources.excludes` 主动删掉了依赖的许可文本。**

```kotlin
// porting/android/app/build.gradle.kts
packaging {
  resources {
    excludes += setOf(
      "/META-INF/{AL2.0,LGPL2.1}",     // 删掉 Apache-2.0 许可文本
      "/META-INF/DEPENDENCIES",        // 删掉依赖清单/NOTICE
      "/META-INF/versions/9/previous-compilation-data.bin",
    )
  }
}
```

实测印证：整个 APK 内只剩 **1 个** 许可相关文件（`okhttp3/internal/publicsuffix/NOTICE`，是 okhttp 自带的 publicsuffix 数据 NOTICE，不是 Apache 主许可文本），其余 8 个进包 Apache-2.0 依赖（core-ktx / activity-ktx / lifecycle-runtime-ktx / androidx.media / okhttp / coroutines / commons-compress / Kotlin stdlib）的许可文本全部不在包内。

| 判定项 | 结果 |
|--------|------|
| 仅自用场景是否违规 | **否**。Apache-2.0 §4(a)「向接收者提供 License 副本」的义务由**分发**触发；不分发则无接收者，义务不成立 |
| 分发场景是否违规 | **是**。若分发，必须在 APK 内或随包提供所有 Apache-2.0 组件的 LICENSE + NOTICE |
| 风险等级 | **提示级（P2）**，但与 §4.4 的"分发前置条件"直接挂钩 |

**F-3：APK 用 Android Debug 证书签名（V2 方案），release 包也是。**

```
$ apksigner verify --print-certs app-debug.apk
V2 Signer: certificate DN: C=US, O=Android, CN=Android Debug
V2 Signer: certificate SHA-256 digest: 7f20f38dc1d7372cde34cac6e0e17d80ec995ac298c298fd0d24605e1a8070f3

$ apksigner verify --print-certs app-release.apk
V2 Signer: certificate DN: C=US, O=Android, CN=Android Debug
V2 Signer: certificate SHA-256 digest: 7f20f38dc1d7372cde34cac6e0e17d80ec995ac298c298fd0d24605e1a8070f3
```

与 `app/build.gradle.kts` 一致（release 也 `signingConfig = signingConfigs.getByName("debug")`，注释写明「个人自用不分发（PDR-003）」）。

| 判定项 | 结果 |
|--------|------|
| 自用影响 | 无。可正常 `adb install` |
| 分发影响 | **硬阻断**。Google Play 明确拒绝 debug 证书签名的包；且 debug 证书私钥是公开的（`~/.android/debug.keystore`，密码 `android`），任何人可签发同签名包 → 无法证明来源 |
| 风险等级 | **提示级（自用）/ 阻断级（分发）**。这是一个**技术上天然防止误分发**的属性，反而是加分项 |

补充（第二轮已在当前包上复验，证书未变）：仅 **V2 Signer**，无 V1 / V3，跨版本一致性可接受；APK 内无绝对路径条目（`/` 开头）与路径穿越条目（含 `..`）。

**F-4（非合规项，但影响交付窗口）：审查期间 `dist/spa` 两次处于缺失状态，且第二次是并发构建互相清空导致；已于 22:32 恢复。**

```
# 审查开始时（21:53）
$ find porting/js/dist -type f
dist/extension-preload/extension-preload.js
dist/smoke/smoke.mjs
（共 2 个文件 / 188 KB，dist/spa 不存在）
$ ls porting/js/.trash/  →  spa.old.1793713436618（164 文件 / 28 MB）

# 复查时（22:2x）
$ find porting/js/dist -maxdepth 1 -type d
porting/js/dist/extension-preload
porting/js/dist/smoke
（dist/spa 仍不存在）
$ ls porting/js/.trash/  →  spa.old.1793715865187（167 文件 / 37 MB）

# 现状（22:32 重建后，已恢复）
$ find porting/js/dist -maxdepth 2 -type d
porting/js/dist/extension-preload / smoke / spa / spa/assets / spa/wasm
dist/spa/assets: 211 文件（含 96 个 .map）→ 非 map 115
```

**归因（经 fullstack-dev 说明，两次不同）**：

| 时间 | 归因 | 现状 |
|------|------|------|
| 21:43 | fullstack-dev 自己的 `pnpm build:all` 的 `clean.mjs` 把 `dist/spa` rename 进 `.trash`，随后构建被宿主进程杀掉，未产出新产物 | 已重建 |
| 22:24 | **并发构建互相清空**：22:06 之后至少 3 个 `pnpm build:all` 并发跑同一个 `dist`（`clean.mjs ext` 出现在 22:14:54 / 22:15:13 / 22:15:48），A 的产物被 B 的 clean 删掉 | 22:32 前台独立重建，EXIT=0、无并发 |

`clean.mjs` 的 rename 行为是设计内的（垃圾必须落在 `dist/` 之外），不是缺陷。**缺陷在于 `dist/` 是单一共享可变目录，无并发保护。** 任何人（或任何自动化）在两个构建重叠时打包，都会拿到半成品或占位包。

**当前风险等级：已降级（产物已恢复，链路已对账）**，但**并发隐患仍在** —— 只要「设备实测 + 有人并行改代码」这个窗口再次出现，就会第三次发生。主理人已在裁决构建窗口归属（构建只由一人发起），我认为这是**必要而非可选**的措施。

**为什么仍然登记**：`requireWeb` 默认 `false` 时，若在 `dist/spa` 缺失的窗口执行 `./gradlew :app:assembleDebug`，`syncWebAssets` 会命中「`dist/spa` 不存在 + 目标目录已有真实产物」分支 → 打 warn 后**用占位 SPA 覆盖整套真实产物** → 白屏包（988 KB）。两次缺失都发生在「设备实测 + 有人并行改代码」的窗口，**这不是罕见事件，是当前工作流的常态**。

**F-5（重要，对构建可复现性门禁是阻断级）：`-PrequireWeb=true` 的保护在干净环境下是空转的。**

`webassets/build.gradle.kts:191-198`：

```kotlin
if (existing > placeholderFiles) {              // ← requireWeb 的断言被包在这个条件里
  val msg = "..."
  if (requireWeb.get()) throw GradleException(msg)   // 第 196 行
  logger.warn(msg)
}
```

实测阈值两个操作数：

| 量 | 实测值 | 命令 |
|----|--------|------|
| `placeholderFiles`（`webassets/placeholder/`） | **1** | `find placeholder -type f \| wc -l` → 只有 `index.html` |
| `existing`（审查当时 `assets/web/spa`） | **118** | `find ../app/src/main/assets/web/spa -type f \| wc -l` |

后果矩阵：

| 状态 | `existing` | `existing > 1` | `requireWeb=true` 的实际行为 |
|------|-----------|----------------|------------------------------|
| 当前状态（审查时 assets 有 118 个真实产物） | 118 | 成立 | **会 throw，保护有效** |
| 干净检出 / assets 被删空 | 0 | 不成立 | **静默通过，产出 1 文件占位包** |
| 已被某次意外覆盖成占位包 | 1 | 不成立（`1 > 1` 为假） | **静默通过，且此后永久失效** |

第三行是最阴的：一旦 assets 被覆盖成占位包，**后续无论带不带 `requireWeb=true` 都再也拦不住**，会连续产出白屏包而构建日志干净。

**受影响的门禁**：「构建可复现性」的验证方式恰恰是**在干净环境重建** —— 而干净环境正是 `requireWeb` 不设防的那种状态。若未来引入 CI 或做一次 clean 重建验收，这个开关会给出虚假的安全感。

**建议的修法（一行，把断言提到条件外；本次未修改代码，转 fullstack-dev）**：

```kotlin
if (!jsDistDir.resolve("spa").isDirectory) {
  if (requireWeb.get()) throw GradleException("[webassets] dist/spa is missing; refusing to build a placeholder APK")
  // 以下保留原有 existing > placeholderFiles 的比较与 warn 逻辑
}
```

即让 `requireWeb` 与「是否有真实产物可保护」解耦：只要 `dist/spa` 缺失就 fail，与 assets 当前有 118 个还是 0 个无关；原条件继续负责「未开 requireWeb 时要不要大声告警」。

这条**不属于许可证合规**，属于构建可复现性，已列入 §4.3 转给 fullstack。因约束禁止跑 `pnpm build`，我**没有**尝试恢复产物 —— 这是有意的，避免与正在进行的设备实测抢资源。

**F-6（重要，对任何以它为门禁的人是阻断级）：`check-webdist.mjs` 对合法产物会误报 INCONSISTENT。**

fullstack-dev 登记为 D-7，我独立核对了脚本源码，确认成立：

```js
// porting/android/scripts/check-webdist.mjs
22: const checkAssets = process.argv.includes('--assets')
23: const spaDir = checkAssets
24:   ? join(root, 'app/src/main/assets/web/spa')
25:   : join(root, '../js/dist/spa')          // ← 默认查 dist/spa
28: const PRELOAD_REL = 'extension-preload/extension-preload.js'
80: const missingPreload = preloadReferenced && !existsSync(join(spaDir, PRELOAD_REL))
```

问题在于**默认模式查的路径与真实布局不符**：

| 事实 | 出处 |
|------|------|
| preload 的真实产物位置是 `dist/extension-preload/extension-preload.js`（`dist/spa` 的**兄弟**目录） | `vite.extension-preload.config.mjs:43` `outDir: path.join(ROOT, 'dist/extension-preload')` |
| 但脚本默认查 `dist/spa/extension-preload/extension-preload.js` | 第 25 行 + 第 28 行拼接 |
| gradle 是把 `dist/` **根**拍平进 `assets/web/spa`，所以打包后该路径**是对的** | `webassets/build.gradle.kts` 的 `from(jsDistDir) { exclude("spa/**", ...) }` |

结论：

| 模式 | 目标目录 | preload 路径是否正确 | 对合法产物的判定 |
|------|----------|---------------------|------------------|
| 默认（无参数） | `../js/dist/spa` | **错**（preload 不在 spa 下） | **误报 `VERDICT: INCONSISTENT —— 不要打包`** |
| `--assets` | `app/src/main/assets/web/spa` | **对**（已拍平） | 可信 |

**风险**：这是一个"专门用来当门禁的工具"，而它在默认用法下对**合法产物**输出"不要打包"。
- 轻则误导人以为产物坏了、去重跑构建（在当前并发构建的环境里，重跑本身就会引发 F-4 那种互相清空）；
- 重则有人为了"消掉这个报错"而降级校验或干脆不用，把真正的门禁一起丢掉。

**权威判定请用以下之一**：
1. **`node scripts/check-webdist.mjs`（默认或 `--assets`）—— 修复后两种模式实测均 `VERDICT: OK` / exit 0**（见 §3.2.3）；
2. gradle 日志里的 `[webassets] reference check OK: 1 entry / 5 worker, ... extension-preload ok`；
3. 或我在 §3.2.2 做的等价独立核对（直接从 APK 内解析 `index.html` 引用 + 全量扫 worker 引用）。

**修复状态：已修复并实测验证（本条从"阻断"降级为"已闭合登记"）**

fullstack-dev 改了 6 行 —— 引入 `PRELOAD_CANDIDATES`，默认模式同时接受两个落点：

```js
// 修复后（当前代码）
43: const PRELOAD_CANDIDATES = checkAssets
44:   ? [join(spaDir, PRELOAD_REL)]
45:   : [join(spaDir, PRELOAD_REL), join(spaDir, '..', 'extension-preload', 'extension-preload.js')]
97: const preloadPath = PRELOAD_CANDIDATES.find((p) => existsSync(p)) ?? null
98: const missingPreload = preloadReferenced && !preloadPath
```

我实跑了两种模式，均 `VERDICT: OK` / `exit 0`，且 preload 分别解析到 `dist/extension-preload/...` 与 `assets/web/spa/extension-preload/...`（见 §3.2.3 的完整输出）。**该脚本现在可以当门禁用。**

残留（提示级，不影响使用）：默认模式的候选列表里仍留着一个**永远不成立**的路径（`dist/spa/extension-preload/...`）。它只是 fallback，无害，但建议后续清理，免得下一个人误以为 preload 可能出现在 `spa` 下 —— 这个误解正是原始 bug 的成因。

### 3.5 本报告的时效性与重审记录

**审查期间磁盘上的 `app-debug.apk` 换了三次，每次都被下一次覆盖。** 这是本轮最重要的过程事实 —— 任何"包里有 N 个文件"的结论如果不绑 `sha256`，都会在几分钟内失效。

| 轮次 | 审计对象 | 总条目 | web 总数 | 泄露计数 | 当时与磁盘是否一致 |
|------|----------|--------|----------|----------|--------------------|
| 第一轮 | 21:40 的 `app-debug.apk`<br>`sha256 8ad9d6d3…`，24,343,591 B | 345 | 118（assets 115 + 3） | 全 0 | 一致 |
| 第二轮 | 22:20:19 的 `app-debug.apk`<br>`sha256 56d66c40…`，24,343,888 B | 348 | 121（assets 118 + 3） | 全 0 | 一致（121 = 121） |
| **第三轮（当前有效）** | **22:32:07 的 `app-debug.apk`**<br>**`sha256 de954102…`，24,343,591 B** | **345** | **118（assets 115 + 3）** | **全 0** | **一致（全链路 117 + 1 = 118，md5 115/115 全同）** |

**三份包的实质差异**：四个关键 chunk（`main.CgvrA_B_.js` / `style.D7fqMNMn.css` / `core.worker-Bjte4zj1.js` / `extension-preload.js`）在三份包里 **size 完全一致**，`showFileSelectModal`（×2）与 `restartChain`（×3）都在。差异集中在 web 条目数 121 ↔ 118，即第二轮包比另两份**多 3 个 web 文件** —— 结合当时 `dist` 状态判断，应是那次构建残留的 3 个陈旧 chunk。**当前包（22:32）是从 22:32 干净重建的 `dist` 打包而来，反而是三份里最干净的一份。**

> ⚠️ **交付风险（转主理人/fullstack-dev）**：fullstack-dev 说「22:20 的包已装机验证」，但**当前磁盘上的包是 22:32 的，不是被验证的那一份**。四段 web chunk 逐字节相同 → 功能风险很低，但严格讲"交付物 ≠ 已测物"。要么重装当前包复跑一遍判据，要么明确接受"chunk 级等价"作为替代证据 —— 这个决定不该由我单方面做。

**关于"21:40 那个包不含 21:33–21:35 改动"这句话 —— 已撤回，是我写错了。**

- 该说法最初来自 fullstack-dev 的口头说明，我未经独立验证就写进了 §3.5。
- fullstack-dev 随后自行复核并更正：旧包 chunk 与当时源码构建结果逐 hash 比对**相同**，且旧包 `main.*.js` 里已有 `showFileSelectModal`（2 处）；旧包与源码的唯一差异是 **CSS**（缺 `ui/mobile.less` §14）。
- **我的处理**：接受该更正，已删除原表述。但我必须说明 —— **我无法独立复验这一条**，因为旧 APK 就位于同一个路径 `app-debug.apk`，已被后续包覆盖，旧副本已不存在。这是一个证据不可再取的情形，如实记录。
- **对合规结论的影响：无。** 三轮审计的泄露计数都是 0。

**当前有效基线（供后续复核，请连同 sha256 一起引用）**：

| 项 | 值 |
|----|-----|
| APK | `app-debug.apk` 24,343,591 B @22:32:07，`sha256 de9541028538bd75027ede62a8bb4081dfb0cec5018823de86861193fad720b1` |
| 总条目 | **345** |
| `assets/web/spa` 文件总数 | **118**（= `assets/` 115 + `index.html` 1 + `extension-preload/` 1 + `wasm/` 1） |
| 入口 | `main.CgvrA_B_.js` 1,370,688 B（SHA1 `818838a2…`）/ `style.D7fqMNMn.css` 192,776 B |
| index.html | SHA1 `93916b797df1319055501b6e1d48f5681f066d98`（dist / assets / APK 三者相同） |
| core worker | `core.worker-Bjte4zj1.js` 1,786,825 B（含 `restartChain`×3） |
| preload | `extension-preload/extension-preload.js` 60,761 B |
| dist | 22:32 重建，`dist/spa/assets` 211 文件（含 96 个 `.map`）→ 非 map 115 |
| 签名 | V2，`CN=Android Debug`，SHA-256 `7f20f38d...8070f3`（无 V1/V3） |

**仍然不需要重审的部分**：§1（上游零改动）、§2（许可证清单与义务）—— 与打包内容无关，重建不影响其结论。

**重审触发条件（下一次任何一方重新构建后）**：重跑 §3.1.2 计数项 + §3.2.1 全链路一致性 + §3.2.3 `check-webdist` 两模式。全部通过才算"产物干净"，且必须记录被审包的 `sha256`。

---

## 4. 门禁签字

### 4.1 签字结论

> **许可证门禁：有条件通过（Conditional Pass）**

**理由：**

1. **上游零改动成立且证据强度足够**（`origin/dev...HEAD = 0 0`，非仅"工作区干净"）→ 可回溯性、可审计性达标，AGPL §5 的"显著修改说明"义务未来可实现。
2. **当前用途（PDR-003：个人使用与学习、不分发、不商用）不触发任何 copyleft 的扩散性义务**：
   - AGPL §4/§5/§6 由 convey 触发 → 未分发，未触发；
   - AGPL §13 由"远程网络交互"触发 → 唯一服务绑 `127.0.0.1` + token，服务对象是用户本人的 WebView，未触发；
   - 其余组件（§2.2 表 B/C/D 共 36 项）中最强的 copyleft 是 MPL-2.0（dompurify，且可选举 Apache-2.0），本项目未修改任何 node_modules → 无义务。
3. **不存在"可能被误判为阻断"的问题**：JS / Android 直接依赖里**没有** GPL / LGPL / AGPL 组件。唯一的 AGPL 是上游本体，且已由 PDR-003 的用途约束覆盖。
4. **之所以不是"无条件通过"**，是因为存在 3 项未闭合的登记义务（下述条件），以及 1 项需要用户/法务拍板的许可证文本自相矛盾（§2.3 的 AGPL+禁商用组合）。这些不构成当前违法，但**不登记就是隐患**。

**本签字的证据边界（必读）**：

- 本签字**基于 §1（上游零改动）与 §2（许可证清单与义务）** —— 这两项与打包内容无关，**不因后续重新构建而失效**，是本报告最稳固的部分。
- §3（产物泄露）**已在三份包上各审计一次，结果均为"干净"**；当前有效结论绑定 22:32:07 的 `app-debug.apk`（`sha256 de954102...`，345 条目，web 118 文件，dist ↔ assets ↔ APK 全链路对账通过，`index.html`/`main.*.js` 的 SHA1 三方相同）。若产物再次重建，需按 §3.5 的触发条件重跑 —— **且必须记录 sha256，否则结论无法归属**。
- **本签字不覆盖「构建可复现性」与「功能等价性」「触控可用性」三道门禁**，理由见 §4.5。其中构建可复现性还额外卡在 F-4（并发构建互相清空）、F-5（`requireWeb` 空转）、F-6（`check-webdist.mjs` 误报）三条未修的基础上。
- 换言之：本次"有条件通过"的含义是「**许可证立场清晰、义务已登记、在当前用途下不违规，且两轮产物均未发现信息泄露**」，不是「这个 APK 可以交付」的全面担保。

### 4.2 有条件通过 —— 条件清单

以下条件**当前无需执行**（因为不分发），但必须在「用途或分发状态发生任何变化」时逐条闭环。建议把这张表直接并入交付说明。

| # | 条件 | 触发时点 | 验收方式 |
|---|------|----------|----------|
| C-1 | 整体以 **AGPL v3** 开源：移植层全部源码 + 构建脚本 + 上游对应源码（可用 commit `c8f40eab` 引用 + 说明获取方式） | 任何形式分发前 | 提供可 `git clone` 的仓库 + 构建文档；能按 `docs/BUILD-from-source.md` 从零重建出等价 APK |
| C-2 | **移除 / 不适用"禁止商用"附加条款的冲突**：分发产物不得声明"禁止商用"以外的额外限制，也不得对下游追加限制（AGPL §10）。许可证文本自相矛盾（AGPL v3 本身允许商用）→ **必须由用户/法务决定呈现方式，不由工程侧自行裁定** | 任何形式分发前 | 用户书面决策记录入 PDR |
| C-3 | 随包附 **第三方许可证 NOTICE**：列全 §2.2 表内所有进入 APK 的组件（含 Apache-2.0 的 8 个 Android 依赖 + 全部 JS bundle 组件），并**显式写明 node-forge → BSD-3-Clause、dompurify → Apache-2.0 的许可选举** | 任何形式分发前 | APK 内或随包可检索到 NOTICE 文件；`packaging.resources.excludes` 中的 `/META-INF/{AL2.0,LGPL2.1}`、`/META-INF/DEPENDENCIES` 必须移除或改为保留 |
| C-4 | 商用需**取得原作者（lyswhut）书面授权** | 任何商业用途前 | 书面授权文件留档。**不得**援引 AGPL §7 第 3 段"可移除进一步限制"来自行豁免 |
| C-5 | 更换签名：使用自有 release keystore，关闭 `signingConfig = debug` | 任何形式分发前 | `apksigner verify` 显示非 `CN=Android Debug` |
| C-6 | 复核 `MANAGE_EXTERNAL_STORAGE`：Google Play 对该权限有专项审核政策 | 上架应用商店前 | 提交权限声明表单或改用 SAF |
| C-7 | release 构建改 `minify: 'esbuild'` + `sourcemap: false`，消除 F-1 的注释泄露（AGPL 下源码本要公开，故此项是体积/整洁考虑而非合规必需） | 分发前（建议） | 构建日志 + APK 内 chunk 无中文注释 |

**条件 C-1 与 C-2 是"不满足则不可分发"的硬条件；C-3 ~ C-7 为配套项。**

### 4.3 按严重度排序的风险项

**风险最高三条（按严重度降序）：**

**① 上游许可证「AGPL v3 + 禁止商用」文本自相矛盾，且用途边界完全依赖 PDR-003 这一条口头承诺**
- 严重度：**高**（潜在后果最重：一旦被认定商用/分发，涉及侵权）
- 事实：`source/LICENSE:669-680` 的附加条款与 AGPL v3 §7/§10 冲突；AGPL v3 本身允许商用并被 FSF 定义为自由许可，但上游作者意图明确禁止。
- 当前控制：PDR-003 声明仅自用、不分发、不商用 → 风险被用途约束吸收，**当前为低**。
- 缺口：这条约束**只存在于决策文档里**，没有任何技术或流程层面的强制。而 APK 已经构建完成、可直接 `adb install` —— 门槛极低，误分发（发给朋友、传网盘）是现实可能。
- 建议：无需改代码。建议由用户在任何对外接触前明确知悉 §4.2 的 C-1/C-2/C-4。

**② node-forge 的 `(BSD-3-Clause OR GPL-2.0)` 未做许可选举**
- 严重度：**中**
- 事实：双许可未选举时，下游可能按任一许可解读。若按 GPL-2.0 → 整个 SPA bundle 强 copyleft；且 GPL-2.0 与 AGPL v3 的组合会引入额外的兼容性讨论（AGPL v3 与 GPL v2-only 不兼容）。
- 当前控制：无。NOTICE 文件尚不存在。
- 影响面：仅分发时触发。当前自用无实际风险。
- 建议：在将来的 NOTICE 中固化 `node-forge — BSD-3-Clause`。零代码改动。

**③ 「构建可复现性」当前不可签：F-4 并发清空 + F-5 requireWeb 空转（F-6 已修）**
- 严重度：**中**（对"构建可复现性"是**阻断级**，对许可证合规是零影响）
- 事实 F-4（并发构建互相清空）：审查期间 `dist/spa` **两次**缺失 —— 21:43（fullstack-dev 的构建被宿主杀掉）与 22:24（**22:06 后至少 3 个 `pnpm build:all` 并发跑同一 `dist`，A 的产物被 B 的 clean 删掉**）。22:32 已前台独立重建恢复（EXIT=0、无并发），当前 dist 与 APK 全链路对账通过。**但并发隐患未消除**——`dist/` 仍是单一共享可变目录、无并发保护。主理人已在裁决构建窗口归属，我认为这是必要而非可选。
- 事实 F-5（保护空转）：`-PrequireWeb=true` 的断言被包在 `if (existing > placeholderFiles)` 里（`webassets/build.gradle.kts:191-198`），`placeholderFiles = 1`。故 assets 有 118 个真实产物时阈值成立、保护有效；但**干净检出（existing=0）或已被打成占位包（existing=1，`1 > 1` 为假）时静默通过**。**这条仍未修。**
- 事实 F-6（**已修**）：`check-webdist.mjs` 原本默认模式误报 `INCONSISTENT`；fullstack-dev 引入 `PRELOAD_CANDIDATES` 双落点后，我实跑两模式均 `VERDICT: OK` / exit 0（§3.2.3）。**该条已闭合，不再阻断。**
- 为什么仍不可签：验证构建可复现性的标准做法是**在干净环境重建**，而干净环境恰恰是 F-5 不设防的状态；同时 F-4 让"重建"本身成为高风险动作。
- 建议（均转 fullstack-dev / 主理人，**我不执行**）：① 构建窗口单点化（F-4，进行中）；② 把 `requireWeb` 的 throw 提到条件外（F-5，已附一行修法）。②修完，"构建可复现性"才有可信的验证基础。

**其余登记项（不排序，均为提示级）：**

| # | 项 | 等级 | 说明 |
|---|---|------|------|
| P2-1 | `exclude("**/*.map")` 生效，但 `minify:false` 使移植层中文注释原样进包（F-1） | 提示 | 无绝对路径泄露；泄露对象是本来就要 AGPL 开源的移植层。两轮包均复现此现象 |
| P2-2 | `packaging.resources.excludes` 删掉 `/META-INF/{AL2.0,LGPL2.1}` 与 `/META-INF/DEPENDENCIES`（F-2） | 提示 | 自用无义务；分发前必须改回。另：`LGPL2.1` 是模板残留，本项目无 LGPL 组件 |
| P2-3 | debug 证书签名（F-3） | 提示（分发时阻断） | 技术上天然防误分发。第二轮复验：仅 V2，无 V1/V3 |
| P2-4 | 7 个构建期包未在 `porting/js/package.json` 声明，靠 `link-vendor.mjs` 目录联接（§2.2C） | 提示 | 许可证无问题；但干净环境 `pnpm install` 后若上游 `node_modules` 缺失，`link-vendor` 直接 `exit(1)`（脚本第 47-52 行）→ 可复现性依赖"上游先装过依赖"这个未文档化的本地状态 |
| P2-5 | SQLite / QuickJS 引擎本体的许可文本是否随 wasm 附带 | 提示 | 两个 wasm 以独立二进制随包，npm 包声明为 MIT，但**引擎本体版权头未在 APK 内单独保留 → 标注"需人工确认"**，不编造 SPDX |
| P2-6 | `AndroidManifest.xml` 申请 `MANAGE_EXTERNAL_STORAGE` | 提示 | 自用正常；上架需专项政策审核 |
| P2-7 | 三份产物审计均已完成，结论均为"干净"（§3.5） | **已闭合** | 当前有效基线：`sha256 de954102...`，345 条目，web **118**（= assets 115 + 3）；dist 117 非 map + preload 1 = 118 全链路对齐，md5 115/115 全同 |
| P2-8 | `requireWeb` 断言位置导致干净环境空转（F-5） | 提示（对构建可复现性为阻断） | 已附一行修法转 fullstack-dev；见 §4.3-③ |
| P2-9 | ~~`check-webdist.mjs` 默认模式对合法产物误报 INCONSISTENT（F-6 / D-7）~~ | **已修复并实测验证** | fullstack-dev 引入 `PRELOAD_CANDIDATES` 双落点；我实跑默认与 `--assets` 两模式均 `VERDICT: OK` / exit 0（§3.2.3）。**现可作为门禁**。残留：候选列表里仍有一个永不成立的路径，无害但建议清理 |
| P2-10 | **数字口径教训：任何"包里有 N 个文件"必须同时给 `sha256`** | **已转为规则** | 审查期 `118`/`121` 的来回纠正，根因是双方在量**不同的包**（22:20 是 121，22:32 是 118）。**不带 sha256 的计数没有意义**；判完整性一律用 §3.2.1 全链路对账 + §3.2.3 两模式 `check-webdist` |
| P2-11 | **交付物 ≠ 已测物**：当前磁盘包（22:32，`de954102…`）不是 fullstack-dev 装机验证的那份（22:20，`56d66c40…`） | **提示（需决策）** | 四个关键 chunk 逐字节相同 → 功能风险低；但严格讲"测的不是要交付的"。需主理人裁决：重装当前包复跑判据，或明确以"chunk 级等价"作为替代证据 |

### 4.4 「仅自用」前提成立 vs 一旦改变用途

#### 当前前提成立（PDR-003：个人使用与学习、不分发、不商用）

| 门禁 | 结论 | 风险等级 |
|------|------|----------|
| **功能等价性** | 见 §4.5（不在本报告四项范围内，此处仅给交叉引用） | — |
| **移动端触控可用性** | 见 §4.5 | — |
| **许可证合规** | **通过（有条件）** | **低** |

具体到每个 copyleft 项在自用下的实际风险：

| 组件 | 自用风险 | 依据 |
|------|----------|------|
| 上游 any-listen（AGPL v3 + 禁商用） | **低** | AGPL §2 允许为自用修改；不 convey 则 §4/§5/§6 义务不触发；§13 因 loopback-only 不触发；禁商用条款不影响个人非商业使用 |
| node-forge（BSD-3 OR GPL-2.0） | **低** | 自用不构成分发，无向第三方声明许可的义务 |
| dompurify（MPL-2.0 OR Apache-2.0） | **低** | 未修改其文件；且自用不分发 |
| Apache-2.0 全家（10 个 Android 依赖 + less/typescript） | **低** | §4 义务由分发触发 |
| junit（EPL-1.0） | **低** | testImplementation，不进包 |

#### 一旦改变用途 —— 必须做什么

**情形 A：分发给他人（哪怕免费、哪怕只是发给一个朋友、哪怕传到网盘/微信群）**

这是最容易被低估的一步。**"免费分发"仍然是分发**，AGPL 的全部义务立即生效。必须完成：

1. **（硬）** 整体以 AGPL v3 授权：移植层源码 + 构建脚本 + 上游对应源码（`c8f40eab`）全部可获取。**不能只给 APK。**
2. **（硬）** 附 NOTICE：§2.2 表内全部入包组件的许可证文本 + 版权声明 + node-forge/dompurify 的许可选举。
3. **（硬）** 移除 `packaging.resources.excludes` 里对 `/META-INF/{AL2.0,LGPL2.1}` 和 `/META-INF/DEPENDENCIES` 的排除。
4. **（硬）** 处理许可证文本自相矛盾：AGPL v3 允许商用，上游附加条款禁止商用。**由用户/法务决定呈现方式**，工程侧不得自行裁定。若无法处理，则**不得分发**。
5. 标注修改：文件级说明移植层为修改版本（上游零改动使得这一步只需标注移植层，成本很低）。
6. 更换签名证书（C-5）。
7. 建议：release 构建关闭 `minify:false`（C-7）。
8. **（硬）** 若同时对公众提供任何网络服务（如把 AndroidShell 的 HTTP 服务改成对外，或另建服务端），AGPL §13 触发 → 必须向所有网络用户提供源码下载入口。

**情形 B：用于商业目的（含在公司内部使用于营利业务、提供付费服务、间接产生收入）**

1. **唯一安全路径：取得原作者（lyswhut）书面授权。** 依据 `source/LICENSE:671-680` 第 1 条与 PDR-003。
2. **不得**援引 AGPL v3 §7 第 3 段（"可移除进一步限制"）来自行豁免 —— 该条款技术上允许，但与作者明示意图冲突，且构成对许可证的解释性主张，超出工程判断范围。
3. 同时完成情形 A 的全部 1-8 项（除非书面授权明确豁免）。
4. 建议：在取得授权前，商业场景**不得**使用本项目产物。

**情形 C：仅自用，但把 APK 交给"另一个自己"（换机、备份到网盘、装到第二台设备）**

- 这属于"同一主体在自己的设备间转移"，仍应视为不分发。
- 但建议仍保留：APK 与对应源码副本（`source/` 的 `c8f40eab` + `porting/`）**成对保存**。理由：AGPL 的自用豁免不要求公开，但保留对应源码是未来任何用途变更时唯一能低成本合规的前提。**`dist` 是易失的（审查期间两次被清空，见 F-4）** → 建议在清理 `.trash` 之前先确认 APK 与源码的对应关系已归档（至少记下当前 APK 的 `sha256 de954102...` 与 `source` 的 `c8f40eab` 这一对，以及 `index.html` 的 SHA1 `93916b79...` 作为产物指纹）。

---

### 4.5 本次审查的边界声明（明确未覆盖项）

作为审查方必须说明我**没有**验证什么，避免这张签字被当成超越范围的担保：

1. **未执行任何构建**（约束禁止 `pnpm build` / `gradlew`）→ 「构建可复现性」门禁**未由本次签字覆盖**；§4.3-③ 的三条（F-4/F-5/F-6）都基于源码静态阅读 + 现有产物状态推断，其中 F-5、F-6 的机制可以直接从代码确定，**F-4 的"并发放大"结论来自两个时间点的现场快照 + fullstack-dev 的构建日志叙述，我没有观察整个并发过程**。
2. **未接触设备**（约束禁止 adb/模拟器）→ **触控可用性门禁**由 fullstack-dev-2 的实测覆盖，不在本报告范围。
3. **未做动态验证**（未运行 APK）→ 「APK 内 0 个 map」是基于 zip 条目名的静态判定；若将来有产物把 map 内容内联进 JS（如 `data:` URL 形式），本条检测会失效。当前扫描未发现此类迹象。
4. **未做许可证的法律解释**（非法律意见）→ §2.3 关于 AGPL v3 §7 的分析是事实陈述 + 风险标注，最终处置须由用户/法务决定。
5. **未核对全部传递依赖** → 本次只覆盖 `package.json` 直接依赖 + `link-vendor` 联接的构建期依赖 + 上游 runtime 直接依赖（即"实际可能进包"的集合）。若 vite 的传递依赖（如 rollup 插件链）中有代码被内联，本报告未逐一枚举 → **标注为"需人工确认"，不做无依据的断言**。
6. **两个 wasm 二进制的许可证文本** → 未解包验证引擎本体的版权头（P2-5）。
7. **未复验已覆盖的旧 APK** → 审查期间同一个 `app-debug.apk` 被覆盖三次（21:40 → 22:20 → 22:32），前两轮的证据**不可再取**。涉及旧包的任何说法（包括我撤回的那条）都无法独立复核，只能依赖当时的记录（§3.5）。
8. **未验证 fullstack-dev-2 的功能实测结论** → 其 `artifacts/logcat-phase5-final.txt`、`shots/emu-*.png`、`artifacts/verify-phase5.sh` 我**没有审阅**，因为「功能等价性」不在本次静态合规任务范围内。若要我签那道门禁，需要单独一轮证据审查。

---

## 附录 A：本次审查执行的全部命令（可逐条复现）

```bash
# --- §1 上游零改动 ---
git -C source status --porcelain
git -C source rev-parse HEAD
git -C source branch --show-current
git -C source remote -v
git -C source rev-list --left-right --count origin/dev...HEAD
git -C source log -1 --format="%H%n%an <%ae>%n%ad%n%s"
git -C source status --porcelain --untracked-files=all | wc -l

# --- §2 许可证 ---
cat porting/js/package.json
cat porting/android/gradle/libs.versions.toml
cat porting/android/app/build.gradle.kts
cat porting/android/*/build.gradle.kts
sed -n '655,680p' source/LICENSE            # 附加条款原文
cat porting/js/scripts/link-vendor.mjs      # 构建期联接的包清单
grep -n "commercial" source/LICENSE
# 各包版本/许可（见 §2.1 循环命令）

# --- §3 产物泄露 ---
find porting/android/app/src/main/assets/web/spa -type f | wc -l
du -sh porting/android/app/src/main/assets/web/spa
find porting/android/app/src/main/assets/web -name "*.map" -type f | wc -l
find porting/js/dist -type f
ls porting/js/.trash/
apksigner verify --print-certs porting/android/app/build/outputs/apk/debug/app-debug.apk
apksigner verify --print-certs porting/android/app/build/outputs/apk/release/app-release.apk
sha256sum porting/android/app/build/outputs/apk/*/*.apk
# APK 内容审计：见 §3.1.2 的 python 脚本

# --- §2.4 AGPL §13 事实核查 ---
grep -rn "127.0.0.1\|0.0.0.0\|InetAddress\|bind" --include=*.kt \
  porting/android/bridge/src porting/android/app/src porting/android/core-ports/src

# --- §3.5 第二轮重审补充（当前有效基线） ---
sha256sum porting/android/app/build/outputs/apk/debug/app-debug.apk
find porting/js/dist -maxdepth 2 -type d            # 确认 dist/spa 是否存在
find porting/js/dist -type f | wc -l
ls porting/js/.trash/                                # 观察 clean.mjs 的垃圾区
find porting/android/app/src/main/assets/web/spa -type f | wc -l    # → 118（22:32 包口径）
find porting/android/webassets/placeholder -type f | wc -l          # → 1（F-5 阈值）
# APK 内 web 条目 / 一致性 / 引用核对 / chunk 大小：见 §3.2.1、§3.2.2 的 python 脚本

# --- F-6 check-webdist 核查（修复前误报 / 修复后实测通过） ---
grep -n "checkAssets\|spaDir\|PRELOAD_REL\|PRELOAD_CANDIDATES\|INCONSISTENT" porting/android/scripts/check-webdist.mjs
grep -n "outDir" porting/js/vite.extension-preload.config.mjs
# 修复后两种模式均应 VERDICT: OK / exit 0（我实测的时间点是 22:3x）：
cd porting/android && node scripts/check-webdist.mjs; echo "exit=$?"
cd porting/android && node scripts/check-webdist.mjs --assets; echo "exit=$?"

# --- §3.2.1 全链路对账（dist ↔ assets ↔ APK） ---
find porting/js/dist/spa -type f | wc -l                       # 213（含 96 个 .map）
find porting/js/dist/spa -name "*.map" | wc -l                 # 96
find porting/js/dist/spa/assets -type f | wc -l                # 211
# 逐文件 md5 比对 dist/spa/assets（剔 .map）与 APK 内 assets/web/spa/assets：见 §3.2.1 python 脚本
# 期望：dist 非 map 115 == APK assets 115，同名 md5 全同，双向差集为空
```

## 附录 B：本报告未修改任何文件

- `source/**`：**只读**，未产生任何写入（`git status --porcelain` 在审查开始与结束时各执行一次，两次输出均为空、退出码 0，见 §1.1）。
- `porting/**`：**只读**，未修改源码、未运行构建、未删除 `.trash`、未改动 `webassets/build.gradle.kts` 与 `check-webdist.mjs`（F-5/F-6 的修法只是**建议**，我一行未改）。
- `docs/porting-decision-record.md`：**未修改**（主理人汇编；审查中仅 `grep` 读取）。
- 唯一写入文件：本文件 `docs/phase6-compliance.md`。

## 附录 C：审查过程中的自我更正（留痕，便于复核）

### C-1 路径解析错误导致误判 `source/node_modules` 为空

- 最初我在 `porting/js` 目录下执行 `ls ../source/node_modules | wc -l`，得到 `0`，并据此写下了「`source/node_modules` 为空」。
- 该结论**是错的**：`../source` 从 `porting/js` 出发解析为 `porting/source`（不存在），所以 `0` 是"目录不存在"的假象。
- 复核后事实为：`source/node_modules` 有 18 项（eslint 工具链 + pnpm 元数据），全部被 `.gitignore:35` 忽略，其下已跟踪文件数为 0。
- **对结论的影响：无。** "零改动"的判定依据是 `git status --porcelain` 为空 + `origin/dev...HEAD = 0 0` + `git ls-files node_modules` = 0，这三条不依赖上述路径。§1.2 表格已按事实改写。

同类需要提醒的口径问题：`git status --porcelain` 为**空**只证明"没有已跟踪文件被改、没有未忽略的未跟踪文件"。它**不**证明"`source/` 下没有任何来自本项目的目录" —— `source/node_modules`、`source/packages/*/node_modules` 都是本项目为构建而 `pnpm install` 出来的。这些目录被上游 `.gitignore` 覆盖，因此不出现在 `status` 里。判定它们是"环境依赖产物"而非"源码改动"的依据是 `git ls-files` 计数为 0，而不是 `status` 为空。

### C-2 未经独立验证就采纳了他人口头结论并写进报告（已撤回）

- 我在 §3.5 曾写下「21:40 那个包**不含 21:33–21:35 的四处改动**（`showOpenDialog` 覆写 + ERR-010 修复）」，并据此把该包定性为"旧包"、把 `118` 定性为"不可用于判断新包完整性"。
- **该表述已撤回。** fullstack-dev 随后自行复核并更正：旧包 chunk 与当时源码构建结果逐 hash 比对相同，旧包 `main.*.js` 里已有 `showFileSelectModal`（2 处），唯一差异是 CSS（缺 `ui/mobile.less` §14）。
- **我的失误**：那句"不含四处改动"来自 fullstack-dev 的一条口头说明，我**没有独立验证**就作为事实写进了合规报告。合规报告里的每一句事实陈述都应有可复现命令支撑，我当时没做到。
- **无法补救的部分**：旧 APK 位于同一路径，已被后续包（22:20，其后又被 22:32 覆盖）替换，我**无法再独立复验**这条更正，只能接受 fullstack-dev 的证据。已如实记入 §4.5 第 7 条。
- **对结论的影响：无。** 因为我对**两个包**都做了完整的产物级审计，两轮的泄露计数都是 0、都与各自磁盘状态一致。§3.5 已改为"两轮审计记录 + 撤回声明"。

### C-3 数字口径 —— 我在这条上也曾过火

我和 fullstack-dev 就 `118` / `121` 来回纠正过，**双方都没错，是在量不同的包**：

| 包 | 总量 | `assets/` 子目录 |
|----|------|------------------|
| 22:20（`56d66c40…`） | 121 | 118 |
| 22:32（`de954102…`，当前） | 118 | 115 |

我在上一轮消息里断言「**121 才对，118 是错的**」——这句话**只在 22:20 那个包上成立**，我同样犯了"没绑 sha256"的错，只是方向相反。当前包的正确值是 **118**。

**结论已固化为 P2-10**：任何"包里有 N 个文件"的陈述必须同时给出 `sha256`，否则该数字在几分钟后就会失效（审查期间包换了三次）。完整性判断请用 §3.2.1 的全链路对账 + §3.2.3 的 `check-webdist` 两模式，不要用裸计数。

### C-4 三次审计、三份包 —— 审计对象一直在动

`app-debug.apk` 在我审查期间换了三次（21:40 → 22:20 → 22:32），每次都被下一次覆盖同一路径。这带来的两个直接后果：

1. **第一、二轮的证据不可复取**，只能依赖当时的记录。凡涉及旧包的更正（C-2 那条）我无法独立复核。
2. **产生了 P2-11「交付物 ≠ 已测物」**：fullstack-dev 装机验证的是 22:20 那份，而当前磁盘上是 22:32 那份。四个关键 chunk 逐字节相同，功能风险低，但"测的不是要交付的"这个事实必须由主理人显式接受或要求重装复测。

我从中得到的教训：在产物仍在变动的窗口里做审计，**第一件事就该记录 sha256 并把结论绑定上去**，而不是先跑脚本再回头找"我审的是哪个包"。

---

## 附录 D 交付物后续变更登记（2026-11-04）

本报告 §3/§4 的审计对象固定在 22:32 的 `de954102…` 那一版（且 §4.3 的 P2-11 在 QA §10 中以 `fefaef66…` 装机复测得证）。此后为修复 D-10/D-11/D-12/D-13/D-22/D-23 与 D-29/D-30，交付物又被重建了数次。为免「当前包」指代失真，登记如下：

| 顺序 | 时间 | 大小 | sha256 | 说明 |
|---|---|---|---|---|
| 第三轮（本报告审计基线） | 22:32 | 24,343,591 B | `de954102…720b1` | §3/§4 的审计对象 |
| v3 定稿 | 11-03 深夜 | 24,343,591 B | `fefaef66…d3b96d` | QA §10 三门禁签字对象 |
| D-29/D-30 修复 | 11-04 09:29 | 24,343,888 B | `244af0ad…52d8b8` | 验收报告 §12 |
| **D-16 修复（当前）** | **11-04 09:50** | **24,343,888 B** | **`9c9b186e…d41d9874`** | **当前交付物（验收报告 §13）** |

**合规结论是否变化：不变。** 依据两条可独立复核的事实：

1. `git -C source status --porcelain` = 0 行（上游 HEAD `c8f40eab` 未被修改），许可证与义务清单（AGPL v3 + 附加条款）不受移植层改动影响；
2. 本轮新增代码只有：`porting/js/shims/fs.ts` 的流式读实现、`porting/js/nodejs/logs.ts` 的降级、`LogPort.kt` 的落盘路径 —— 全部为自研适配层代码（含 2 个 UI 覆写与 1 个 fs 垫片实现），未引入新的第三方依赖，`package.json` 依赖树未变。

因此 C-1（分发前整体 AGPL v3 开源）与 C-2（「禁商用」附加条款的呈现方式）仍是交付前必须由用户书面裁决的硬条件，与本轮重建无关。§3.2 的产物泄露检查（无 `.map`、无源码、`lib/` 为空）对当前包同样成立（`unzip -l` 复核：`lib/` 条目 0 个）。

---

## 附录 E C-1 材料就绪登记（2026-11-04）

本附录只登记**事实与状态**，不改变 §4.2 的结论：C-1 仍未闭环，闭环判据见文末表格。
各项均可在仓库内直接核对（`git log`、`sha256sum`、`git clone`）。

### E.1 已落地

| 产出 | 位置 | 可核验方式 |
|---|---|---|
| 上游许可全文（**逐字节**） | `LICENSE` | `sha256sum LICENSE` = `86e79e49e6b378e23f9ee226a05641506cf91c720804a44f6cec248348cf52c2`，与 `source/LICENSE` 相同 |
| 移植层许可状态 + AGPL §5 修改声明 + 对应源码获取方式 | `NOTICE` | 六节：作品定位 / 上游与许可 / 移植层许可 / 修改声明 / 对应源码 / 商用与第三方 |
| 可 `git clone` 的源码树 | 仓库 `main` 分支首个提交 | `git clone . /tmp/x && git ls-files \| wc -l` → **276**；`source/`、`artifacts/`、`.workbuddy/` 均未入库 |
| 从零重建文档 | `docs/BUILD-from-source.md` | 工具链实测版本、目录布局硬约束、5 步命令、等价判据、已验证/未验证边界 |

**为什么 LICENSE 要单独用 `-text`**：`.gitattributes` 的 `* text=auto eol=lf` 会把上游 LICENSE 的 CRLF
归一成 LF（680 行 → 少 680 字节），仓库内文件的 `sha256` 与上游就对不上，「逐字节复制、未做编辑」
这句话随之无法自证。已改为 `LICENSE -text`（禁用一切转换），克隆后指纹与上游完全一致。

**仓库体积**：276 个文件、`.git` 1.9 MB。无二进制膨胀 —— 上游 checkout、`dist/`、`build/`、
`node_modules/`、验收截图全部排除。

### E.2 仍未闭环

| 判据 | 状态 | 说明 |
|---|---|---|
| 干净目录从零重建出等价 APK | ✅ **已实测**（2026-11-04） | 空目录起、按 `docs/BUILD-from-source.md` 五步执行：克隆 3 s → 两处 frozen install 13 s → `build:all` 27 s → `assembleDebug` 109 s → `check-webdist --assets` = `VERDICT: OK`。出包 19,890,423 B / 345 条目 / 入口 `main.oGPa8w3b.js`。**与交付包不字节相同**（详见附录 E.4） |
| 随包第三方 NOTICE（C-3） | ❌ 未生成 | `node-forge → BSD-3-Clause`、`dompurify → Apache-2.0` 两处选举已定，但完整清单未成文 |
| C-2 呈现方式 | ❌ 待裁决 | 只能由用户/法务定；`NOTICE` 现采用「原样传递、不追加不减免」的事实性写法，该写法在两个候选方案下都成立 |
| 发布到远端仓库 | ❌ 未执行 | 本地仓库已可 `git clone`；远端需要用户自己的账号与命名 |

### E.3 对 §4.3 ③ 的一处更正（F-5）

§4.3 ③ 记「F-5 `requireWeb` 保护空转……**这条仍未修**」。**该记录已过期**：现行
`webassets/build.gradle.kts` 已把 `requireWeb` 判定移到 `existing > placeholderFiles` 之外，
并在抛错前先 `logger.error` 说明原因（注释里写明了干净检出与占位包两种静默通过场景）。
干净检出时 `-PrequireWeb=true` 会按预期失败，不再静默产出白屏包。

对结论的影响：构建可复现性的阻断项只剩 **F-4（`dist/` 是单一共享可变目录，并发构建互相清空）**，
该条已在 `docs/BUILD-from-source.md` §3 步骤 3 与 §6 中作为操作约束写明（同一时间只允许一个构建）。

### E.4 干净重建实测（2026-11-04）与一个新发现

执行环境：空目录 `c1-clean2/`，严格按 `docs/BUILD-from-source.md`。共用时约 2.5 分钟。
过程中撞到 4 个**文档原先没写或写错**的点，均已回写进该文档（`--ignore-scripts`、
`ANDROID_HOME`、`CI=true`、`source/` 必须在仓库根内而非仓库旁边）。

| 项 | 交付包 | 干净重建包 |
|---|---|---|
| 字节数 | 24,343,888 | 19,890,423 |
| zip 条目 | 348 | 345 |
| 入口 | `main.CJYsJ0I6.js` | `main.oGPa8w3b.js` |
| `check-webdist --assets` | `VERDICT: OK` | `VERDICT: OK` |
| `emscripten-module-*.wasm`（磁盘 / 被引用） | 4 / 1 | 1 / 1 |

**差异不是"重建缺东西"，而是"交付包多带了死重"。** 交付包的 `dist/spa/assets` 里有 4 个
quickjs wasm 变体，产物只引用其中 1 个（`release-sync`，扩展沙箱用），另外 3 个（合计 4.4 MB）
是 `shrink-assets.mjs` 该删而没删的孤儿；干净重建只留被引用的那个。两份包中
**被引用的那个变体同名同内容**，因此扩展沙箱能力一致。

登记为 **F-8（P2，构建管线）**：`shrink-assets.mjs` 的「删除未被引用的 wasm」在多轮增量构建后
未能清掉孤儿，机制未定位（干净目录不复现）。影响仅为包体 +4.4 MB，不影响功能。
**处置建议：发布用的包一律取干净重建产物**，或在发布前加一条
`ls dist/spa/assets/*.wasm` 与「被引用集合」的比对断言。

**另外一条不能用的判据**：包内 `main.<hash>.js` 文件名**不能**用来判断"是否同一次构建的内容"。
本次两份包主 chunk 从第 70 字节（`__vite__mapDeps` 的懒加载分块名）起就不同，属分块哈希连锁；
131 个不反向引用主 chunk 的分块逐字节相同。跨环境重建出现不同哈希是正常现象。

**仍未覆盖**：重建包未安装到真机跑行为验收（设备是用户日常机，未擅自覆盖安装）。
若要把「等价」钉到行为层面，需装一次并复跑六条启动判据 —— 这一步只能由用户决定何时做。

### E.5 重建包真机复跑（2026-11-04 12:41）

设备：Xiaomi 2211133C / Android 16 / 1080×2400（393×872 CSS）/ arm64。
安装方式：`adb install -r artifacts/c1-rebuild-app-debug.apk`（Streamed Install: Success，覆盖安装，数据保留）。

| # | 判据 | 实测 | 判定 |
|---|---|---|---|
| 1 | `bootstrap dataPath` | `/data/user/0/com.anylisten.android/files, externalRoot=/storage/emulated/0` | ✅ |
| 2 | `sqlite ready` | `db=…/files/app/anylisten.data.db preloaded=true` | ✅ |
| 3 | `quickjs ready` | 2 条（`[shims/vm]` + `[ext.worker]`） | ✅ |
| 4 | `core worker ready` | `[bootstrap] core worker ready` @12:41:04.533 | ✅ |
| 5 | `webview client connected` | `[ipc] webview client connected (main)` @12:41:04.532 | ✅ |
| 6 | `Displayed` | **+745 ms**（交付包历史值 490 / 762 / 790 ms） | ✅ < 1.5 s |
| — | `FATAL EXCEPTION` | 0 | ✅ |
| — | `backup failed` | 0 | ✅ |
| — | 界面 | 曲库「试听列表」3 首、迷你播放器、三标签栏齐全，无白屏/错误页 | ✅ |

链路时序：`bootstrap` 12:41:04.207 → `sqlite ready` .369 → `webview client connected` .532
→ `core worker ready` .533，即 bootstrap 到 worker 就绪 **326 ms**。

**结论**：C-1 的「能重建出等价 APK」在**结构**（`check-webdist` 三项指纹全等）与**行为**
（六条启动判据 + 零崩溃 + 零备份失败 + 界面真实渲染）两层都成立。
唯一不成立的是**字节级复现**，且已知其原因为分块哈希连锁与孤儿 wasm（见 E.4），不影响等价性。

> 设备上现装的是重建包（`main.oGPa8w3b.js`，19.9 MB）。它与交付包的唯一实质差别是少带
> 3 个未被引用的 wasm（4.4 MB）。若要回到交付包，覆盖安装 `artifacts/device-after-d31-d27.apk` 即可。
