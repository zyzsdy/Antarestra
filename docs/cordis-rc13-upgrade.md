# Cordis rc.13 升级记录

本次从 `cordis@4.0.0-rc.11` 升级到精确版本 `4.0.0-rc.13`，同时核对 [rc.12 发布说明](https://github.com/cordiverse/cordis/releases/tag/v4.0.0-rc.12) 和 [rc.13 发布说明](https://github.com/cordiverse/cordis/releases/tag/v4.0.0-rc.13)。底层运行时仍仅由 `@antarestra/plugin-sdk` 直接依赖。

## 破坏性变更与项目处理

| 上游变更                                                                                                                                      | 项目影响与处理                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rc.12：`Service.resolveConfig` → `Service.resolveIntercept`；`Config.merge` → `Service.mergeIntercept`；`Service.config` → `Service.metadata` | 项目没有直接使用旧符号或合并钩子。HTTP 升级到 `@cordisjs/http@1.6.0`，由新版实现解析注入和拦截元数据。项目的普通 `Http.resolveConfig()` 方法仍然存在，不是被移除的符号方法。                   |
| rc.12：`ctx.root` → `ctx[Context.root]`                                                                                                       | 项目未使用旧入口。`ctx.loader.root` 是配置树，保持不变。                                                                                                                                       |
| rc.12：include 改用 YAML 1.2，二进制整数字面量改为字符串                                                                                      | 项目未使用官方 include，自己的配置加载器原本已使用 `yaml`；保持现有配置解析契约。                                                                                                              |
| rc.13：上游 plugin 更名为 component；注册入口改为 `ctx.use()`，`ctx.plugin()` 只作为弃用别名                                                  | 源码、测试、脚本与开发示例改用 `ctx.use()`；已移除的 `Plugin` 类型改为 `Component`。项目业务仍称“插件”，包名、`antarestra-plugin` 关键字和主配置键不改。                                       |
| rc.13：`@cordisjs/plugin-*` 包去掉 `plugin-`                                                                                                  | SDK 改用 `@cordisjs/loader@1.0.0-rc.10`、`@cordisjs/hmr@2.0.0-rc.0`；HTTP 改用 `@cordisjs/http@1.6.0`。不再使用 timer，移除旧依赖。                                                            |
| rc.13：HMR 默认关闭文件监视，配置迁入 `watch`，`watch.files` 替代 `root` / `ignored`                                                          | 显式关闭官方内置监视；项目的 Chokidar 按字面目录监视并调用公开的 `reconcile()`。保留绝对路径、排除优先级、空目录数组、100 毫秒防抖与 150 毫秒写入稳定检测。                                    |
| rc.13：`ctx.hmr.watch()` → `ctx.fs.watch()`；移除 `hmr/change`、`hmr/reload`                                                                  | 项目未直接调用这些旧接口。源码监视使用项目的 Chokidar，前端 WebSocket 桥接不依赖这些事件。                                                                                                     |
| rc.13：HMR 缺少 Node 内部接口时启动失败；宿主模块变化不再自动重启                                                                             | 启动命令已经包含 `--expose-internals`。移除以 `loader.internal` 是否存在判断 HMR 能力的旧逻辑，交由 HMR 自身校验。`packages` / `apps` 继续由 `tsx watch` 重启；被 HMR 跳过的变更记录重启提示。 |
| rc.13：include 默认不监视配置，需显式 `watch: true`                                                                                           | 未使用官方 include。主配置仍由面板显式应用，外部编辑不会自动加载。                                                                                                                             |
| rc.13：官方 CLI 在 loader 前加载 fs，要求安装 fs 和 fs-node                                                                                   | 项目使用自己的启动入口，没有调用官方 CLI；不额外启动 fs 服务。锁文件中的上游可选 peer 包不表示项目已启用这些服务。                                                                             |
| rc.13：`@cordisjs/fs` 改为可挂载的文件系统服务，不再是浏览器 `node:fs` 替代品                                                                 | 未使用旧浏览器实现，无需迁移。                                                                                                                                                                 |
| rc.13：`entry.fiber` → `entry.innerFiber`                                                                                                     | 配置加载器与配置管理器的官方 Entry 登记字段已迁移。项目自己维护的实例 `fiber` 字段不变。                                                                                                       |
| rc.13：删除 `registry.delete()`                                                                                                               | 项目没有调用；继续通过可等待的 `fiber.dispose()` 卸载。                                                                                                                                        |
| rc.13：loader 删除 `cordis:` 解析、`builtins`、`exit()`、`ModuleLoader` 及关联类型，`internal` 仅保留 `import()`                              | 项目使用自己的包名解析和进程管理；没有使用这些已删除入口。HMR 不再探测 loader 私有缓存接口。                                                                                                   |
| rc.13：`DisposableList.clear()` 的返回值改为正序                                                                                              | 项目未使用该集合，无需迁移。                                                                                                                                                                   |

## 运行语义与验证重点

HMR 通过 `registry.replace()` 原地替换组件，Fiber 身份和配置保持有效；服务实例与副作用仍会清理并重新创建。原有测试中等待 Fiber 身份改变的断言已改为等待服务实例重建，并确认旧 Fiber 引用仍可独立卸载。

公开的 `reconcile()` 入口与配置管理共用生命周期队列。卸载时等待已经执行的事务，跳过尚未执行的事务，避免卸载与排队重载互相等待。导入失败保留原实例，下一次文件变更重试失败单元；不相关单元可以独立更新。

官方 loader 现在把条目注入与组件注入分成外层、内层 Fiber，并分别计算配置表达式。项目仍自行校验配置、处理环境引用和注入组件，不调用 `Entry.update()` 来启用官方表达式配置；只登记 Entry 供宿主集成使用，因此不迁移到上游的新配置格式。

验证范围按共享 SDK 的实际消费关系选择：基础插件生命周期、配置加载与管理、配置面板、HTTP、HMR 和 AI 管理生命周期；HMR 使用真实 Node 子进程、文件监视器和本地 HTTP。服务端项目引用构建同时检查 SDK 的服务端消费者。测试不需要真实模型密钥，也不代表真实模型集成验证。

## 升级时的定向验证

验证环境为 macOS arm64、Node.js 26.13.1、pnpm 11.7.0，未在 Windows、Linux 或 x64 环境执行验证。

- `pnpm --filter @antarestra/server build`：服务端及项目引用构建通过。检查时发现启动入口对可选的 `process.disconnect` 缺少类型保护，已改为可选调用。
- `pnpm exec vue-tsc -p tsconfig.tests.json --noEmit`：测试与关联脚本类型检查通过。
- 定向执行以下 10 个测试文件，共 123 项通过，没有执行全量测试：

```sh
pnpm exec vitest run tests/integration/plugins.test.ts tests/integration/config-loader.test.ts tests/integration/config-manager.test.ts tests/integration/config-loader-diagnostics.test.ts tests/integration/config-layers.test.ts tests/integration/config-panel.test.ts tests/integration/hmr.test.ts tests/integration/hmr-webui.test.ts tests/integration/http.test.ts tests/integration/ai-management-lifecycle.test.ts
```

- `node scripts/smoke-server.mjs`：编译产物健康接口、认证、聊天与后台扩展、未登录拒绝检查通过，子进程已回收。S3、网页工具和终端插件因缺少环境配置未加载，不在本次冒烟成功范围内。
- 对本次修改文件执行 Prettier 格式检查与 `git diff --check`，均通过。

## 后续完整检查

2026-11-14 按用户要求，在 macOS arm64、Node.js 26.13.1、pnpm 11.7.0 环境执行 `pnpm check`。首次检查发现 OneBot 工具文件的 emoji 标识数组未按 Prettier 换行，已修正格式，数组内容与运行逻辑不变。

修复后重新执行完整命令，退出码为 0：

- 全仓库格式检查、TypeScript / Vue 类型检查通过。
- 全量测试共 91 个文件通过，1334 项通过、56 项按测试条件跳过，没有失败项。跳过条件涉及真实数据库、浏览器和 Open Terminal 远端环境，不能视为这些环境已经验证。
- 全工作区服务端与前端生产构建通过。构建仍有大于 500 kB 的前端分块提示，测试仍有 Node 实验性功能提示，均未导致检查失败。

在本次实际执行的检查范围内，没有发现 Cordis 升级导致的插件回归；尚未验证其他操作系统或架构。
