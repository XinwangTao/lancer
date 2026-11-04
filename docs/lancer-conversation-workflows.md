# Lancer 会话与模型交接

2026-10-28 实现与验证交接。验收目标是保留左侧模块／助手／会话列表、中间对话、右侧 GitTree 的既有布局，让会话类型、实际模型与保存的历史保持一致。本轮补充每个模块会话的阶段任务配置、局部历史读取错误和可滚动的真实分支树；当前源码、开发 Electron 证据与上一版安装验收分别记录。

## 实际行为

- 常态会话使用显式 `chat` 类型；标题中提到视频、论文或 GitHub 不会自动进入模块。类型由 `lancer-zone:<id>|` 前缀表示，无前缀或未知类型按常态会话处理。点击尚无会话的模块时，新建会话入口会显式带入该模块类型。
- 每个模块会话在对话顶部显示可配置的 1–8 个阶段，每阶段保存名称、负责模型、技能、要解决的问题，以及交付物与验收要求。点击已配置且可用的阶段，通过原会话的 `setSessionModel` 切换实际模型，沿用同一 Pi 会话及上下文；随后点击“载入任务”，检查输入框内容后发送。不会自动发送或自动执行后续阶段。
- “载入任务”经 `prepare-workflow` 检查当前草稿、模型与技能，再载入阶段目标和交付要求。非空草稿会阻止载入并保留原文；目标为空或技能不可用时给出错误。启用技能命令时使用第一个所选技能的真实 `slashCommand`，并在任务中列出所有所选技能的文件路径，要求先读取适用说明；未启用技能命令时仍保留这些路径与要求。
- 运行中禁止修改、交接或载入阶段任务；未配置或当前不可用的阶段进入设置。模型切换失败时显示错误，不把阶段标为已交接。阶段名称最多 40 字，每阶段最多 12 个技能，目标与交付要求各最多 4000 字；非法配置拒绝保存并保留原记录。旧版仅含名称与模型的配置仍可读取和交接，补充目标后才可载入任务。
- 标题栏保留 GPT、Claude、Grok、Gemini、豆包、Kimi、DeepSeek、Qwen、GLM 九个模型家族，并补充可用的自定义家族。家族之后是本机 App 入口（WorkBuddy、Marvis、OpenCode），它们没有模型目录，点开只提供启动该程序的操作；主进程按固定允许列表解析可执行文件，渲染层只能传 id。模型目录区分可用、未启用与未配置，只有可用且已启用的模型可选择；图标出现不代表账号已连接。
- 会话菜单支持改名与类型变更；切回常态会话隐藏阶段条并保留内容。删除按钮执行归档，可从回收区恢复，运行中的会话须先停止。读取历史树不应启动模型运行或改写历史。
- 右侧 GitTree 默认正常间距：会话列最少 112px、节点行距 32px；“总览”改为最少 76px、18px，不缩小节点图形或把全部历史压进一屏。分支较多时按深度增加列宽（`56 + depth × 22px`），保留横向与纵向滚动。筛选栏与时钟固定在可视区域，横向滚动到中间、最右或自动定位末尾会话时仍可操作“全部会话”。原生分支按保存的父子关系连接，隐藏的元数据会追溯到可见父节点，嵌套旁支保留各自路径；并行任务的合并只来自状态为 `accepted` 的 `lancer-branch-return` 回执，重启后仍由保存记录重建。
- 历史树读取失败按会话保存错误：受影响的侧栏条目、树列和错误节点显示“历史读取失败”，选中该会话后才在对话内显示说明、可展开原因与“重新读取”。失败时保留已缓存树和相邻成功结果；重试只请求当前所选会话。历史读取错误不会新增到用户转录，也不冒充模型运行失败。
- 应用图标资源与侧栏标记来自用户提供的蓝白 Lancer 画作。原图、衍生图、生成方式与提示词记录在 [provenance.json](../apps/desktop/resources/brand/provenance.json)。

## 状态归属

| 状态                                                               | 所有者与边界                                                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 阶段名称／模型／技能／目标／交付要求、当前阶段、助手身份与会话归属 | 主进程 `LancerAssistantStore` 写入 userData 的 `assistants.json`；以 `workspaceId:sessionId` 索引流程，校验后排队原子写入。 |
| 会话标题／类型、归档状态                                           | 既有 workspace/session owner；界面经窄接口调用，不直接写磁盘。                                                              |
| 实际模型、消息上下文、会话树                                       | conversation owner 与 Pi driver；交接调用原有模型设置路径，不复制转录或创建新会话。                                         |
| 正常间距／总览视图                                                 | renderer 局部视图状态，默认正常间距；不是保存的工作流执行进度。                                                             |
| 历史树缓存与读取错误                                               | `useSessionTrajectory` 在 renderer 中按会话维护缓存与 `errorsBySessionId`；独立处理各请求的结果，不写入用户历史。           |

入口为 [lancer-workflows.ts](../apps/desktop/contracts/lancer-workflows.ts)、[lancer-zones.ts](../apps/desktop/contracts/lancer-zones.ts)、[lancer-assistant-store.ts](../apps/desktop/electron/application/lancer-assistant-store.ts) 与 [app-store.ts](../apps/desktop/electron/application/app-store.ts)。历史树读取由 driver 的 `getSessionTree` 使用现有运行时或只读 `SessionManager` 完成。主进程通过 [session-tree-transport.ts](../apps/desktop/contracts/session-tree-transport.ts) 将节点和子节点 ID 平铺传输，renderer 再还原树；保留根节点、兄弟分叉顺序与当前叶节点，避免 Electron contextBridge 的嵌套深度限制。

