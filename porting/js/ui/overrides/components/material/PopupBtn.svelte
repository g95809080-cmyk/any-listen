<!--
  D-34 —— 触屏点 More 后菜单"闪一下就消失"的覆盖（整文件覆盖，`source/` 未改）。

  上游同时用 click 与 mouseenter/mouseleave 控制弹层：click 打开，hover 进入保持、
  移出关闭。触屏 Chrome 在 `click` 之后仍会补发一套兼容 mouse 事件，真机实测顺序是
  `click` → `mouseenter` → 约 100ms 后 `mouseleave` → 再 100ms `visible = false`，
  于是抽屉刚出现就被自己的合成 `mouseleave` 关掉。DOM `button.click()` 不会产生这套
  兼容事件，所以此前只在自动化里"看起来正常"。

  修法：按钮的 hover 开关仅在 `(hover: hover) and (pointer: fine)` 时启用；触摸端只保留
  click 打开。**不能**给 `Popup` 的 `onmouseleave` 加同样的门禁 ——
  `ui/boot/popupDismiss.ts` 正是向 `.popup` 派发合成 `mouseleave` 来执行点遮罩关闭，
  门禁掉它会让抽屉在触屏上彻底关不掉。
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import Popup from '@/components/base/Popup.svelte'
  import type { WheelEventHandler } from 'svelte/elements'
  const {
    autoshow = true,
    children,
    content,
    onwheel,
    'aria-label': arialabel,
    debug,
    height,
    maxheight,
    ontransitionend,
    onvisible,
    btncls,
  }: {
    children: Snippet
    content: Snippet
    btncls?: boolean
    debug?: boolean
    height?: string
    maxheight?: number
    onwheel?: WheelEventHandler<HTMLButtonElement>
    autoshow?: boolean
    'aria-label': string
    ontransitionend?: (visible: boolean) => void
    onvisible?: (visible: boolean) => void
  } = $props()

  let visible = $state(false)
  let domBtn = $state<HTMLElement | null>(null)

  const handleShowPopup = (evt: MouseEvent) => {
    if (visible) {
      evt.stopPropagation()
      if (autoshow) return
      handlMsLeave()
    } else {
      handlMsEnter()
    }
    // setTimeout(() => {
    //   // if (!)
    //   visible.value = !visible.value
    // }, 50)
  }

  let timeout: number | null = null
  const handlMsEnter = () => {
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
    if (visible) return
    timeout = setTimeout(() => {
      visible = true
      onvisible?.(visible)
    }, 100)
  }
  const handlMsLeave = () => {
    if (debug) return
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
    if (!visible) return
    timeout = setTimeout(() => {
      timeout = null
      visible = false
      onvisible?.(visible)
    }, 100)
  }

  // 触屏 WebView 也会让 `(hover: hover)` 命中吗？Android WebView 按主输入设备查询，
  // 纯触摸设备为 false；接鼠标/触控板时才回到桌面 hover 语义。
  const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches
  const handleBtnMouseEnter = () => {
    if (!canHover || !autoshow) return
    handlMsEnter()
  }
  const handleBtnMouseLeave = () => {
    if (!canHover || !autoshow) return
    handlMsLeave()
  }

  export const hide = () => {
    visible = false
    onvisible?.(visible)
  }
</script>

<button
  bind:this={domBtn}
  class="container"
  class:btn={btncls}
  onclick={handleShowPopup}
  onmouseenter={handleBtnMouseEnter}
  onmouseleave={handleBtnMouseLeave}
  aria-label={arialabel}
  {onwheel}
>
  {@render children()}
  <Popup
    {visible}
    {height}
    {maxheight}
    btnel={domBtn}
    ontransitionend={() => {
      ontransitionend?.(visible)
    }}
    onmouseenter={handlMsEnter}
    onmouseleave={handlMsLeave}
  >
    {@render content()}
  </Popup>
</button>

<style lang="less">
  .container {
    position: relative;
    display: inline-block;
    padding: 0;
    background-color: transparent;
    border: none;

    &.btn {
      flex: none;
      width: var(--size, 1.6rem);
      aspect-ratio: 1 / 1;
      padding: 0.25em;
      font-size: 14px;
      color: var(--btn-font, var(--color-button-font));
      cursor: pointer;
      background-color: var(--color-button-background);
      border-radius: @form-radius;
      // outline: none;
      transition: @transition-normal;
      transition-property: background-color, opacity;
      &:hover {
        background-color: var(--color-button-background-hover);
      }
      &:active {
        background-color: var(--color-button-background-active);
      }

      :global(svg) {
        width: 100%;
        height: 100%;
      }
    }
  }
</style>
