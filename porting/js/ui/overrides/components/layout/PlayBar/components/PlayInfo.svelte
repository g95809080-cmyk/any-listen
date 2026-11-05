<script lang="ts">
  import { lyricLine, lyricLines } from '@ui/modules/lyric/reactive.svelte'
  import { musicInfo, playerPlaying, statusText } from '@ui/modules/player/reactive.svelte'
  import { useSettingValue } from '@ui/modules/setting/reactive.svelte'
  import { buildMusicName } from '@any-listen/common/tools'

  import { playbackErrorStatus } from '@porting/ui/player/errorNotice'
  import { formatPlayerStatus } from '@porting/ui/statusText'

  let nameFormat = useSettingValue('download.fileName')

  let status = $derived.by(() => {
    if ($playbackErrorStatus) return $playbackErrorStatus
    const current =
      $playerPlaying && $lyricLines.length ? $lyricLine.text : formatPlayerStatus($statusText)
    return current || ($playerPlaying ? $musicInfo.singer : '')
  })
  let musicLabel = $derived.by(() => {
    const info = $musicInfo
    if (!info.id) return ''
    return buildMusicName(nameFormat.val, info.name, info.singer)
  })
</script>

<div class="container">
  <p class="name">{musicLabel}</p>
  <p class="status-text">{status}</p>
</div>

<style lang="less">
  .container {
    flex: auto;
    min-width: 0;
    contain: content;
  }
  .name {
    padding: 3px 0;
    font-size: 14px;
    color: var(--color-font-label);
    .mixin-ellipsis-1();
  }

  .status-text {
    box-sizing: content-box;
    height: 18px;
    padding-bottom: 3px;
    font-size: 15px;
    .mixin-ellipsis-1();
  }
</style>
