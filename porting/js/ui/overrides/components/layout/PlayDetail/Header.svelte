<script lang="ts">
  /**
   * O-7 —— 播放详情页顶栏（**整文件覆盖**，由 vite 覆写表顶替
   * `@/components/layout/PlayDetail/Header.svelte`，`source/` 一字未改）。
   *
   * ## 为什么必须覆盖（D-10 的根因 ①）
   *
   * 上游顶栏的模板是：
   * ```svelte
   * {#if import.meta.env.VITE_IS_DESKTOP} <div class="header drag-no-modal"> … {/if}
   * {#if import.meta.env.VITE_IS_WEB}     <div class="header" {@attach windowDarg}> … {/if}
   * ```
   * 本移植构建把 `VITE_IS_DESKTOP` / `VITE_IS_WEB` **双双置为 false**
   * （`vite.config.mjs` 的 define 段，arch §6.3 的三段式条件分支），于是：
   *
   * 1. 顶栏两个分支都不渲染 → `bind:this={domBtns}` **永远不会被赋值**；
   * 2. `onMount` 里 `domBtns!.addEventListener('mouseover', …)` 直接抛
   *    `Uncaught TypeError: Cannot read properties of undefined (reading 'addEventListener')`
   *    （实测 `@main.CgvrA_B_.js:36304`）→ 播放详情组件树的后续刷新中断 → 整屏白；
   * 3. 顺带：**关闭键也不存在**，播放详情页没有任何关闭入口（只能长按触发 contextmenu，
   *    或按系统返回键——而后者的契约见 `ui/boot/androidBack.ts`）。
   *
   * ## 与上游的差异（只有这两处，其余逐行保留）
   *
   * 1. `onMount` 内挂监听前先判空（并返回一个只做 `unsub()` 的清理函数，
   *    避免提前 return 把 `appEvent.on('focus')` 的订阅漏掉）。
   * 2. 模板补一个 `{#if import.meta.env.VITE_IS_ANDROID}` 分支渲染顶栏 —— uiux
   *    `phase3-uiux-impl-spec.md` §5 明确要求「播放详情顶栏控制键（关闭/全屏）→ 44dp，
   *    隐藏全屏键」，所以 Android 上顶栏本来就该存在（全屏键由 mobile.less §5 隐藏）。
   *    **没有这条，判空之后 to 空的顶栏仍然没有关闭键**，等于用"不报错"换"关不掉"。
   *
   * 导入路径：本文件不在 `view-main/src` 下，`@/` 会先查 `porting/js/host`、再查
   * `web-server/src`，所以统一用 `@ui/` 显式指向 `source/packages/view-main/src`
   * （与 O-1 / O-2 的覆盖文件保持一致）。
   */
  import { setMaximized, windowDarg } from '@ui/shared/browser/widnow.svelte'
  import { t } from '@ui/plugins/i18n'
  import { setShowPlayDetail } from '@ui/modules/playDetail/store/action'
  import { onMount } from 'svelte'
  import { appEvent } from '@ui/modules/app/store/event'
  import { useIsFullscreen } from '@ui/modules/app/reactive.svelte'
  import { setFullScreen } from '@ui/modules/app/store/action'

  const fullscreenState = useIsFullscreen()

  let domBtns = $state<HTMLDivElement>()

  onMount(() => {
    const getBtnEl = (el: HTMLElement | null): HTMLButtonElement | null => {
      return el ? (el.tagName == 'BUTTON' ? (el as HTMLButtonElement) : getBtnEl(el.parentNode as HTMLElement | null)) : null
    }
    const handleMouseover = (event: MouseEvent) => {
      const btn = getBtnEl(event.target as HTMLElement)
      if (!btn) return
      btn.classList.add('hover')
    }
    const handleMouseout = (event: MouseEvent) => {
      const btn = getBtnEl(event.target as HTMLElement)
      if (!btn) return
      btn.classList.remove('hover')
    }

    const unsub = appEvent.on('focus', () => {
      if (!domBtns) return
      for (const node of domBtns.childNodes) {
        if ((node as HTMLElement).tagName != 'BUTTON') continue
        ;(node as HTMLElement).classList.remove('hover')
      }
    })
    // ⚠️ 与上游唯一的差异之一：`domBtns` 可能还没绑定（Svelte 5 的 `bind:this` 赋值
    // 不保证早于 onMount；任一平台分支未渲染时它干脆永远为空）—— 不判空必抛 TypeError。
    if (!domBtns) {
      return () => {
        unsub()
      }
    }
    domBtns.addEventListener('mouseover', handleMouseover)
    domBtns.addEventListener('mouseout', handleMouseout)
    return () => {
      unsub()
      domBtns?.removeEventListener('mouseover', handleMouseover)
      domBtns?.removeEventListener('mouseout', handleMouseout)
    }
  })
