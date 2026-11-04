<#
.SYNOPSIS
  Any Listen Android 真机部署脚本（Windows PowerShell 5.1+）

.DESCRIPTION
  用法：
    .\scripts\deploy.ps1               # 安装现有 APK → 启动 → 跟日志
    .\scripts\deploy.ps1 -Build        # 先 assembleDebug 再装
    .\scripts\deploy.ps1 -NoLog        # 装完启动就返回
    .\scripts\deploy.ps1 -Clear        # 安装前卸载旧包（清 localStorage/OPFS，验首启用）
    .\scripts\deploy.ps1 -Loose        # 用 -PallowCleartext=true 构建（允许 http 音源）

  环境变量 ADB 可显式指定 adb.exe；否则依次尝试 local.properties 的 sdk.dir、PATH。
#>
[CmdletBinding()]
param(
  [switch]$Build,
  [switch]$NoLog,
  [switch]$Clear,
  [switch]$Loose
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Apk = Join-Path $Root 'app\build\outputs\apk\debug\app-debug.apk'
$Pkg = 'com.anylisten.android'
# applicationId 与 namespace（com.anylisten.app）不同，`am start -n pkg/.MainActivity` 会失败；
# 运行时用 resolve-activity 动态解析，这里只是兜底。
$FallbackComponent = "$Pkg/com.anylisten.app.MainActivity"

function Say([string]$msg) { Write-Host "[deploy] $msg" -ForegroundColor Cyan }
function Warn([string]$msg) { Write-Host "[deploy] $msg" -ForegroundColor Yellow }
function Die([string]$msg) { Write-Host "[deploy] $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 定位 adb
function Find-Adb {
  if ($env:ADB -and (Test-Path $env:ADB)) { return $env:ADB }
  $localProps = Join-Path $Root 'local.properties'
  if (Test-Path $localProps) {
    $line = Get-Content $localProps -Encoding UTF8 | Where-Object { $_ -match '^sdk\.dir=' } | Select-Object -First 1
    if ($line) {
      $sdk = $line.Substring($line.IndexOf('=') + 1)
      $sdk = $sdk -replace '\\\\', '\' -replace '\\:', ':' -replace '\\', '\'
      $candidate = Join-Path $sdk 'platform-tools\adb.exe'
      if (Test-Path $candidate) { return $candidate }
    }
  }
  $cmd = Get-Command adb.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$Adb = Find-Adb
if (-not $Adb) {
  Die '找不到 adb。装 Android SDK Platform-Tools，或 $env:ADB="C:\...\platform-tools\adb.exe" 后重试。'
}
Say "adb: $Adb"

# ---------------------------------------------------------------- 构建（可选）
if ($Build) {
  Say '构建 debug APK…'
  Push-Location $Root
  try {
    # -PrequireWeb=true：装机包必须带真实前端，避免 dist/spa 恰好缺失时静默降级成占位 SPA（白屏）
    if ($Loose) { & .\gradlew.bat :app:assembleDebug --console=plain -PallowCleartext=true -PrequireWeb=true }
    else { & .\gradlew.bat :app:assembleDebug --console=plain -PrequireWeb=true }
    if ($LASTEXITCODE -ne 0) { Die '构建失败（或前端产物缺失，见日志里的 [webassets]）' }
  } finally { Pop-Location }
}

if (-not (Test-Path $Apk)) {
  Die "APK 不存在：$Apk`n先跑 .\gradlew.bat :app:assembleDebug 或加 -Build"
}

# 体积体检：占位 SPA 的包只有 ~1 MB，带真实前端约 24 MB
$apkBytes = (Get-Item $Apk).Length
if ($apkBytes -lt 3000000) {
  Warn "APK 只有 $([int]($apkBytes / 1024)) KB，很可能是占位 SPA（无真实前端），装上去会白屏。"
  Warn '用 -PrequireWeb=true 重新构建，或先跑 pnpm run build:all 再打包。'
}

# ---------------------------------------------------------------- 设备检查
Say '等待设备…'
& $Adb start-server 2>&1 | Out-Null

function Get-Device {
  $out = & $Adb devices 2>&1
  foreach ($line in $out) {
    $parts = ($line -split '\s+') | Where-Object { $_ }
    if ($parts.Count -ge 2 -and $parts[1] -eq 'device') { return $parts[0] }
  }
  return $null
}

$Device = Get-Device
if (-not $Device) {
  Write-Host ''
  Warn '没有可用的 Android 设备。逐条排查：'
  @'
  1) 手机「开发者选项 → USB 调试」是否打开；插上后手机上弹出的「允许 USB 调试」是否点了允许
  2) 数据线是只能充电的线吗？换一根支持数据传输的
  3) Windows 需要装厂商 USB 驱动（小米/华为/三星各自有），否则 adb 看不到设备
  4) 设备状态 unauthorized → 手机上重新确认授权；offline → 拔插一次
  5) adb 服务卡死：adb kill-server; adb start-server，然后重跑本脚本
  6) 无线调试：adb pair <ip>:<port> 配对后 adb connect <ip>:<port>
'@ | Write-Host
  & $Adb devices
  exit 1
}
Say "设备: $Device"

# ---------------------------------------------------------------- 安装
if ($Clear) {
  Say '卸载旧包（清 localStorage / IndexedDB / OPFS）…'
  & $Adb -s $Device uninstall $Pkg 2>&1 | Out-Null
}

$sizeMb = [math]::Round((Get-Item $Apk).Length / 1MB, 1)
Say "安装 $sizeMb MB APK…"
& $Adb -s $Device install -r -d $Apk 2>&1 | Select-Object -Last 5 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) {
  Die '安装失败。常见原因：签名冲突（先 -Clear）、空间不足、minSdk 高于设备版本（需 Android 10+）'
}

# ---------------------------------------------------------------- 启动
$resolved = & $Adb -s $Device shell cmd package resolve-activity --brief $Pkg 2>&1 |
  Select-Object -Last 1
$Component = if ($resolved -and $resolved.ToString().Contains('/')) { $resolved.ToString().Trim() } else { $FallbackComponent }
Say "启动 $Component …"
& $Adb -s $Device shell am start -n $Component 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Warn 'am start 返回非 0，若界面已打开可忽略' }

if ($NoLog) {
  Say '完成（-NoLog，未跟日志）。'
  exit 0
}

# ---------------------------------------------------------------- 日志
Say '跟日志中（Ctrl+C 退出）。标签：AnyListen/*、崩溃、chromium'
Write-Host '---------------------------------------------------------------'
& $Adb -s $Device logcat -v time `
  -s AnyListen/Bridge:V AnyListen/Storage:V AnyListen/Playback:V AnyListen/App:V AnyListen/Notify:V `
  AndroidRuntime:E chromium:E DEBUG:E