## 既有视觉系统核对

本次是既有界面的扩展，没有建立新的全局设计系统，也不新增 token。核对了 `src/styles/tokens.css`、`contracts/theme.ts`、`process-surface.css`、`shell.css`、`assistants.css`，以及新增的 `workflow-styles.css`、`model-catalog.css` 与对应 React 组件。

新增控件沿用主题提供的表面、文字、细线和悬停覆盖色；既有字体为 Inter／系统中文回退，基础字号为 13px，全局紧凑字号阶梯包含 11／12／14／16px，间距基于 4px。阶段和模型选择继续使用紧凑按钮、细边框与轻微圆角；阶段及箭头的间隙收紧为 4px，模块会话隐藏重复标题行。1100px 截图中阶段条横向滚动，标题栏收起家族文字；树列保留横排名称和完整图形，通过滚动查看超出的内容。上述是实现观察，不把局部的 9–10px 辅助文字提升为新的通用字号规范。

本轮独立完成复审的范围为 `.impeccable/review/ui3/` 中的 1480px 浅色／暗色、1100px、流程编辑器、模型目录、局部错误、深树与分支起点截图，结论为 ship；同目录 `detector.json` 为 `[]`。该结论覆盖所列界面与证据，不等于全界面或所有平台无缺陷；之后正式用户截图暴露筛选栏／时钟横向滚出问题；将树容器设为 `container-type: inline-size`，让筛选栏以 `left: 0` 固定且宽度为 `100cqi` 后，专项复审确认中间、最右、自动定位末尾会话与“全部会话”导航均可用，结论为 ship。该专项复审未重新运行 detector。按用户要求，本轮没有制作动效演示；下面的真实飞行检查是既有产品交互的回归证据。

流程编辑器采用原生 `dialog.showModal()`，对 dialog 设置 `overscroll-behavior: contain`，对 backdrop 同时设置 `overflow: hidden` 与 `overscroll-behavior: contain`。这落实了本轮 [Modern Web Guidance 记录](/tmp/lancer-ui3-layout-guide.md) 中 `prevent-page-scroll-under-modal-dialog` 的具体要求：“Without this declaration `::backdrop` defaults to `overflow: visible` and `overscroll-behavior` will have no effect.” 没有通过修改根页面 overflow 来锁滚动；非溢出容器的滚动拦截按指南视为渐进增强，不扩展为 Safari 兼容性结论。同次查阅的 `scrollability-affordance-hints` 未引入 scroll-state 查询或渐变提示，不记为已应用。

此前复审已逐张检查 `.artifacts/lancer-module-review-fixed/core-lancer-module-workflo-1bb3c--saved-trees-remain-visible/` 中的 `module-workflow-all-trees.png`、`module-workflow-dark.png`、`module-workflow-1100.png`、`model-catalog.png`。模型目录禁用行已取消整体透明度衰减，保留可读的名称、来源与未配置说明。该次独立复审结论为 ship；检测记录 `.artifacts/lancer-ui-review/detector.json` 为 `[]`，不等于全界面无缺陷。

未固化为设计规则或修复的既有表现：暗色截图中的视频输入框仍为白底；该视频区域样式不属于本次工作流和模型目录扩展。

## 本轮验证（ui3）

