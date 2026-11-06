<script lang="ts">
  import PlayerMusicHeartBtn from '@ui/components/common/PlayerMusicHeartBtn.svelte'
  import CommentBtn from '@ui/components/common/CommentBtn.svelte'
  import PlaybackRateBtn from '@ui/components/common/PlaybackRateBtn.svelte'
  import PlaylistBtn from '@ui/components/common/PlaylistBtn/index.svelte'
  import SoundEffectBtn from '@ui/components/common/SoundEffectBtn/index.svelte'
  import TogglePlayModeBtn from '@ui/components/common/TogglePlayModeBtn.svelte'
  import VolumeBtn from '@ui/components/common/VolumeBtn.svelte'
  import MiddlePlayProgress from '@ui/components/layout/PlayDetail/Footer/MiddlePlayProgress.svelte'
  import PlayBtns from '@ui/components/layout/PlayDetail/Footer/PlayBtns.svelte'
  import PlayStatusText from '@ui/components/layout/PlayDetail/Footer/PlayStatusText.svelte'
  import { fade } from 'svelte/transition'

  let { introend }: { introend: boolean } = $props()
</script>

<div class="footer">
  {#if introend}
    <div in:fade={{ delay: 5 }} class="footer-content">
      <MiddlePlayProgress />
      <div class="control">
        <div class="control-row control-row-aux">
          <div class="aux-action">
            <SoundEffectBtn />
          </div>
          <div class="aux-action">
            <PlaybackRateBtn />
          </div>
          <div class="aux-action">
            <CommentBtn />
          </div>
          <div class="aux-action">
            <TogglePlayModeBtn />
          </div>
          <div class="aux-action">
            <VolumeBtn />
          </div>
        </div>
        <div class="control-row control-row-main">
          <div class="side-action side-action-heart">
            <PlayerMusicHeartBtn />
          </div>
          <PlayBtns />
          <div class="side-action side-action-playlist">
            <PlaylistBtn />
          </div>
        </div>
      </div>
      <PlayStatusText />
    </div>
  {/if}
</div>
