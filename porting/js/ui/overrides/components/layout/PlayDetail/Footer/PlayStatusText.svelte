<script lang="ts">
  import { playerPlaying, statusText } from '@ui/modules/player/reactive.svelte'

  import { playbackErrorStatus } from '@porting/ui/player/errorNotice'
  import { formatPlayerStatus } from '@porting/ui/statusText'

  let status = $derived($playerPlaying ? '' : $playbackErrorStatus || formatPlayerStatus($statusText))
</script>

<div class="play-status">
  {status}
</div>

<style lang="less">
  .play-status {
    position: absolute;
    bottom: 3px;
    left: 0;
    box-sizing: content-box;
    width: 100%;
    height: 16px;
    font-size: 12px;
    color: var(--color-font-label);
    text-align: center;
    pointer-events: none;

    .mixin-ellipsis-1();
  }
</style>