| 证据层级                 | 已完成的检查                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 仓库基线                 | `/tmp/lancer-ui3-check-fixed.log` 的 `pnpm check` 完成格式、lint、架构边界、类型与基线检查；桌面单元测试 430 通过、1 个平台跳过。完整基线早于最后筛选栏 CSS 修正；修正后补做相关 Electron 检查与定向 lint。                                                                                                                                                                                                                                                                                                                                |
| 定向单元                 | `/tmp/lancer-ui3-unit.log`：10 通过（1.5s），覆盖阶段配置持久化与输入校验、真实技能命令、不可用技能拒绝、嵌套旁支及可见父节点连接、事件类型归属。                                                                                                                                                                                                                                                                                                                                                                                          |
| 确定性 Electron 集成     | `/tmp/lancer-ui3-core.log`：4 通过（45.6s），覆盖深历史树、助手并行／orb／保存的合并、模块阶段草稿保护与技能正文展开、原生窗口与导航。这些使用 fixture 和实际 Electron，不是实际供应商运行证明。                                                                                                                                                                                                                                                                                                                                           |
| 本轮截图与局部错误       | `/tmp/lancer-ui3-final-core.log` 中模块与深树检查通过；错误用例因带类型前缀的标题定位失败。修正测试入口后，`/tmp/lancer-ui3-errors.log` 单独 1 通过（6.0s），确认局部错误显示、相邻会话可用、恢复读取后错误消失。复审截图在 `.impeccable/review/ui3/`。                                                                                                                                                                                                                                                                                    |
| 真实供应商 Electron 会话 | `/tmp/lancer-ui3-live.log`：2 通过（51.7s）。`openai-codex` 从 `gpt-6.1-sol` 交接到 `gpt-6-astra`，经配置界面载入并发送任务，保留 `QUARTZ-472` 上文，返回技能正文要求的 `SKILL-829` 和交付要求 `DELIVERED-24`；同一 session 保持不变。`.artifacts/lancer-ui3-live/live-lancer-module-handoff-e499f--without-losing-its-context/proof.json` 确认可见开发 Electron、无 test mode／test hooks、`contextRetained: true`。                                                                                                                      |
| 真实飞行与落点回归       | 同轮 `process-live-flight` 使用真实 `openai-codex / gpt-6.1-sol`。`.artifacts/lancer-ui3-live/live-process-live-flight-v-0f243-original-flight-and-landing/real-live-flight.json` 记录 96 个飞行绘制帧和 119 个落点绘制帧，轨迹终点最大误差为 0，落点中心最大误差约 `0.00006104px`。                                                                                                                                                                                                                                                       |
| 本轮候选包               | `/tmp/lancer-ui3-final-package.log` 已完成；含筛选栏修正的产物为 `apps/desktop/release-local-20261028-231751-2095/mac-arm64/Lancer.app`，日志确认签名校验 `valid on disk`、`satisfies its Designated Requirement`。                                                                                                                                                                                                                                                                                                                        |
| 本轮安装与重启           | `/tmp/lancer-ui3-final-install.json` 记录已安装至 `/Applications/Lancer.app`，替换前应用保留于 `/Applications/.lancer-update-3X3xOw/previous-Lancer.app`。`/tmp/lancer-ui3-final-installed.log` 为 1 通过（14.6s）；`.artifacts/lancer-ui3-final-installed/production-lancer-installe-06ae0-onversations-across-restart/installed-proof.json` 确认实际 packaged Electron、无 test mode／test hooks、可见窗口和重启完成。测试覆盖横向滚动后的筛选栏／时钟可见性、阶段目标／交付要求／技能选择的持久化，以及 5 个独立 fixture 会话 ID 保存。 |

筛选栏专项检查 `/tmp/lancer-ui3-sticky.log` 为 1 通过（14.4s），截图为 `.artifacts/lancer-ui3-sticky/core-deep-session-trees-lo-fa17b-sible-beside-other-sessions/fixed-scroll-middle.png` 与 `fixed-scroll-right.png`。本轮实现提交为 `bcdd616`（阶段技能、目标与交付要求）和 `fe19ac7`（树间距、局部错误及分支连接）。

本轮失败证据保留：首次 `/tmp/lancer-ui3-check.log` 在新“载入任务”按钮的 Promise 处理上报 `no-floating-promises`，补齐拒绝处理后完整基线通过。`/tmp/lancer-ui3-final-core.log` 的错误用例失败发生在前置会话定位，不能将原整组称为全绿；后续专门复验通过。未用这些测试定位失败解释为用户历史损坏。

筛选栏修正前的本轮候选包亦保留证据：`/tmp/lancer-ui3-package.log` 与 `/tmp/lancer-ui3-install.json` 对应 `release-local-20261028-230951-73405`，旧应用备份为 `/Applications/.lancer-update-d1D2w8/previous-Lancer.app`；`/tmp/lancer-ui3-installed.log` 为 1 通过（14.7s）。更新前 40 份历史的字节数与 SHA-256 见 `/tmp/lancer-ui3-history-before.json`，该候选的 `.artifacts/lancer-ui3-production-preservation.json` 记录前后均为 40 个会话、无新增或丢失 ID，40 份文件逐字相同，`changes: []`。该记录仅证明筛选栏修正前候选的保存结果。

最终正常用户 profile 已重新打开。`.artifacts/lancer-ui3-final-production-preservation.json` 记录 40 → 40 个会话，`missing_ids` 与 `added_ids` 均为空；39 份历史逐字一致，另 1 份仅追加 1 条 `thinking_level_change` 与 16 条 `message`（包含 user／assistant／toolResult，时间为 2026-10-28 15:15:07–15:17:25 UTC）。该文件的 `prior_bytes_intact: true` 确认全部安装前字节完整保留，不把它描述为逐字未变。

最终正常工作区截图 `.artifacts/lancer-ui3-final-production.png` 已核对：当前助手的 35 个会话与 3 条分支可见，横向定位后“全部会话”和时钟仍在视区内，没有历史读取错误，0 条分支运行中。最终安装与用户历史验收已完成；范围为 macOS，不声明其他平台已验收。以下此前开发验证与上一版安装记录保留，供追溯失败和修复范围。

## 此前验证与边界

| 证据层级                 | 已完成的检查                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仓库基线                 | 上一版 `pnpm check` 记录为 `/tmp/lancer-deep-trees-check.log`：格式、lint、架构边界、类型与基线检查完成；桌面单元测试 428 通过、1 个平台跳过。                                                                                                                                                                                                                            |
| 确定性 Electron 集成     | `tests/core/lancer-module-workflows.spec.ts` 后续运行通过（18.2s）：创建常态／模块会话、本地模型运行与交接上下文、五棵树同时可见、改名、归档恢复、重启及转回常态会话。截图见上方复审目录。                                                                                                                                                                                |
| 真实供应商 Electron 会话 | `tests/live/lancer-module-handoff.spec.ts` 使用 `openai-codex`，从 `gpt-6.1-sol` 交接到 `gpt-6-astra`，同一 session 回答前一模型收到的校验词。`.artifacts/lancer-module-real-verified/live-lancer-module-handoff-e499f--without-losing-its-context/proof.json` 记录 `contextRetained: true`、可见开发 Electron、无 test mode／test hooks，配有 `real-model-handoff.png`。 |
| 历史读取回归             | `packages/pi-sdk-driver/test/read-only-session-tree.test.mts`（提交 `18e036d`）读取三个已无可用模型的历史会话，断言运行时启动次数为零，三个 session 文件与 catalog 内容逐字不变。                                                                                                                                                                                         |
| 相邻 Core 回归           | `.artifacts/lancer-modules-verified/` 中并行任务／orb 与事件飞行检查通过；它们不构成真实供应商的完整飞行或完整会话证明。                                                                                                                                                                                                                                                  |

