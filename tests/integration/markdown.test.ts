import { describe, expect, it, vi } from 'vitest'
import { createMarkdownRenderer, createMarkdownStream } from '@antarestra/markdown/core'
import type { CodeNode } from '@antarestra/markdown/core'
import { Context } from '@antarestra/plugin-sdk'
import Server from '@antarestra/plugin-server'
import WebUI from '@antarestra/webui'
import * as MarkdownPlugin from '@antarestra/plugin-markdown-render'

describe('Markdown 增量解析', () => {
  it('插件入口支持独立卸载、WebUI 依赖卸载与恢复', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(Server, { host: '127.0.0.1', port: 0 })
      const webui = await ctx.plugin(WebUI)
      const plugin = await ctx.plugin(MarkdownPlugin)
      expect(ctx.webui.getEntries().map((entry) => entry.id)).toEqual(['markdown-render'])
      await plugin.dispose()
      expect(ctx.webui.getEntries()).toEqual([])
      await ctx.plugin(MarkdownPlugin)
      await webui.dispose()
      await ctx.plugin(WebUI)
      await vi.waitFor(() =>
        expect(ctx.webui.getEntries().map((entry) => entry.id)).toEqual(['markdown-render']),
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })
  it('只解析活动尾部，已稳定节点保持引用，结束时不重建前缀', () => {
    const renderer = createMarkdownRenderer()
    const boundaries = vi.spyOn(renderer, 'boundaries')
    const stream = createMarkdownStream(renderer)
    const initial = stream.update('# 标题\n\n第一段\n\n第二段\n')
    const next = stream.update('# 标题\n\n第一段\n\n第二段\n继续')
    expect(next[0]).toBe(initial[0])
    expect(next[1]).toBe(initial[1])
    expect(boundaries.mock.calls.at(-1)?.[0]).toBe('第二段\n继续')
    const final = stream.update('# 标题\n\n第一段\n\n第二段\n继续', false)
    expect(final[0]).toBe(initial[0])
    expect(final[1]).toBe(initial[1])
    expect(final.at(-1)?.streaming).toBe(false)
  })

  it.each([
    '- 一\n\n- 二\n\n尾部\n',
    '> 引用\n>\n> 继续\n\n尾部\n',
    '| A | B |\n|---|---|\n| 1 | 2 |\n\n尾部\n',
    '标题\n===\n\n尾部\n',
    '````go\n```\n正文\n````\n\n尾部\n',
  ])('逐字分片与一次输入的块结构相同：%s', (source) => {
    const stream = createMarkdownStream()
    for (let length = 1; length <= source.length; length++) stream.update(source.slice(0, length))
    const actual = stream.update(source, false)
    const expected = createMarkdownStream().update(source, false)
    expect(actual).toEqual(expected)
  })

  it('全文替换与清空不残留上一消息', () => {
    const stream = createMarkdownStream()
    stream.update('旧消息\n\n正文\n')
    expect(stream.update('新消息', false).map((block) => block.source)).toEqual(['新消息'])
    expect(stream.update('', false)).toEqual([])
  })

  it.each([
    ['```chart\n{}\n```', true, false],
    ['```chart\n{}\n```', false, true],
    ['```chart\n{}\n```\n', true, true],
    ['````chart\n{}\n```\n', false, false],
    ['```chart\n{}\n~~~\n', false, false],
    ['```chart\n{}\n    ```\n', false, false],
    ['~~~chart options\n{}\n~~~~\n', true, true],
    ['> ```chart\n> {}\n> ```\n', true, true],
    ['- 条目\n\n  ```chart\n  {}\n  ```\n', true, true],
  ])('依据 AST 和结束围栏判断完成：%s', (source, streaming, closed) => {
    const nodes: CodeNode[] = []
    createMarkdownRenderer().render(source, {
      streaming,
      fence: (node) => {
        nodes.push(node)
        return ''
      },
    })
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.closed).toBe(closed)
    expect(nodes[0]?.language).toBe('chart')
  })

  it('默认关闭原始 HTML 并转义语言属性，保留公式、表格与高亮', () => {
    const renderer = createMarkdownRenderer()
    expect(renderer.render('<script>alert(1)</script>')).not.toContain('<script>')
    expect(renderer.render('```x"onclick="evil\ntext\n```')).not.toContain('onclick="evil')
    expect(renderer.render('$a^2$')).toContain('katex')
    expect(renderer.render('| A |\n|---|\n| B |')).toContain('md-table-wrap')
    expect(renderer.render('```go\nfunc main() {}\n```')).toContain('hljs-keyword')
  })
})
