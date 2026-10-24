# macOS 原生开发与迁移

开发目录使用 `~/Workspace/Antarestra`。Node.js、pnpm、TypeScript/Vue 构建、Chrome 和 PostgreSQL 在 macOS 原生运行；NapCat 和空的 RustFS 文件存储通过 Colima 的 Docker 运行。

## 安装开发工具

Apple Silicon 使用 `/opt/homebrew` 下的 Homebrew。安装 Xcode Command Line Tools 和 Chrome 后执行：

```sh
brew install node@24 postgresql@18 colima docker docker-compose
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/postgresql@18/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
npm install --global --prefix "$HOME/.local" pnpm@11.7.0
```

在 `~/.zprofile` 中持久化 Homebrew 和上述 PATH。SSH 非交互命令不一定读取该文件，应明确设置 PATH；LaunchAgent 也必须显式指定 PATH 和工作目录。

下载需要本机代理时，仅为相应安装命令设置环境：

```sh
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
export NO_PROXY=localhost,127.0.0.1,::1
```

在 `~/.docker/config.json` 的 `cliPluginsExtraDirs` 数组中加入 `/opt/homebrew/lib/docker/cli-plugins`，保留文件原有配置。

## 源码、配置与依赖

从原机器复制 Git 仓库，或通过 `git bundle create` / `git clone` 保留尚未推送的提交。用 bundle 克隆后，将 `origin` 改回实际远程仓库地址。

单独安全复制 `.env`、`antarestra.local.yml` 和 `.env.storage.local`，权限设为 `600`。不要输出或提交这些文件。重新安装 macOS 依赖，不能复制 Windows 的 `node_modules` 或构建产物：

```sh
cd ~/Workspace/Antarestra
pnpm install --frozen-lockfile
pnpm build
```

如果存在独立的 `plugins/private.local` 仓库，同时迁移其源码与 Git 历史，再执行：

```sh
cd ~/Workspace/Antarestra/plugins/private.local
pnpm install --frozen-lockfile
pnpm build
pnpm attach
```

第三方插件中的 Windows 可执行文件路径需要单独替换。可将本机辅助程序放在 `~/Workspace/bin`，在本地配置中填写绝对路径；迁移源码不代表已验证这些程序的实际功能。

## PostgreSQL 数据迁移

原生数据库使用 PostgreSQL 18，与现有开发库保持相同主版本：

```sh
brew services start postgresql@18
```

迁移前停止旧应用写入，使用源端 `pg_dump -Fc` 制作一致性备份，通过 SSH 传输并核对 SHA-256。在目标端创建独立应用角色和空数据库，使用 `pg_restore --exit-on-error --no-owner --role=应用角色 --dbname=数据库 --jobs=4` 恢复。不要把备份恢复进已有业务库。

将目标 `.env` 中的 `ANTARESTRA_DATABASE_URL` 改为原生实例的本机连接，应用角色使用随机密码。Homebrew 初始化可能默认允许本地 TCP `trust` 登录，应将 `pg_hba.conf` 的 TCP 规则调整为 `scram-sha-256`，保留本机维护所需的 Unix socket 访问，再重载配置。数据库只监听本机。

启动新应用前，对比全部业务表的行数与内容摘要，以及序列值。跨 Linux/macOS 比较时，对每行使用 `to_jsonb(row)::text` 统一表示，固定时区，并按 `COLLATE "C"` 排序行摘要。复合行直接转 `text` 的引号表示可能随系统区域设置不同，不能据此断言数据丢失。逻辑恢复不保留旧库空闲页和膨胀空间，物理体积变小不代表少迁了数据。

迁移完成后保留源数据库和受保护的备份，避免同时启动新旧机器人实例。

## Docker、NapCat 与原生服务互联

```sh
colima start --vm-type vz --arch aarch64 --cpu 4 --memory 6 --disk 80 --runtime docker
```

