# 从零重建（干净检出）

> 这份文档的唯一目的：**让第三方拿到源码后，能独立重建出等价的 APK**。
> 它是合规条件 C-1 的验收判据（见 `docs/phase6-compliance.md` §4.2）。
>
> **当前状态**：§5 记录了先前版本的干净目录重建；2026-11-04 最新修改已在现有工作区构建和验证，尚未重新执行干净目录重建。

---

## 1. 工具链（实测版本）

| 组件 | 版本 | 说明 |
|---|---|---|
| JDK | 17.0.12 | `jvmTarget = 17`；Gradle 8.14.3 需 JDK 17+ |
| Node.js | v22.22.2 | 上游 `package.json` 要求 `>= 22` |
| pnpm | 10.34.5 | 两个 `pnpm-lock.yaml` 都按 10.x 生成 |
| Android SDK | compileSdk / targetSdk **35**，minSdk **29** | `platforms;android-35` + `build-tools;35.x` |
| Gradle | 8.14.3 | 由 wrapper 自带，无需预装 |
| NDK | **不需要** | 交付包内 `.so` 数量为 0（`unzip -l app-debug.apk \| grep '\.so$'` 为空）。全部原生能力走 WebView / WASM |

`ANDROID_HOME`（或 `porting/android/local.properties` 里的 `sdk.dir`）必须指向 SDK 根目录；
后者由 Gradle 自动写入，已被 `.gitignore` 排除。

---

## 2. 目录布局（硬要求）

`git clone` 得到的是整个仓库；上游要检出到**仓库根目录内**的 `source/`：

```
any-listen-android/            ← 本仓库（git clone 得到的目录）
├── source/                    ← 上游，按 commit 检出；不入库（.gitignore 已排除）
│   └── packages/view-main/…
├── porting/
│   ├── js/                    ← 下文所有 `pnpm` 命令的 ROOT
│   └── android/
└── docs/  LICENSE  NOTICE  README.md
```

**为什么必须在仓库根内**：`porting/js/vite.config.mjs:57` 与 `porting/js/scripts/link-vendor.mjs:29`
都以 `ROOT/../../source` 解析（ROOT = `porting/js`），落点正是 `<仓库根>/source`。
把上游放在仓库旁边（`<父目录>/source`）会解析到仓库根的上一级，两个脚本都会报「找不到 source」。


---

## 3. 步骤

### 步骤 0 · 取上游（固定 commit）

```bash
cd <仓库根>
git clone https://github.com/any-listen/any-listen.git source
git -C source checkout c8f40eab05021735b969e5991e6ec2f2c63e83b8
```

`c8f40eab` 是 `0.10.1-beta.2`（desktop）/ `0.12.1-beta.2`（web-server）的发布提交。
**不要**用 `dev` 分支 HEAD 代替 —— 上游任何接口变动都会让覆写表失效（`OVERRIDES` 的 key
是相对 `source/packages` 的路径）。

### 步骤 1 · 装上游依赖（**最容易漏的一步**）

```bash
cd source && pnpm install --frozen-lockfile --ignore-scripts
```

**为什么带 `--ignore-scripts`**：上游依赖 `better-sqlite3@13`，它装完会跑 node-gyp 编译原生扩展。
在**没有 MSVC 构建工具**的机器上必然失败（实测报 `gyp ERR! find VS`，整个 install 以 exit 1 中断，
后续所有步骤连锁失败）。而这个原生模块**对本移植完全无用**：数据库走 `sql.js`(WASM) + Kotlin
`SqlitePort`，`dist/spa/assets/*.js` 里没有任何 `require('better-sqlite3')`，只有一处字符串残留。
跳过脚本只影响这个用不到的原生二进制，不影响任何被 bundle 的代码。
（有完整 C++ 工具链的机器可以不加；加了也等价。）

**其它前提**：非交互 shell（CI、脚本）里 pnpm 需要 `CI=true`，否则它在重建 `node_modules`
时会以 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 中止。

