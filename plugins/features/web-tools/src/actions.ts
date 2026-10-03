import type { JsonObject } from '@antarestra/ai'
import { target } from './dom.js'
import type { BrowserPage } from './sessions.js'
import { WebError } from './common.js'

export async function perform(record: BrowserPage, action: JsonObject) {
  const page = record.page
  const type = String(action.type)
  if (type === 'dialog') {
    if (!record.dialog) throw new WebError('no_dialog', '当前没有待处理对话框')
    const dialog = record.dialog
    delete record.dialog
    if (action.accept === true)
      await dialog.accept(typeof action.text === 'string' ? action.text : undefined)
    else await dialog.dismiss()
    return
  }
  if (record.dialog) throw new WebError('dialog_pending', '请先处理当前网页对话框')
  if (record.pdf)
    throw new WebError('document_readonly', 'PDF 支持读取、查找和截图，不支持网页交互')
  const element =
    typeof action.ref === 'string'
      ? await target(record.snapshot, action.ref, record.key)
      : undefined
  try {
    const coordinates = async () => {
      const shot = record.screenshot
      if (!shot || action.screenshotId !== shot.id || shot.revision !== record.revision)
        throw new WebError('stale_screenshot', '坐标操作需要当前截图标识')
      const viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        x: scrollX,
        y: scrollY,
      }))
      const version = await page.evaluate(
        (key) => (globalThis as unknown as Record<string, { version: number }>)[key]?.version ?? 0,
        record.key,
      )
      if (version !== shot.domVersion)
        throw new WebError('stale_screenshot', '页面内容已变化，请重新截图')
      if (
        viewport.width !== shot.viewportWidth ||
        viewport.height !== shot.viewportHeight ||
        viewport.x !== shot.scrollX ||
        viewport.y !== shot.scrollY
      )
        throw new WebError('stale_screenshot', '视口或滚动位置已经变化，请重新截图')
      if (
        typeof action.x !== 'number' ||
        typeof action.y !== 'number' ||
        action.x < 0 ||
        action.y < 0 ||
        action.x >= shot.width ||
        action.y >= shot.height
      )
        throw new WebError('invalid_coordinates', '坐标超出截图范围')
      const scale = shot.scale
      const x = action.x / scale + shot.x,
        y = action.y / scale + shot.y
      if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height)
        throw new WebError('invalid_coordinates', '目标不在当前视口，请先滚动再截图')
      return { x, y }
    }
    const needElement = () => {
      if (!element) throw new WebError('missing_element', '此操作需要元素引用 ref')
      return element
    }
    if (type === 'click' || type === 'double_click') {
      const clickCount = type === 'double_click' ? 2 : 1
      if (element) await element.click({ clickCount })
      else {
        const point = await coordinates()
        await page.mouse.click(point.x, point.y, { clickCount })
      }
    } else if (type === 'fill') {
      await needElement().fill(String(action.text ?? ''))
    } else if (type === 'type') {
      if (element) await element.focus()
      await page.keyboard.type(String(action.text ?? ''))
    } else if (type === 'select') {
      await needElement().selectOption(
        Array.isArray(action.values) ? action.values.map(String) : [String(action.value ?? '')],
      )
    } else if (type === 'check') {
      await needElement().setChecked(action.checked === true)
    } else if (type === 'hover') await needElement().hover()
    else if (type === 'scroll') {
      if (element)
        await element.evaluate((node, [x, y]) => node.scrollBy(x, y), [
          Number(action.deltaX ?? 0),
          Number(action.deltaY ?? 500),
        ] as [number, number])
      else await page.mouse.wheel(Number(action.deltaX ?? 0), Number(action.deltaY ?? 500))
      delete record.screenshot
    } else if (type === 'move') {
      const point = await coordinates()
      await page.mouse.move(point.x, point.y)
    } else if (type === 'mouse_down' || type === 'mouse_up') {
      const point = await coordinates()
      await page.mouse.move(point.x, point.y)
      const button =
        action.button === 'right' || action.button === 'middle' ? action.button : 'left'
      if (type === 'mouse_down') await page.mouse.down({ button })
      else await page.mouse.up({ button })
    } else if (type === 'drag') {
      const from = needElement()
      const to = await target(record.snapshot, String(action.toRef), record.key)
      try {
        await from.scrollIntoViewIfNeeded()
        await to.scrollIntoViewIfNeeded()
        const a = await from.boundingBox(),
          b = await to.boundingBox()
        if (!a || !b) throw new WebError('not_interactable', '拖拽目标不可见')
        await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
        await page.mouse.down()
        try {
          await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
        } finally {
          await page.mouse.up()
        }
      } finally {
        await to.dispose()
      }
    } else if (type === 'press' || type === 'key_down' || type === 'key_up') {
      if (element) await element.focus()
      const keys = String(action.key ?? '').split('+')
      if (type === 'key_down') await page.keyboard.down(keys[0]!)
      else if (type === 'key_up') await page.keyboard.up(keys[0]!)
      else {
        const modifiers = keys.slice(0, -1)
        try {
          for (const key of modifiers) await page.keyboard.down(key)
          await page.keyboard.press(keys.at(-1)!)
        } finally {
          for (const key of modifiers.reverse()) await page.keyboard.up(key)
        }
      }
    } else if (type === 'wait') {
      const timeout = Math.min(Number(action.timeoutMs ?? 5000), 30000)
      if (action.text || action.url)
        await page.waitForFunction(
          ([text, url]) =>
            (!text || document.body.innerText.includes(text)) &&
            (!url || location.href.includes(url)),
          [String(action.text ?? ''), String(action.url ?? '')] as [string, string],
          { timeout },
        )
      else if (element) await element.waitForElementState('visible', { timeout })
      else throw new WebError('invalid_wait', '等待需要 text、url 或 ref 条件')
    } else throw new WebError('invalid_action', '不支持的网页操作')
  } finally {
    await element?.dispose()
  }
}
