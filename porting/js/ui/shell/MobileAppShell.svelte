<script lang="ts">
  import Router from '@ui/plugins/svelte-spa-router/Router.svelte'
  import routes, { location, query, replace } from '@ui/plugins/routes'
  import { musicInfo } from '@ui/modules/player/reactive.svelte'
  import { userListsAll } from '@ui/modules/musicLibrary/reactive.svelte'
  import { importLocalFile } from '@ui/components/layout/Aside/MyList/action'
  import { LIST_IDS } from '@any-listen/common/constants'
  import { _locale, i18n } from '@ui/plugins/i18n'
  import { t, tm } from '@porting/ui/i18n'
  import {
    SETTINGS_SECTION_TITLE_KEYS,
    resolveSettingsRoute,
  } from '@porting/ui/settings/navigation'

  import MiniPlayer from './MiniPlayer.svelte'
  import MobileAppBar from './MobileAppBar.svelte'
  import MobileOnlineSearch from './MobileOnlineSearch.svelte'
  import MobileTabBar from './MobileTabBar.svelte'

  const hasMusic = $derived(!!$musicInfo.id)
  const path = $derived($location.split('?')[0] ?? '')
  const isLibrary = $derived(path === '/library')
  const settingsRoute = $derived(resolveSettingsRoute($query))
  const isSettingsChild = $derived(path === '/settings' && settingsRoute.kind !== 'home')
  /**
   * 根级页面（底部有 MiniPlayer + TabBar 压着）需要留白；
   * 播放详情是 overlay，不走这里。
   *
   * 曲库现在分两级：`/library` 是一级歌单列表，`/library?id=…` 是二级歌曲页。
   * 二级页必须显示返回键，否则用户只能点底部 Tab 或按 Android 返回；后者还需要
   * `androidBack.ts` 同时把带 id 的曲库路由当作子页（见该文件的根级判据）。
   */
  const isRoot = $derived(
    isLibrary
      ? !$query.id
      : ['/online', '/search'].includes(path) ||
          (path === '/settings' && settingsRoute.kind === 'home')
  )
  const isOnline = $derived(path === '/online')
  const importList = $derived($userListsAll.find((list) => list.id === $query.id))
  const canImport = $derived(
    importList != null && importList.id !== LIST_IDS.LAST_PLAYED &&
      (importList.type === 'default' || importList.type === 'general') &&
      (importList.meta.songCount > 0 || importList.type === 'general')
  )
  const importMusic = () => {
    if (!importList || !canImport) return
    void importLocalFile(importList as AnyListen.List.MyListInfo).catch((error: unknown) => {
      console.error('[mobile] 导入本地音乐失败', error)
    })
  }

  /**
   * 顶栏标题。**必须按路径前缀判断**：svelte-spa-router 的 `$location` 带查询串
   *（实测 `#/library?id=love` → `/library?id=love`），直接等值比较会全部落空。
   */
  function resolveTitle(loc: string): string {
    const currentPath = loc.split('?')[0] ?? ''
    if (currentPath.startsWith('/extenstion')) return tm('mobile__extension_manage')
    if (currentPath.startsWith('/library')) return tm('mobile__tab_library')
    if (currentPath.startsWith('/online')) return tm('mobile__tab_online')
    if (currentPath.startsWith('/search')) return tm('mobile__tab_search')
    if (currentPath === '/settings') {
      switch (settingsRoute.kind) {
        case 'section':
          return i18n.t(SETTINGS_SECTION_TITLE_KEYS[settingsRoute.section])
        case 'extension':
          return tm('mobile__settings_extension')
        case 'logs':
          return i18n.t('settings__type_logs')
        default:
          return t('setting')
      }
    }
    return tm('mobile__tab_library')
  }

  const title = $derived.by(() => {
    void $_locale
    return resolveTitle($location)
  })

  const goBack = () => {
    if (isSettingsChild && history.length <= 1) {
      void replace('/settings')
      return
    }
    // 深链直达时 history 里没有上一页，回退会直接退出应用 —— 兜底回曲库
    if (history.length > 1) history.back()
    else void replace('/library')
  }
</script>

<!--
  N-2 壳层骨架：**它自己不含任何业务逻辑**，只负责"顶栏插槽 + 路由内容 + MiniPlayer + TabBar"的纵向排布。
  上游 `Main.svelte` 提供 `#view{flex:auto}`，这里由 `.content` 承担同一职责，
  所以 `views/*` 的根节点 `.view-container` 不需要改。
-->
<div class="shell" class:with-player={hasMusic} class:is-root={isRoot}>
  <MobileAppBar {title} back={!isRoot} onback={goBack} search={isOnline}>
    {#snippet actions()}
      {#if isOnline}
        <MobileOnlineSearch />
      {:else if isLibrary && canImport}
        <button class="ab-entry" type="button" aria-label={tm('mobile__library_empty_import')} onclick={importMusic}>
          {tm('mobile__library_import')}
        </button>
      {/if}
    {/snippet}
  </MobileAppBar>
  <main class="content" id="view">
    <Router {routes} />
  </main>
  {#if hasMusic}
    <MiniPlayer />
  {/if}
  <MobileTabBar />
</div>

<style lang="less">
  .shell {
    position: relative;
    display: flex;
    flex: auto;
    flex-flow: column nowrap;
    height: 100%;
    min-height: 0;
    background-color: var(--color-content-background);
  }
  .content {
    position: relative;
    flex: auto;
    min-height: 0;
    overflow: hidden;

    /*
     * 必须逐字复刻上游 `components/layout/Main.svelte` 的这条规则：
     * `views/*` 的根节点 `.view-container` 自己带 `flex: 1 1 auto`，但它并不是
     * 本元素的 flex 子项语义来源 —— 上游是靠 `position: absolute; inset: 0`
     * 让它撑满 `#view` 的。缺了这条，`.view-container` 的高度退化为 `auto`；
     * 一旦视图内容是绝对定位（如空态），高度就会塌成 0，内容被顶出视口。
     */
    > :global(.view-container) {
      position: absolute !important;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
  }

  /* 顶栏右侧入口（D-12）：命中区 44×44 起步（--touch-min），描边款与空态按钮同一套
     主题安全语言（ERR-008：主色填充 + 主色文字 = 同色不可见，所以不用实心主色）。 */
  .ab-entry {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    min-width: var(--touch-min);
    height: var(--touch-min);
    padding: 0 14px;
    font-size: 13px;
    font-weight: 500;
    color: var(--color-primary-font);
    white-space: nowrap;
    cursor: pointer;
    background: transparent;
    border: 1.5px solid var(--color-primary-alpha-200);
    border-radius: 22px;

    &:active {
      background-color: var(--color-primary-background-active);
    }
  }
  /* 子页面自己带滚动容器（VirtualizedList / settings list），外层不再滚 */
</style>
