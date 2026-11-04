#!/usr/bin/env bash
# Any Listen Android 真机部署脚本（macOS / Linux / Windows Git Bash）
#
# 用法：
#   ./scripts/deploy.sh                 # 安装现有 APK 并启动 + 跟日志
#   ./scripts/deploy.sh --build         # 先 assembleDebug 再装（-PcleanJsDist 可选）
#   ./scripts/deploy.sh --no-log        # 装完启动就返回，不跟日志
#   ./scripts/deploy.sh --clear         # 安装前卸载旧包（清掉 localStorage/OPFS，验首启时用）
#   ./scripts/deploy.sh --loose         # 用 -PallowCleartext=true 构建（允许 http 音源）
#
# 环境变量：
#   ADB=/path/to/adb   显式指定 adb（否则先读 local.properties 的 sdk.dir，最后回退 PATH）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK="$ROOT/app/build/outputs/apk/debug/app-debug.apk"
PKG="com.anylisten.android"
# applicationId 与 namespace 不同（namespace=com.anylisten.app），所以 `/.MainActivity` 是错的。
# 下面运行时会用 `cmd package resolve-activity` 动态解析，这里只是兜底值。
FALLBACK_COMPONENT="$PKG/com.anylisten.app.MainActivity"

DO_BUILD=0
DO_LOG=1
DO_CLEAR=0
LOOSE=0

for arg in "$@"; do
  case "$arg" in
    --build) DO_BUILD=1 ;;
    --no-log) DO_LOG=0 ;;
    --clear) DO_CLEAR=1 ;;
    --loose) LOOSE=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（--help 看用法）" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 定位 adb
find_adb() {
  if [[ -n "${ADB:-}" ]]; then echo "$ADB"; return; fi
  local sdk=""
  if [[ -f "$ROOT/local.properties" ]]; then
    # sdk.dir=C\:\\Users\\x\\AppData\\Local\\Android\\Sdk
    sdk="$(grep -E '^sdk\.dir=' "$ROOT/local.properties" | head -1 | cut -d= -f2- \
      | sed -e 's/\\\\/\//g' -e 's/\\:/:/g' -e 's/\\//g')"
  fi
  if [[ -n "$sdk" ]]; then
    if [[ -x "$sdk/platform-tools/adb" ]]; then echo "$sdk/platform-tools/adb"; return; fi
    if [[ -x "$sdk/platform-tools/adb.exe" ]]; then echo "$sdk/platform-tools/adb.exe"; return; fi
  fi
  command -v adb 2>/dev/null || true
}

ADB_BIN="$(find_adb)"
if [[ -z "$ADB_BIN" ]]; then
  die "找不到 adb。装 Android SDK Platform-Tools，或 export ADB=/path/to/adb 后重试。"
fi
say "adb: $ADB_BIN"

# ---------------------------------------------------------------- 构建（可选）
if [[ "$DO_BUILD" == "1" ]]; then
  say "构建 debug APK…"
  # -PrequireWeb=true：装机包必须带真实前端。否则 dist/spa 恰好不在时（JS 侧正在 build）
  # 会静默降级成占位 SPA，装上去白屏，而 APK 只有 988 KB「看起来反而更好」。
  if [[ "$LOOSE" == "1" ]]; then
    (cd "$ROOT" && ./gradlew :app:assembleDebug --console=plain -PallowCleartext=true -PrequireWeb=true) \
      || die "构建失败（或前端产物缺失，见日志里的 [webassets]）"
  else
    (cd "$ROOT" && ./gradlew :app:assembleDebug --console=plain -PrequireWeb=true) \
      || die "构建失败（或前端产物缺失，见日志里的 [webassets]）"
  fi
fi

[[ -f "$APK" ]] || die "APK 不存在：$APK\n先跑 ./gradlew :app:assembleDebug 或加 --build"

# 体积体检：占位 SPA 的包只有 ~1 MB，而带真实前端的是 24 MB 左右。
# 装机白屏最常见的成因就是「构建时 dist/spa 恰好不在」→ 静默降级成占位页。
APK_BYTES=$(wc -c <"$APK" | tr -d ' ')
if (( APK_BYTES < 3000000 )); then
  warn "APK 只有 $((APK_BYTES / 1024)) KB，很可能是占位 SPA（无真实前端），装上去会白屏。"
  warn "用 -PrequireWeb=true 重新构建，或先跑 pnpm run build:all 再打包。"
fi

# ---------------------------------------------------------------- 设备检查
say "等待设备…"
"$ADB_BIN" start-server >/dev/null 2>&1 || true

device_of() {
  # 取第一个 state=device 的序列号；忽略 offline / unauthorized
  "$ADB_BIN" devices | awk 'NR>1 && $2=="device" {print $1; exit}'
}

DEVICE="$(device_of)"
if [[ -z "$DEVICE" ]]; then
  echo
  warn "没有可用的 Android 设备。逐条排查："
  cat >&2 <<'EOF'
  1) 手机「开发者选项 → USB 调试」是否打开；插上后手机上弹出的「允许 USB 调试」是否点了允许
  2) 数据线是只能充电的线吗？换一根支持数据传输的
  3) Windows 需要装厂商 USB 驱动（小米/华为/三星各自有），否则 adb 看不到设备
  4) 设备状态是 unauthorized → 在手机上重新确认授权；offline → 拔插一次
  5) adb 服务卡死：adb kill-server && adb start-server，然后重跑本脚本
  6) 无线调试：adb pair <ip>:<port> 配对后 adb connect <ip>:<port>
EOF
  echo
  "$ADB_BIN" devices
  exit 1
fi
say "设备: $DEVICE"

# ---------------------------------------------------------------- 安装
if [[ "$DO_CLEAR" == "1" ]]; then
  say "卸载旧包（清 localStorage / IndexedDB / OPFS）…"
  "$ADB_BIN" -s "$DEVICE" uninstall "$PKG" >/dev/null 2>&1 || true
fi

say "安装 $(du -h "$APK" | cut -f1) APK…"
if ! "$ADB_BIN" -s "$DEVICE" install -r -d "$APK" 2>&1 | tail -5; then
  die "安装失败。常见原因：签名冲突（先 --clear）、空间不足、minSdk 高于设备版本（需 Android 10+）"
fi

# ---------------------------------------------------------------- 启动
# applicationId(com.anylisten.android) 与 namespace(com.anylisten.app) 不一致，
# `am start -n pkg/.MainActivity` 会解析失败 —— 必须向系统问真实组件名。
COMPONENT="$("$ADB_BIN" -s "$DEVICE" shell cmd package resolve-activity --brief "$PKG" 2>/dev/null \
  | tr -d '\r' | tail -1)"
if [[ "$COMPONENT" != */* ]]; then
  COMPONENT="$FALLBACK_COMPONENT"
fi
say "启动 $COMPONENT …"
"$ADB_BIN" -s "$DEVICE" shell am start -n "$COMPONENT" >/dev/null 2>&1 \
  || warn "am start 返回非 0，若界面已打开可忽略"

if [[ "$DO_LOG" != "1" ]]; then
  say "完成（--no-log，未跟日志）。"
  exit 0
fi

# ---------------------------------------------------------------- 日志
say "跟日志中（Ctrl+C 退出）。标签：AnyListen/Bridge|Storage|Playback|App、崩溃、chromium"
echo "---------------------------------------------------------------"
exec "$ADB_BIN" -s "$DEVICE" logcat -v time \
  -s AnyListen/Bridge:V AnyListen/Storage:V AnyListen/Playback:V AnyListen/App:V AnyListen/Notify:V \
  AndroidRuntime:E chromium:E DEBUG:E
