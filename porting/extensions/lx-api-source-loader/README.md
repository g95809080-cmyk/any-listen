# LX Music 自定义源加载器（Android 适配）

这个扩展让 Any Listen Android 使用 LX Music 自定义源，支持多选导入、继续从其他目录选择，并显示导入、重复和失败的结果。开启「启用歌曲缓存」后，播放过的歌曲会由 Android 宿主保存到本地，完整下载后可以断网复听。

使用 Node.js 22.18 或更新版本，在本目录执行 `pnpm install --frozen-lockfile` 和 `pnpm build`，安装包会生成在仓库的 `artifacts/lx-loader/`。将 `.alix` 文件复制到手机，在应用的「扩展管理 → 本地安装」选择它，再到「设置 → 扩展设置」导入 `.js` 音源。

缓存默认开启，文件保存在应用私有的 `files/cache/proxy/` 下。正在播放时会先正常取流，同时在后台补齐完整歌曲；后台下载完成前断网仍然不能播放。卸载应用或清除应用数据会删除缓存。

本适配基于 [Any Listen LX API Source Loader 0.1.7](https://github.com/any-listen/any-listen-extension-lx-api-source-loader/tree/1d88ccad40e823e52e9255953a87939b9e0d4af3)，保留 Apache-2.0 许可证。适配版使用独立扩展 ID，本地包未冒用官方签名；它和官方扩展的数据互不覆盖。已有音源可从官方扩展导出后重新导入。导入成功表示文件已保存，不保证第三方音源的服务可用。
