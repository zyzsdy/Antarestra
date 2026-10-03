import { createHash } from 'node:crypto'
import { Tiktoken } from 'js-tiktoken/lite'
import ranks from 'js-tiktoken/ranks/o200k_base'

const encoder = new Tiktoken(ranks)
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
export const countTokens = (text: string) => encoder.encode(text, [], []).length

export function searchText(text: string): string {
  return [...segmenter.segment(text.normalize('NFKC').toLowerCase())]
    .filter((part) => part.isWordLike)
    .map(({ segment }) =>
      Buffer.byteLength(segment) >= 1024
        ? `long${createHash('sha256').update(segment).digest('hex')}`
        : segment,
    )
    .join(' ')
}

/** 每块远小于 PostgreSQL tsvector 的大小及词位上限；保留完整正文。 */
export function chunks(content: string): { content: string; search_text: string }[] {
  const result: { content: string; search_text: string }[] = []
  let part = ''
  for (const { segment } of segmenter.segment(content)) {
    if (part.length + segment.length > 8192 && part) {
      result.push({ content: part, search_text: searchText(part) })
      part = ''
    }
    part += segment
  }
  if (part) result.push({ content: part, search_text: searchText(part) })
  return result
}
