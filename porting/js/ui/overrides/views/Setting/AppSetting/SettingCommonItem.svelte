<script lang="ts">
  import { onMount } from 'svelte'

  import Input from '@ui/components/base/Input.svelte'
  import Selection from '@ui/components/base/Selection.svelte'
  import Textarea from '@ui/components/base/Textarea.svelte'
  import { useSettingValue } from '@ui/modules/setting/reactive.svelte'
  import { updateSetting } from '@ui/modules/setting/store/action'
  import { t } from '@ui/plugins/i18n'

  import type { EnumItem, SettingListCommonItem } from './settings'

  let {
    item,
  }: {
    item: SettingListCommonItem
  } = $props()

  let list = $state.raw<EnumItem[]>([])

  onMount(() => {
    let unsubscribe: (() => void) | undefined
    if (item.type === 'radio') {
      if (item.asyncEnum) {
        void item.asyncEnum().then((result) => {
          list = result
        })
      } else {
        list = item.enum!
      }
      if (item.enumUpdated) {
        unsubscribe = item.enumUpdated((result) => {
          list = result
        })
      }
    }

    return () => {
      unsubscribe?.()
    }
  })

  const setting = useSettingValue(item.field)
</script>

{#if item.type === 'input'}
  <section class="m-setting-field">
    <div class="m-setting-field-head">
      <h3 class="m-setting-title">{$t(item.name)}</h3>
      {#if item.description}
        <p class="m-setting-desc">{$t(item.description)}</p>
      {/if}
    </div>
    {#if item.textarea}
      <Textarea
        id={`appSetting_${item.field}_${item.type}`}
        value={setting.val as string}
        onchange={(value) => {
          const next = value.trim()
          if (item.onUpdate) {
            item.onUpdate(next)
          } else {
            void updateSetting({ [item.field]: next })
          }
          item.onChnaged?.(next)
        }}
      />
    {:else}
      <Input
        id={`appSetting_${item.field}_${item.type}`}
        value={setting.val as string}
        onchange={(value) => {
          const next = value.trim()
          if (item.onUpdate) {
            item.onUpdate(next)
          } else {
            void updateSetting({ [item.field]: next })
          }
          item.onChnaged?.(next)
        }}
      />
    {/if}
  </section>
{:else if item.type === 'boolean'}
  <button
    class="m-setting-toggle"
    class:on={setting.val as boolean}
    type="button"
    role="switch"
    aria-checked={setting.val as boolean}
    onclick={() => {
      const next = !(setting.val as boolean)
      if (item.onUpdate) {
        item.onUpdate(next)
      } else {
        void updateSetting({ [item.field]: next })
      }
      item.onChnaged?.(next)
    }}
  >
    <span class="m-setting-copy">
      <span class="m-setting-title">{$t(item.name)}</span>
      {#if item.description}
        <span class="m-setting-desc">{$t(item.description)}</span>
      {/if}
    </span>
    <span class="m-setting-switch" aria-hidden="true"></span>
  </button>
{:else if item.type === 'radio'}
  <section class="m-setting-field">
    <div class="m-setting-field-head">
      <h3 class="m-setting-title">{$t(item.name)}</h3>
      {#if item.description}
        <p class="m-setting-desc">{$t(item.description)}</p>
      {/if}
    </div>
    <div class="m-setting-radio-list" role="radiogroup" aria-label={$t(item.name)}>
      {#each list as radioItem (radioItem.value)}
        <button
          class="m-setting-choice"
          class:checked={(setting.val as string) == radioItem.value}
          type="button"
          role="radio"
          aria-checked={(setting.val as string) == radioItem.value}
          disabled={radioItem.disabled}
          onclick={() => {
            if (item.onUpdate) {
              item.onUpdate(radioItem.value)
            } else {
              void updateSetting({ [item.field]: radioItem.value })
            }
            item.onChnaged?.(radioItem.value)
          }}
        >
          <span class="m-setting-radio-dot" aria-hidden="true"></span>
          <span class="m-setting-choice-label">{$t(radioItem.name)}</span>
        </button>
      {/each}
    </div>
  </section>
{:else if item.type === 'selection'}
  <section class="m-setting-field">
    <div class="m-setting-field-head">
      <h3 class="m-setting-title">{$t(item.name)}</h3>
      {#if item.description}
        <p class="m-setting-desc">{$t(item.description)}</p>
      {/if}
    </div>
    <div class="m-setting-select">
      <Selection
        value={setting.val as string | number}
        list={item.enum.map((entry) => ({ label: entry.name, value: entry.value }))}
        itemkey="value"
        itemname="label"
        onchange={(value) => {
          if (item.onUpdate) {
            item.onUpdate(value)
          } else {
            void updateSetting({ [item.field]: value })
          }
          item.onChnaged?.(value)
        }}
      />
    </div>
  </section>
{/if}
