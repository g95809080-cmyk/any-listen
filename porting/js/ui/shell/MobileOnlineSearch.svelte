<script lang="ts">
  import SvgIcon from '@ui/components/base/SvgIcon.svelte'
  import { toOnlineSearch } from '@ui/modules/resource/actions'
  import { query } from '@ui/plugins/routes'
  import { t, tm } from '../i18n'

  let text = $state('')
  let input = $state<HTMLInputElement | null>(null)
  let composing = false

  $effect(() => {
    const current = $query.q ?? ''
    if (document.activeElement !== input) text = current
  })

  function submit(event: SubmitEvent) {
    event.preventDefault()
    if (composing) return
    const keyword = text.trim()
    if (!keyword) return
    void toOnlineSearch(keyword)
    input?.blur()
  }

  function clear() {
    text = ''
    if ($query.q) void toOnlineSearch('')
    input?.focus()
  }
</script>

<form class="online-search" role="search" onsubmit={submit}>
  <input
    bind:this={input}
    bind:value={text}
    type="search"
    enterkeyhint="search"
    autocomplete="off"
    aria-label={tm('mobile__search_placeholder')}
    placeholder={tm('mobile__search_placeholder')}
    oncompositionstart={() => { composing = true }}
    oncompositionend={() => { composing = false }}
    onkeydown={(event) => {
      if (event.key === 'Enter' && (event.isComposing || composing)) event.preventDefault()
    }}
  />
  {#if text}
    <button type="button" aria-label={t('btn_clear')} onclick={clear}>
      <SvgIcon name="window-close" />
    </button>
  {/if}
  <button type="submit" aria-label={tm('mobile__tab_search')}>
    <SvgIcon name="search" />
  </button>
</form>

<style lang="less">
  :global(html.mobile) .online-search {
    display: flex;
    align-items: center;
    width: 100%;
    min-width: 0;
    height: var(--touch-min);
    overflow: hidden;
    background: var(--color-primary-light-300-alpha-700);
    border-radius: 22px;

    &:focus-within {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
    }

    input {
      flex: 1 1 auto;
      min-width: 0;
      height: 100%;
      padding: 0 0 0 12px;
      font-size: 15px;
      color: var(--color-font);
      background: transparent;
      border: 0;
      outline: none;
    }

    button {
      display: flex;
      flex: 0 0 var(--touch-min);
      align-items: center;
      justify-content: center;
      width: var(--touch-min);
      height: var(--touch-min);
      padding: 0;
      color: var(--color-font);
      background: transparent;
      border: 0;

      &:active { background: var(--color-button-background-active); }
      &:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -2px; }
      & :global(.svg-icon) { width: 20px; height: 20px; }
    }
  }
</style>
