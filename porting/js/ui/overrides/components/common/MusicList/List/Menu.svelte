<script lang="ts">
  import { tick } from 'svelte'
  import { t } from '@/plugins/i18n'
  import Menu, { type MenuList } from '@/components/base/Menu.svelte'
  import {
    copyName,
    dislikeMusic,
    locateMusic,
    playMusicLater,
    removeMusic,
    updateMusicPosition,
  } from '@ui-raw/components/common/MusicList/List/action'
  import { hasDislike } from '@/modules/dislikeList/store/actions'
  import type { MenuSelectInfo } from '@ui-raw/components/common/MusicList/type'
  import { showMusicAddModal } from '@/components/apis/musicAddModal'
  import { showMusicCommentModal } from '@/components/apis/musicCommentModal'
  import { appState } from '@/modules/app/store/state'
  import { showMusicToggleModal } from '@/components/common/MusicList/List/components/MusicToggleModal'
  import { showMusicSortModal } from '@/components/common/MusicList/List/components/MusicSortModal'
  import { tm } from '@porting/ui/i18n'
  import { cacheMusic, getMusicCacheTask } from '@porting/ui/musicCache'

  type ListType = 'default' | AnyListen.List.UserListType
  let {
    source,
    type,
    deviceid,
    onplay,
    onhide,
    oncancelmulti,
  }: {
    source: AnyListen.Player.SourceType
    type: ListType
    deviceid: string | null
    onplay: (musicInfo: AnyListen.Music.MusicInfo) => Promise<void>
    onhide?: () => void
    oncancelmulti: () => void
  } = $props()

  type MenuType =
    | 'play'
    | 'cache'
    | 'download'
    | 'playLater'
    | 'addTo'
    | 'moveTo'
    | 'detail'
    | 'sort'
    | 'toggleSource'
    | 'comment'
    | 'copyName'
    | 'sourceDetail'
    | 'search'
    | 'locate'
    | 'dislike'
    | 'remove'
  let menuVisible = $state.raw(false)
  let menuLocation = $state.raw({ x: 0, y: 0 })
  let menus = $state.raw<MenuList<MenuType>>([])
  let selectInfo: MenuSelectInfo

  const getCacheMenu = (musicInfo: AnyListen.Music.MusicInfo): { label: string; disabled: boolean } => {
    if (musicInfo.isLocal) return { label: tm('mobile__cache_music'), disabled: true }
    const task = getMusicCacheTask(musicInfo.id)
    if (task?.state === 'complete') return { label: tm('mobile__cached'), disabled: true }
    if (task?.state === 'failed') return { label: tm('mobile__cache_retry'), disabled: false }
    if (task?.state === 'resolving') return { label: tm('mobile__cache_resolving'), disabled: true }
    if (task?.state === 'queued') return { label: tm('mobile__cache_queued'), disabled: true }
    if (task?.state === 'downloading') {
      const percent = task.total > 0 ? Math.min(100, Math.round((task.downloaded / task.total) * 100)) : null
      return {
        label:
          percent == null
            ? tm('mobile__cache_downloading_unknown')
            : tm('mobile__cache_downloading', { percent }),
        disabled: true,
      }
    }
    return { label: tm('mobile__cache_music'), disabled: false }
  }

  const setMenu = () => {
    let dislike = hasDislike(selectInfo.musicInfo)
    const local = source === 'local'
    const localList = deviceid != null
    const notLocalList = localList && deviceid != appState.machineId
    const notLocalMusic = notLocalList || selectInfo.musicInfo.meta.deviceId != appState.machineId
    const cacheMenu = getCacheMenu(selectInfo.musicInfo)
    const newMenu: Array<MenuList<MenuType>[number] | false> = [
      { action: 'play', label: $t('user_list_music_menu__play') },
      !selectInfo.musicInfo.isLocal && {
        action: 'cache',
        disabled: cacheMenu.disabled,
        label: cacheMenu.label,
      },
      { action: 'playLater', label: $t('user_list_music_menu__play_later') },
      null,
      { action: 'addTo', label: $t('user_list_music_menu__add_to') },
      local && !localList && { action: 'moveTo', label: $t('user_list_music_menu__move_to') },
      local && { action: 'sort', label: $t('user_list_music_menu__sort') },
      local &&
        !(['local', 'remote'] as ListType[]).includes(type) && {
          action: 'toggleSource',
          label: $t('user_list_music_menu__toggle_source'),
        },
      null,
      { action: 'comment', label: $t('user_list_music_menu__comment') },
      { action: 'copyName', label: $t('user_list_music_menu__copy_name') },
      null,
      { action: 'dislike', disabled: dislike, label: $t('user_list_music_menu__dislike') },
      local && { action: 'remove', disabled: notLocalList, label: $t('user_list_music_menu__remove') },
    ]
    if (import.meta.env.VITE_IS_DESKTOP) {
      if (selectInfo.musicInfo.isLocal) {
        newMenu.splice(newMenu.findIndex((m) => m && m.action === 'comment') + 1, 0, {
          action: 'locate',
          disabled: notLocalMusic,
          label: $t('user_list_music_menu__locate'),
        })
      }
    }
    menus = newMenu.filter((m) => m !== false) as MenuList<MenuType>
  }

  export const show = async (_selectInfo: MenuSelectInfo, position: { x: number; y: number }) => {
    selectInfo = _selectInfo
    menuLocation = position
    setMenu()
    await tick()
    menuVisible = true
  }

  const handleClick = (menu: NonNullable<(typeof menus)[number]>) => {
    switch (menu.action) {
      case 'play':
        void onplay?.(selectInfo.musicInfo)
        break
      case 'cache':
        void cacheMusic(selectInfo.musicInfo, { notify: true })
        break
      case 'playLater':
        void playMusicLater(
          selectInfo.listId,
          selectInfo.musicInfo,
          selectInfo.selectedList,
          source,
          selectInfo.onRemoveAllSelected
        )
        break
      case 'addTo':
        void showMusicAddModal(
          false,
          selectInfo.listId,
          selectInfo.selectedList.length ? selectInfo.selectedList : [selectInfo.musicInfo]
        )
        break
      case 'moveTo':
        void showMusicAddModal(
          true,
          selectInfo.listId,
          selectInfo.selectedList.length ? selectInfo.selectedList : [selectInfo.musicInfo]
        )
        break
      case 'sort': {
        const mInfo = selectInfo.musicInfo
        const selectedLength = selectInfo.selectedList.length
        void showMusicSortModal(mInfo, selectedLength).then((num) => {
          if (num == null) return
          if (selectInfo.musicInfo !== mInfo || selectInfo.selectedList.length !== selectedLength) return
          const musics = selectInfo.selectedList.length ? selectInfo.selectedList : [selectInfo.musicInfo]
          void updateMusicPosition(
            selectInfo.listId,
            num,
            musics.map((m) => m.id)
          ).then(() => {
            oncancelmulti()
          })
        })
        break
      }
      case 'comment':
        void showMusicCommentModal(selectInfo.musicInfo)
        break
      case 'copyName':
        copyName(selectInfo.musicInfo)
        break
      case 'locate':
        locateMusic(selectInfo.musicInfo as AnyListen.Music.MusicInfoLocal)
        break
      case 'toggleSource':
        void showMusicToggleModal(selectInfo.musicInfo, selectInfo.listId)
        break
      case 'dislike':
        void dislikeMusic(selectInfo.musicInfo)
        break
      case 'remove':
        void removeMusic(selectInfo.listId, selectInfo.musicInfo, selectInfo.selectedList, selectInfo.onRemoveAllSelected)
        break
      default:
        break
    }
    menuVisible = false
  }
</script>

<Menu bind:visible={menuVisible} {menus} location={menuLocation} onclick={handleClick} {onhide} />