漏了会这样失败：`porting/js/scripts/link-vendor.mjs` 要把
`source/packages/view-main/node_modules` 目录联接进 `porting/js/node_modules`，
让 UI 层用**上游同一份** `svelte` 编译器（两份 `$state` 实现互不识别 → 响应式失效）。
上游没装 → 联接目标不存在 → 构建期报找不到 `svelte/internal/client`。

### 步骤 2 · 装移植层依赖

```bash
cd ../porting/js && pnpm install --frozen-lockfile
```

### 步骤 3 · 构建 JS 产物

```bash
pnpm build:all
```

约 **17 分钟**（4 个产物：`dist/spa`、3 个 worker、`extension-preload`）。
产物落在 `porting/js/dist/`，已被 `.gitignore` 排除 —— 它是构建产物，不是源码。

⚠️ **构建窗口独占**（F-4）：`dist/` 是单一共享可变目录，`build:all` 开跑先 `clean`。
两个 `build:all` 并发 = A 的产物被 B 删掉，得到空/半截 dist。
**同一时间只允许一个构建**，包括不要让 Gradle 在此时触发它（见步骤 4）。

### 步骤 4 · 打 APK

**先解决 SDK 路径**：`local.properties` 是本地文件、不入库，所以干净检出里**没有**它。
不设 `ANDROID_HOME` 会直接失败（`SDK location not found … porting/android/local.properties`）：

```bash
export ANDROID_HOME=/path/to/Android/Sdk    # Windows: C:/Users/<你>/AppData/Local/Android/Sdk
```

```bash
cd ../android
./gradlew assembleDebug -PrequireWeb=true -PskipWeb=true
```

两个开关各有明确用途，**都要带**：

| 开关 | 作用 | 不带的后果 |
|---|---|---|
| `-PrequireWeb=true` | `dist/spa` 不存在时直接失败，拒绝把占位 SPA 打进包 | 得到一个 988 KB 的白屏包，日志里只有一条容易忽略的 warn |
| `-PskipWeb=true` | 只同步 `dist` 进 assets，不重跑 JS 构建 | `:webassets:syncWebAssets` 依赖 `buildWebJs`，会**再跑一遍** `build:all` → 总耗时 45 分钟 |

产物：`app/build/outputs/apk/debug/app-debug.apk`。

### 步骤 5 · 验证产物是"真的"

```bash
# ① 一致性门禁：dist ↔ assets 逐文件指纹比对（唯一的硬判据）
node scripts/check-webdist.mjs --assets      # 期望 VERDICT: OK, exit 0

# ② 记录入口名与包体（用于登记，不要用来判"是否同一次构建"）
unzip -l app/build/outputs/apk/debug/app-debug.apk | grep -o 'assets/web/spa/assets/main\.[A-Za-z0-9_-]*\.js'

# ③ 有没有把源码/映射文件漏进包（应为空）
unzip -l app/build/outputs/apk/debug/app-debug.apk | grep -E '\.map$|assets/web/spa/src/' || echo "clean"

# ④ 被引用的 quickjs wasm 必须在包内（扩展沙箱靠它）
grep -rhoE "assets/emscripten-module-[A-Za-z0-9_-]+\.wasm" dist | sort -u
```

---

## 4. "等价"怎么判定（**不是**字节相同）

先把实测结果摆出来：同一份源码，交付包与干净重建包**字节不同、入口哈希也不同**。
所以判据只能建立在「结构与行为」上，不能建立在指纹上。

| # | 判据 | 交付包（参考） | 干净重建 |
|---|---|---|---|
| 1 | `check-webdist.mjs --assets` | `VERDICT: OK` | `VERDICT: OK` |
| 2 | 被引用的 quickjs wasm | 1 个被引用（`NWak2PoB`） | 1 个被引用（同名） |
| 3 | Kotlin 新符号 | `rebuildWebView` / `recoverPage` 在 dex 内 | 同（源码相同） |
| 4 | 行为 | 六条启动判据 + 真机闭环 | 需实机验收（本机未装） |
| — | 包体 | 24,343,888 B / 348 条目 | 19,890,423 B / 345 条目 |
| — | 入口名 | `main.CJYsJ0I6.js` | `main.oGPa8w3b.js` |

