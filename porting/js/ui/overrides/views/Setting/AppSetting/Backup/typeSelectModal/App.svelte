<script lang="ts">
  import Modal from '@/components/material/Modal.svelte'
  import Btn from '@/components/base/Btn.svelte'
  import { t } from '@/plugins/i18n'
  import Checkbox from '@/components/base/Checkbox.svelte'
  import { CANCELED_ERROR_MSG } from '@any-listen/common/constants'

  let {
    onafterleave,
  }: {
    onafterleave: () => void
  } = $props()

  let visible = $state(false)
  let mode = $state<'export' | 'import'>('export')
  let availableTypes = $state<AnyListen.BackupType[]>(['songlist', 'settings'])
  let selectedTypes = $state<AnyListen.BackupType[]>(['songlist'])
  let promise: [(result: AnyListen.BackupType[]) => void, (error: Error) => void] | null = null

  const closeModal = () => {
    visible = false
  }

  const handleComfirm = () => {
    promise?.[0]([...selectedTypes])
    closeModal()
  }

  const handleTypeChange = (type: 'songlist' | 'settings', checked: boolean) => {
    if (checked) {
      if (!selectedTypes.includes(type)) selectedTypes = [...selectedTypes, type]
      return
    }
    selectedTypes = selectedTypes.filter((item) => item != type)
  }

  const handleAfterLeave = () => {
    onafterleave?.()
  }

  export const show = async (_mode: 'export' | 'import' = 'export', _availableTypes?: AnyListen.BackupType[]) => {
    mode = _mode
    availableTypes = _availableTypes?.length ? [..._availableTypes] : ['songlist', 'settings']
    selectedTypes = availableTypes.includes('songlist') ? ['songlist'] : []
    visible = true
    return new Promise<AnyListen.BackupType[]>((resolve, reject) => {
      promise = [resolve, reject]
    })
  }

  export const hide = () => {
    closeModal()
    promise?.[1](new Error(CANCELED_ERROR_MSG))
  }

  let disabledConfirm = $derived(!selectedTypes.length)
</script>

<Modal bind:visible teleport="#root" minheight="0" bgclose={false} onclose={hide} onafterleave={handleAfterLeave}>
  <div class="main">
    <h3 class="title">{mode == 'export' ? $t('settings.backup.export_type_title') : $t('settings.backup.import_type_title')}</h3>
    <ul class="type-list">
      {#if availableTypes.includes('songlist')}
        <li class="type-item">
          <Checkbox
            id="backup_type_songlist"
            checked={selectedTypes.includes('songlist')}
            onchange={(checked) => handleTypeChange('songlist', checked)}
            label={$t('settings.backup.list')}
          />
        </li>
      {/if}
      {#if availableTypes.includes('settings')}
        <li class="type-item">
          <Checkbox
            id="backup_type_settings"
            checked={selectedTypes.includes('settings')}
            onchange={(checked) => handleTypeChange('settings', checked)}
            label={$t('setting')}
          />
        </li>
      {/if}
    </ul>
  </div>
  <div class="footer">
    <Btn onclick={hide}>{$t('btn_cancel')}</Btn>
    <Btn disabled={disabledConfirm} onclick={handleComfirm}>{$t('btn_confirm')}</Btn>
  </div>
</Modal>

<style lang="less">
  .main {
    flex: auto;
    min-width: 320px;
    min-height: 40px;
    padding: 15px 15px 0;
  }

  .title {
    padding-bottom: 10px;
    font-size: 14px;
  }

  .type-list {
    display: flex;
    flex-flow: column nowrap;
    gap: 10px;
  }

  .type-item {
    display: flex;
    flex-flow: column nowrap;
    min-height: 44px;
    justify-content: center;
  }

  .footer {
    display: flex;
    flex: none;
    flex-flow: row nowrap;
    gap: 15px;
    justify-content: flex-end;
    padding: 15px;

    :global(.btn) {
      min-width: 70px;
    }
  }
</style>
