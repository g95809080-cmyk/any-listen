<script lang="ts">
  import SettingItem from '@ui/views/Setting/AppSetting/SettingItem.svelte'
  import type { SettingListSection, SettingListItem } from './settings'

  let {
    settings,
  }: {
    settings: SettingListSection
  } = $props()

  const filterList = $derived(settings.list.filter((item) => item) as SettingListItem[])
</script>

<div class="m-settings-detail">
  <div class="m-settings-detail-scroll">
    <div class="m-settings-detail-card">
      {#each filterList as item (`${settings.id}:${item.id || item.name}`)}
        <SettingItem {item} />
      {/each}
    </div>
  </div>
</div>

<style lang="less">
  .m-settings-detail {
    display: flex;
    flex: auto;
    flex-flow: column nowrap;
    min-height: 0;
    overflow: hidden;
  }
  .m-settings-detail-scroll {
    flex: auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
</style>
