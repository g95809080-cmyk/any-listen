# Any Listen 迁移报告

- 生成时间：2026-11-02T14:37:09.707Z
- 工具：anylisten-migrate v1.0.0（Node v22.22.2）
- 模式：实际执行
- 输入：`C:\Users\kuma\WorkBuddy\Any Listen移植apk\porting\.tmp\baddb`
- 输出：`C:\Users\kuma\WorkBuddy\Any Listen移植apk\porting\.tmp\t5e`

> ⚠ **本次数据来自自动备份，不是主库**：`C:\Users\kuma\WorkBuddy\Any Listen移植apk\porting\.tmp\baddb\backup\db_backups\daily\anylisten.data.db.20261102-222901089.bak`
> 主库无法打开，已改用该备份。备份点之后的改动（最后一段播放记录/新增歌曲）不会包含在迁移包里。
> 若要拿到最新数据：关闭桌面版 → 确认进程已退出 → 删除或改名损坏的 `anylisten.data.db` → 重新执行本脚本。

## 1. 设备与路径

| 项 | 值 |
|---|---|
| deviceId | `515f3256-2018-4906-8737-b2fb5aaac0ee`（新生成） |
| 路径映射 | **未提供**（本地音乐会失效） |

## 2. 源数据库状态

| 项 | 值 |
|---|---|
| journal_mode | wal |
| db_version | 3 |
| my_list | 4 |
| my_list_music_info | 24 |
| my_list_music_info_order | 20 |
| play_list_music_info | 2 |
| lyric | 3 |
| music_url | 1 |
| download_list | 1 |
| dislike_list | 2 |
| play_count | 1 |

## 3. 数据库改写明细

| 项 | 数量 |
|---|---|
| journal_mode 变更 | wal → delete |
| WAL checkpoint | `{"busy":0,"log":0,"checkpointed":0}` |
| deviceId 重绑 | 23 行 |
| 路径改写 | 0 行 |
| lyric.id 改写 | 0 行 |
| dislike_list 改写 | 0 行 |
| music_url 清空 | 1 行 |
| download_list（未动） | 1 行 |

## 4. 设置项

原始 112 项 → 保留 62 项，丢弃 47 项。

**需在 Android 上重设：**

- `download.savePath`：需在 Android 上重选目录（SAF）
- `backup.backupPath`：需在 Android 上重选目录（SAF）

<details><summary>已丢弃的 47 项</summary>

- `common.windowSizeId`
- `common.startInFullscreen`
- `common.transparentWindow`
- `common.tryAutoUpdate`
- `common.allowPreRelease`
- `common.showChangeLog`
- `common.font`
- `tray.enable`
- `tray.isToTray`
- `tray.themeId`
- `player.mediaDeviceId`
- `player.isMediaDeviceChangedPausePlay`
- `player.isShowTitleLyric`
- `player.isShowTaskProgess`
- `desktopLyric.pad.0`
- `desktopLyric.pad.1`
- `desktopLyric.pad.2`
- `desktopLyric.pad.3`
- `desktopLyric.pad.4`
- `desktopLyric.pad.5`
- `desktopLyric.pad.6`
- `desktopLyric.pad.7`
- `desktopLyric.pad.8`
- `desktopLyric.pad.9`
- `desktopLyric.pad.10`
- `desktopLyric.pad.11`
- `desktopLyric.pad.12`
- `desktopLyric.pad.13`
- `desktopLyric.pad.14`
- `desktopLyric.pad.15`
- `desktopLyric.pad.16`
- `desktopLyric.pad.17`
- `desktopLyric.pad.18`
- `desktopLyric.pad.19`
- `desktopLyric.pad.20`
- `desktopLyric.pad.21`
- `desktopLyric.pad.22`
- `desktopLyric.pad.23`
- `desktopLyric.pad.24`
- `desktopLyric.pad.25`
- `desktopLyric.pad.26`
- `desktopLyric.pad.27`
- `desktopLyric.pad.28`
- `desktopLyric.pad.29`
- `desktopLyric.pad.30`
- `desktopLyric.pad.31`
- `desktopLyric.pad.32`

</details>

## 5. 迁移后校验

- journal_mode：delete
- integrity_check：**ok**
- db_version：3
- 残留未重绑 deviceId：0

✅ 表结构与 `tables.ts` 一致，Android 端 `verifyDB` 会通过。

## 6. 产物清单

- config.json
- deviceid
- anylisten.data.db（124.0 KB）

## 7. 警告

- 原库无法打开，已改用备份：C:\Users\kuma\WorkBuddy\Any Listen移植apk\porting\.tmp\baddb\backup\db_backups\daily\anylisten.data.db.20261102-222901089.bak

## 附：Android 端落位路径

```
/data/data/com.anylisten.mobile/files/any-listen/
  ├── config.json
  ├── deviceid
  ├── anylisten.data.db
  ├── sound_effect.json     （可选）
  ├── data.json             （可选）
  └── extension/            （可选）
        ├── extensions.json
        ├── ext/<extId>/
        └── datas/
```