此前同轮后续完成的端到端证明：

- **完整真实会话：** [桌面验证技能](../.agents/skills/verify-pi-gui/SKILL.md) 的默认会话流程通过（2.2 分钟）。`.artifacts/verify-pi-gui/run-vw2VP4/result.json` 为 `passed`，10 个检查点全部完成、`assertionFailures` 为空，覆盖流式增长、运行中阅读与切会话、真实工具结果、停止、草稿隔离、归档恢复及重启后的两段会话；两次测试进程均已关闭。
- **真实飞行与落点：** `.artifacts/lancer-flight-sampled-proof/live-process-live-flight-v-0f243-original-flight-and-landing/real-live-flight.json` 保留 97 个飞行绘制帧、120 个落点绘制帧；轨迹终点误差（`flights.endpointError`）与落点中心误差（`landings.error`）最大值均为约 `0.00003052px`。使用真实 `openai-codex / gpt-6.1-sol`。
- **原生布局与导航：** Core `process-native-parity` 通过；`.artifacts/lancer-native-family-proof/core-process-native-parity-2000f--with-real-session-controls/native/` 的 `native-1440.png`、`native-1480.png` 与 `geometry.json` 记录 macOS Electron 实际窗口，11 棵树同时可见，检查细节模式行距、跨会话导航与草稿保留。此项使用 fixture，不扩大为真实供应商证明。

复验沿用 [CI baseline](ci-baseline.md) 的 `pnpm check`，桌面测试先构建 `pnpm --filter @lancer/desktop build`，再用 `apps/desktop/playwright.config.ts` 运行相应 spec。Core 使用本地 provider fixture；真实交接需要显式真实认证，以及 `PI_GUI_PROVIDER`、`PI_GUI_MODEL`、`PI_GUI_HANDOFF_MODEL`，不能以跳过代替通过。

保留失败来源与修复范围：初次 `.artifacts/lancer-modules-verified/` 的模块测试存在恢复竞态失败，已由后续通过记录取代，不能把初次整组称为全绿。真实模型交接测试曾暴露空模块的新建会话类型未带入，修复侧栏入口后 Sol → Astra 通过。短暂飞行动画的早期检查遇到截图与瞬时 DOM 的时序竞争，改为检查 `requestAnimationFrame` 记录的实际绘制帧后通过；这不是延长或重播产品动画来满足测试。

## 上一版安装与用户历史验收

以下为本轮 ui3 更新前的安装记录，不代表当前候选包的最终状态。

上一版实现提交为 `18e036d`（只读历史树）、`312addb`（Lancer 图标）、`be90756`（模块交接与同时显示会话树）、`4c341e1`（深层历史树传输）。签名候选包 `apps/desktop/release-local-20261028-222452-91972/mac-arm64/Lancer.app` 当时已安装到 `/Applications/Lancer.app`，更新前应用保留于 `/Applications/.lancer-update-EwaamI/previous-Lancer.app`；此前备份也保留。安装包的 `codesign --verify --deep --strict` 校验通过。

上一版正式安装包测试 `tests/production/lancer-installed-assistants.spec.ts` 最终通过（1 passed，12.4s），日志为 `/tmp/lancer-deep-trees-installed.log`，证据在 `.artifacts/lancer-installed-deep-trees/production-lancer-installe-06ae0-onversations-across-restart/`。`installed-proof.json` 确认 `app.isPackaged`、无 test mode／test hooks、重启完成；测试检查安装资源与源码图标一致、模块流程可见、助手改名重启持久化、5 个测试会话 ID 保留，以及包含 650 轮分叉的长历史在重启前后都可见且无加载错误。

上一版验收曾重新启动正常用户 profile。记录 `.artifacts/lancer-installed-production-preservation.json`：安装前 40、安装后 40，`missing_ids: []`、`added_ids: []`。逐一核对 40 份历史文件：39 份逐字相同；当时打开的“豆包 App”会话在恢复运行时追加了模型和思考级别两条元数据，追加之前的全部字节与安装前哈希一致。原有历史内容完整保留，不把该文件描述为逐字未变。

**已修复的生产边界：** 初次正常工作区验收发现 4 个超长历史会话在经 Electron `contextBridge` 传输时触发 `recursion depth exceeded`。平铺传输后，10,002 节点的拓扑往返单元测试、1,300 多层真实 Electron 历史树与三个既有 `/tree` 导航测试通过。Core 深树证据为 `.artifacts/lancer-deep-trees-fixed/`；首次深树测试把分叉错误地断言为提交节点，按实际事件语义修正断言后通过。正式安装包也包含同一长历史回归。

