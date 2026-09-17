---
version: alpha
name: Antarestra
description: 以紫色与薄荷色品牌标识连接聊天空间和插件管理控制台。
colors:
  primary: '#315ed1'
  sidebar: '#111d32'
  background: '#f4f6fa'
  surface: '#ffffff'
  text: '#263047'
  scrollbar: '#a3adbd'
typography:
  sans:
    fontFamily: "'Segoe UI', 'Microsoft YaHei', sans-serif"
rounded:
  DEFAULT: '10px'
  sm: '7px'
  lg: '12px'
spacing:
  page: '36px'
  compact: '16px'
components:
  logo: {}
  icon: {}
  navigation: {}
  feedback: {}
---

# Antarestra 视觉规范

## 产品与视觉方向

面向管理插件、用户和权限的管理员，以及进入个人工作空间的聊天用户。界面为简体中文，现有业务资料未规定特定地域市场。桌面用于管理，窄屏保证导航和操作可达。

保留现有深蓝导航与浅色工作区；让三道倾斜、紫色与薄荷色的品牌笔画成为视觉识别点。品牌表现集中在 Logo，表格、表单和菜单采用安静、明确的产品界面，不增加营销式装饰或动画。

本文件记录既有运行时样式及此次统一决策，不生成 CSS。全局字体、焦点和滚动条由 `plugins/definitions/webui/client/style.css` 唯一维护；控制台布局由 `ConsoleLayout.vue` 维护，聊天布局由 `chat.css` 维护。修改这些规范时同步检查对应样式和真实页面。

## 颜色

控制台主色为 primary，导航背景为 sidebar，工作区为 background，卡片为 surface，正文为 text。Logo 原色以 `assets/brand/logo.svg` 为唯一来源，不在组件内重新描摹或着色。聊天保留现有浅中性色和绿色辅助色。

全局滚动条变量为 `--scrollbar-thumb`、`--scrollbar-track`、`--scrollbar-hover`、`--scrollbar-active`；焦点由 `--focus-ring` 定义。高对比模式使用系统滚动条和 Highlight 焦点色。当前只承诺浅色工作区，不宣称已实现深色主题。

## 字体

沿用系统字体，中文回退到微软雅黑，避免额外字体下载和布局偏移。品牌文字 19–21px、控制台标题 27px、正文 14px，窄屏标题 23px。层级用字号、字重和间距表达，不引入无关装饰字体。

## 布局

控制台侧栏 248px、折叠后 76px，内容最大宽度 1500px，桌面内边距 36px；760px 以下内容边距 16px，首次加载默认折叠菜单。控制台不设置独立顶栏，页面定位由左侧当前项与内容标题共同表达。内容自然滚动，表格局部横向溢出，不固定表单高度。异步权限检查不清空已挂载的外壳。

## 层次与深度

以表面颜色和细边框区分区域，移动侧栏和通知可使用现有阴影；普通卡片不增加浮动效果。弹窗由 WebUI 的原生 dialog 进入顶层，避免手工模拟焦点约束。

## 形状

导航圆角 7px，卡片 10–12px，延续现有控件形状。Logo 保持 96:80 原始比例，不使用字母方块代替，不添加背景遮盖原始图形。

## 组件

- Logo：`@antarestra/webui/components` 的 `AntarestraLogo`，默认宽 36px；`size` 调整宽度，`decorative` 用于已有品牌文字的场景。
- 图标：`@antarestra/webui/icons` 的 Heroicons 24px 线性图标，默认通过 `ui-icon` 显示为 20px，继承文字色；图标按钮保留可访问名称，菜单仍带文字。
- 导航：`ConsoleLayout.vue` 为共享外壳，选中项有底色和 `aria-current`。分组标题是可折叠按钮，默认只展开当前分区，并保留当前页面会话内的手工开合。折叠按钮位于品牌右侧，整栏折叠后 Logo 作为恢复入口；图标菜单通过标题与可访问名称保留含义。
- 账号菜单：用户名与头像固定在侧栏底部，整栏折叠后只显示头像。头像菜单向上展开，统一提供用户中心、返回聊天和退出登录，并支持方向键、Home、End 与 Escape。
- 反馈：继续使用 `FeedbackHost.vue`；加载、错误、拒绝访问用中文文字说明，错误提供恢复路径。焦点始终可见，禁用操作保留禁用语义。
- 动效：只保留现有短侧栏过渡；减少动态效果设置下禁用侧栏过渡。不得用动画遮掩重复挂载。

## 应当与避免

- 应当通过共享入口复用图标、Logo 和反馈。
- 应当同时验证常规窗口、窄屏及键盘访问。
- 避免特殊字符图标、字母 Logo 占位符和插件内重复品牌资源。
- 避免把导航权限快照当作服务端授权依据。

## 用户与权限管理

用户列表以用户名为主，登录名和主体标识作为灰色辅助信息；角色以名称与 ID 成对呈现。筛选栏取代卡片内重复标题。角色编辑采用列表与下方面板，选中行与面板顶部使用现有 primary 色建立关联；锁定的默认权限使用 background 色，不增加新的颜色令牌。实现样式由 auth-local/client/style.css 维护。

初始登录信息使用共享编辑弹窗呈现，密码采用 Cascadia Mono、Consolas、Courier New 的等宽字体栈以方便打印辨认；复制操作复制完整交付文本，但通知不重复显示密码。登录、注册与修改密码共用带文字标签的显示/隐藏密码控件，默认保持遮罩。

可编辑下拉框由 WebUI 的 EditableSelect.vue 统一维护，基于 Reka UI 处理键盘、弹层和碰撞边界；使用现有主色、边框及圆角。表单弹窗由 EditorDialog.vue 维护，原生 dialog 负责焦点隔离，内容超高时在弹窗内滚动。
