import { createCanvas, DOMMatrix, Path2D, ImageData } from '@napi-rs/canvas'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api.js'
import { WebError } from './common.js'

export class PdfDocument {
  private constructor(
    readonly document: PDFDocumentProxy,
    readonly texts: string[],
  ) {}
  static async open(bytes: Uint8Array) {
    if (!globalThis.DOMMatrix) Object.assign(globalThis, { DOMMatrix })
    if (!globalThis.Path2D) Object.assign(globalThis, { Path2D })
    if (!globalThis.ImageData) Object.assign(globalThis, { ImageData })
    const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
    const task = pdf.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      standardFontDataUrl: root.replaceAll('\\', '/') + '/standard_fonts/',
    })
    const document = await task.promise.catch(async (error: unknown) => {
      await task.destroy()
      throw error
    })
    try {
      if (document.numPages > 500)
        throw new WebError('pdf_too_large', 'PDF 超过 500 页，请使用较小文档')
      const texts: string[] = []
      for (let i = 1; i <= document.numPages; i++) {
        const page = await document.getPage(i)
        const content = await page.getTextContent()
        texts.push(
          content.items
            .flatMap((item) => ('str' in item ? [item.str + (item.hasEOL ? '\n' : ' ')] : []))
            .join(''),
        )
        page.cleanup()
      }
      return new PdfDocument(document, texts)
    } catch (error) {
      await task.destroy()
      throw error
    }
  }
  async screenshot(number: number) {
    if (number < 1 || number > this.texts.length)
      throw new WebError('invalid_pdf_page', 'PDF 页码超出范围')
    const page = await this.document.getPage(number)
    const viewport = page.getViewport({ scale: 1.5 })
    if (viewport.width * viewport.height > 24_000_000)
      throw new WebError('screenshot_too_large', 'PDF 页面尺寸过大')
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise
    return { data: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height }
  }
  async close() {
    await this.document.loadingTask.destroy()
  }
}
