<script lang="ts">
  import { fade } from 'svelte/transition'

  import { lyricLines } from '@ui/modules/lyric/reactive.svelte'
  import { musicInfo } from '@ui/modules/player/reactive.svelte'
  import LyricPlayer from '@ui/components/layout/PlayDetail/RightLyric/LyricPlayer.svelte'

  import { tm } from '@porting/ui/i18n'

  let { introend }: { introend: boolean } = $props()

  let showEmpty = $state(false)

  $effect(() => {
    const musicId = $musicInfo.id
    const lineCount = $lyricLines.length
    showEmpty = false
    if (!musicId || lineCount) return

    const timeout = setTimeout(() => {
      showEmpty = true
    }, 1500)
    return () => {
      clearTimeout(timeout)
    }
  })
</script>

<div class="right-lyric">
  {#if introend}
    <div in:fade={{ delay: 5 }} class="right-lyric-content">
      <LyricPlayer />
      {#if !$lyricLines.length}
        <div class="lyric-empty" aria-live="polite">
          {tm(showEmpty ? 'mobile__lyric_empty' : 'mobile__lyric_loading')}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style lang="less">
  .right-lyric {
    position: relative;
    flex: auto;
    contain: strict;
  }
  .right-lyric-content {
    position: absolute;
    inset: 0;
  }
  .lyric-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 24px;
    font-size: 15px !important;
    line-height: 1.5;
    color: var(--color-300);
    text-align: center;
    pointer-events: none;
  }
</style>