正常用户工作区截图 `.artifacts/lancer-installed-production.png` 已核对：当前助手的 35 个会话与 3 条分支同时展示，四个长历史树的加载错误消失；原有助手和会话选择保持可用。以上为 macOS 实际验收，不声明其他平台已验收。

## 2026-10-29：保留现有界面的局部修正

- 输入框使用外层中性色焦点边框，移除内部蓝色矩形；顶部模型家族以边框标出当前选择。
- 先识别实际模型 ID，再识别目录名称，最后才使用 provider 回退。网关不再作为模型家族展示，仍可通过模型选择器调用。
- 新事件从对应顶部模型图标飞向同一事件的 GitTree 节点；每次事件固定一组随机轨迹与颜色。历史加载不重播，减少动态效果设置仍有效。
- 持久化文件变更记录显示为文件交付节点；真实模型创建 delivery.txt 后，重启 Electron 仍保留卡片和对应产物节点。
- 用户明确要求清空全部未运行会话，已通过应用归档 44 条会话，未归档为 0。历史保留在回收区；40 份原有 transcript 的原始字节前缀校验全部通过，见 `.artifacts/lancer-ui4-archive-audit.json`。
- 核对时发现归档后轨迹仍可能包含旧选中会话，现按归档身份过滤，空会话不再构造可见树。

本轮验证证据：`/tmp/lancer-ui4-core.log`（Electron 界面回归通过）、`/tmp/lancer-ui4-live2.log`（真实 provider 光线与交付重启通过）。首次真实验证因测试仍要求旧聊天区发射源而失败，保留 `/tmp/lancer-ui4-live.log`；断言已改为顶部模型来源，并继续校验飞行端点和落点误差小于 1 px。

最终源代码回归：`/tmp/lancer-ui4-core-final.log` 两项通过，`/tmp/lancer-ui4-live-final.log` 真实 provider 测试通过，稳定证据保存于 `.artifacts/lancer-ui4-core-final/` 与 `.artifacts/lancer-ui4-live-final/`。`/tmp/lancer-ui4-check.log` 全仓检查通过，桌面单测 431 通过、1 跳过；最终类型与格式检查通过。

已签名安装包：`apps/desktop/release-local-20261029-001626-46014/mac-arm64/Lancer.app`；安装路径 `/Applications/Lancer.app`，旧版备份 `/Applications/.lancer-update-opDOsg/previous-Lancer.app`。安装记录 `/tmp/lancer-ui4-install.json`。

安装后回归 `/tmp/lancer-ui4-installed.log`：1 项通过，隔离配置下的助手、会话与重启状态保持正常。正式应用启动后，原用户配置仍为 44 条已归档、0 条未归档；原生界面显示 GitTree 0 个会话、0 条分支，顶部仅保留 9 个模型家族。

## 新会话工作区与图标修正

空白会话页原先在每次本地工作区选择变化后，都从全局选中工作区同步回来。现在仅在全局选中目录实际改变时同步，保留用户的本地选择；新会话增加打开文件夹入口，复用原有系统目录选择 IPC。取消不改变工作区和草稿，加入目录后自动选中。

右上角月亮形工作区工具入口已移除，左下角设置入口保留。左下角 L 占位头像改用现有 Lancer 图标；macOS 运行中的 Dock 图标也显式使用应用随附的指定 PNG，应用包的 ICNS 已核对为同一品牌图案。

`/tmp/lancer-ui5-final-core.log` 六项 Electron 回归通过；文件夹处理归入新会话控制器后的复核 `/tmp/lancer-ui5-owner-final.log` 一项通过。测试覆盖现有目录选择、取消保留草稿、新目录选择、发送后的实际 workspaceId、图标及按钮。目录选择返回值在自动化中使用夹具，真实原生窗口另行核验。测试修正了点击选择器后仍要求输入框聚焦，以及未先关闭模型弹层便点击其后方设置按钮的旧断言。

新版已安装至 `/Applications/Lancer.app`，候选包为 `release-local-20261029-002700-90953`，备份为 `/Applications/.lancer-update-iqmVSV/previous-Lancer.app`。原生 UI 已点击“打开文件夹…”、通过 macOS 前往目录输入本机项目目录并确认打开，工作区最终显示 lancer；左下角品牌图标可见、右上角月亮入口不存在。安装前后 44 条会话 ID 集合一致，均保留归档状态，证据为 `/tmp/lancer-ui5-before-install.json` 与 `/tmp/lancer-ui5-after-install.json`。

最终全仓检查 `/tmp/lancer-ui5-check-final.log` 通过：桌面单测 431 通过、1 跳过；包括格式、lint、架构边界和类型检查。

## 底部模型与思考菜单

新会话底部选择器改为向上展开；模型与思考菜单共同使用原生 Popover 顶层及 CSS anchor positioning，按窗口边缘翻转、限制可用高度并内部滚动。菜单行解除输入栏的固定高度约束，说明文字换行，搜索框在弹层显示后聚焦。顶部模型家族目录保持原来的展开方式。

Electron 夹具回归覆盖 1480×980、1000×600、1000×300 下的菜单边界、模型和思考选择，以及短窗口内真实滚轮滚动。证据 `.artifacts/lancer-ui6-verified/`；已有会话选择测试发现首次发送的 idle→running 切换会与菜单点击竞争，改为等待无凭证夹具实际进入 failed 后再检查闲置会话模型切换，复核 `.artifacts/lancer-ui6-settled/` 通过。合计七项用例均有通过结果；该测试不代表外部模型调用验证。