Docker daemon 的下载代理与终端代理是不同配置。Colima 虚拟机内访问 macOS 回环代理应使用 `http://192.168.5.2:7890`；可通过 `~/.colima/default/colima.yaml` 的 `env` 配置持久化。`no_proxy` 包含回环地址及宿主地址。按当前网络实际情况设置 `network.dns`，并验证虚拟机和容器内的域名解析。

首次启动若出现 `/etc/resolv.conf` 指向不存在的 systemd-resolved 文件、dnsmasq 启动失败，检查实际解析文件和服务日志，使用当前网络中已验证可用的 DNS 修复，并在 Colima 配置中持久化。不能只验证通过代理拉取镜像成功。

复制仓库的 `compose.napcat.yml` 到 `~/Workspace/NapCat/compose.yaml`，在该目录创建权限为 `600` 的 `.env`，配置随机 `NAPCAT_WEBUI_TOKEN`。首次扫码成功后，可设置 `NAPCAT_ACCOUNT` 为原机器人账号以便重启后快速登录。

```sh
cd ~/Workspace/NapCat
docker compose up -d
```

在 NapCat WebUI 中配置 **WebSocket 客户端（反向 WebSocket）**：

- 地址为 `ws://host.lima.internal:14451/im/onebot/实例路径`，与 Antarestra `im-onebot.path` 一致，无 `/api` 前缀。
- Token 与 Antarestra 的 `ANTARESTRA_ONEBOT_TOKEN` 一致，消息格式为 `array`。
- 登录账号与 Antarestra 的 `selfId` 一致，连接角色为 `Universal`。

Compose 的 `extra_hosts` 将 `host.lima.internal` 映射为 `host-gateway`；Colima 的 Docker daemon 将这个网关指向 macOS 宿主。容器内的 `127.0.0.1` 不指向原生 Antarestra。Antarestra 应监听容器可达的地址，例如现有默认 `0.0.0.0:14451`。

NapCat 管理端口只绑定宿主回环。Mac 上访问 `http://127.0.0.1:6099/webui/`；从其他电脑管理时使用 SSH 转发：

```sh
ssh -N -L 6099:127.0.0.1:6099 用户名@Mac主机
```

QQ 扫码和手机确认必须由账号本人完成。验证应包括容器到 `/api/health` 可达、QQ 已登录、反向 WebSocket 保持连接，以及服务重启后恢复连接；不需要为了验证而向真实群聊发送消息。

部署依据：[NapCat 官方 Docker 指南](https://napneko.github.io/guide/boot/Shell#docker)、[Colima 官方说明](https://github.com/abiosoft/colima/blob/main/docs/FAQ.md)。

## 文件存储与日常启动

不迁移文件时，新建空的 RustFS 存储：

```sh
cd ~/Workspace/Antarestra
pnpm startdevstorage
pnpm initdevstorage
pnpm test:storage
```

数据库中的旧附件、表情和资源记录仍会保留，但对应旧文件内容不在新存储中；这些历史资源不能正常下载。新上传使用新存储。

开发服务直接运行 `pnpm dev`。初次完整构建后，按需另开终端运行对应前端插件的 `pnpm --filter 包名 dev`；根级 `pnpm dev` 不启动前端构建监听。

本次部署使用用户级 LaunchAgent `local.antarestra.dev` 托管原生 `pnpm dev`，日志位于项目 `.tmp/macos/`。常用操作：

```sh
# 查看与重启原生开发服务
launchctl print "gui/$(id -u)/local.antarestra.dev"
launchctl kickstart -k "gui/$(id -u)/local.antarestra.dev"

# 停止后台实例，切换到终端前台调试
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.antarestra.dev.plist"
cd ~/Workspace/Antarestra
pnpm dev

# 结束前台进程后恢复后台实例
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.antarestra.dev.plist"
```

PostgreSQL 与 Colima 使用 `brew services` 管理；容器采用 `restart: unless-stopped`。这些用户级服务在用户登录后启动，不保证停留在 FileVault 解锁界面时运行。不要在后台实例仍运行时另外启动占用相同端口的开发服务。
