<script lang="ts">
  import SvgIcon from '@ui/components/base/SvgIcon.svelte'
  import { push } from '@ui/plugins/routes'
  import { _locale, i18n } from '@ui/plugins/i18n'

  import {
    SETTINGS_SECTION_TITLE_KEYS,
    type SettingsSectionId,
    settingsSectionHref,
  } from '../settings/navigation'
  import { t, tm } from '../i18n'

  interface SettingsNavItem {
    id: string
    icon: string
    href: string
    label: () => string
  }

  interface SettingsNavGroup {
    id: string
    title: () => string
    items: SettingsNavItem[]
  }

  const sectionLabel = (section: SettingsSectionId) => i18n.t(SETTINGS_SECTION_TITLE_KEYS[section])

  const groups: SettingsNavGroup[] = [
    {
      id: 'playback',
      title: () => tm('mobile__settings_group_playback'),
      items: [
        {
          id: 'basic',
          icon: 'tune',
          href: settingsSectionHref('basic'),
          label: () => sectionLabel('basic'),
        },
        {
          id: 'player',
          icon: 'play',
          href: settingsSectionHref('player'),
          label: () => sectionLabel('player'),
        },
        {
          id: 'playDetail',
          icon: 'phone',
          href: settingsSectionHref('playDetail'),
          label: () => sectionLabel('playDetail'),
        },
        {
          id: 'list',
          icon: 'list-order',
          href: settingsSectionHref('list'),
          label: () => sectionLabel('list'),
        },
      ],
    },
    {
      id: 'onlineData',
      title: () => tm('mobile__settings_group_data'),
      items: [
        {
          id: 'onlineResource',
          icon: 'sound_cloud',
          href: settingsSectionHref('onlineResource'),
          label: () => sectionLabel('onlineResource'),
        },
        {
          id: 'network',
          icon: 'setting-control',
          href: settingsSectionHref('network'),
          label: () => sectionLabel('network'),
        },
        {
          id: 'dataSync',
          icon: 'synchronize',
          href: settingsSectionHref('dataSync'),
          label: () => sectionLabel('dataSync'),
        },
        {
          id: 'backup',
          icon: 'time_machine',
          href: settingsSectionHref('backup'),
          label: () => sectionLabel('backup'),
        },
      ],
    },
    {
      id: 'extensions',
      title: () => tm('mobile__settings_group_extension'),
      items: [
        {
          id: 'extensionManage',
          icon: 'puzzle',
          href: '/extenstion',
          label: () => tm('mobile__extension_manage'),
        },
        {
          id: 'extension',
          icon: 'settings',
          href: settingsSectionHref('extension'),
          label: () => tm('mobile__settings_extension'),
        },
      ],
    },
    {
      id: 'other',
      title: () => tm('mobile__settings_group_other'),
      items: [
        {
          id: 'logs',
          icon: 'file',
          href: '/settings?section=logs',
          label: () => t('settings__type_logs'),
        },
        {
          id: 'other',
          icon: 'gears',
          href: settingsSectionHref('other'),
          label: () => sectionLabel('other'),
        },
        {
          id: 'about',
          icon: 'info',
          href: settingsSectionHref('about'),
          label: () => sectionLabel('about'),
        },
      ],
    },
  ]

  const localizedGroups = $derived.by(() => {
    void $_locale
    return groups.map((group) => ({
      id: group.id,
      title: group.title(),
      items: group.items.map((item) => ({
        ...item,
        label: item.label(),
      })),
    }))
  })

  const open = (href: string) => {
    void push(href)
  }
</script>

<div class="m-settings-home">
  <div class="m-settings-scroll">
    {#each localizedGroups as group (group.id)}
      <h2 id={`settings-group-${group.id}`} class="m-settings-group-title">{group.title}</h2>
      <section class="m-settings-group" aria-labelledby={`settings-group-${group.id}`}>
        {#each group.items as item (item.id)}
          <button class="m-settings-nav-row" type="button" onclick={() => open(item.href)}>
            <span class="m-settings-nav-icon">
              <SvgIcon name={item.icon} />
            </span>
            <span class="m-settings-nav-label">{item.label}</span>
            <span class="m-settings-nav-chevron">
              <SvgIcon name="angle-right-solid" />
            </span>
          </button>
        {/each}
      </section>
    {/each}
  </div>
</div>