全仓 `/tmp/lancer-ui6-check.log` 通过（桌面单测 431 通过、1 跳过）；最后菜单行样式和测试等待修正后补做定向 lint、格式检查及 Electron 回归。

已签名安装 `release-local-20261029-004154-83969/mac-arm64/Lancer.app` 至 `/Applications/Lancer.app`，旧版备份 `/Applications/.lancer-update-ebPiPG/previous-Lancer.app`。原生安装版实际点击确认模型菜单、思考菜单均向上显示；思考从 high 切到 medium、模型从 GPT-6 Astra 筛选切到 GPT-6 Luna 均更新成功，验收后恢复 Astra/high。没有发送测试消息。安装前后会话 ID 集合一致，44 条历史继续保持归档。

## 模块管理与默认模板

左侧模块标题旁增加管理/新增入口，每行齿轮可直接编辑对应模块：名称、颜色、说明，以及复用现有流程编辑器的阶段、模型、Skill、目标和交付物配置。模块列表超过可用高度后滚动。

模块配置保存在现有 assistants.json 持久化所有者中，兼容没有 modules 字段的旧配置。模块模板在创建会话时复制为会话自己的流程；后续模板编辑不会覆盖已保存的会话流程。删除使用可恢复标记，模块会话在界面归入常态会话，保留原标题归属、历史、交付物及流程；管理器中选择已删除模块可恢复原分组。空模块被删除时，新会话入口回到常态会话。

管理操作按返回的模块配置确认成功，避免当前会话旧的运行错误被误报为模块保存失败。模块的主流程标题、侧栏分组和视频工具入口都按当前有效模块配置解析。

验收：`.artifacts/lancer-ui7-final/` 两项 Electron 回归通过，覆盖创建自定义模块、阶段模型配置、新会话模板复制、改名、删除后的历史保留、重启与恢复，以及原有交接/任务载入/工作树显示。`/tmp/lancer-ui7-check-final.log` 全仓检查通过，桌面单测 432 通过、1 跳过；最后入口解析与列表滚动修正另经定向 lint、格式及构建回归。截图已检查。这些是隔离配置的 Electron/本地运行夹具验证，并非新的外部模型服务验证。

正式安装版原生验证已打开模块齿轮和流程编辑器，确认模型、Skill、目标和交付字段可用。发现内层流程编辑的 Escape 事件会冒泡关闭外层模块窗口，已阻止冒泡；`.artifacts/lancer-ui7-escape/` 回归确认 Escape 回到模块设置且保留草稿，后续新增、删除、重启恢复流程仍通过。定向 lint 通过。首次更新前后 47 条会话 ID 集合一致。

最终安装包 `release-local-20261029-010725-46343/mac-arm64/Lancer.app` 已安装至 `/Applications/Lancer.app`，旧版备份 `/Applications/.lancer-update-DWCz0g/previous-Lancer.app`。安装等待用户当前运行自然结束后正常退出，未中断任务。原生安装版再次验证模块齿轮 → 阶段编辑 → Escape 返回外层模块设置成功，再关闭返回原会话；未保存测试配置。最终更新前后 47 条会话 ID 集合一致。

## 豆包 GUI 入口的目录展示

顶部豆包目录以「App 直连」标记已有 GUI 入口；API 模型计数仅用于 API 列表，不再以零 API 模型显示「尚未配置」。存在 API 模型时两种入口并列显示。豆包 App 行具有选中标识，当前豆包会话显示「GUI 对话直连 · 当前会话」。此标识表示入口/会话模式，具体连接权限或错误仍由豆包会话连接界面负责，不把入口可见误报为连接健康。

`.artifacts/lancer-ui8-core/` Electron 回归通过：无 API 模型时目录展示正确，经顶部入口进入固定豆包会话、选中状态和切回模型均验证。该回归只替换原生 GUI 传输为夹具，renderer、IPC 和绑定持久化使用真实实现，不代表向外部豆包发送了新消息。已检查截图。检索 Modern Web Guidance 的空状态指南及目录后，没有匹配此产品入口计数问题的专项模式，本次沿用现有 Popover。

安装验证：UI8 已更新至 `/Applications/Lancer.app`，原生 Electron 菜单显示「豆包 App 直连」与「GUI 对话直连」，没有零模型/尚未配置提示；仅检查菜单后关闭，没有向外部豆包发送消息。安装前后 47 个会话 ID 一致。`pnpm check` 通过（432 passed，1 skipped），专用 Electron 回归通过。

## 会话区阅读布局

模块会话使用两层结构：固定在正文滚动区上方的模块名、阶段模型与配置入口，正文内独立显示会话标题。常态会话不显示模块流程。阶段按钮保留真实配置和交接操作，选中阶段使用浅蓝边框；不把选过或跳过的阶段伪装为已完成。

助手正文取消整块气泡，用户消息改为浅灰底，正文最大 720px；时间采用消息真实 createdAt，缺失时不显示合成时间。当前历史消息契约没有逐条模型身份，因此没有把当前模型回填到所有旧消息。已有工具展开、交付物与右侧工作树继续使用原运行数据。

