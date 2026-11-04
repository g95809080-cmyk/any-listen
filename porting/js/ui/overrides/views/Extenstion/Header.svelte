<script lang="ts">
  import Tab from '@/components/base/Tab.svelte'
  import { viewIcons, viewTypes } from '@ui/views/Extenstion/shared'
  import { i18n } from '@/plugins/i18n'
  import HeaderActions from '@ui/views/Extenstion/HeaderActions.svelte'
  let { activeview }: { activeview: (typeof viewTypes)[number] } = $props()
  const typeList = $derived(
    viewTypes.map((t) => {
      return { id: t, href: `/extenstion?type=${t}`, label: i18n.t(`extension__type_${t}`), icon: viewIcons[t] }
    })
  )
</script>

<header class="header">
  <Tab list={typeList} itemkey="id" itemlabel="label" itemicon="icon" value={activeview} tagname="a" href="href" />
  <HeaderActions />
</header>

<style lang="less">
  /*
   * O-10：扩展页顶栏在手机上的排布（D-33 的第二个表现）。
   *
   * 上游是 `justify-content: space-between` 的一行：左边 5 个 Tab（已安装/已启用/已禁用/
   * 扩展商店/本地安装），右边 HeaderActions。393px 宽放不下，flex 会把每个 Tab 压到
   * 44px 左右，中文标签被逐字换行变成「已/安/装」竖排（截图 artifacts/d32-store.png）。
   *
   * 改动只有三条：顶栏可横向滚动、Tab 条不参与收缩、标签禁止换行。
   * 内容变多时横向滚动比压缩字宽更可读，也不影响右侧操作区（`flex: none`）。
   */
  .header {
    /* O-10（D-33 修订）：单行放不下的正确解法是**分成两行**，而不是硬挤一行再裁切。
       实测单行时 Tab 条被压到 269px，第 5 个标签（扩展商店）直接被裁掉，
       而 HeaderActions 因为高度只有 Tab 的一半，视觉上像掉到了第二行且与标签重叠。 */
    display: flex;
    flex: none;
    flex-flow: column nowrap;
    align-items: stretch;
    gap: 8px;
    padding: 0 15px;

    /* 标签条整行铺满，自身横向滚动；标签不换行、不被压缩。
       ⚠️ 这里必须写 `width: auto`，**不能写 `width: 100%`**：实测 100% 会解析成 96px
       （收缩后的参考框），标签条被压到只剩一个多标签的宽度；auto 才是 361px 铺满。 */
    :global(.list) {
      width: auto;
      flex: none;
      overflow-x: auto;
      scrollbar-width: none;
    }
    :global(.list::-webkit-scrollbar) {
      display: none;
    }
    :global(.list-item) {
      white-space: nowrap;
    }
    /* 操作区（本地安装）独立一行，右对齐 */
    :global(.header-actions) {
      align-self: flex-end;
    }
  }
</style>
