<script lang="ts">
  import Empty from '@/components/material/Empty.svelte'
  import { useOnlineExtensionList } from '@/modules/extension/reactive.svelte'
  import { getOnlineExtensionList } from '@/modules/extension/store/actions'

  // import { extensionList } from '@/modules/extension/reactive'
  import ListItemOnline from '@ui/views/Extenstion/ListItemOnline.svelte'
  import { t } from '@/plugins/i18n'
  import { verticalScrollbar } from '@/shared/compositions/verticalScrollbar.svelte'
  import { showExtensionDetailModal } from '@/components/apis/extensionDetail'
  let loading = $state(false)

  const list = useOnlineExtensionList()

  $effect(() => {
    loading = true
    void getOnlineExtensionList().finally(() => {
      loading = false
    })
  })
</script>

<div class="container">
  {#if list.val.length}
    <ul class="list ext-list" {@attach verticalScrollbar({ offset: '0.22rem' })}>
      {#each list.val as ext (ext.id)}
        <ListItemOnline
          {ext}
          onshowdetail={async () => {
            await showExtensionDetailModal(ext)
          }}
        />
      {/each}
    </ul>
  {:else}
    <Empty label={loading ? $t('loading') : ''} />
  {/if}
</div>

<style lang="less">
  /*
   * O-9：扩展商店列表的手机布局（D-33）。
   *
   * 上游是桌面优先的双列：`repeat(auto-fill, minmax(300px, 1fr))`，卡片自身还有
   * `min-width: 300px`。这在本构建里会错位成两件事：
   * 　① 300px 被 postcss-pxtorem 换算成 rem，按当前根字号只有 ~174px，于是 393px 视口
   * 　　 被切成两列 174px；
   * 　② 卡片内容仍按 280px 的固有宽度排版，比它所在的网格列还宽 → 卡片互相压盖、
   * 　　 右侧被裁切（截图 artifacts/d32-store.png 可见）。
   * 手机上一列足够（卡片本身有图标+两行文字+按钮），改成单列后宽度由容器决定。
   *
   * 只在**这个页面**生效：`.list` 是 Tab/其它列表共用的类名，全局改会波及曲库与设置。
   */
  .container {
    position: relative;
    display: flex;
    flex: auto;
    flex-flow: column nowrap;
    min-height: 0;
    margin-top: 15px;
  }
  .list {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
    min-height: 0;
    padding: 0 16px 16px;
    overflow: hidden;
  }
</style>
