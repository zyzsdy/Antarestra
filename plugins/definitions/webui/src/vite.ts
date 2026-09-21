import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import * as runtime from 'vue'
import * as reka from 'reka-ui'
import { defineConfig, normalizePath } from 'vite'
import type { Plugin, UserConfig } from 'vite'

/** WebUI 扩展模板的统一构建入口；与页面壳共享 Vue 和 Reka UI，样式随上下文回收。 */
export function defineWebUIConfig(): UserConfig {
  const entryId = '\0antarestra:entry'
  const rekaId = '\0antarestra:reka'
  const vueId = '\0antarestra:vue'
  let entry: string
  const extension: Plugin = {
    name: 'antarestra-webui',
    enforce: 'pre',
    configResolved(config) {
      entry = normalizePath(resolve(config.root, 'client/index.ts'))
    },
    resolveId(id, _importer, options) {
      if (options.isEntry && normalizePath(id) === entry) return entryId
      if (id === 'reka-ui') return rekaId
      if (id === 'vue') return vueId
      if (id.startsWith('vue/') || id.startsWith('@vue/'))
        this.error('WebUI 扩展必须从 vue 导入共享运行时，不支持 Vue 内部入口')
    },
    load(id) {
      if (id === vueId || id === rekaId) {
        const namespace = id === vueId ? 'vue' : 'reka'
        const exports = id === vueId ? runtime : reka
        return `const runtime = globalThis[Symbol.for('antarestra.webui.${namespace}')];
if (!runtime) throw new Error('请通过 Antarestra WebUI 页面壳加载扩展');
${Object.keys(exports)
  .filter((key) => /^[a-zA-Z_$][\w$]*$/.test(key) && key !== 'default')
  .map((key) => `export const ${key} = runtime.${key};`)
  .join('\n')}`
      }
      if (id === entryId) {
        return `import apply from ${JSON.stringify(entry)};
export default function(ctx) {
  ctx.effect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL(/* @vite-ignore */ './style.css', import.meta.url).href;
    document.head.append(link);
    return () => link.remove();
  });
  return apply(ctx);
}`
      }
    },
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        if (!bundle['style.css'])
          this.emitFile({ type: 'asset', fileName: 'style.css', source: '/* 此扩展没有样式。 */' })
      },
    },
  }
  return defineConfig({
    publicDir: false,
    plugins: [extension, vue()],
    build: {
      outDir: 'public',
      cssCodeSplit: false,
      lib: {
        entry: 'client/index.ts',
        formats: ['es'],
        fileName: () => 'index.js',
        cssFileName: 'style',
      },
    },
  })
}
