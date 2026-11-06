// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { patchMarkdown } from '../../packages/markdown/src/dom.js'
import ImagePreview from '../../plugins/features/chat-webui/client/ImagePreview.vue'
import { useImagePreview } from '../../plugins/features/chat-webui/client/useImagePreview.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})
function mount(component: Parameters<typeof createApp>[0]) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(component)
  app.mount(host)
  cleanups.push(() => app.unmount())
  return host
}
async function settle() {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('聊天图片预览', () => {
  it('流式新增图片支持点击与键盘，保留节点和普通链接，卸载清理观察器', async () => {
    let state: ReturnType<typeof useImagePreview> | undefined
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const host = mount(
      defineComponent({
        setup() {
          const root = ref<HTMLElement>()
          state = useImagePreview(root)
          return () =>
            h('div', { ref: root, onClick: state!.click, onKeydown: state!.keydown }, [
              h('div', { class: 'md-body' }),
            ])
        },
      }),
    )
    const body = host.querySelector<HTMLElement>('.md-body')!
    const image = document.createElement('img')
    image.src = '/first.png'
    image.alt = '第一张'
    body.append(image)
    await settle()
    expect(image.getAttribute('role')).toBe('button')
    expect(image.tabIndex).toBe(0)
    image.click()
    expect(state?.preview.value).toEqual({ src: image.src, name: '第一张' })
    expect(document.activeElement).toBe(image)
    const next = document.createElement('img')
    next.src = '/second.png'
    body.append(next)
    await settle()
    next.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(state?.preview.value?.src).toBe(next.src)
    expect(body.firstChild).toBe(image)
    patchMarkdown(body, '<img src="/first.png" alt="第一张"><img src="/second.png">流式更新')
    await settle()
    expect(body.firstChild).toBe(image)
    expect(image.getAttribute('role')).toBe('button')
    expect(image.tabIndex).toBe(0)
    const link = document.createElement('a')
    link.href = '/page'
    link.textContent = '文字链接'
    body.append(link)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    state!.click(event)
    expect(event.defaultPrevented).toBe(false)
    cleanups.pop()!()
    expect(disconnect).toHaveBeenCalledOnce()
    disconnect.mockRestore()
  })

  it('加载后才可缩放，限制比例，支持平移复位、失败重试和关闭', async () => {
    const close = vi.fn()
    mount(
      defineComponent({
        setup: () => () => h(ImagePreview, { src: '/image.png', name: '示例', onClose: close }),
      }),
    )
    await settle()
    const button = (name: string) =>
      document.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!
    expect(button('放大图片').disabled).toBe(true)
    const image = document.querySelector<HTMLImageElement>('.chat-image-stage img')!
    image.dispatchEvent(new Event('load'))
    await nextTick()
    button('放大图片').click()
    await nextTick()
    expect(document.querySelector('output')?.textContent).toBe('125%')
    const stage = document.querySelector<HTMLElement>('.chat-image-stage')!
    stage.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -100000, bubbles: true, cancelable: true }),
    )
    await nextTick()
    expect(
      Number(document.querySelector('output')?.textContent?.replace('%', '')),
    ).toBeLessThanOrEqual(800)
    for (let i = 0; i < 30; i++) button('放大图片').click()
    await nextTick()
    expect(document.querySelector('output')?.textContent).toBe('800%')
    expect(button('放大图片').disabled).toBe(true)
    for (let i = 0; i < 40; i++) button('缩小图片').click()
    await nextTick()
    expect(document.querySelector('output')?.textContent).toBe('25%')
    expect(button('缩小图片').disabled).toBe(true)
    button('复位图片').click()
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await nextTick()
    expect(image.style.transform).toBe('translate(32px, 0px) scale(1)')
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await nextTick()
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1)')
    image.dispatchEvent(new Event('error'))
    await nextTick()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('图片加载失败')
    expect(button('放大图片').disabled).toBe(true)
    document.querySelector<HTMLButtonElement>('[role="alert"] button')!.click()
    await nextTick()
    expect(document.querySelector('.chat-image-stage img')).not.toBeNull()
    expect(document.querySelector('[role="status"]')?.textContent).toBe('正在加载图片…')
    button('关闭图片预览').click()
    expect(close).toHaveBeenCalledOnce()
  })
})
