<script lang="ts">
  import Router from '@ui/plugins/svelte-spa-router/Router.svelte'
  import routes, { location, push, replace } from '@ui/plugins/routes'
  import { musicInfo } from '@ui/modules/player/reactive.svelte'
  import { t, tm } from '@porting/ui/i18n'

  import MiniPlayer from './MiniPlayer.svelte'
  import MobileAppBar from './MobileAppBar.svelte'
  import MobileTabBar from './MobileTabBar.svelte'

  const hasMusic = $derived(!!$musicInfo.id)
  /**
   * 根级页面（底部有 MiniPlayer + TabBar 压着）需要留白；
   * 播放详情是 overlay，不走这里。
   */
  const isRoot = $derived(
    ['/online', '/library', '/search', '/settings'].some(
      (p) => $location === p || $location.startsWith(p + '?')
    )
  )

  /**
   * 设置页（D-12）：扩展管理页 `#/extenstion` 在移动壳原本**零入口** ——
   * 上游只把它挂在 `Aside/Nav.svelte` 与 `Header/ControlBtnsDesktop.svelte` 上，
   * 那两个组件移动壳根本不渲染。PDR-002 明确要求保留第三方扩展能力
   *（安装 / 启用 / 停用 / 重启扩展宿主），所以入口必须补上。
   *
   * 落点选「设置页顶栏右侧的一个 44dp 文字按钮」，而不是第 4 个 Tab：
   * 3 Tab 的信息架构已冻结（uiux），扩展管理是低频维护页，不属于一级导航。
   * 用文字而不是图标：图标库里没有语义明确的「扩展」图标，猜一个符号会让人认不出。
   */
  const isSettings = $derived(
    $location === '/settings' || $location.startsWith('/settings?')
  )
  const openExtension = () => {
    void push('/extenstion')
  }

  /**
   * 顶栏标题。**必须按路径前缀判断**：svelte-spa-router 的 `$location` 带查询串
   *（实测 `#/library?id=love` → `/library?id=love`），直接等值比较会全部落空。
   */
  function resolveTitle(loc: string): string {
    const path = loc.split('?')[0] ?? ''
    if (path.startsWith('/extenstion')) return tm('mobile__extension_manage')
    if (path.startsWith('/library')) return tm('mobile__tab_library')
    if (path.startsWith('/online')) return tm('mobile__tab_online')
    if (path.startsWith('/search')) return tm('mobile__tab_search')
    if (path.startsWith('/settings')) return t('setting')
    return tm('mobile__tab_library')
  }

  const title = $derived(resolveTitle($location))

  const goBack = () => {
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
  <MobileAppBar {title} back={!isRoot} onback={goBack}>
    {#snippet actions()}
      {#if isSettings}
        <button class="ab-entry" type="button" onclick={openExtension}>
          {tm('mobile__extension_manage')}
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
