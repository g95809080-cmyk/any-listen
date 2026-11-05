<script lang="ts">
  import ListItem from '@ui-raw/components/material/fileExplorerModal/ListItem.svelte'
  import type { File } from '@ui/components/material/fileExplorerModal/shared'

  let {
    file,
    picstyle,
    disabled = false,
    selected = false,
    selectfolder = false,
    selectedactive,
    onclick,
    ongoto,
  }: {
    file: File
    picstyle: string
    disabled?: boolean
    selected?: boolean
    selectfolder?: boolean
    selectedactive?: boolean
    onclick: () => void
    ongoto?: () => void
  } = $props()
</script>

<ListItem
  {file}
  {picstyle}
  {disabled}
  {selected}
  {selectfolder}
  {selectedactive}
  {ongoto}
  onclick={() => {
    // 手机上文件夹统一单击进入；目录选择由文件浏览器底部的“确定”选择当前目录，
    // 不再要求双击。`selectfolder` 仍保留在 props 里兼容上游调用方。
    if (!file.isFile && ongoto) {
      ongoto()
    } else {
      onclick()
    }
  }}
/>
