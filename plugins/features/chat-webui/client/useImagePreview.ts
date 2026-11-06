import { onMounted, onUnmounted, ref, type Ref } from 'vue'

/** Markdown 的 DOM 由流式渲染器维护，通过委托接入预览，不改变节点结构。 */
export function useImagePreview(host: Ref<HTMLElement | undefined>) {
  const preview = ref<{ src: string; name: string }>()
  let observer: MutationObserver | undefined
  function enhance() {
    for (const image of host.value?.querySelectorAll<HTMLImageElement>('.md-body img[src]') ?? []) {
      if (image.closest('button, a')) continue
      if (image.tabIndex !== 0) image.tabIndex = 0
      if (image.getAttribute('role') !== 'button') image.setAttribute('role', 'button')
      const label = `查看大图：${image.alt || '图片'}`
      if (image.getAttribute('aria-label') !== label) image.setAttribute('aria-label', label)
    }
  }
  function open(image: HTMLImageElement) {
    if (!image.getAttribute('src')) return
    image.focus()
    preview.value = { src: image.currentSrc || image.src, name: image.alt || '图片预览' }
  }
  function click(event: MouseEvent) {
    const image = event.target
    if (
      !(image instanceof HTMLImageElement) ||
      !image.closest('.md-body') ||
      image.closest('button')
    )
      return
    event.preventDefault()
    // 图片链接也预览当前图片，文字链接仍保留原有导航。
    image.closest('a')?.focus()
    open(image)
  }
  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const target = event.target
    const image =
      target instanceof HTMLImageElement
        ? target
        : target instanceof HTMLAnchorElement
          ? target.querySelector('img')
          : null
    if (!image?.closest('.md-body')) return
    event.preventDefault()
    open(image)
  }
  onMounted(() => {
    enhance()
    observer = new MutationObserver(enhance)
    if (host.value)
      observer.observe(host.value, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src', 'alt', 'role', 'tabindex', 'aria-label'],
      })
  })
  onUnmounted(() => observer?.disconnect())
  return { preview, click, keydown }
}
