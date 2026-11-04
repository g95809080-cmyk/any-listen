<script lang="ts">
  /**
   * 曲库空态（移动端）。
   *
   * **为什么必须有这个按钮**：全仓只有两个 `importLocalFile()` 的调用点 ——
   * 定义处 `components/layout/Aside/MyList/action.ts:43`，以及桌面左侧歌单栏的右键菜单
   * `components/layout/Aside/MyList/Menu.svelte:98`。移动壳不渲染 `AppShell`（没有 Aside），
   * 所以**在空态出现之前，用户在手机上没有任何入口能往曲库加歌**。
   *
   * 为什么只有一个按钮：`importLocalFileFolder()`（递归导入文件夹）走
   * `addFolderMusics()` → `@any-listen/app/modules/list` 的递归 + `shims/fs`，
   * 而 `host/app/modules/` 下没有对应的 list 模块，端到端**未验证**。
   * 按「不要给用户一个点了没反应的按钮」的约定，先不放；验证通过后再加回来。
   *
   * 文案走 `ui/i18n.ts` 的 `mobile__*` 字典（上游 `source/packages/shared/i18n` 不可改，
   * 且实测系统语言为 en-us 时，硬编码中文会和 TabBar 的英文标签混在一起）。
   */
  import SvgIcon from '@ui/components/base/SvgIcon.svelte'
  import { LIST_IDS } from '@any-listen/common/constants'
  import { getUserListsAll } from '@ui/modules/musicLibrary/reactive.svelte'
  import { importLocalFile } from '@ui/components/layout/Aside/MyList/action'
  import { tm } from '@porting/ui/i18n'

  import type { ListInfo } from '@ui/components/common/MusicList/type'

  let { listInfo }: { listInfo: ListInfo } = $props()

  /** `importLocalFile()` 要的是 `AnyListen.List.MyListInfo`（不是渲染用的 `ListInfo`） */
  const myList = $derived(getUserListsAll().find((l) => l.id === listInfo.id))

  /** 只有「默认列表」和「我喜欢」放导入按钮：手机上还没有创建普通歌单的入口 */
  const canImport = $derived(listInfo.id === LIST_IDS.DEFAULT || listInfo.id === LIST_IDS.LOVE)

  const onImport = () => {
    if (!myList) {
      console.error('[mobile] 导入失败：找不到歌单元数据', listInfo.id)
      return
    }
    void importLocalFile(myList).catch((err: unknown) => {
      // `importLocalFile` 内部已对「用户取消」与「部分失败」做了 showNotify，
      // 走到这里说明是选择器本身或 IPC 异常，不要吞掉
      console.error('[mobile] 导入本地音乐失败', err)
    })
  }
</script>

<div class="empty">
  <SvgIcon name="music_library" />
  <p class="empty-title">{tm('mobile__library_empty_title')}</p>
  <p class="empty-sub">
    {#if canImport}
      {tm('mobile__library_empty_sub')}
    {:else}
      {tm('mobile__library_empty_sub_list')}
    {/if}
  </p>
  {#if canImport && myList}
    <button class="empty-primary" type="button" onclick={onImport}>{tm('mobile__library_empty_import')}</button>
  {/if}
</div>

<style lang="less">
  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    // 视觉重心略高于几何中心；小屏上不让它漂太多
    padding: 0 24px max(12%, 24px);
    text-align: center;

    // `SvgIcon` 的默认尺寸是 1.2em，这里直接覆盖成 64dp（1 CSS px = 1 dp）
    :global(.svg-icon) {
      width: 64px;
      height: 64px;
      margin-bottom: 16px;
      color: var(--color-font-label);
      opacity: 0.35;
    }
  }

  .empty-title {
    margin: 0 0 8px;
    font-size: 17px;
    font-weight: 600;
    color: var(--color-font);
  }

  .empty-sub {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--color-font-label);
  }

  /*
   * **不能做成「主色填充 + 白字」**：实测 15 个内置主题的 `--color-primary` 亮度跨度是
   * 0.24（mid_autumn `rgb(74,55,82)`）到 0.70（orange `rgb(245,171,53)`）——
   * 白字压在 orange 上对比度只有约 1.9:1，等于看不见。
   * 而主题里也**没有**「主色之上的前景色」这种变量（`--color-primary-font` 就是主色本身）。
   * 所以按上游自己的按钮语言来：主色描边 + 主色文字 + 透明底，任何主题都成立。
   */
  .empty-primary {
    width: 100%;
    max-width: 320px;
    height: 52px;
    margin-top: 24px;
    font-size: 15px;
    font-weight: 600;
    color: var(--color-primary-font);
    cursor: pointer;
    background: transparent;
    border: 1.5px solid var(--color-primary-alpha-200);
    border-radius: 12px;

    &:active {
      background: var(--color-primary-background-active);
    }
  }
</style>
