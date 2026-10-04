# 全局表情包库

在主配置启用 `im-stickers-lib: {}`。依赖数据库、RBAC 和 workspace-file；控制台、AI 模板和 IM 指令分别随 WebUI、AI、IM/命令服务接入。可选服务卸载不删除库数据。元数据使用当前数据库后端持久化，图片复用 workspace-file 的存储后端和配额。

## 管理与使用

管理控制台 → 机器人 → 表情包库：图片列表支持查询、添加、编辑标题/描述/分类和删除。访问需要 `admin.console.view` 和 `admin.im.stickers.manage`。编辑保留文件 ID，修订冲突拒绝覆盖；标题全局唯一，分类留空为“未分类”，描述可留空。

图片支持 PNG、JPEG、GIF、WebP，最大 8 MiB；服务端验证实际格式与尺寸。添加生成独立图片文件，不依赖原群媒体归档或用户文件的保留时间。

在助理提示词中使用 `{{ im_stickers }}`，运行时插入全部已登记表情包，一行一条：

```text
ID: 文件ID | 标题: "开心" | 文本描述: "开心地笑" | 分类: "情绪"
```

空库返回空文本。ID 就是 workspace-file 文件 ID，可以交给 `im_prepare_image`，也可用于现有 IM 回复的 `<sticker>resource://文件ID</sticker>`。模板不输出临时签名地址。

## IM 指令

```text
/sticker add 标题 [同一条消息中的一张图片]
/sticker delete 标题
```

标题可包含空格，也可用引号包围。添加时描述为空、分类为“未分类”，后续在控制台完善。这两项属于 **bot 管理指令**，由 im-commands 校验当前群的 bot 管理权限；群主自动拥有权限，额外管理员通过 `/admin add <id>` 或“群消息与 AI 会话”列表设置。私聊不能执行 bot 管理指令。

表情包全局共享，任何群的 bot 管理员删除表情包都会影响所有使用方。

## 共享边界与清理

图片保存在专用工作空间 `library:im-stickers`，可在存储配额面板管理容量。插件通过 workspace-file 的 `registerSharedResources` 只发布仍在库中的精确 ID。调用方仍需原有身份/空间授权；按 ID 读取、下载、AI 附件和 IM 发送允许共享资源。目录、路径读取、移动、删除等操作继续限定调用方工作空间。不能通过普通文件 API 修改共享库。

删除先在数据库事务中撤销登记并记录待清理 ID，然后删除图片文件。存储故障时保留持久清理队列，每分钟重试；不再对其他空间公开。已签发的临时地址遵循存储后端的原到期时间，不能保证撤销已经发出的链接。插件卸载撤销共享解析器、模板、指令和页面；重新启用恢复已保存的库。

HTTP API 位于 `/api/im-stickers`：GET 列表，POST 添加（元数据、mimeType、base64 data），PUT `/:id` 编辑（带 revision），POST `/:id/delete` 删除（带 revision），GET `/:id/content` 获取管理预览。所有管理接口都校验控制台和表情包管理权限，写请求检查同源及体积限制。
