<script lang="ts">
  /**
   * O-2 —— 曲库页的移动端覆盖（**整文件覆盖**，由 vite 覆写表顶替
   * `@/views/Library/index.svelte`，`source/` 一字未改）。
   *
   * 与上游的差异只有模板里 `{#if listInfo}` 那一块，**script 段一行未动**
   * （store 订阅、两个 `$effect`、`handleScroll`、`musicList` 绑定、`buildActiveListInfo`
   * 全部逐行保留）—— 这里只做"补空态"，不重构。
   *
   * 上游模板是：
   * ```svelte
   * {#if listInfo}
   *   <MusicList … />
   * {/if}
   * ```
   * `listInfo` 是 `$derived(buildActiveListInfo(...))`，`$query.id` 为空时返回 `undefined`，
   * 而**没有 else 分支** → 内容区一个节点都不渲染（纯白，控制台不报错）。
   *
   * 三种状态：
   * 1. `listInfo` 有值且列表非空 → 原样渲染 `MusicList`；
   * 2. `listInfo` 有值但列表为空 → `MobileEmptyState`（带「导入本地音乐」按钮）；
   * 3. `listInfo` 无值 → 曲库还没 inited 时提示载入中，否则提示未选歌单并给一个入口。
   *
   * 注意第 3 种通常是**瞬态**：`porting/js/entries/main.ts` 补了 `getUserLists()` 之后，
   * `$effect` 会 `replace('/library?id=…')` 把 `$query.id` 补上。之所以仍然保留这一支，
   * 是为了在任何时序意外下都不出现"纯白"。
   *
   * 导入路径说明：本文件不在 `view-main/src` 下，所以 `@/` 会先查 `host/`、再查
   * `web-server/src`，最后才到 `view-main/src`。为了不撞名，这里统一用 `@ui/`（显式指向
   * `source/packages/view-main/src`），与 O-1 的写法保持一致。
   */
  import MusicList from '@ui/components/common/MusicList/MusicList.svelte'
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
    getListPrevSelectId,
    saveListPrevSelectId,
  } from '@ui/modules/musicLibrary/store/actions'
  import { type ComponentExports, tick, untrack } from 'svelte'
  import { LIST_IDS } from '@any-listen/common/constants'
  import { resourceList } from '@ui/modules/extension/reactive.svelte'
  import { LIST_PIC_ICON } from '@ui/shared/constants'

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
    if (id && $userListsAll.some((l) => l.id == id)) {
      void saveListPrevSelectId(id)
    } else {
      void getListPrevSelectId().then((prevId) => {
        void replace(`/library?id=${prevId || LIST_IDS.LOVE}`)
      })
    }
  })
</script>

<div class="view-container container">
  {#if listInfo}
    {#if list.length}
      <MusicList bind:this={musicList} listinfo={listInfo} {list} onscroll={handleScroll} />
    {:else}
      <MobileEmptyState {listInfo} />
    {/if}
  {:else if !$userListInited}
    <div class="fallback">
      <p>正在载入曲库…</p>
    </div>
  {:else}
    <div class="fallback">
      <p>还没有打开任何歌单</p>
      <button class="fallback-btn" type="button" onclick={() => void replace('/library', { id: LIST_IDS.LOVE })}>
        打开「我喜欢」
      </button>
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

  .fallback-btn {
    min-width: 44px;
    height: 44px;
    margin-top: 16px;
    padding: 0 20px;
    font-size: 13px;
    color: var(--color-primary);
    cursor: pointer;
    background: transparent;
    border: 1px solid var(--color-primary);
    border-radius: 22px;

    &:active {
      opacity: 0.6;
    }
  }
  // .list {
  //   flex: auto;
  // }
</style>
