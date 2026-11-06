<script lang="ts">
  import { onMount } from 'svelte'

  import SvgIcon from '@ui/components/base/SvgIcon.svelte'
  import { extI18n, extT } from '@ui/modules/extension/i18n'
  import { getAllExtensionSettings } from '@ui/modules/extension/store/actions'
  import { extensionEvent } from '@ui/modules/extension/store/event'
  import { push, query, replace } from '@ui/plugins/routes'
  import type { ExtenstionListItem } from '@ui/views/Setting/ExtensionSetting/shared'
  import ExtenstionList from '@ui/views/Setting/ExtensionSetting/ExtenstionList.svelte'
  import SettingView from '@ui/views/Setting/ExtensionSetting/SettingView.svelte'

  import { tm } from '@porting/ui/i18n'

  let extSettings = $state<AnyListen.Extension.ExtensionSetting[]>([])
  let loaded = $state(false)

  const settings = $derived.by(() => {
    return extSettings.map((extension) => {
      return {
        id: extension.id,
        name: $extT(extension.id, extension.name),
        settings: extension.settingItems.map((setting) => {
          const next = {
            ...setting,
            name: extI18n.t(extension.id, setting.name),
            description: extI18n.t(extension.id, setting.description),
          }
          switch (next.type) {
            case 'selection':
              next.enumName = next.enumName.map((name) => extI18n.t(extension.id, name))
              break
            case 'configCheckbox':
              next.actionCommands &&= next.actionCommands.map((name) => `${extension.id}:${name}`)
              next.actionCommandNames &&= next.actionCommandNames.map((name) => extI18n.t(extension.id, name))
              break
            case 'configCheckboxMultiple':
              next.value ??= []
              next.actionCommands &&= next.actionCommands.map((name) => `${extension.id}:${name}`)
              next.actionCommandNames &&= next.actionCommandNames.map((name) => extI18n.t(extension.id, name))
              break
            default:
              break
          }
          return next
        }),
      }
    })
  })
  const activeExt = $derived(Object.values(settings).find((entry) => entry.id == $query.id) ?? settings[0])

  onMount(() => {
    void getAllExtensionSettings()
      .then((settings) => {
        extSettings = settings
      })
      .catch((error: unknown) => {
        console.error('[mobile] 加载扩展设置失败', error)
      })
      .finally(() => {
        loaded = true
      })

    const unsubscribe = extensionEvent.on('extenstionSettingUpdated', (setting) => {
      const targetExt = extSettings.find((entry) => entry.id == setting.id)
      if (!targetExt) return
      for (const [field, value] of Object.entries(setting.setting)) {
        const targetSetting = targetExt.settingItems.find((entry) => entry.field == field)
        if (targetSetting) {
          targetSetting.value = value as string | boolean
        }

        const targetConfigCheckboxSetting = targetExt.settingItems.find(
          (entry) =>
            (entry.type === 'configCheckbox' || entry.type === 'configCheckboxMultiple') &&
            entry.enumConfigFiled == field
        ) as
          | AnyListen.Extension.FormConfigValue<
              AnyListen.Extension.FormConfigCheckbox | AnyListen.Extension.FormConfigCheckboxMultiple
            >
          | undefined
        if (targetConfigCheckboxSetting) {
          targetConfigCheckboxSetting.enum = Array.isArray(value)
            ? value.map((item) => {
                return {
                  name: item[targetConfigCheckboxSetting.enumNameFiled],
                  value: item[targetConfigCheckboxSetting.enumFiled],
                  description: targetConfigCheckboxSetting.enumDescriptionFiled
                    ? item[targetConfigCheckboxSetting.enumDescriptionFiled]
                    : undefined,
                  raw: item,
                }
              })
            : []
        }
      }
    })

    return () => {
      unsubscribe()
    }
  })
</script>

<div class="settings-extension-container">
  {#if settings.length}
    <ExtenstionList
      list={settings}
      active={activeExt?.id}
      onchange={(extension: ExtenstionListItem) => {
        void replace('/settings', { section: 'extension', id: extension.id })
      }}
    />
    {#if activeExt}
      <SettingView id={activeExt.id} name={activeExt.name} list={activeExt.settings} />
    {/if}
  {:else if loaded}
    <div class="m-settings-empty">
      <span class="m-settings-empty-icon">
        <SvgIcon name="extenstion" />
      </span>
      <h2>{tm('mobile__extension_settings_empty_title')}</h2>
      <p>{tm('mobile__extension_settings_empty_sub')}</p>
      <button type="button" onclick={() => void push('/extenstion')}>
        {tm('mobile__extension_manage')}
      </button>
    </div>
  {/if}
</div>

<style lang="less">
  .settings-extension-container {
    display: flex;
    flex-flow: row nowrap;
    height: 100%;
    min-height: 0;
    padding-top: 10px;
  }
</style>
