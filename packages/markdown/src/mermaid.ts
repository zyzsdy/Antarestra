/**
 * Mermaid 懒加载封装：仅在页面出现第一个 Mermaid 代码块时才加载约 1MB 的渲染器。
 * mermaid 以 strict 安全级别运行，输出内容会被转义，不允许内嵌脚本与点击回调。
 */

let mermaidModule: (typeof import('mermaid'))['default'] | null = null
let initialized = false
let diagramCounter = 0

async function loadMermaid(): Promise<(typeof import('mermaid'))['default']> {
  if (!mermaidModule) {
    const imported = await import('mermaid')
    mermaidModule = imported.default
  }
  if (!initialized) {
    mermaidModule.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
    })
    initialized = true
  }
  return mermaidModule
}

export async function renderMermaidDiagram(code: string): Promise<string> {
  const mermaid = await loadMermaid()
  diagramCounter += 1
  const id = `md-mermaid-svg-${diagramCounter.toString(36)}`
  const { svg } = await mermaid.render(id, code)
  return svg
}
