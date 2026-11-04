<script lang="ts">
  /**
   * O-1 —— 曲库歌曲列表的移动端覆盖（**整文件覆盖**，由 vite 覆写表顶替
   * `@/components/common/MusicList/List/index.svelte`，`source/` 一字未改）。
   *
   * 与上游的差异只有 4 处，其余逻辑（虚拟列表、选中、快捷键、搜索定位、重复歌曲弹窗、
   * 排序弹窗）**逐行保留**：
   *
   * 1. 行高系数 `3.2` → `4.5`：72dp 行（16px 基准字号 × 4.5）是 uiux 的触控底线；
   *    3.2 只有 52dp，配合封面 42dp 后文字区只剩 2 行挤在 52dp 里。
   * 2. 新增「多选」入口按钮：上游靠表头复选框进多选，而表头在移动端被
   *    `mobile.less` §4 隐藏了（4 列 → 双行卡片后表头无意义），必须补一个可见入口。
   * 3. 新增多选态底部操作条（`.mobile-select-bar`，样式在 `ui/mobile.less` §13）。
   * 4. **单击即播**（D-16）：上游 `action.ts` 的 `musicClick` 是手写的 400ms 双击窗口 ——
   *    首击只记录时间、不出声，这对桌面「单击选中 / 双击播放」是合理的，但触屏没有
   *    双击语义（用户不会为了放一首歌先点两下）。这里改为单击直接 `playMusic`，
   *    选中态仍由 `select.setSelectIndex` 维护；键盘 Enter（`isKey`）本来就该一次触发。
   *
   * **长按不进多选**（与 uiux 规格的差异，已报备）：长按统一交给
   * `ui/compositions/longPress.ts` 在 document 层合成 `contextmenu`，
   * 这样上游 34 处右键菜单（不止这个列表）全部可用，语义只有一套。
   * 多选则由第 2 点的按钮进入 —— 两个能力都可达，且不互相抢手势。
   */
  import VirtualizedList from '@ui/components/base/VirtualizedList.svelte'
  import Empty from '@ui/components/material/Empty.svelte'
  import { playMusicInfo } from '@ui/modules/player/reactive.svelte'
  import { useListItemHeight } from '@ui/modules/app/reactive.svelte'
  import { appEvent } from '@ui/modules/app/store/event'
  import { type ComponentExports, onMount, untrack } from 'svelte'

  import Menu from '@ui/components/common/MusicList/List/Menu.svelte'
  import ListItem from '@ui/components/common/MusicList/List/ListItem.svelte'
  import Header from '@ui/components/common/MusicList/List/Header.svelte'
  import SearchList from '@ui/components/common/MusicList/List/components/SearchList.svelte'
  import DuplicateMusicModal from '@ui/components/common/MusicList/List/components/DuplicateMusicModal/index.svelte'
  import ListSortModal from '@ui/components/common/MusicList/List/components/ListSortModal.svelte'
  import { playMusic } from '@ui/components/common/MusicList/List/action'
  import { useSelect } from '@ui/components/common/MusicList/List/useSelect.svelte'
  import { useHotkey } from '@ui/components/common/MusicList/List/useHotkey.svelte'
  import { getListMetaInfo } from '@ui/components/common/MusicList/shared'
  import type { ListInfo } from '@ui/components/common/MusicList/type'

  import { t, tm } from '@porting/ui/i18n'

  let {
    source,
    listinfo,
    list,
    multimode = $bindable(),
    finding = $bindable(),
    duplicate = $bindable(),
    listsort = $bindable(),
    loaded,
    onscroll,
  }: {
    listinfo: ListInfo
    list: AnyListen.Music.MusicInfo[]
    source: AnyListen.Player.SourceType
    multimode: boolean
    finding: boolean
    duplicate: boolean
    listsort: boolean
    loaded: boolean
    onscroll?: (pos: number) => void
  } = $props()

  let virtualizedList = $state<ComponentExports<typeof VirtualizedList<AnyListen.Music.MusicInfo>> | null>(null)

  let playingIndex = $derived(
    $playMusicInfo?.listId == listinfo.id ? list.findIndex((m) => m.id == $playMusicInfo.musicInfo.id) : -1
  )
  // ← 改动 1：3.2 → 4.5（52dp → 72dp）
  let listItemHeight = useListItemHeight(4.5)
  let picwidth = $derived(listItemHeight.val * 0.8)
  let picStyle = $derived(`height:${picwidth}px; width:${picwidth}px;`)
  let activeIndex = $state(-1)
  let itv: number | null = null
  let unmounted = false
  const clearIntv = () => {
    if (!itv) return
    clearInterval(itv)
    itv = null
  }

  const scrollToIndex = (idx: number, animate = true) => {
    clearIntv()
    virtualizedList?.scrollToIndex(idx, -100, animate, (end) => {
      if (!end || unmounted) return
      clearIntv()
      activeIndex = idx
      let count = 0
      let curItv = setInterval(() => {
        if (curItv != itv) return
        activeIndex = ++count % 2 ? -1 : idx
        if (count > 2) clearIntv()
      }, 400)
      itv = curItv
    })
  }
  let select = useSelect({
    get isShiftDown() {
      return hotkey.isShiftDown
    },
    get list() {
      return list
    },
  })
  let hotkey = useHotkey({
    getListEl() {
      return virtualizedList?.getListEl()
    },
    selectAll() {
      multimode ||= true
      select.override([...list])
    },
  })

  let menu = $state<ComponentExports<typeof Menu> | null>(null)
  $effect(() => {
    if (multimode) {
      untrack(() => {
        const len = list.length
        if (select.selectIndex < len) return
        select.setSelectIndex(len ? len - 1 : 0)
      })
    } else {
      select.clearSelect()
    }
  })
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    list
    select.clearSelect()
  })
  onMount(() => {
    const unsub = appEvent.on('scrollListTo', (listId, musicId) => {
      if (listinfo.id != listId) return
      const idx = list.findIndex((m) => m.id == musicId)
      if (idx < 0) return
      scrollToIndex(idx)
    })
    return () => {
      if (itv) clearInterval(itv)
      unmounted = true
      unsub()
    }
  })
  export const setScrollPosition = (number: number, animate?: boolean) => {
    virtualizedList?.scrollTo(number, animate)
  }
  export const setScrollIndex = (number: number, animate = false) => {
    scrollToIndex(number, animate)
  }
  export const getScrollPosition = () => {
    return virtualizedList?.getScrollTop() ?? 0
  }

  // ← 改动 2：移动端多选入口（表头被 mobile.less 隐藏后唯一的入口）
  const enterMultiMode = () => {
    multimode = true
  }
  const exitMultiMode = () => {
    multimode = false
  }
  const selectAll = () => {
    select.override(select.list.length == list.length ? [] : [...list])
  }
