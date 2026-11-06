<script lang="ts">
  /**
   * O-2 —— 曲库页的移动端覆盖（**整文件覆盖**，由 vite 覆写表顶替
   * `@/views/Library/index.svelte`，`source/` 一字未改）。
   *
   * 上游只有「某个歌单的歌曲列表」，歌单一览在桌面 Aside 里。移动壳不渲染 Aside，
   * 而上游 `$effect` 在没有 `id` 时会把路由补成上次选择或 `love`，于是用户看到的
   * 第一屏永远是「我喜欢」，收藏/导入的歌单没有入口。
   *
   * 本覆盖把曲库明确分成两级：
   * 1. `/library`（无 `id`）→ `MobileLibraryLists`：默认「我喜欢」「试听列表」+ 顶层用户歌单；
   * 2. `/library?id=…` → 原来的 `MusicList` 歌曲页；空列表显示 `MobileEmptyState`。
   *
   * 因此第二个 `$effect` 不再做“无 id 就跳上次选择”的兜底；只有 id 失效时才 replace 回一级。
   *
   * 导入路径说明：本文件不在 `view-main/src` 下，所以 `@/` 会先查 `host/`、再查
   * `web-server/src`，最后才到 `view-main/src`。为了不撞名，这里统一用 `@ui/`（显式指向
   * `source/packages/view-main/src`），与 O-1 的写法保持一致。
   */
  import MusicList from '@ui/components/common/MusicList/MusicList.svelte'
  import MobileLibraryLists from '@porting/ui/pages/MobileLibraryLists.svelte'
  import MobileEmptyState from '@porting/ui/pages/MobileEmptyState.svelte'
  import { query, replace } from '@ui/plugins/routes'
  import { getListMusics } from '@ui/modules/musicLibrary/actions'
  import { musicLibraryEvent } from '@ui/modules/musicLibrary/store/event'
  import type { ListInfo } from '@ui/components/common/MusicList/type'
  import { useListCover, userListInited, userListsAll } from '@ui/modules/musicLibrary/reactive.svelte'
  import { dateFormat } from '@ui/shared'
  import {
    getListScrollPosition,
    saveListScrollPosition,
    userListExist,
    sortListMusics,
    saveListPrevSelectId,
  } from '@ui/modules/musicLibrary/store/actions'
  import { type ComponentExports, tick, untrack } from 'svelte'
  import { resourceList } from '@ui/modules/extension/reactive.svelte'
  import { LIST_PIC_ICON } from '@ui/shared/constants'
  import { tm } from '@porting/ui/i18n'

  let list = $state.raw<AnyListen.Music.MusicInfo[]>([])
  let musicList = $state<ComponentExports<typeof MusicList> | null>(null)

  const getTargetActiveListInfo = (allList: typeof $userListsAll, activeId: string) => {
    return allList.find((l) => l.id == activeId)
  }
  const buildActiveListInfo = (
    resourceList: AnyListen.Extension.ResourceList,
    info?: AnyListen.List.MyListInfo,
    listCover?: string | null
  ) => {
    if (!info) return undefined
    switch (info.type) {
      case 'default':
      case 'general':
        return {
          id: info.id,
          name: info.name,
          createTime: info.type == 'default' ? '' : dateFormat(info.meta.createTime, 'Y-M-D'),
          playCount: info.meta.playCount,
          pic: info.type == 'default' ? '' : info.meta.pic || listCover || '',
          picIcon: LIST_PIC_ICON[info.id as keyof typeof LIST_PIC_ICON],
          type: info.type,
        } satisfies ListInfo
      case 'local':
        return {
          id: info.id,
          name: info.name,
          createTime: dateFormat(info.meta.createTime, 'Y-M-D'),
          playCount: info.meta.playCount,
          pic: info.meta.pic || listCover || '',
          type: info.type,
          listMeta: {
            deviceId: info.meta.deviceId,
          },
          getSortTimeFn() {
            return async (list, type) => {
              return sortListMusics(info.id, list, type)
            }
          },
        } satisfies ListInfo
      case 'online':
      case 'remote':
        return {
          id: info.id,
          name: info.name,
          createTime: dateFormat(info.meta.createTime, 'Y-M-D'),
          playCount: info.meta.playCount,
          pic: info.meta.pic || listCover || '',
          type: info.type,
          listMeta: {
            extensionId: info.meta.extensionId,
            source: info.meta.source,
          },
          getSortTimeFn() {
            if (
              info.type === 'remote' &&
              resourceList.listProvider.find((l) => l.extensionId === info.meta.extensionId && l.id === info.meta.source)
                ?.fileSortable
            ) {
              return async (list, type) => {
                return sortListMusics(info.id, list, type)
              }
            }
            return null
          },
        } satisfies ListInfo
    }
  }
  const targetListInfo = $derived(getTargetActiveListInfo($userListsAll, $query.id))
  const listCover = $derived(useListCover(targetListInfo))
  const listInfo = $derived(buildActiveListInfo($resourceList, targetListInfo, listCover.val))

  let currentId = ''
  const handleScroll = (pos: number) => {
    if (!currentId) return
    void saveListScrollPosition(currentId, pos)
  }

  $effect(() => {
    const id = $query.id
    if (id != currentId) {
      currentId = id
      untrack(() => {
        const musicId = $query.mid
        if (!id) return
        void Promise.all([getListMusics(id), getListScrollPosition(id)]).then(([_list, pos]) => {
          list = _list
          void tick().then(() => {
            let idx = -1
            if (musicId) {
              idx = _list.findIndex((m) => m.id == musicId)
              void replace(`/library?id=${id}`)
            }
            if (idx < 0) {
              musicList?.setScrollPosition(pos)
            } else {
              musicList?.setScrollIndex(idx)
            }
          })
        })
      })
    }
    const unsub = musicLibraryEvent.on('listMusicChanged', (ids) => {
      if (!ids.includes(id) || !userListExist(id)) return
      void getListMusics(id).then((_list) => {
        list = [..._list]
      })
    })
    const unsub2 = musicLibraryEvent.on('listMusicUpdated', (updateInfo) => {
      if (!updateInfo.has(id) || !userListExist(id)) return
      void getListMusics(id).then((_list) => {
        list = [..._list]
      })
    })

    return () => {
      unsub()
      unsub2()
    }
  })

  $effect(() => {
    const id = $query.id
    if (!$userListInited) return
    if (!id) return
    if (id && $userListsAll.some((l) => l.id == id)) {
      void saveListPrevSelectId(id)
    } else {
      void replace('/library')
    }
  })
</script>

<div class="view-container container">
  {#if !$query.id}
    <MobileLibraryLists />
  {:else if listInfo}
    {#if list.length}
      <MusicList bind:this={musicList} listinfo={listInfo} {list} onscroll={handleScroll} />
    {:else}
      <MobileEmptyState {listInfo} />
    {/if}
  {:else if !$userListInited}
    <div class="fallback">
      <p>{tm('mobile__library_loading')}</p>
    </div>
  {:else}
    <div class="fallback">
      <p>{tm('mobile__library_loading')}</p>
    </div>
  {/if}
</div>

<style lang="less">
  .container {
    position: relative;
    display: flex;
    flex: auto;
    flex-flow: column nowrap;
    // border-right: 1px solid var(--color-border);
    // background: #fff;
    // overflow: hidden;
    :global(.slider-content) {
      width: 200px;
    }
  }

  /* 第 3 种状态（瞬态）的兜底，样式刻意朴素：它不应该被用户看到 */
  .fallback {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0 24px max(12%, 24px);

    p {
      margin: 0;
      font-size: 13px;
      color: var(--color-font-label);
    }
  }

  // .list {
  //   flex: auto;
  // }
</style>
