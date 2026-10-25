# macOS 原生开发与迁移

本指南以 macOS arm64（Apple Silicon）、zsh / bash 为例，不要求 PowerShell。项目也面向 macOS x64；Intel Mac 的 Homebrew 前缀和外部依赖路径需按本机安装位置调整。完整开发与目标运行平台范围见[启动与开发指南](development.md)。

开发目录使用 `~/Workspace/Antarestra`。Node.js、pnpm、TypeScript/Vue 构建、Chrome 和 PostgreSQL 在 macOS 原生运行；NapCat 和 RustFS 文件存储通过 OrbStack 的 Docker 运行。

## 安装开发工具

Apple Silicon 使用 `/opt/homebrew` 下的 Homebrew。安装 Xcode Command Line Tools 和 Chrome 后执行：

```sh
brew install node@24 postgresql@18
brew install --cask orbstack
open -a OrbStack
export PATH="$HOME/.orbstack/bin:/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/postgresql@18/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
npm install --global --prefix "$HOME/.local" pnpm@11.7.0
```

在 `~/.zprofile` 中持久化 Homebrew 和上述 PATH。SSH 非交互命令不一定读取该文件，应明确设置 PATH；LaunchAgent 也必须显式指定 PATH 和工作目录。

下载需要本机代理时，仅为相应安装命令设置环境：

```sh
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
export NO_PROXY=localhost,127.0.0.1,::1
```

OrbStack 自带 Docker CLI 和 Compose，无需另装 Homebrew 的 `docker`、`docker-compose`。通过 `orb doctor` 检查命令路径和插件，通过 `docker context show` 确认当前上下文为 `orbstack`。

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
orb start
docker context use orbstack
orb config set cpu 4
orb config set memory_mib 6144
orb config set app.start_at_login true
orb config set app.wait_for_container_stop true
orb config set network.proxy.exclude 'localhost,127.0.0.1,::1,host.docker.internal,host.orb.internal'
```

CPU 和内存是这台开发机的配置选择，可按负载调整；设置后按提示执行 `orb stop`、`orb start` 生效。

Docker daemon 的下载代理与终端代理是不同配置。OrbStack 默认 `network_proxy: auto`，跟随 macOS 系统代理；只给终端设置 `http_proxy` 不等于配置了 daemon。通过 OrbStack 的网络设置调整代理，并保留宿主地址的排除规则。验证容器内的 DNS 和宿主访问，不能只验证拉取镜像成功。

复制仓库的 `compose.napcat.yml` 到 `~/Workspace/NapCat/compose.yaml`，在该目录创建权限为 `600` 的 `.env`，配置随机 `NAPCAT_WEBUI_TOKEN` 和固定 `NAPCAT_MACHINE_ID`（32 位小写十六进制）。已有容器应读取其 `/etc/machine-id`，将原值写入 `.env`，不要重新生成；全新部署可用 `openssl rand -hex 16` 生成一次。`.env` 权限保持为 `600`，不提交版本库。首次扫码成功后，可设置 `NAPCAT_ACCOUNT` 为原机器人账号以便重启后快速登录。

```sh
cd ~/Workspace/NapCat
docker compose up -d
```

Compose 通过 `configs.content` 从 `.env` 读取 machine-id，并在 `/etc/machine-id` 与 `/var/lib/dbus/machine-id` 提供只读配置文件（需要 Docker Compose 2.23.1 或更新版本）。Linux QQ 的 GUID 按 `MD5(machine-id + MAC)` 计算，其中 MAC 来自 QQ 数据目录的 `global/nt_data/msf/machine-info`，不一定等于容器网卡 MAC；必须同时保留 `.env` 中的 machine-id 和 QQ 数据目录，才能在重建或升级镜像后保持该 GUID。

Compose 还显式固定了当前部署的 hostname 和 MAC 地址，并通过三个 `data` 目录持久化 QQ 登录数据、NapCat 配置和插件。重建或升级时保留这些配置与目录；部署其他实例时使用独立的 MAC 地址。修改 hostname 或 MAC 后执行 `docker compose up -d napcat` 应用配置，这会重建容器并短暂断线；OrbStack 的 Restart 只重启现有容器，不会应用 Compose 修改。固定这些标识不能保证 QQ 永远不要求重新验证。

在 NapCat WebUI 中配置 **WebSocket 客户端（反向 WebSocket）**：

- 地址为 `ws://host.docker.internal:14451/im/onebot/实例路径`，与 Antarestra `im-onebot.path` 一致，无 `/api` 前缀。
- Token 与 Antarestra 的 `ANTARESTRA_ONEBOT_TOKEN` 一致，消息格式为 `array`。
- 登录账号与 Antarestra 的 `selfId` 一致，连接角色为 `Universal`。