**两条不能用的判据（都有实测反例）：**

- ❌ **包内 `main.<hash>.js` 文件名相同**。差异从主 chunk 第 70 字节就开始了，落在
  `__vite__mapDeps` 的懒加载分块名上 —— 是分块哈希连锁，不是逻辑改动：
  131 个不反向引用主 chunk 的分块**逐字节相同**。跨环境重建出现不同哈希是正常的。
- ❌ **zip 条目数 / 字节数相同**。本机交付包连续三个包字节数完全一样（24,343,888），
  纯属巧合；而干净重建比它少 3 条、4.4 MB。

**少掉的 3 条已定位，不是缺文件**：交付包的 `dist/spa/assets` 里有 4 个
`emscripten-module-*.wasm`，但产物只引用其中 1 个（`release-sync` 变体，扩展沙箱用它），
另外 3 个是 `shrink-assets.mjs` 没删掉的孤儿。干净重建只留下被引用的那个。
也就是说：**交付包多带了 4.4 MB 死重，而不是重建缺了什么。**

---

## 5. 实测记录（2026-11-04，本机）

从空目录 `c1-clean2/` 起，严格按上面 5 步执行：

| 步骤 | 结果 | 耗时 |
|---|---|---|
| 0 · `git clone` 本仓库 | ✅ 276 个文件，`LICENSE` 指纹与上游一致 | 3 s |
| 0b · 把上游克隆进 `<仓库根>/source` + checkout `c8f40eab` | ✅ | 2 s |
| 1 · `pnpm install --frozen-lockfile --ignore-scripts`（source） | ✅ 17 个 workspace 项目 | 10 s |
| 2 · `pnpm install --frozen-lockfile`（porting/js） | ✅ | 3 s |
| 3 · `pnpm build:all` | ✅ `dist` 41 MB | 27 s |
| 4 · `./gradlew assembleDebug -PrequireWeb -PskipWeb` | ✅ 出包 | 109 s |
| 5 · `check-webdist --assets` | ✅ `VERDICT: OK`，3 项指纹全等 | — |

> 步骤 3 的 27 秒与主工作区曾实测的 17 分钟相差两个数量级：主工作区受 `.trash` 累积与
> 文件系统缓存影响。**不要拿耗时当判据**，也不要因为"太快了"怀疑构建没跑——以
> `check-webdist` 与 `dist/spa/index.html` 的存在为准。

**已经闭合的边界**（此前是 ❌）：

| 项 | 状态 |
|---|---|
| 干净检出 + 两处 fixed install（步骤 0/1/2） | ✅ 实测通过 |
| 全链路从空目录一次跑到出包 | ✅ 实测通过（约 2.5 分钟，含克隆） |
| 产物一致性门禁 | ✅ `VERDICT: OK` |

**当时的重建包**已装到真机（Xiaomi 2211133C / Android 16）复跑六条启动判据：
`Displayed +745 ms`、`bootstrap → core worker ready` 326 ms、0 崩溃、0 备份失败、曲库真实渲染。
明细见 `docs/phase6-compliance.md` 附录 E.5。

---

## 6. 已知环境坑

1. **`.trash` 拖慢构建**：`porting/js/.trash/` 每轮构建留下一个 old 目录，累积到 9 个
   （约 200 MB）时，clean 阶段反复尝试删除失败，`build:all` 从 17 分钟涨到 25 分钟。
   定期清空即可（它是构建缓存，不属于交付物）。
2. **Gradle 会重复跑 JS 构建**：见步骤 4 的 `-PskipWeb=true`。
3. **Git Bash 的路径改写（两个方向都会出事）**：
   - 不设 `MSYS_NO_PATHCONV`：`adb shell ls /sdcard/...` 里的 `/sdcard` 会被改成
     `C:/Program Files/Git/sdcard`，设备上找不到。
   - 设了 `MSYS_NO_PATHCONV=1`：`git clone <src> /c/Users/...` 会把这个 **POSIX 路径原样**
     交给 `git.exe`，Windows 侧解析成 `C:\c\Users\...` —— clone **返回 0**，但目录建在别处，
     后续 `cd` 才报 `No such file or directory`。
   - 结论：**要么全用 `C:/...` 形式的 Windows 路径**（推荐，脚本里一律这么写），
     要么只在 adb 那几条命令前临时 `export`。别把两者混在同一个脚本里。
