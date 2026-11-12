<script lang="ts">
  import SvgIcon from '@ui/components/base/SvgIcon.svelte'
  import { tm } from '@porting/ui/i18n'
  import {
    cachePlaylist,
    playlistCacheStore,
    retryFailedPlaylistCache,
  } from '@porting/ui/musicCache'

  let {
    listId,
    list,
  }: {
    listId: string
    list: AnyListen.Music.MusicInfo[]
  } = $props()

  let task = $derived($playlistCacheStore[listId])
  let percent = $derived(task ? Math.min(100, Math.round((task.completed / task.total) * 100)) : 0)
  let retryable = $derived(!task?.active && (task?.failed ?? 0) > 0)
  let complete = $derived(!task?.active && task != null && task.failed === 0 && task.completed === task.total)

  const handleClick = () => {
    if (task?.active) return
    if (retryable) {
      void retryFailedPlaylistCache(listId, list)
    } else {
      void cachePlaylist(listId, list)
    }
  }
</script>

<div class="playlist-cache-bar" class:downloading={task?.active}>
  <div class="cache-main">
    <button
      class="cache-action"
      class:complete
      disabled={task?.active || complete}
      onclick={handleClick}
      aria-label={retryable ? tm('mobile__cache_retry') : tm('mobile__cache_playlist')}
    >
      <SvgIcon name={complete ? 'checkbox-blank' : retryable ? 'refresh' : 'software_installer'} />
      <span>
        {#if task?.active}
          {task.completed}/{task.total}
        {:else if complete}
          {tm('mobile__cached')}
        {:else if retryable}
          {tm('mobile__cache_retry')}
        {:else}
          {tm('mobile__cache_playlist')}
        {/if}
      </span>
    </button>

    <div class="cache-summary" aria-live="polite">
      {#if task?.active}
        <span>{tm('mobile__cache_playlist_progress', { done: task.completed, total: task.total })}</span>
        <span class="cache-pending">下载中 {Math.min(2, task.total - task.completed)}</span>
      {:else if complete}
        <span>{tm('mobile__cache_playlist_done', { total: task.total })}</span>
      {:else if retryable}
        <span class="cache-error">{tm('mobile__cache_playlist_failed', { num: task.failed })}</span>
      {:else}
        <span>{list.length} 首</span>
        <span class="cache-pending">仅缓存当前已加载歌曲</span>
      {/if}
    </div>
  </div>

  {#if task}
    <div class="cache-track" aria-hidden="true">
      <span style={`width:${percent}%`}></span>
    </div>
  {/if}
</div>

<style lang="less">
  .playlist-cache-bar {
    display: flex;
    flex: none;
    flex-flow: column nowrap;
    gap: 7px;
    margin: 0 16px 10px;
    padding: 8px 10px;
    background: var(--color-primary-alpha-950, rgb(100 92 255 / 5%));
    border: 1px solid var(--color-primary-alpha-900, rgb(100 92 255 / 12%));
    border-radius: 12px;
  }

  .cache-main {
    display: flex;
    gap: 10px;
    align-items: center;
    min-width: 0;
  }

  .cache-action {
    display: inline-flex;
    flex: none;
    gap: 6px;
    align-items: center;
    justify-content: center;
    min-height: 40px;
    padding: 0 13px;
    color: var(--color-primary);
    background: var(--color-content-background);
    border: 1px solid var(--color-primary-alpha-700);
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;

    :global(svg) {
      width: 16px;
      height: 16px;
    }

    &:disabled {
      opacity: 1;
    }

    &.complete {
      color: var(--color-font-label);
      border-color: var(--color-border);
    }
  }

  .cache-summary {
    display: flex;
    flex: auto;
    flex-flow: row wrap;
    gap: 4px 10px;
    align-items: center;
    min-width: 0;
    font-size: 12px;
    color: var(--color-font);
  }

  .cache-pending {
    color: var(--color-font-label);
  }

  .cache-error {
    color: var(--color-danger);
  }

  .cache-track {
    width: 100%;
    height: 3px;
    overflow: hidden;
    background-color: var(--color-primary-alpha-900);
    border-radius: 999px;

    > span {
      display: block;
      height: 100%;
      background-color: var(--color-primary);
      border-radius: inherit;
      transition: width 0.2s ease;
    }
  }
</style>
