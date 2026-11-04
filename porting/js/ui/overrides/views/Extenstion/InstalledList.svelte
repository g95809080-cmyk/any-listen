<script lang="ts">
  import Empty from '@/components/material/Empty.svelte'
  import { extensionList } from '@/modules/extension/reactive.svelte'
  import ListItem from '@ui/views/Extenstion/ListItem.svelte'
  import type { viewTypes } from '@ui/views/Extenstion/shared'
  import { verticalScrollbar } from '@/shared/compositions/verticalScrollbar.svelte'
  import { showExtensionDetailModal } from '@/components/apis/extensionDetail'
  let { type }: { type: Omit<(typeof viewTypes)[number], 'online'> } = $props()
  let list = $derived(
    type == 'installed'
      ? $extensionList
      : type == 'enabled'
        ? $extensionList.filter((e) => e.enabled)
        : $extensionList.filter((e) => !e.enabled)
  )
</script>

<div class="container">
  {#if list.length}
    <ul class="list ext-list" {@attach verticalScrollbar({ offset: '0.22rem' })}>
      {#each list as ext (ext.id)}
        <ListItem
          {ext}
          onshowdetail={async () => {
            await showExtensionDetailModal(ext)
          }}
        />
      {/each}
    </ul>
  {:else}
    <Empty />
  {/if}
</div>

<style lang="less">
  .container {
    position: relative;
    display: flex;
    flex: auto;
    flex-flow: column nowrap;
    min-height: 0;
    margin-top: 15px;
  }
  .list {
    /* O-11（D-33）：与 O-9 同因。上游双列 `minmax(300px,1fr)` 经 pxtorem 后只有 ~174px，
       而卡片 `min-width:300px` 不缩，装了扩展就会互相压盖。手机改单列。 */
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
    min-height: 0;
    padding: 0 16px 16px;
    overflow: hidden;
  }
</style>
