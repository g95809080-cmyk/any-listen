/**
 * O-8 —— 播放列表（队列）点击语义的移动端覆盖（**整文件覆盖**，`source/` 一字未改）。
 *
 * 上游这一处是 `createClickHandle(() => {}, index => playIndex(index))` ——
 * 桌面语义的 400ms 双击窗口：**第一次点击什么都不做**，第二次才切歌。
 * 触屏没有双击概念（用户不会为了切一首歌先点两下），所以移动端改为单击即切歌。
 *
 * 与上游的差异只有 `musicClick` 的实现方式；`removeMusic` / `playIndex` / `TabType`
 * 逐行保留。配套的曲库列表改动见 `ui/overrides/components/common/MusicList/List/index.svelte`
 * 文件头第 4 条差异（同一缺陷 D-16 的两个入口）。
 *
 * 注：`QueueList.svelte` 在 Enter 键路径上会连调两次 `musicClick`。这里不再区分 ——
 * `playIndex` 是同步函数（`playerActions.ts:431`，只做 `setPlaying(true)` + 换曲），
 * 触屏路径 `isKey` 恒为 false，不会走到第二次调用。
 */
import { playIndex } from '@ui/modules/player/actions'
import { removePlayListMusic } from '@ui/modules/player/store/actions'

export type TabType = 'queue' | 'history'

export const musicClick = (index: number) => {
  playIndex(index)
}

export const removeMusic = async (id: string) => {
  await removePlayListMusic([id])
}

export { playIndex }
