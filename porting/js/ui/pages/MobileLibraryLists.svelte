<script lang="ts">
  import { defaultLists, useUserList } from '@ui/modules/musicLibrary/reactive.svelte'
  import { tm } from '@porting/ui/i18n'

  import MobileLibraryListItem from './MobileLibraryListItem.svelte'

  // 与桌面 Aside 的「我的歌单」同一数据源：默认列表 + 顶层用户歌单。
  // 不走 userListsAll，避免把「播放历史」和子歌单混进一级列表。
  const userLists = useUserList(null)
  const lists = $derived([...$defaultLists, ...userLists.val])
  const hasUserLists = $derived(userLists.val.length > 0)
</script>

<div class="library-home">
  <div class="section-head">
    <h2>{tm('mobile__library_my_lists')}</h2>
    <span>{tm('mobile__library_list_count', { num: lists.length })}</span>
  </div>

  <div class="lists" role="list">
    {#each lists as listInfo (listInfo.id)}
      <div class="list-row" role="listitem">
        <MobileLibraryListItem {listInfo} />
      </div>
    {/each}
  </div>

  {#if !hasUserLists}
    <p class="hint">{tm('mobile__library_list_hint')}</p>
  {/if}
</div>

<style lang="less">
  .library-home {
    height: 100%;
    padding: 4px 12px max(20px, var(--safe-bottom, 0px));
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }

  .section-head {
    display: flex;
    flex-flow: row nowrap;
    align-items: baseline;
    justify-content: space-between;
    padding: 8px 4px 10px;

    h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      line-height: 1.3;
      color: var(--color-font);
    }

    span {
      font-size: 12px;
      color: var(--color-font-label);
    }
  }

  .list-row {
    border-bottom: 1px solid var(--color-primary-light-400-alpha-800);

    &:last-child {
      border-bottom: 0;
    }
  }

  .hint {
    padding: 8px 4px 24px;
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--color-font-label);
  }
</style>
