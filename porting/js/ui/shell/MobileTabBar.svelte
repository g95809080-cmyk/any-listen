<script lang="ts">
  import SvgIcon from '@ui/components/base/SvgIcon.svelte'
  import { link, location } from '@ui/plugins/routes'

  import { t, tm } from '../i18n'

  interface Tab {
    to: string
    icon: string
    label: string
  }

  /**
   * 4 个 Tab 均分 411dp（≈102dp/个），远大于 44dp 下限。
   * **不给选中项加顶部指示条**：颜色 + 字重已足够区分，再加会和紧邻的 MiniPlayer 形成视觉噪音（uiux 结论）。
   * 文案全部来自 `ui/i18n.ts`：`/library` 用移动端字典（上游 `list_name__default` 是「试听列表」，语义错），
   * `/settings` 复用上游 `setting`。
   */
  const tabs: Tab[] = [
    { to: '/library', icon: 'music_library', label: tm('mobile__tab_library') },
    { to: '/online', icon: 'sound_cloud', label: tm('mobile__tab_online') },
    { to: '/settings', icon: 'setting', label: t('setting') },
  ]

  const isActive = (to: string) =>
    $location === to || $location.startsWith(to + '?') || $location.startsWith(to + '/')
</script>

<nav class="tabbar" role="tablist">
  {#each tabs as tab (tab.to)}
    <a
      class="tab"
      class:active={isActive(tab.to)}
      role="tab"
      aria-selected={isActive(tab.to)}
      aria-label={tab.label}
      href={tab.to}
      {@attach link()}
    >
      <SvgIcon name={tab.icon} />
      <span>{tab.label}</span>
    </a>
  {/each}
</nav>

<style lang="less">
  .tabbar {
    display: flex;
    flex: none;
    flex-flow: row nowrap;
    height: calc(56px + var(--safe-bottom, 0px));
    padding-bottom: var(--safe-bottom, 0px);
    background-color: var(--color-content-background);
    border-top: 1px solid var(--color-primary-light-400-alpha-800);
  }
  .tab {
    display: flex;
    flex: 1 1 0;
    flex-flow: column nowrap;
    gap: 2px;
    align-items: center;
    justify-content: center;
    min-width: 0;
    height: 56px;
    font-size: 11px;
    color: var(--color-font-label);
    text-decoration: none;
    transition: color 100ms;

    & :global(.svg-icon) {
      width: 24px;
      height: 24px;
    }
    &:active {
      opacity: 0.6;
    }
    &.active {
      font-weight: 600;
      color: var(--color-primary);
    }
  }
</style>