</script>

{#snippet content()}
  <div bind:this={domBtns} class="control-btn no-drag">
    {#if import.meta.env.VITE_IS_DESKTOP}
      {#if fullscreenState.isFullscreen}
        <button
          type="button"
          class="fullscreen"
          data-click-hide
          aria-label={$t('fullscreen_exit')}
          onclick={() => {
            setFullScreen(false)
          }}
        >
          <svg version="1.1" height="60%" viewBox="0 0 24 24">
            <use xlink:href="#icon-window-fullscreen-exit" />
          </svg>
        </button>
      {/if}
    {/if}
    {#if import.meta.env.VITE_IS_WEB}
      <button
        type="button"
        class="fullscreen"
        data-click-hide
        aria-label={fullscreenState.isFullscreen ? $t('maximized_exit') : $t('maximized')}
        onclick={() => {
          setMaximized(!fullscreenState.isFullscreen)
        }}
      >
        <svg version="1.1" height="60%" viewBox="0 0 24 24">
          <use xlink:href={fullscreenState.isFullscreen ? '#icon-window-restore' : '#icon-window-maximize'} />
        </svg>
      </button>
    {/if}
    <button
      type="button"
      class="hide"
      data-click-hide
      aria-label={$t('play_detail.hide_tip')}
      onclick={() => {
        setShowPlayDetail(false)
      }}
    >
      <svg version="1.1" height="35%" viewBox="0 0 30.727 30.727">
        <use xlink:href="#icon-window-hide" />
      </svg>
    </button>
  </div>
{/snippet}

{#if import.meta.env.VITE_IS_DESKTOP}
  <div class="header drag-no-modal">
    {@render content()}
  </div>
{/if}
{#if import.meta.env.VITE_IS_WEB}
  <div class="header" {@attach windowDarg}>
    {@render content()}
  </div>
{/if}
<!-- 与上游的差异之二：Android 也要顶栏（关闭键 = 播放详情页唯一的关闭入口）。
     `windowDarg` 是 Electron/浏览器窗口拖拽，Android 上不需要；全屏键由 mobile.less §5 隐藏。 -->
{#if import.meta.env.VITE_IS_ANDROID}
  <div class="header">
    {@render content()}
  </div>
{/if}

<style lang="less">
  :global(.fullscreen) {
    .header {
      align-self: flex-start;
      // .control-btn {
      //   .close,
      //   .min {
      //     display: none;
      //   }
      //   .fullscreenExit {
      //     display: flex;
      //   }
      // }
    }
  }
  .header {
    position: relative;
    flex: none;
    flex: 0 0 @height-toolbar;
    align-self: flex-start;
    width: 100%;

    .control-btn {
      position: absolute;
      top: 0;
      right: 0;
      display: flex;

      button {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 46px;
        height: 30px;
        padding: 1px;
        color: var(--color-font-label);
        cursor: pointer;
        outline: none;
        background: none;
        border: none;
        transition: background-color 0.2s ease-in-out;

        &:global(.hover) {
          background-color: var(--color-button-background-hover);

          &.close {
            background-color: var(--color-btn-close);
          }
        }
      }

      // .fullscreenExit {
      //   display: none;
      // }
    }
  }
</style>
