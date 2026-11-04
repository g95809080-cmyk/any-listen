<script lang="ts">
  import Icons from '@ui/components/layout/Icons.svelte'
  import PlayDetail from '@ui/components/layout/PlayDetail/index.svelte'
  import Loading from '@ui/components/layout/Loading.svelte'
  import { useAppAeady } from '@ui/modules/app/reactive.svelte'
  import { onMount } from 'svelte'

  import MobileAppShell from './shell/MobileAppShell.svelte'
  import { installLongPressContextMenu } from './compositions/longPress'

  const appReady = useAppAeady()

  onMount(() => {
    document.documentElement.classList.add('mobile')
    const root = document.getElementById('root')
    if (root) root.style.display = 'block'
    // 全局长按 → contextmenu：让上游 34 处右键菜单在触屏上可用（配合 mobile.less 变 BottomSheet）
    return installLongPressContextMenu()
  })
</script>

<!--
  N-1 与桌面 `App.svelte` 的差异（team-lead 明确要求）：
  - **不渲染 `AppLayout`** → Aside / Header / PlayBar 三个桌面外壳自动消失，不需要 CSS 去藏；
  - 不按 `VITE_IS_DESKTOP/WEB` 分支（移植构建里 VITE_IS_ANDROID 才是真，桌面分支永远不该走）；
  - 不含 `Login`（单机版无登录态）。
  `PlayDetail` 是全屏 overlay（播放页），保留原样；`Icons` 负责 svg sprite 的 <use> 定义。
-->
<div id="container" class="view-container">
  <Icons />
  {#if appReady.appAeady}
    <MobileAppShell />
    <PlayDetail />
  {:else}
    <Loading />
  {/if}
</div>
