<script lang="ts">
  import ExtensionSetting from '@ui/views/Setting/ExtensionSetting/ExtensionSetting.svelte'
  import Logs from '@ui/views/Setting/Logs/Logs.svelte'
  import SettingView from '@ui/views/Setting/AppSetting/SettingView.svelte'
  import { query } from '@ui/plugins/routes'

  import MobileSettingsHome from '@porting/ui/pages/MobileSettingsHome.svelte'
  import { resolveSettingsRoute } from '@porting/ui/settings/navigation'
  import { settings } from './AppSetting/settings'

  const route = $derived(resolveSettingsRoute($query))
  const activeSetting = $derived(
    route.kind === 'section' ? settings.find((section) => section.id === route.section) : undefined
  )
</script>

<div class="view-container m-settings-page">
  {#if route.kind === 'section' && activeSetting}
    <SettingView settings={activeSetting} />
  {:else if route.kind === 'extension'}
    <ExtensionSetting />
  {:else if route.kind === 'logs'}
    <Logs />
  {:else}
    <MobileSettingsHome />
  {/if}
</div>

<style lang="less">
  .m-settings-page {
    display: flex;
    flex-flow: column nowrap;
    min-height: 0;
  }
</style>
