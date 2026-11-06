<script lang="ts">
  import Image from '@ui/components/base/Image.svelte'
  import SvgIcon from '@ui/components/base/SvgIcon.svelte'
  import { useListCover } from '@ui/modules/musicLibrary/reactive.svelte'
  import { push } from '@ui/plugins/routes'
  import { LIST_PIC_ICON } from '@ui/shared/constants'

  let { listInfo }: { listInfo: AnyListen.List.MyListInfo } = $props()

  const cover = useListCover(listInfo)
  const icon = $derived(LIST_PIC_ICON[listInfo.id as keyof typeof LIST_PIC_ICON] ?? 'music_library')

  const open = () => {
    // 一级列表 → 二级歌曲页必须 push：AppBar 返回键和 Android 返回键都要能回到这里。
    void push(`/library?id=${encodeURIComponent(listInfo.id)}`)
  }
</script>

<button class="row" type="button" aria-label={listInfo.name} onclick={open}>
  <span class="cover">
    <Image src={cover.val} {icon} />
  </span>
  <span class="text">
    <span class="name">{listInfo.name}</span>
    <span class="meta">
      <SvgIcon name="music" />
      {listInfo.meta.songCount}
    </span>
  </span>
  <SvgIcon name="angle-right-solid" />
</button>

<style lang="less">
  .row {
    display: flex;
    flex-flow: row nowrap;
    gap: 12px;
    align-items: center;
    width: 100%;
    min-height: 64px;
    padding: 8px 4px;
    font: inherit;
    color: var(--color-font);
    text-align: left;
    cursor: pointer;
    background: transparent;
    border: 0;
    border-radius: 10px;
    -webkit-tap-highlight-color: transparent;

    &:active {
      background-color: var(--color-primary-background-active);
    }

    :global(.svg-icon:last-child) {
      flex: none;
      width: 18px;
      height: 18px;
      color: var(--color-300);
    }
  }

  .cover {
    display: block;
    flex: none;
    width: 48px;
    height: 48px;
    overflow: hidden;
    border-radius: 10px;
  }

  .text {
    display: flex;
    flex: 1 1 auto;
    flex-flow: column nowrap;
    gap: 4px;
    min-width: 0;
  }

  .name {
    font-size: 15px;
    line-height: 1.3;
    .mixin-ellipsis-1();
  }

  .meta {
    display: flex;
    flex-flow: row nowrap;
    gap: 4px;
    align-items: center;
    font-size: 12px;
    line-height: 1.2;
    color: var(--color-font-label);

    :global(.svg-icon) {
      width: 14px;
      height: 14px;
    }
  }
</style>