基于中间区域容器宽度调整内边距与输入框，窄窗口阶段横向滚动，设置按钮保留。`.artifacts/lancer-ui9-final/` Electron 本地运行时回归通过，覆盖常态/模块分离、标题与流程层级、开放正文、真实时间、窄窗口边界、配置技能/目标/交付物、交接上下文、归档恢复与重启；已检查宽窄截图。此为本地 provider 夹具，不是外部模型请求证明。

UI9 安装验证：已更新 `/Applications/Lancer.app`，真实历史会话正文为开放式布局，常态会话无模块流程栏，输入框与右侧树正常显示；47 个会话 ID 安装前后一致。`pnpm check` 通过（432 passed，1 skipped）。

## AI 助手右键管理

右键助手头像或名称显示「重命名 / 删除」，Shift+F10 也可打开；支持方向键、Home/End、Escape、Tab 和外部点击关闭。使用原生 Popover 顶层与锚点，键盘方向导航在当前 Electron 的 focusgroup 不可用时补齐。菜单延后至右键松开后显示，避免 Chromium light-dismiss 在同一次点击中立即收起。

重命名仅编辑名称，删除直接进入现有会话转交界面；取消不改变助手，确认后会话与树转交其他助手，最后一个助手不允许删除。原名称左键的头像编辑功能保留。`.artifacts/lancer-ui11-fixed/` 本地运行时 Electron 回归通过，覆盖头像右键、名称右键、键盘开关、改名保存与重启、取消删除、删除转交与会话保留，并检查菜单截图。

UI11 已安装至 `/Applications/Lancer.app`，原生右键 Lancer 头像显示重命名/删除，Escape 关闭并回到头像；没有修改用户助手。47 个会话 ID 保留。基线检查通过（432 passed，1 skipped），最终类型检查与受影响文件 ESLint 通过。

## 右侧工作树聚焦与全部会话

「聚焦」仅呈现当前会话及其并行子任务的树，独立会话不再混排；无分支时主线居中，有分支时按整个分支宽度居中。切换左侧会话时跟随当前会话。「全部会话」恢复所有未归档会话并列展示，超出面板横向滚动。两个按钮仅控制右侧，不切换中间记录区或当前会话；按钮位于横向滚动区之外，切换后重置旧树的滚动位置。

`.artifacts/lancer-ui13-final/` 两项 Electron 本地运行时回归通过，覆盖单树居中、全部树恢复、当前会话不变、跟随切换，以及两个并行分支的分叉和已保存合并节点；已检查单树与并行树截图。本地 provider 夹具不代表外部模型服务验证。UI13 原生安装操作因 Mac 锁屏受阻，尚未更新 `/Applications/Lancer.app`；本次构建包含 UI12 设置图标调整。

UI13 基线 `pnpm check` 通过（432 passed，1 skipped）。签名校验通过的待安装构建：`apps/desktop/release-local-20261029-014013-6113/mac-arm64/Lancer.app`。

## UI14 报错排查与实录准备

自定义网关可能返回 `503 / route_price_unavailable`。这是网关路由价格配置错误，并非前端崩溃。Pi 将 503 当临时故障重试；驱动现通过公开 `abortRetry()` 在该明确错误码下停止重试，保留失败状态和原始记录。微任务延后调用是因为 Pi 在发布 `auto_retry_start` 后才设置取消控制器。不改变用户配置，不关闭其他临时故障的重试，不改写依赖包。

生命周期回归 4/4 通过，覆盖正常重试成功与永久路由错误只请求一次。真实网关探测仍返回原错误，但原始 JSONL 仅一个 assistant 错误条目，状态 failed；直连 openai-codex/gpt-6.1-sol 的标题连接探测成功。这些连接探测不是完整业务验收。

13 项 Electron 选定回归最初 12 过、1 失败：新会话壳测试仍使用旧助手按钮名称。按现有「选择助手：Lancer」无障碍名称修正后，与会话树错误隔离测试一并复验 2/2 通过。没有把预期失败场景（如故意缺失媒体工具）伪装为业务成功。

用户要求的 15–30 秒真实视频尚未录制：原生工具确认 Mac 锁屏，已请用户解锁。解锁后先安装包含 UI12/13/14 的包，再在隔离测试工作区通过 UI 验证竞品调研、GitHub 项目研究、论文筛选/学习沉淀及真实抖音下载复刻；候选项目 pbakaus/impeccable，论文主题 AI Agent 记忆，真实抖音链接 https://v.douyin.com/I8vYzXvIa_o/ 来自之前的用户业务记录。必须先验收真实业务与交付物，再录制实际会话/工作树，不注入回复或复用旧视频冒充下载。Grok 网关服务端路由仍需修复，不能报告所有模型均可用。

UI14 `pnpm check` 通过（桌面单元测试 432 passed，1 skipped；驱动新增回归包含在完整基线中）。待安装包签名校验通过：`apps/desktop/release-local-20261029-014759-54979/mac-arm64/Lancer.app`。

## UI15 左侧模块管理入口

模块标题旁显式显示「＋新增」「管理」文字按钮，管理默认打开当前模块或第一个模块。右键模块或 Shift+F10 直接打开该模块管理面板，行内设置按钮提示其支持重命名、配置与删除。复用原有原生 dialog 和持久化逻辑，没有另建数据路径。