OrbStack 内置 `host.docker.internal` 指向 macOS 宿主，无需 Compose `extra_hosts`。容器内的 `127.0.0.1` 不指向原生 Antarestra。Antarestra 应监听容器可达的地址，例如现有默认 `0.0.0.0:14451`。

NapCat 管理端口只绑定宿主回环。Mac 上访问 `http://127.0.0.1:6099/webui/`；从其他电脑管理时使用 SSH 转发：

```sh
ssh -N -L 6099:127.0.0.1:6099 用户名@Mac主机
```

QQ 扫码和手机确认必须由账号本人完成。验证应包括容器到 `/api/health` 可达、QQ 已登录、反向 WebSocket 保持连接，以及服务重启后恢复连接；不需要为了验证而向真实群聊发送消息。

部署依据：[NapCat 官方 Docker 指南](https://napneko.github.io/guide/boot/Shell#docker)、[OrbStack 安装说明](https://docs.orbstack.dev/install)、[OrbStack 容器网络](https://docs.orbstack.dev/docker/network)。

## 文件存储与日常启动

从其他电脑迁入且不迁移历史附件时，首次新建空的 RustFS 存储：

```sh
cd ~/Workspace/Antarestra
pnpm startdevstorage
pnpm initdevstorage
pnpm test:storage
```

数据库中的旧附件、表情和资源记录仍会保留，但对应旧文件内容不在新存储中；这些历史资源不能正常下载。新上传使用新存储。

### 从 Colima 切换到 OrbStack

Docker 上下文拥有各自的容器、镜像和命名卷，切换上下文不会迁移卷数据。迁移期间显式使用 `docker --context colima` 与 `docker --context orbstack`，避免误操作。

1. 清点旧环境的全部容器与卷，停止原生 Antarestra 和 NapCat，等待写入停止；记录 RustFS 的桶配置、对象元数据与下载内容的 SHA-256，然后停止 RustFS。
2. 将 `~/Workspace/NapCat` 的 `data`、`compose.yaml` 和 `.env` 一起备份。QQ 登录状态在 `data/qq`，连接配置在 `data/config`；这些宿主绑定目录可直接复用。备份含凭据，目录权限设为 `700`，文件设为 `600`。
3. 离线导出 `antarestra-storage_antarestra_dev_rustfs` 卷，保留文件权限与数字 UID/GID，记录全部文件的 SHA-256。使用 `docker image save` / `load` 搬运正在使用的镜像，避免迁移过程中同时升级 `latest`。
4. 在 OrbStack 创建同名卷，补充 Compose 的项目和卷标签，恢复数据；在启动 RustFS 前对比全部文件摘要。将 NapCat 反向连接中的 `host.lima.internal` 改为 `host.docker.internal`，删除旧的 `extra_hosts`。
5. 用原 `.env.storage.local` 和相同 Compose 项目名启动 RustFS，再对比对象内容、元数据和桶配置；不要重新初始化已有桶。随后启动原生 Antarestra 与 NapCat，验证登录、容器访问宿主健康接口及反向 WebSocket，再验证 OrbStack 和原生服务重启后的恢复。
6. 验证通过后，停止 Colima 的 Homebrew 服务，使用 `colima delete default --force --data` 删除已迁移的虚拟机及运行时数据。确认 Lima 没有其他用途后卸载 `colima`、`lima`；使用 OrbStack 自带 CLI 后，也可卸载重复的 Homebrew `docker`、`docker-compose`，并移除失效的插件搜索路径。保留独立备份，最后执行 `orb doctor` 和服务健康检查。

本次切换保留了现有 RustFS 的 1 个桶、10 个对象与 NapCat 登录状态。迁移前后卷文件、对象内容和桶配置均已对比；受保护的回滚备份位于 `~/Workspace/.orbstack-migration`。

### 日常启动

开发服务直接运行 `pnpm dev`。初次完整构建后，按需另开终端运行对应前端插件的 `pnpm --filter 包名 dev`；根级 `pnpm dev` 不启动前端构建监听。

当前已禁用用户级 LaunchAgent `local.antarestra.dev`，Antarestra 不再随登录自动启动。原 plist 和历史日志保留，日常在 Mac 终端手工运行：

```sh
cd ~/Workspace/Antarestra
pnpm dev
```

通过 `launchctl print-disabled "gui/$(id -u)"` 可确认 `local.antarestra.dev` 为禁用状态。前台开发进程使用 `Ctrl+C` 停止；在普通 SSH 会话中手工运行时，不保证断开会话后继续运行。

PostgreSQL 使用 `brew services` 管理，OrbStack 已设置登录时启动；NapCat 和 RustFS 容器采用 `restart: unless-stopped`，保持自动启动。NapCat 会等待手工启动的 Antarestra 并自动重连。这些用户级服务在用户登录后启动，不保证停留在 FileVault 解锁界面时运行。不要同时启动多个占用相同端口的开发服务。
