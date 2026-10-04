import { expect, it } from 'vitest'
import { filterCitationLinks } from '../../plugins/adapters/im-onebot/src/citation-links.js'

it('过滤网页搜索示例的引用，保留全部推荐正文及换行', () => {
  const text = `我会先推《摇曳百合》，日常搞笑，很适合放松看 ([yuruyuri.com](https://yuruyuri.com/3hai/story/introduction.php?utm_source=openai))
再来《黄金拼图》，偏温馨的校园日常 ([kinmosa.com](https://kinmosa.com/?utm_source=openai))
想沿着《摇曳百合》接着看，也可以补《大室家》 ([prtimes.jp](https://prtimes.jp/a/?c=2734&f=d2734-1914-2cf413d19e804c57ec7ca4023158b213.pdf&r=1914&utm_source=openai))`
  expect(filterCitationLinks(text)).toBe(`我会先推《摇曳百合》，日常搞笑，很适合放松看
再来《黄金拼图》，偏温馨的校园日常
想沿着《摇曳百合》接着看，也可以补《大室家》`)
})

it.each([
  ['正文 ([来源](https://example.com/a(b)?x=1&y=2))。', '正文。'],
  ['正文 （[甲](https://a.test), [乙](https://b.test)）！', '正文！'],
  ['see ([a](https://a.test)) this', 'see this'],
  ['看[官方网站](https://example.com "标题")。', '看官方网站。'],
  ['看[标题中的 [括号]](https://example.com)。', '看标题中的 [括号]。'],
  ['正文 [1](https://a.test) [example.com](https://example.com)', '正文  '],
  ['[https://example.com](https://example.com)', ''],
  ['([来源](https://example.com))', ''],
  ['前文 ([来源](https://a.test))\r\n后文 ([来源](https://b.test))', '前文\r\n后文'],
  ['(参见[官网](https://example.com))', '(参见官网)'],
  ['[带转义括号](https://example.com/a\\(b\\))', '带转义括号'],
])('过滤引用变体：%s', (source, expected) => {
  expect(filterCitationLinks(source)).toBe(expected)
})

it.each([
  '普通文本 https://example.com/a?x=1&y=2，保留裸链接',
  '`[代码](https://example.com)`',
  '```markdown\n[代码](https://example.com)\n```',
  '~~~markdown\n[代码](https://example.com)\n~~~',
  '    [缩进代码](https://example.com)\n',
  '![图片](https://example.com/a.png)',
  '\\[转义示例](https://example.com)',
  '[未闭合](https://example.com',
  '[邮箱](mailto:a@example.com)',
])('保留正文、代码、图片及不匹配的内容：%s', (source) => {
  expect(filterCitationLinks(source)).toBe(source)
})

it('过滤代码块前后内容但不改写代码块，重复执行结果稳定', () => {
  const source =
    '前文 ([来源](https://a.test))\n```md\n[代码](https://b.test)\n```\n后文 [官网](https://c.test)'
  const result = '前文\n```md\n[代码](https://b.test)\n```\n后文 官网'
  expect(filterCitationLinks(source)).toBe(result)
  expect(filterCitationLinks(result)).toBe(result)
})
