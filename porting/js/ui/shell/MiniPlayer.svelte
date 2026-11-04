<script lang="ts">
  import Pic from '@ui/components/layout/PlayBar/components/Pic.svelte'
  import PlayInfo from '@ui/components/layout/PlayBar/components/PlayInfo.svelte'
  import SvgIcon from '@ui/components/base/SvgIcon.svelte'
  import { actions } from '@ui/shared/actions'
  import { playing } from '@ui/modules/player/reactive.svelte'
  import { setShowPlayDetail } from '@ui/modules/playDetail/store/action'

  import { t, tm } from '../i18n'
</script>

<!--
  N-5。**复用上游两个组件**，省掉全部播放逻辑与封面加载逻辑：
  - `PlayBar/components/Pic.svelte` —— 封面（`button.btn` 是 44dp 见方，天然满足触控下限）
  - `PlayBar/components/PlayInfo.svelte` —— 歌名 + 播放时显示当前歌词行（`lyricLine.text`）

  ⚠️ 这两个组件的根 class **都叫** `.container`，所以绝不能写 `:global(.container)`（会同时命中两者，
  把 Pic 的 padding/height 覆盖套到 PlayInfo 上）。下面只按"内部唯一类名"定位：
  `button.btn`（仅 Pic 有）、`.name` / `.status-text`（仅 PlayInfo 有）。
-->
<div class="mini">
  <button class="mini-main" aria-label={tm('mobile__open_player')} onclick={() => setShowPlayDetail(true)}>
    <Pic />
    <PlayInfo />
  </button>
  <button
    class="mini-btn"
    aria-label={$playing ? t('player__pause') : t('player__play')}
    onclick={() => actions.exec('player.togglePlay')}
  >
    <SvgIcon name={$playing ? 'pause' : 'play'} />
  </button>
  <button class="mini-btn" aria-label={t('player__list')} onclick={() => setShowPlayDetail(true)}>
    <SvgIcon name="playlist" />
  </button>
</div>

<style lang="less">
  .mini {
    display: flex;
    flex: none;
    flex-flow: row nowrap;
    align-items: center;
    height: 60px;
    padding-right: 4px;
    background-color: var(--color-main-background);
    border-top: 1px solid var(--color-primary-light-400-alpha-800);
  }
  .mini-main {
    display: flex;
    flex: auto;
    flex-flow: row nowrap;
    align-items: center;
    min-width: 0;
    height: 100%;
    padding: 0;
    text-align: left;
    background: transparent;
    border: 0;

    &:active {
      opacity: 0.7;
    }
    & :global(.container) {
      min-width: 0;
    }
    & :global(button.btn) {
      /* Pic: .btn 是 height:100% + aspect-ratio:1，60dp 条减 padding 16 = 44dp */
      width: 44px;
      height: 44px;
    }
    & :global(.name) {
      padding: 0 !important;
      font-size: 14px !important;
      color: var(--color-font) !important;
    }
    & :global(.status-text) {
      height: 16px !important;
      padding: 0 !important;
      font-size: 12px !important;
      color: var(--color-font-label) !important;
    }
  }
  .mini-btn {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    padding: 0;
    color: var(--color-font);
    background: transparent;
    border: 0;

    & :global(.svg-icon) {
      width: 24px;
      height: 24px;
    }
    &:active {
      opacity: 0.6;
    }
  }
</style>
