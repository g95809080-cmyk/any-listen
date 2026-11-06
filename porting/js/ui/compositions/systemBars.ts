import { ports } from '@porting/ports'

/**
 * 系统状态栏图标必须跟随 Web 页面配色：
 * - 列表/设置：浅色底 → 深色图标
 * - 播放详情、深色主题：按当前内容背景亮度决定
 *
 * 主题通过 `window.setTheme()` 改写 body 里的 style，播放详情是动态挂载的
 * overlay，两者都没有统一的事件。这里只观察会改变结果的节点，避免播放歌词
 * 更新等文本变化也触发每帧重算。
 */

const luminance = (color: string): number | null => {
  const match = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
  if (!match) return null
  const channel = (raw: string) => {
    const value = Number(raw) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(match[1]!) + 0.7152 * channel(match[2]!) + 0.0722 * channel(match[3]!)
}

export const installSystemBarAppearance = (): (() => void) => {
  let requested = 0
  let last: boolean | null = null

  const sync = () => {
    requested = 0
    const surface =
      document.querySelector<HTMLElement>('.play-detail') ??
      document.querySelector<HTMLElement>('.shell') ??
      document.documentElement
    const computed = getComputedStyle(surface)
    const background =
      computed.backgroundColor ||
      computed.getPropertyValue('--color-content-background').trim()
    const darkIcons = (luminance(background) ?? 1) >= 0.5
    if (darkIcons === last) return
    last = darkIcons
    void ports.theme.setSystemBarAppearance(darkIcons).catch((err: unknown) => {
      console.warn('[ui/systemBars] setSystemBarAppearance failed', err)
    })
  }

  const schedule = () => {
    if (requested) return
    requested = requestAnimationFrame(sync)
  }

  sync()

  // `.play-detail` 是 #container 的直接子节点，切换时只会插入/移除这一层。
  const pageObserver = new MutationObserver(schedule)
  const page = document.getElementById('container') ?? document.body
  pageObserver.observe(page, { childList: true })

  // 上游 index.html 在 body 末尾维护唯一的主题 <style>；window.setTheme()
  // 通过重写它的 innerText 更新 CSS 变量。
  const themeStyle = Array.from(document.body.children).find(
    (node): node is HTMLStyleElement => node instanceof HTMLStyleElement
  )
  const themeObserver = new MutationObserver(schedule)
  if (themeStyle) {
    themeObserver.observe(themeStyle, {
      childList: true,
      characterData: true,
      subtree: true,
    })
  }

  return () => {
    pageObserver.disconnect()
    themeObserver.disconnect()
    if (requested) cancelAnimationFrame(requested)
  }
}
