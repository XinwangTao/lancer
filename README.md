# Lancer

<p align="center">
  <img src="docs/branding/lancer-readme-banner.png" alt="Lancer — agent-native desktop workspace" width="100%" />
</p>

Lancer 是基于 [pi-gui](https://github.com/minghinmatthewlam/pi-gui) 和 [pi](https://github.com/earendil-works/pi) 的桌面 AI 工作区。把会话、并行分支、运行过程和交付文件放在一起，方便追溯一次任务从开始到结束的过程。

**当前为开发中的 Alpha。** 源码仓库：https://github.com/raylee-ai/lancer 。macOS Apple Silicon 是主要验证平台，Linux / Windows 的打包配置不代表所有原生功能已经验证。

- **会话与模块**：常态会话独立使用；模块会话可配置阶段、模型、Skill、目标和交付要求。
- **并行工作**：一个助手可管理多个会话；任务可派生子分支和孙分支，结果回到父会话汇总。
- **GitTree**：右侧同时查看多条会话线、分支、合并和交付节点；可聚焦当前会话。它是任务事件图，节点不都代表 Git 提交。
- **运行反馈**：活动气泡和过程行有流动边框，模型和交付动作向对应节点发送同色光线。
- **模型与账号**：通过 pi 接入订阅账号、API 密钥和自定义端点。模型品牌与网关分别管理。
- **豆包接管**：macOS 上关联一个已打开的豆包 App 会话，接收回复和视频。需要本机辅助功能权限，桌面版 UI 更新可能影响兼容性。

视频工作流能够下载或接收视频、提取关键帧、生成带证据的分析和交接文件。**自动复刻尚不能保证与模板 1:1 一致**；豆包接管、模型分析、代码动画与最终剪辑是不同环节，需要分别验收。

## 单独复用光线 UI

只想使用模型 / 气泡到工作树的光线？见 [Lancer Light UI](packages/light-ui/README.md) 和 [可复制提示词](packages/light-ui/PROMPT.md)。它不依赖 Electron、CLI 或模型服务，提供单线、分叉合并与多会话并行示例。

```sh
pnpm export:light-ui /absolute/new/lancer-light-ui
cd /absolute/new/lancer-light-ui
npm install && npm run dev
```

## Develop

要求 Node **>=22.19.0 <26**（推荐 24）、pnpm **10.34.9**、Git。macOS 还需要 Xcode Command Line Tools。

```sh
npx --yes pnpm@10.34.9 run doctor
npx --yes pnpm@10.34.9 install --frozen-lockfile
npx --yes pnpm@10.34.9 dev
```

以上命令不需要 `corepack enable` 或全局安装 pnpm。已有 pnpm 10.34.9 时，可直接使用 `pnpm`。

Linux 还需要 Python 3、make 和 C++ 编译器，用于原生终端依赖；Debian / Ubuntu 可先安装 `build-essential python3`，其他发行版安装对应开发工具。Linux 图形会话及系统运行库仍需按平台验证。

若安装时跳过了依赖脚本，Electron 二进制不会自动存在。确认网络可访问 Electron 下载源后，运行 `npx --yes pnpm@10.34.9 run setup:electron`，再启动；不要通过关闭全部依赖脚本检查来修复。

首次启动后，在设置中连接模型账号，添加工作区，再创建会话。源码启动不需要签名证书。可用 `LANCER_LOCALE=zh-CN` 或 `en` 指定语言。

会话和账号使用 pi 的 `~/.pi/agent`；Lancer 界面状态在 macOS 的 `~/Library/Application Support/Lancer`。请勿把这些目录、认证文件或真实会话录屏提交到公开仓库。

可选配置及加载方法见 [`.env.example`](.env.example) 和下方英文开发指南。桌面启动不会自动读取 `.env`，实际账号请在应用设置中连接。工作区之外的目录（例如知识库）可通过[额外捕获根](docs/external-capture-roots.md)进入同一回合的变更记录。

### 视频工具

视频处理另外需要可运行的 FFmpeg、FFprobe、yt-dlp：

```sh
pnpm run doctor --media
```

工具不在 PATH 时，可通过 `FFMPEG`、`FFPROBE`、`YT_DLP` 环境变量指定路径；桌面启动也可在用户数据目录的 `video-learn-tools.json` 配置绝对路径。配置格式与模型选择见[发布与验证说明](docs/release-readiness.md)。诊断会实际执行工具版本命令，因此能发现“文件存在但动态库缺失”的情况。

### 验证

完整检查包含真实媒体解码测试，需要可运行的 FFmpeg 和 FFprobe。
先执行 `ffmpeg -version`、`ffprobe -version`；工具不在 PATH 时设置上文的环境变量。
只有启动对话界面时不需要这些媒体工具。

```sh
pnpm check
pnpm build
pnpm audit:dependencies
pnpm verify:install-copy
pnpm verify:release-config
pnpm --filter @lancer/desktop run test:e2e:core
```

Core 是隔离数据的真实 Electron 界面测试。真实模型、原生权限、安装包和性能测试分别运行；Core 通过不能代替这些证据。参阅[验证技能](.agents/skills/verify-pi-gui/SKILL.md)、[测试说明](apps/desktop/tests/AGENTS.md)和[贡献指南](CONTRIBUTING.md)。

## 构建与安装 macOS 应用

源码压缩包不包含可直接双击的 `.app`，需要先安装依赖并构建。独立应用下载尚未发布；不要把源码包当成安装包。

```sh
bash scripts/build-mac-lancer.sh --skip-install --dir
```

本地安装包要求配置**持久签名证书**；脚本不会自动创建证书、切换到临时签名或公证。配置方法见 [macOS 本地签名](docs/macos-local-signing.md)。输出保存在独立的 `apps/desktop/release-local-*/` 目录。

验证后添加 `--install` 可安装到 `/Applications`。安装器要求正常退出旧应用，校验签名，并保留可恢复的旧版本；会话数据不会被清空。公开分发还需要 Developer ID、公证和干净机器验收，不能把本地签名等同于已经公证。

## 准备源码发布

```sh
pnpm export:source /absolute/path/to/new/lancer-source
```

该命令生成新的源码候选目录和 SHA-256 清单，排除 `.git`、本地会话产物、密钥文件和构建输出。它保留当前工作区、历史截图和录屏。候选包仍需审核素材授权和敏感内容，命令成功不等于已批准公开发布。

网站可在构建时配置 `NEXT_PUBLIC_LANCER_GITHUB_URL` 和 `NEXT_PUBLIC_LANCER_SITE_URL`。只有发布产物真实可用后才设置 `NEXT_PUBLIC_LANCER_RELEASES_AVAILABLE=true`。未配置时显示待发布状态，不把用户导向上游安装包。

## English development guide

Lancer is an Alpha desktop workspace for parallel AI conversations, recursive branches and traceable deliverables. The source archive is not a ready-to-run application. Workspace packages use the `@lancer/*` scope; upstream copyright notices remain intact.

### Prerequisites

- Node.js **>=22.19.0 <26** (24 recommended), Git and **pnpm 10.34.9**.
- macOS: Xcode Command Line Tools (`xcode-select --install` if absent).
- Linux: Python 3, make and a C++ compiler (Debian/Ubuntu: `sudo apt-get install build-essential python3`). A graphical desktop and Electron system libraries are required; headless CI needs its own display setup.
- Windows: Python and Visual Studio Build Tools with the C++ workload may be required for native dependencies. Native Windows behavior has not been validated in this release round.

### Install and start

Extract into a new directory, open a terminal in its `lancer` folder, then run:

```sh
npx --yes pnpm@10.34.9 run doctor
npx --yes pnpm@10.34.9 install --frozen-lockfile
npx --yes pnpm@10.34.9 dev
```

This avoids a global pnpm installation and `corepack enable` permissions. Downloads require internet access. After startup, connect your model account in Settings, select a workspace and create a conversation. Existing pnpm 10.34.9 users can replace `npx --yes pnpm@10.34.9` with `pnpm` in these commands.

### Configuration and privacy

See [`.env.example`](.env.example) for optional language, media tool and public website settings. Folders outside a workspace, such as a knowledge base, join the same turn changes through [extra capture roots](docs/external-capture-roots.md). Desktop scripts do **not** automatically load `.env` files. On macOS/Linux, copy the template to `.env.local`, review it, and load it in the same terminal:

```sh
cp .env.example .env.local
set -a
. ./.env.local
set +a
```

On PowerShell, set individual values, for example `$env:LANCER_LOCALE = "en"`. Configure model credentials in the app; never commit keys, private endpoints or real transcripts. A separate source folder does not isolate runtime data: pi uses `~/.pi/agent`, and macOS app state uses `~/Library/Application Support/Lancer`. Use a separate OS user for fully isolated manual testing.

### Troubleshooting

| Symptom                          | Action                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corepack permission error        | Use the pinned `npx` commands above; no global shim change is required.                                                                                                   |
| Electron not installed correctly | Check installation/network errors, then run `npx --yes pnpm@10.34.9 run setup:electron`. Do not approve every dependency script indiscriminately.                         |
| Linux `make` / compiler missing  | Install native build prerequisites before retrying installation.                                                                                                          |
| Video tools missing or failing   | Run `pnpm doctor --media`; set `FFMPEG`, `FFPROBE`, `YT_DLP` to working executables. A missing shared library is a broken tool installation, not a successful tool check. |
| Model unavailable                | Connect a supported account/provider in Settings. No personal credentials ship with the source.                                                                           |

### Build and test

```sh
pnpm check
pnpm build
pnpm --filter @lancer/desktop run test:dev:reload
pnpm --filter @lancer/desktop run test:e2e:core
```

Media tests require working FFmpeg/FFprobe. Core tests use isolated fixtures and do not establish real-provider or native-platform compatibility. See [platform validation](docs/platform-validation.md) for the actual coverage and gaps.

For a local macOS application, run `bash scripts/build-mac-lancer.sh --skip-install --dir` after configuring a persistent signing identity as described in [macOS signing](docs/macos-local-signing.md). Output is placed in `apps/desktop/release-local-*/`. The source archive contains no `.app`; local signed apps are not notarized public releases. Do not replace an installed app until the candidate is verified.

## 致谢与许可

Lancer 基于 Matthew Lam 的 **pi-gui v1.0.1**（MIT）开发，保留原始 [LICENSE](LICENSE)、版权声明、[NOTICE](NOTICE) 和[上游 README](docs/upstream/README.md)。Lancer 与 pi-gui、pi 和模型提供商没有隶属关系。

第三方模型商标、用户上传头像、参考视频和 Fate 素材不因源码 MIT 许可而自动获得再分发许可。公开包中的素材须单独核查；用户工作区内容不属于发布源码。

依赖包各自保留原许可证，详见[第三方依赖说明](docs/third-party-dependencies.md)。`video/` 是可选的宣传视频工具，使用 Remotion License，不属于桌面应用或光线 UI 的运行依赖。