</script>

<Header
  {multimode}
  {picwidth}
  selectall={list.length > 0 && select.list.length == list.length}
  disabledselect={!list.length}
  onselectall={(all) => {
    select.override(all ? [...list] : [])
  }}
/>
{#if list.length}
  <div class="container">
    <VirtualizedList
      {list}
      keyname="id"
      itemheight={listItemHeight.val}
      bind:this={virtualizedList}
      containerclass="my-list"
      {onscroll}
    >
      {#snippet row(item, index)}
        <ListItem
          musicinfo={item}
          listid={listinfo.id}
          {source}
          active={activeIndex == index}
          selected={select.list.includes(item)}
          selectedactive={hotkey.isShiftDown && select.selectIndex == index}
          {index}
          {picStyle}
          playing={playingIndex == index}
          oncontextmenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            activeIndex = index
            menu!.show(
              {
                listId: listinfo.id,
                musicInfo: item,
                selectedList: select.list,
                onRemoveAllSelected() {
                  multimode = false
                },
              },
              { x: event.pageX, y: event.pageY }
            )
          }}
          onclick={() => {
            if (multimode || hotkey.isKeyMultiKeyDown()) {
              multimode ||= true
              select.handleSelect(index)
            } else {
              select.setSelectIndex(index)
              // 移动端单击即播（D-16）：不使用上游的 400ms 双击窗口，见文件头第 4 条差异
              void playMusic(listinfo.id, list, item, source, getListMetaInfo(listinfo))
            }
          }}
          onplay={() => {
            void playMusic(listinfo.id, list, item, source, getListMetaInfo(listinfo))
          }}
        />
      {/snippet}
    </VirtualizedList>

    {#if !multimode}
      <button class="multiselect-entry" onclick={enterMultiMode}>{tm('mobile__multi_select')}</button>
    {:else}
      <!-- ← 改动 3：多选态底部操作条（样式在 ui/mobile.less §13） -->
      <div class="mobile-select-bar">
        <span class="count">{tm('mobile__selected_count', { num: select.list.length })}</span>
        <button class="bar-btn" onclick={selectAll}>{t('select_all')}</button>
        <button class="bar-btn" onclick={exitMultiMode}>{t('batch_select_exit')}</button>
      </div>
    {/if}

    <Menu
      bind:this={menu}
      {source}
      type={listinfo.type}
      deviceid={listinfo.type == 'local' ? listinfo.listMeta.deviceId : null}
      onplay={async (musicInfo) => {
        void playMusic(listinfo.id, list, musicInfo, source, getListMetaInfo(listinfo))
      }}
      onhide={() => {
        activeIndex = -1
      }}
      oncancelmulti={() => {
        multimode = false
      }}
    />
  </div>
{:else if loaded}
  <Empty />
{/if}
<SearchList
  bind:visible={finding}
  {list}
  onselect={(idx, isPlay) => {
    if (isPlay) {
      void playMusic(listinfo.id, list, list[idx], source, getListMetaInfo(listinfo))
    } else {
      scrollToIndex(idx)
    }
  }}
/>
<DuplicateMusicModal bind:visible={duplicate} {listinfo} />
<ListSortModal bind:visible={listsort} {listinfo} />

<style lang="less">
  .container {
    position: relative;
    flex: auto;
    min-height: 0;
    margin: 0 6px;
    overflow: hidden;
  }

  /* 多选入口：贴列表右下角悬浮，44×44 命中区。
     不放进 Header 是因为 Header 在移动端被整块隐藏（mobile.less §4），
     而多选是高频操作，必须有稳定的可达位置。 */
  .multiselect-entry {
    position: absolute;
    right: 8px;
    bottom: calc(12px + var(--safe-bottom, 0px));
    z-index: 4;
    min-width: 44px;
    min-height: 44px;
    padding: 0 14px;
    font-size: 13px;
    color: var(--color-button-font);
    background-color: var(--color-button-background);
    border: 0;
    border-radius: 22px;
    box-shadow: 0 2px 8px rgb(0 0 0 / 24%);
  }

  .bar-btn {
    flex: none;
    min-width: 44px;
    min-height: 44px;
    padding: 0 12px;
    font-size: 13px;
    color: var(--color-font);
    background: transparent;
    border: 0;
    border-radius: 22px;
  }
</style>
