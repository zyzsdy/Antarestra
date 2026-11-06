export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 剪贴板权限被拒绝时尝试传统路径。
  }
  const area = document.createElement('textarea')
  const previousFocus = document.activeElement
  const selection = document.getSelection()
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : []
  const input =
    previousFocus instanceof HTMLInputElement || previousFocus instanceof HTMLTextAreaElement
      ? previousFocus
      : null
  const start = input?.selectionStart ?? null
  const end = input?.selectionEnd ?? null
  const direction = input?.selectionDirection ?? undefined
  try {
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '0'
    area.style.left = '0'
    area.style.width = '1px'
    area.style.height = '1px'
    area.style.opacity = '0'
    area.tabIndex = -1
    // 放在当前弹窗内，避免焦点陷阱或原生 dialog 的 inert 机制阻止选择。
    const container =
      previousFocus?.closest('[role="dialog"], [role="alertdialog"], dialog') ?? document.body
    container.append(area)
    area.focus({ preventScroll: true })
    area.select()
    area.setSelectionRange(0, text.length)
    const copied = document.execCommand('copy')
    return copied
  } catch {
    return false
  } finally {
    area.remove()
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true })
    if (input && start !== null && end !== null) input.setSelectionRange(start, end, direction)
    if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
  }
}
