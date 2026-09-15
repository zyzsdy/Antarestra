import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const name = process.argv[2]
if (process.argv.length !== 3 || !name || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
  console.error('用法：pnpm create:webui <名称>；名称使用小写字母、数字和短横线。')
  process.exit(1)
}
const root = fileURLToPath(new URL('../', import.meta.url))
const target = join(root, 'plugins', 'features', name)
// 非递归创建，已有目录时拒绝覆盖。
await mkdir(target)
async function copy(source, destination) {
  for (const item of await readdir(source, { withFileTypes: true })) {
    const output = join(destination, item.name)
    if (item.isDirectory()) {
      await mkdir(output)
      await copy(join(source, item.name), output)
    } else {
      const content = await readFile(join(source, item.name), 'utf8')
      await writeFile(output, content.replaceAll('__NAME__', name), { flag: 'wx' })
    }
  }
}
await copy(join(root, 'templates', 'webui-plugin'), target)
console.log(`已创建 ${target}。接下来执行：
pnpm install
pnpm --filter @antarestra/server add '@antarestra/plugin-${name}@workspace:*'
pnpm --filter @antarestra/plugin-${name} build
在 antarestra.yml 的 plugins 中添加 plugin-${name}: {}，重启服务后访问 /${name}/。
开发时另开终端执行 pnpm --filter @antarestra/plugin-${name} dev。`)