4. **`node_modules` 不能移动、不能跨机拷贝**：pnpm 建的是**绝对路径**符号链接
   （实测：`view-main/node_modules/less -> /c/Users/…/c1-clean/source/node_modules/.pnpm/less@4.9.1/…`）。
   把已 install 过的 `source/` 目录 `mv` 到别处，链接全部悬空，构建报「缺失依赖：svelte, less…」，
   而表面上文件都还在。**必须原地 install**：先把上游克隆到最终位置，再装依赖。
5. **没有 MSVC 时 `better-sqlite3` 编译必然失败**：见步骤 1 的 `--ignore-scripts`。
   报错形如 `gyp ERR! find VS`，且会让整个 `pnpm install` 以 exit 1 中断。
6. **非交互 shell 要 `CI=true`**：否则 pnpm 重建 `node_modules` 时会以
   `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 中止。
7. **`local.properties` 不在仓库里**：干净检出必须先设 `ANDROID_HOME`，否则 Gradle 报
   `SDK location not found`（见步骤 4）。
8. **Windows 中文路径下的 JVM 测试编码**：本机 JDK 17 使用 UTF-8 启动 Gradle 测试进程时，
   工作区路径中的中文会让测试类加载失败。系统代码页为 GBK 的环境可在当前 PowerShell
   会话中临时统一 Gradle 和测试进程的编码，再在项目原目录执行：

   ```powershell
   cd porting/android
   $previousJavaOptions = $env:JAVA_TOOL_OPTIONS
   try {
     $env:JAVA_TOOL_OPTIONS = '-Dfile.encoding=GBK'
     .\gradlew.bat :core-ports:testDebugUnitTest -PskipWeb=true --no-daemon '-Dorg.gradle.jvmargs=-Xmx512m -Dfile.encoding=GBK'
   } finally {
     $env:JAVA_TOOL_OPTIONS = $previousJavaOptions
   }
   ```

   按实际系统代码页调整编码；此设置仅用于测试。恢复环境变量后再打包，必要时对打包任务
   加 `--rerun-tasks`：本机曾出现任务显示成功但 APK 仍含旧 DEX 的情况。不要通过另一个
   目录连接执行测试后再从原路径打包；共享中间产物也可能使 APK 混入旧版本类。
9. **需要保留旧构建目录时，可用独立产物目录**。以下命令在新的 `artifacts/` 子目录中构建，
   不调用会扫描旧 `.trash/` 的清理脚本。每次把 `$qaStageName` 改成尚不存在的目录名：

   ```powershell
   $qaStageName = 'qa-build-js-timeout-status-20261105'
   cd porting/js
   $qaStageRoot = Join-Path (Resolve-Path '../../artifacts').Path $qaStageName
   node ./node_modules/vite/bin/vite.js build --outDir (Join-Path $qaStageRoot 'spa')
   node ./node_modules/vite/bin/vite.js build --config vite.extension-preload.config.mjs --outDir (Join-Path $qaStageRoot 'extension-preload')
   node scripts/shrink-assets.mjs "--spa-dir=../../artifacts/$qaStageName/spa"
   node scripts/smoke.mjs "--dist=../../artifacts/$qaStageName"
   cd ../android
   .\gradlew.bat :app:assembleDebug -PskipWeb=true "-PjsDistDir=../../artifacts/$qaStageName" -PrequireWeb=true
   node scripts/check-webdist.mjs --assets "--dist=../../artifacts/$qaStageName"
   ```

   两次 Vite 构建的 `root` 不同，`--outDir` 必须使用绝对路径，否则扩展预加载文件会写入上游源码树。

   当前包使用的目录是 `artifacts/qa-build-js-timeout-status-20261105`。指定 `jsDistDir` 时必须同时
   指定 `-PskipWeb=true`；默认不带 `--dist` 的检查仍然针对旧的 `porting/js/dist`。
