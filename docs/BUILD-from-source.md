# 从零重建（干净检出）

> 这份文档的唯一目的：**让第三方拿到源码后，能独立重建出等价的 APK**。
> 它是合规条件 C-1 的验收判据（见 `docs/phase6-compliance.md` §4.2）。
>
> **当前状态**：本文件描述的步骤在「已装好依赖的工作区」里反复跑通；但**干净目录从零
> 走一遍尚未执行**。这是 C-1 目前唯一未闭合的验收项 —— 不要把它当成已签字的结论。

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

```
<任意父目录>/
├── source/          ← 上游，按 commit 检出（不在本仓库内）
└── porting-tree/    ← 本仓库（含 porting/、docs/、README、LICENSE、NOTICE）
```

**为什么必须同级**：`porting/js/vite.config.mjs` 以 `../../source/packages` 解析上游模块。
换布局就必须改构建配置，改完就不再是"按文档原样重建"。

---

## 3. 步骤

### 步骤 0 · 取上游（固定 commit）

```bash
cd <父目录>
git clone https://github.com/any-listen/any-listen.git source
git -C source checkout c8f40eab05021735b969e5991e6ec2f2c63e83b8
```

`c8f40eab` 是 `0.10.1-beta.2`（desktop）/ `0.12.1-beta.2`（web-server）的发布提交。
**不要**用 `dev` 分支 HEAD 代替 —— 上游任何接口变动都会让覆写表失效（`OVERRIDES` 的 key
是相对 `source/packages` 的路径）。

### 步骤 1 · 装上游依赖（**最容易漏的一步**）

```bash
cd source && pnpm install --frozen-lockfile
```

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
# ① 一致性门禁：dist ↔ assets 逐文件指纹比对
node scripts/check-webdist.mjs --assets      # 期望 VERDICT: OK, exit 0

# ② 入口名（内容哈希，可用来判断"是不是同一次构建的内容"）
unzip -l app/build/outputs/apk/debug/app-debug.apk | grep -o 'assets/web/spa/assets/main\.[A-Za-z0-9_-]*\.js'

# ③ 有没有把源码/映射文件漏进包（应为空）
unzip -l app/build/outputs/apk/debug/app-debug.apk | grep -E '\.map$|assets/web/spa/src/' || echo "clean"
```

---

## 4. "等价"怎么判定（**不是**字节相同）

不要用 `sha256` 对比两份 APK —— debug 签名带时间戳、zip 条目带 mtime，同一份源码
两次构建的字节数都不保证相同（本项目连续三个包的字节数**完全一样**，纯属巧合，
所以更不能拿大小当判据）。

可信的等价判据，按强度排序：

1. **`check-webdist.mjs --assets` 返回 `VERDICT: OK`** —— 它比对 dist 与 assets 的指纹，
   保证"SHA1 三方相同"这条链路在包内成立。
2. **包内 `assets/web/spa/assets/main.<hash>.js` 文件名相同** —— Vite 的文件名哈希由
   内容决定，名字相同即内容相同。参考包是 `main.CJYsJ0I6.js`。
3. **assets 文件数相同** —— 参考包为 121 个 `assets/web/` 条目、348 个 zip 条目（24,343,888 B）。
4. Kotlin 侧改动无法用文件名验证，需查符号：
   `unzip -p app-debug.apk classes*.dex | grep -ac rebuildWebView`（应 > 0）。

---

## 5. 已验证 / 未验证边界

| 项 | 状态 |
|---|---|
| 步骤 3（`build:all`） | ✅ 多次跑通，exit 0 |
| 步骤 4（`assembleDebug -PrequireWeb -PskipWeb`） | ✅ 多次跑通，22 秒（增量） |
| 步骤 5（三项验证） | ✅ 在当前包上通过 |
| 步骤 0 / 1 / 2（干净检出 + 两处 frozen install） | ❌ **未实测** |
| 全链路从空目录一次跑到出包 | ❌ **未实测**（预计 40–60 分钟，主要耗在步骤 3） |

把最后两行从 ❌ 变成 ✅，C-1 的验收判据才算真正满足。

---

## 6. 已知环境坑

1. **`.trash` 拖慢构建**：`porting/js/.trash/` 每轮构建留下一个 old 目录，累积到 9 个
   （约 200 MB）时，clean 阶段反复尝试删除失败，`build:all` 从 17 分钟涨到 25 分钟。
   定期清空即可（它是构建缓存，不属于交付物）。
2. **Gradle 会重复跑 JS 构建**：见步骤 4 的 `-PskipWeb=true`。
3. **Git Bash 会改写以 `/` 开头的参数**：Windows 下 `adb shell ls /sdcard/...` 里的
   `/sdcard` 会被改写成 `C:/Program Files/Git/sdcard`。前置 `export MSYS_NO_PATHCONV=1`。
4. **`node_modules` 不能跨机拷贝**：`link-vendor.mjs` 建的是**目录联接**（junction /
   symlink），绝对路径写死。换机器必须重跑步骤 1 与 2，不要拷目录。
