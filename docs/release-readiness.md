# November 1 Alpha release

Target: 2026-11-01. This is a local preparation checklist, not a published release announcement. The owner will supply the GitHub repository address separately. Do not upload local history or publish a release until the candidate and destination are reviewed.

## What must pass

- Fresh source checkout: Node >=22.19.0 <26, pnpm 10.34.9, frozen install, `pnpm run doctor`, `pnpm check`, `pnpm build`.
- Security: `pnpm audit:dependencies` has no high/critical advisories across runtime and build dependencies; renderer and extension-frame boundary tests pass.
- Conversations: new workspace selection, send/stream, model/thinking selection, stop, switching, drafts, archive/restore and restart.
- Parallel work: parent → child → grandchild, concurrent progress, completion and returned files; verify failure and admission-limit behavior.
- UI: keep conversation bubbles, blue running borders and matching GitTree light paths. Profile on a foreground window; record hardware and distinguish display refresh timing from CPU long frames.
- Doubao: fixed conversation identity, partial-history order, no unconfirmed automatic resend, received-video integrity. Fixture proof does not prove compatibility with the installed native App.
- Media: working FFmpeg/FFprobe, configured image-capable model, evidence-bound analysis, packaged process schemas. Template-perfect video reproduction is not an Alpha guarantee.
- Package: launch the exact signed candidate, create a conversation, verify native helpers and the bundled video process definitions from a working directory outside the source checkout. Source-run tests alone are insufficient.

## Parallel limits

Defaults are 8 unfinished child branches across the app, depth 4 below a root conversation, and 32 total child/grandchild records per task tree. Pending creations reserve capacity before asynchronous work begins. Existing sessions are not deleted when a limit is reached. Independent root conversations have independent tree counts.

Set environment variables to override: `LANCER_MAX_CONCURRENT_BRANCHES` (default 8), `LANCER_MAX_BRANCH_DEPTH` (default 4), `LANCER_MAX_TREE_BRANCHES` (default 32), `LANCER_MAX_TREE_TOKENS` (default 500000). Each accepts any positive integer, or `unlimited` / `off` to turn that check off for the session. Invalid values such as `0` still fail closed instead of silently removing the guard.

The token check is an **admission limit based on currently loaded provider-reported usage**, including input, output and cache tokens. It blocks new composer submissions and new branch requests once the known total reaches the threshold. It is not a billing cap: in-flight requests, previously queued turns, provider-internal tool loops and unloaded history can exceed it. Do not describe it as a guaranteed maximum cost. Hard runtime budgeting and write-isolated automatic branches remain separate work.

## Video model and tool configuration

By default analysis uses the model selected in the owning conversation. It must support image input and be authenticated through pi. There is no built-in private gateway or implicit second model. Optional explicit overrides live in the app userData directory as `video-learn-tools.json`:

```json
{
  "ffmpegPath": "/absolute/path/to/ffmpeg",
  "ffprobePath": "/absolute/path/to/ffprobe",
  "ytDlpPath": "/absolute/path/to/yt-dlp",
  "providerId": "your-configured-provider",
  "modelId": "your-image-capable-model",
  "handoffModelId": "your-optional-second-model"
}
```

Credentials stay in pi's auth/model configuration, never in this file or release artifacts. Model IDs above are placeholders. Configure both provider and model together. Omit `handoffModelId` if no second model is intended. The second model uses the same provider and must differ from the analysis model. Run `pnpm run doctor --media` to diagnose executables, including missing shared libraries.

## Public source and assets

`pnpm export:source /absolute/new/folder` exports current source with a hash manifest. It excludes `.git`, `.lancer-task`, local agent settings, known credential/signing files and generated build/test directories. It does not remove anything from the working checkout. Review the manifest, run checks from the export and perform a separate secret scan before publishing. The export is a candidate, not certification of a clean Git history.

Package a pristine export with `pnpm package:source /absolute/source-export /absolute/new-source.tar.gz`. This also supports the independent Light UI export. It verifies every listed file and rejects additional files before writing; archive ownership and timestamps are anonymous. Do not use a normal archive of the development directory. Check actual local API/OAuth values, private gateway URLs and saved account/session identifiers against the final package offline, without logging their values. Review screenshot/video content and metadata as well as source text. Existing local configuration and history stay on the owner's machine.

Retained relay evidence is optional and must be selected explicitly: set both `LANCER_RELAY_GOLDEN` (the golden JSON file) and `LANCER_RELAY_DISK_ROOT` (its workspace) to absolute paths. With neither set, the disk-evidence test is reported as skipped; synthetic relay tests still run. Incomplete or invalid explicit configuration fails instead of silently skipping. A fresh checkout must not read a maintainer's private workspace by default.

Remaining publication decisions:

- Repository URL, issue/security reporting channel and branch protection.
- The owner supplied the new App icon on 2026-10-30. Default assistant portraits now use the new icon and authored neutral SVG glyphs; old character artwork is retained privately. See `apps/desktop/resources/brand/README.md` for provenance. User-provided future portraits require the same asset review.
- The website now uses a current Electron capture with explicitly synthetic test conversations. Upstream media remain only with the preserved upstream documentation, not as Lancer product proof.
- Public Developer ID/notarization credentials, or an explicitly source-only first release. Local persistent signing is not public notarization.
- A clean-machine install and platform-specific native validation; Linux/Windows package configurations alone are not proof.

The source retains the upstream MIT license and attribution. Reference videos, Fate materials, downloaded files and private test recordings are not release assets.

## Website configuration

Build with `NEXT_PUBLIC_LANCER_GITHUB_URL=https://github.com/OWNER/REPO` and `NEXT_PUBLIC_LANCER_SITE_URL=https://YOUR_DOMAIN` after those destinations exist. Only set `NEXT_PUBLIC_LANCER_RELEASES_AVAILABLE=true` when release artifacts are actually available. An unconfigured preview disables indexing and offers release status instead of upstream downloads.

## 从源码包构建安装包

源码包不含 Git 历史，也不预填私人仓库地址。GitHub Actions 自动使用当前仓库 URL。
本地构建 Linux 安装包前设置 `LANCER_REPOSITORY_URL=https://github.com/你的账号/你的仓库`（替换成实际地址）；其他平台也可设置它来填入安装包元数据。
地址未确定时可以完成源码安装、检查、开发启动和 macOS 本地验证，不能把上游 pi-gui 地址填作 Lancer 下载来源。

真实视频模型验收需要显式配置：`LANCER_VIDEO_PASS_LIVE=1`、`LANCER_VIDEO_PASS_PROVIDER`、`LANCER_VIDEO_PASS_MODEL`，以及绝对路径的 `LANCER_VIDEO_PASS_AGENT_DIR`（或 `PI_APP_REAL_AUTH_SOURCE_DIR`）。模型必须支持图片输入。
`FFMPEG`、`FFPROBE` 可指定实际可执行文件。测试不再依赖维护者的私人网关或默认读取个人目录。
