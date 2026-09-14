# 插件源码热更新

`@antarestra/plugin-hmr` 基于官方 [`@cordisjs/plugin-hmr`](https://github.com/cordiverse/cordis/tree/main/packages/hmr) 1.1.0，使用官方 loader 1.0.0-rc.7、timer 1.1.3 与项目固定的 `cordis@4.0.0-rc.10`。官方 npm 包名不是 `@cordis/plugin-hmr`。

模块依赖分析、ESM / CommonJS 缓存失效、导入失败回滚和 Fiber 替换均由官方实现。项目只适配目录配置、Windows 路径以及现有配置加载器的模块与实例登记；主配置格式、环境变量规则保持一致，不启用官方 loader 的 JS 配置表达式。

## 使用

默认主配置已启用：

```yaml
plugins:
  plugin-hmr:
    include: [plugins]
    exclude: []
```

运行 `pnpm dev:server` 或 `pnpm dev`，保存插件源码后，受影响的插件实例会在原进程中卸载并重新创建，不需要手动重启服务器。依赖服务的消费者按 Cordis 生命周期重新激活；未受影响的插件继续运行。多实例保留各自配置，但内存运行状态会随实例重建丢失。

| 字段      | 类型       | 默认值      | 含义                                     |
| --------- | ---------- | ----------- | ---------------------------------------- |
| `include` | 字符串数组 | `[plugins]` | 监视的目录，包含子目录；空数组不监视目录 |
| `exclude` | 字符串数组 | `[]`        | 排除的目录及其子目录，优先于 include     |

相对路径以项目根目录为基准，与工作目录、`--conf` 指向的配置文件位置无关，也支持绝对目录。目录按字面路径处理，不接受 glob 通配符语义。例如排除 `plugins/implementations/agent-demo` 不会排除同级 `agent-demo-extra`。即使某个排除目录也出现在 include 中，仍不触发刷新。

沿用官方对 `node_modules` 的排除，避免监视 pnpm 依赖链接；工作区插件实际源码仍从 `plugins` 目录监视。

开发命令通过 `--expose-internals` 提供官方 HMR 需要的 Node 模块缓存接口，并以 `development` 条件加载 TypeScript 源码。`tsx watch` 额外监视 `packages`、`apps` 的源码，排除 `plugins`；前两者修改会重启进程，插件修改由 HMR 处理。重新加载的模块沿用原 URL，不通过不断附加查询参数制造新缓存。

## 行为边界

- 监视已导入模块的文件修改，包含插件入口和间接依赖。语法或导入失败保留旧实例，修复保存后重试；插件启动失败会留下失败实例，修复后可重新加载。
- 使用官方默认 100 毫秒防抖，额外等待文件写入稳定 150 毫秒，减少编辑器保存过程中的半写入状态。
- 新增未被导入的文件、删除文件、修改主 YAML 配置或包的 exports 不属于当前自动重载入口；新增插件或改变装配配置后需重启开发服务。
- `pnpm start` 运行编译产物；修改 TypeScript 源码后要先构建，只有实际加载的 `dist` 模块更新才会热替换。源码开发使用 `pnpm dev:server`。
- 禁用时将配置键改为 `~plugin-hmr` 并重启；此时插件源码修改不会被 `tsx watch` 接管。卸载 HMR 插件会回收监视器和定时器。
- 框架核心改动由 `tsx watch` 重启处理。HMR 不提供状态迁移、请求无缝切换或不可信插件隔离。

验证使用真实 Node 子进程与文件监视器，覆盖间接 TypeScript 依赖、多个实例、服务依赖变化、异步清理、排除优先级、失败恢复及卸载；另复用开发命令验证 HTTP 内容原进程更新，以及 packages / apps 修改触发重启。
