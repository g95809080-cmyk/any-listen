<script lang="ts">
  import SvgIcon from '@ui/components/base/SvgIcon.svelte'
  import type { Snippet } from 'svelte'

  import { tm } from '../i18n'

  let {
    title,
    back = false,
    onback,
    actions,
    search = false,
  }: {
    title: string
    back?: boolean
    onback?: () => void
    actions?: Snippet
    search?: boolean
  } = $props()
</script>

<!--
  N-4。高度 56dp + 顶部安全区；左右按钮都是 44×44（--touch-min）。
  左槽在非 back 时保留 12dp 的内缩而非 44dp —— 避免标题在小屏上被白白挤掉 32dp。
-->
<header class="appbar">
  {#if back}
    <button class="ab-btn" aria-label={tm('mobile__back')} onclick={() => onback?.()}>
      <span class="ab-back-icon"><SvgIcon name="angle-right-solid" /></span>
    </button>
  {:else}
    <span class="ab-pad"></span>
  {/if}
  <h1 class="ab-title" class:compact={search}>{title}</h1>
  <div class="ab-actions" class:search-actions={search}>
    {@render actions?.()}
  </div>
</header>

<style lang="less">
  .appbar {
    display: flex;
    flex: none;
    flex-flow: row nowrap;
    gap: 4px;
    align-items: center;
    height: calc(56px + var(--safe-top, 0px));
    padding-top: var(--safe-top, 0px);
    padding-right: 4px;
    padding-left: 4px;
    background-color: var(--color-content-background);
  }
  .ab-pad {
    flex: none;
    width: 12px;
  }
  .ab-title {
    flex: auto;
    min-width: 0;
    font-size: 20px;
    font-weight: 600;
    .mixin-ellipsis-1();
  }
  .ab-btn {
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
    border-radius: 22px;

    & :global(.svg-icon) {
      width: 22px;
      height: 22px;
    }
    &:active {
      background-color: var(--color-primary-background-active);
    }
  }
  .ab-back-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    transform: rotate(180deg);
  }
  .ab-actions {
    display: flex;
    flex: none;
    gap: 4px;
    align-items: center;
  }
  .ab-title.compact { flex: none; }
  .ab-actions.search-actions { flex: 1 1 auto; min-width: 0; }
</style>