`.artifacts/lancer-ui15-modules/` Electron 回归通过，验证新增、自定义阶段、右键改名、键盘管理、删除保留会话、重启与恢复。已检查截图，桌面类型检查及受影响文件 ESLint 通过。原生工具再次确认 Mac 锁屏，安装与前述真实业务实录继续待解锁。

## UI16 助手消息按内容自适应

助手消息不再强制占满阅读区，改为 intrinsic fit-content 宽度、最大宽度 100%，短回复自然收缩，长回复与窄窗口按可用宽度换行；消息身份行允许换行。保留既有开放正文风格与消息操作。

`.artifacts/lancer-ui16-sizing/` 两项 Electron 回归通过（发送、引导、排队、失败恢复、模块流程与上下文），已检查短回复及窄窗口长回复截图。样式格式检查通过。安装仍待 Mac 解锁，四场景真实业务实录尚未完成。

## UI17 光线与目标工作树同色

按用户最新要求取消独立随机光线颜色。飞行光线、尾迹渐变和命中光圈都采用事件所属会话的工作树颜色；随机轨迹种子保留，错误节点和重试关系仍有原来的错误标识。删除不再使用的 flightColors 状态、缓存及传递路径。

10 项相关单元检查通过，桌面类型检查与受影响文件 ESLint 通过；`.artifacts/lancer-ui17-colors/` Electron 会话回归通过，截图确认紫色树与紫色飞行光线一致。构建待安装，前述真实业务实录仍待 Mac 解锁。

## UI18 消息头像可读性

将会话消息身份行的助手头像从 16×16 调整为 32×32，名字字号 12px、间距 8px；正文大小与侧栏头像规格不变。`.artifacts/lancer-ui18-avatar/` Electron 会话回归通过，已检查实际截图；样式格式检查通过。原生工具仍报告 Mac 锁屏，待安装版本包含 UI12–18 累积改动。

## UI19 错误图标绘制

把字体感叹号替换为固定 14px SVG 圆形错误图标，消除字体行高对内部居中的影响；装饰性 SVG 隐藏于无障碍树，保留邻近错误文字与节点的既有可访问名称。覆盖树容器的通用 SVG 绝对定位规则，避免错误节点偏离轨道。错误分类、真实失败记录与恢复流程不变。

`.artifacts/lancer-ui19-error-icon/` 会话操作与错误隔离两项 Electron 回归通过。截图发现并修复 SVG 定位冲突后，`.artifacts/lancer-ui19-final/` 再次验证错误隔离与恢复通过，已确认错误节点居中。最终安装包仍待解锁安装。

## UI20 工具步骤退出码误报

用户截图对应的真实历史中，有一条工具结果 `isError: true`，末尾为 `Command exited with code 1`。分组错误状态有依据；步骤摘要却以“非空且不含 error/failed”的启发式显示 exit 0，导致上下矛盾。删除该启发式：运行中显示处理中，明确结构化退出码或失败结果的 Pi 退出码尾行显示数字，其余使用工具执行状态显示成功/失败，不猜测退出码，不修改真实失败记录。

3 项格式化单元回归通过，涵盖真实截图的 code 1、成功输出含 error/failed、空输出、未知失败、运行中及结构化退出码。桌面 typecheck、受影响文件 ESLint、diff 检查通过。`.artifacts/lancer-ui20-status/` 隔离 Electron 回归通过，展开失败步骤可见 exit 1，错误分组保留；已检查截图。用户历史只读核对，没有删除或重写。安装仍待 Mac 解锁。

## UI21 真实四场景与视频证据归属

2026-10-29 解锁后安装 UI20；安装包与正式应用 ASAR SHA-256 一致，更新前 47 条历史 ID 全部保留。通过正式应用界面分别创建竞品、GitHub、论文、抖音四个真实会话并发送任务，前三者产出报告；抖音下载调用现有 engine 后因 yt-dlp 缺失返回 E_PROBE_MISSING，未生成视频，也未执行依赖步骤。研究报告区分实际来源与未核验项。真实结果保存在 `.artifacts/lancer-business-20261029/`，不是 fixture 回复。

实测发现工作区视频状态被投射到任意当前会话。现在视频调用携带发起会话，owner 按 videoId 保存到门控目录；重读恢复归属，投射同时检查 workspaceId/sessionId。无归属的旧记录保留在工作区，不冒充某一会话的历史。豆包收到的视频也写入真实接收会话归属。

22 项单元检查、typecheck、受影响文件 ESLint 通过。Electron 视频流程通过；增强隔离断言首轮误用了已被 relay 呈现替代的事件 ID，截图证实失败节点已显示，改为断言用户可见的错误步骤后通过：所属会话显示失败节点，切到研究会话不继承该节点（`.artifacts/lancer-ui21-isolation-final/`）。另一个磁盘 replay 用例为既有 opt-in skip，不计为通过。

UI21 最终已安装到 `/Applications/Lancer.app`，重启后四个验收会话可读，原先 47 条历史全部保留。原生检查确认当前研究树不再混入旧视频交接节点。录制 `lancer-window-test.mp4`，25.03 秒，系统对指定 Lancer 窗口连续实录；内容是四场景真实结果切换，不是四项端到端成功演示。已抽查 12 秒、22 秒及末帧。首个全屏录制抓到错误显示器，保留但不作为交付。抖音样片仍未生成，缺失下载依赖的业务阻塞尚未解决。
