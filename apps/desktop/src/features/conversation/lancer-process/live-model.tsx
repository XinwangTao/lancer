import { BranchReturnCard } from "./branch-return-card";
import { externalCaptureEvents } from "./external-capture-events";
import { sessionRunLabel } from "../../../../contracts/session-run-state";
import { moduleZones } from "../../../../contracts/lancer-modules";
import { conversationRoot } from "../../../../contracts/lancer-assistants";
import { modelFamily } from "../../../ui/model-families";
import { conversationColor, parallelTreeEvents } from "./parallel-tree";
import type { ComponentProps } from "react";
import type { ProcessBlock } from "../process-timeline/build-process-blocks";
import { ProcessToolStep } from "../process-timeline/process-tool-step";
import { ProcessHandoffCard } from "../process-timeline/process-handoff-card";
import { MessageMarkdown } from "../message-markdown";
import { ImageAttachmentThumb } from "../image-attachment-thumb";
import type { ThreadListEntry } from "../../threads/thread-groups";
import type { useSessionTrajectory } from "../session-trajectory/use-session-trajectory";
import { trajectoryEvent } from "../session-trajectory/trajectory-events";
import { conversationZoneId, stripLancerZonePrefix } from "../../../../contracts/lancer-zones";
import { REPLAY_FIXTURE } from "./replay-fixture";
import { buildRelayTree } from "./relay-tree";
import type { LancerAssistantsState } from "../../../../contracts/lancer-assistants";
import type { OrchestrationChildThread } from "../../../../contracts/desktop-state";
import { videoDeliverables } from "./video-deliverables";
import { VideoDeliveryCards } from "./video-delivery-cards";
import { nativeClock } from "./process-math";
import type {
  ProcessEvent,
  ProcessFixture,
  ProcessMessage,
  ProcessStepData,
} from "./process-types";
import { t } from "../../../../contracts/i18n";
import type { VideoLearnSnapshot } from "../../../../contracts/video-learn";
import { videoLearnProcessEvents, videoLearnProcessMessages } from "../video-learn-stages";
import { TurnChangesCard, type OpenTurnChange } from "../turn-changes-card";
import type { TurnChangeSummary } from "../../../../contracts/review";

export function liveActor(provider?: string, model?: string): string {
  const key = `${provider} ${model}`.toLowerCase();
  if (/anthropic|claude|opus/.test(key)) return "opus";
  if (/xai|grok/.test(key)) return "grok";
  if (/doubao|volcengine/.test(key)) return "doubao";
  if (/moonshot|kimi/.test(key)) return "kimi";
  if (/gemini/.test(key)) return "gemini";
  return "sol";
}
const eventKind = (key: ReturnType<typeof trajectoryEvent>): ProcessEvent["kind"] => {
  if (key === "submit") return "commit";
  if (key === "test-fail") return "test";
  if (key === "model") return "switch";
  return key;
};
export interface LiveProcessInput {
  readonly runtime?: import("@lancer/session-driver/runtime-types").RuntimeSnapshot;
  readonly archivedSessions?: readonly import("./process-types").ArchivedConversation[];
  readonly assistants?: LancerAssistantsState;
  readonly assistantId?: string;
  readonly sidebarCollapsed?: boolean;
  readonly workspaceId?: string;
  readonly children?: readonly OrchestrationChildThread[];
  readonly threads: readonly ThreadListEntry[];
  readonly selectedSessionId: string;
  readonly sidebarSessionId?: string;
  readonly title: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly processBlocks: readonly ProcessBlock[];
  readonly trajectory: ReturnType<typeof useSessionTrajectory>;
  readonly workspacePath?: string;
  readonly scheduledOrigins?: ReadonlyMap<
    string,
    import("../../../../contracts/scheduled-tasks").ScheduledTaskOrigin
  >;
  readonly onViewFileInDiff?: (path: string) => void;
  readonly onOpenDeliverable?: (path: string) => Promise<void>;
  readonly turns?: readonly TurnChangeSummary[];
  readonly onOpenTurnChange?: OpenTurnChange;
  readonly onOpenWorkspaceFileLine?: ComponentProps<
    typeof MessageMarkdown
  >["onOpenWorkspaceFileLine"];
  readonly onForkFromMessage?: (index: number, preview?: string) => void;
  readonly videoLearn?: VideoLearnSnapshot | null;
}

/** Projection only. Session history, sending, model changes and worktrees retain their
 * existing owners. No reference fixture conversation/event/branch is injected here. */
export function buildLiveProcessData(input: LiveProcessInput): {
  data: ProcessFixture;
  lane: string;
} {
  const current =
    input.trajectory.lanes.find((lane) => lane.isCurrent)?.id ?? `lane:${input.selectedSessionId}`;
  // Workspace gates are not conversation history. Only project video evidence
  // onto a session when the producer explicitly identifies that owner.
  const videoLearn = input.videoLearn?.sessions.some(
    (session) =>
      session.sessionId === input.selectedSessionId && session.workspaceId === input.workspaceId,
  )
    ? input.videoLearn
    : null;
  const deliveries = videoDeliverables(videoLearn);
  const chosen = input.threads.find((entry) => entry.session.id === input.selectedSessionId);
  const sidebar = moduleZones(input.assistants?.modules).map((lane) => {
    const threads = input.threads.filter(
      (thread) =>
        conversationZoneId(thread.session.title, input.assistants?.modules) === lane.id &&
        !input.children?.some(
          (child) =>
            child.childSessionId === thread.session.id &&
            child.childWorkspaceId === thread.workspaceId,
        ),
    );
    return {
      name: lane.label,
      id: lane.id,
      count: `${threads.length} 个会话`,
      sessions: threads.map((thread) => ({
        id: `${thread.workspaceId}:${thread.session.id}`,
        sessionId: thread.session.id,
        pinned: Boolean(thread.session.pinnedAt),
        actor: liveActor(thread.session.config?.provider, thread.session.config?.modelId),
        title: stripLancerZonePrefix(thread.session.title),
        branch: thread.environment.branchName ?? thread.environment.label,
        treeError: input.trajectory.errorsBySessionId?.[thread.session.id],
        hasUnseenUpdate: thread.session.hasUnseenUpdate,
        status:
          thread.session.status === "running" ||
          (thread.session.id === input.selectedSessionId && videoLearn?.busy)
            ? "run"
            : thread.session.status === "failed" ||
                (thread.session.id === input.selectedSessionId &&
                  videoLearn?.guiStatus === "FAILED")
              ? "failed"
              : thread.session.status === "idle" && thread.session.lastRunOutcome === "completed"
                ? "done"
                : "",
        selected: thread.session.id === (input.sidebarSessionId ?? input.selectedSessionId),
      })),
    };
  });
  const events: ProcessEvent[] = [];
  const messages: Record<string, ProcessMessage[]> = {};
  const titles: Record<string, { title: string; branch: string }> = {};
  const represented = input.trajectory.lanes
    .filter(
      (lane) =>
        lane.sessionId &&
        !input.archivedSessions?.some(
          (session) =>
            session.sessionId === lane.sessionId && session.workspaceId === lane.workspaceId,
        ),
    )
    .sort((a, b) => {
      const rootA = conversationRoot(a, input.children),
        rootB = conversationRoot(b, input.children);
      const group = `${rootA.workspaceId}:${rootA.sessionId}`.localeCompare(
        `${rootB.workspaceId}:${rootB.sessionId}`,
      );
      return (
        group ||
        Number(a.sessionId !== rootA.sessionId) - Number(b.sessionId !== rootB.sessionId) ||
        a.id.localeCompare(b.id)
      );
    });
  // Each lane is an ordered work tree, not a shared wall-clock chart. Start every
  // populated lane at the top and advance by its own event order so later-created
  // sessions do not produce large empty vertical gaps.
  const longestLane = Math.max(
    1,
    ...represented.map((lane) => (input.trajectory.laneNodes.get(lane.id) ?? []).length),
  );
  for (const lane of represented) {
    const id = lane.id;
    const thread = input.threads.find((thread) => thread.session.id === lane.sessionId);
    titles[id] = {
      title: stripLancerZonePrefix(lane.label),
      branch: thread?.environment.branchName ?? thread?.environment.label ?? "",
    };
    const nodes = input.trajectory.laneNodes.get(lane.id) ?? [];
    const provider = lane.isCurrent ? input.provider : thread?.session.config?.provider;
    const modelId = lane.isCurrent ? input.modelId : thread?.session.config?.modelId;
    const catalogModel = input.runtime?.models.find(
      (model) => model.providerId === provider && model.modelId === modelId,
    );
    const list: ProcessMessage[] = [];
    for (const [index, node] of nodes.entries()) {
      const kind = trajectoryEvent(node);
      const event: ProcessEvent = {
        id: `${lane.id}:${node.id}`,
        index,
        time: 0.5 + (index / Math.max(1, longestLane - 1)) * 25,
        row: index,
        lane: id,
        kind: eventKind(kind),
        actor: lane.isCurrent ? "selected-model" : `model:${lane.id}`,
        modelFamily: modelFamily(provider, modelId, catalogModel?.label)?.id,
        emits: node.state === "user" ? false : undefined,
        label: node.title,
        summary: node.preview ?? node.title,
        branch: node.isFork,
        fail: kind === "test-fail",
        running:
          lane.isCurrent &&
          input.processBlocks.some(
            (block) =>
              block.kind === "stage" &&
              block.status === "running" &&
              block.scrollTargetId === node.scrollTargetId,
          ),
        nativeNode: node,
        hash: node.id.slice(-7),
      };
      events.push(event);
      if (!lane.isCurrent)
        list.push({
          id: event.id,
          kind: "event",
          time: event.time,
          eventId: event.id,
          steps: node.preview
            ? [
                {
                  id: `${event.id}:detail`,
                  kind: "read",
                  label: "会话条目",
                  duration: "",
                  detail: node.preview,
                },
              ]
            : [],
        });
    }
    messages[id] = list;
  }
  // Files from extra capture roots (for example a knowledge base) live outside the
  // workspace checkout, so they produce no native trajectory node. Surface each one as
  // its own commit point in the selected lane.
  events.push(
    ...externalCaptureEvents({
      turns: input.turns,
      lane: current,
      laneNodes: input.trajectory.laneNodes.get(current) ?? [],
      laneLength: longestLane,
      fallbackLabel: t("timeline.turnChanges.external"),
    }),
  );
  for (const lane of represented) {
    const error = input.trajectory.errorsBySessionId?.[lane.sessionId];
    if (error)
      events.push({
        id: `tree-error:${lane.id}`,
        index: events.length,
        time: 26.5,
        row: input.trajectory.laneNodes.get(lane.id)?.length ?? 0,
        lane: lane.id,
        kind: "error",
        actor: "selected-model",
        label: "历史读取失败",
        summary: error,
        fail: true,
        emits: false,
        errorCode: "TREE_LOAD",
      });
  }
  const currentEvents = events.filter((event) => event.lane === current);
  messages[current] = input.processBlocks.map((block, index) => {
    const event = currentEvents.find(
      (event) =>
        event.nativeNode?.id === block.id ||
        event.nativeNode?.scrollTargetId ===
          (block.kind === "stage" ? block.scrollTargetId : block.id),
    );
    const base = {
      id: block.id,
      eventId: event?.id,
      timestampLabel: nativeClock(
        block.kind === "assistant-prose" ? block.createdAt : event?.nativeNode?.timestamp,
      ),
      anchorId: block.kind === "stage" ? block.scrollTargetId : block.id,
      time: event?.time ?? ((index + 1) / (input.processBlocks.length + 2)) * 26.5,
    };
    if (block.kind === "turn-changes") {
      const turn = input.turns?.find((turn) => turn.checkpointId === block.turnId);
      return {
        ...base,
        kind: "assistant",
        actor: "selected-model",
        nativeBody: turn ? <TurnChangesCard turn={turn} onOpen={input.onOpenTurnChange} /> : null,
      };
    }
    if (block.kind === "user" && /^\[return:/.test(block.text)) {
      return {
        ...base,
        kind: "assistant",
        actor: "selected-model",
        nativeBody: (
          <BranchReturnCard
            text={block.text}
            workspacePath={input.workspacePath}
            onOpenDeliverable={input.onOpenDeliverable}
          />
        ),
      };
    }
    if (block.kind === "user")
      return {
        ...base,
        kind: "user",
        text: block.text,
        nativeBody: (
          <>
            {input.scheduledOrigins?.has(block.id) ? (
              <div className="timeline-item__scheduled-origin" data-testid="sent-by-scheduled-task">
                {t("timeline.sentByScheduledTask")}
              </div>
            ) : null}
            {block.attachments?.map((attachment, i) =>
              attachment.kind === "image" ? (
                <ImageAttachmentThumb
                  className="timeline-item__attachment timeline-item__attachment--image"
                  key={i}
                  name={attachment.name ?? "Image"}
                  src={`data:${attachment.mimeType};base64,${attachment.data}`}
                />
              ) : (
                <span
                  key={i}
                  className="timeline-item__attachment timeline-item__attachment--file"
                  title={attachment.fsPath}
                >
                  <span className="timeline-item__attachment-name">{attachment.name}</span>
                </span>
              ),
            )}
            <MessageMarkdown text={block.text} />
          </>
        ),
      };
    if (block.kind === "assistant-prose")
      return {
        ...base,
        kind: "assistant",
        actor: "selected-model",
        text: block.text,
        running: chosen?.session.status === "running" && index === input.processBlocks.length - 1,
        nativeBody: (
          <>
            <MessageMarkdown
              text={block.text}
              workspacePath={input.workspacePath}
              onOpenWorkspaceFileLine={input.onOpenWorkspaceFileLine}
            />
            {block.sourceMessageIndex !== undefined ? (
              <div className="timeline-item__actions">
                <button
                  type="button"
                  data-testid="fork-from-message"
                  disabled={!input.onForkFromMessage}
                  className="timeline-item__action"
                  onClick={() => input.onForkFromMessage?.(block.sourceMessageIndex!, block.text)}
                >
                  {t("timeline.fork")}
                </button>
              </div>
            ) : null}
          </>
        ),
      };
    const steps: ProcessStepData[] =
      block.kind === "stage"
        ? block.steps.map((step) => {
            if (step.kind === "tool")
              return {
                id: step.id,
                kind: "run",
                label: step.item.label,
                duration: step.item.metadata ?? "",
                detail: step.item.detail ?? "",
                nativeBody: (
                  <ProcessToolStep
                    item={step.item}
                    defaultOpen={false}
                    onViewFileInDiff={input.onViewFileInDiff}
                  />
                ),
              };
            if (step.kind === "thinking")
              return {
                id: step.id,
                kind: "think",
                label: `思考了 ${Math.round(step.durationMs / 1000)} 秒`,
                duration: `${Math.round(step.durationMs / 1000)}s`,
                detail: "",
              };
            return {
              id: step.id,
              kind: "read",
              label: step.item.label,
              duration: "",
              detail:
                step.kind === "activity"
                  ? (step.item.detail ?? step.item.metadata ?? "")
                  : (step.item.metadata ?? ""),
            };
          })
        : [];
    return {
      ...base,
      kind: "event",
      eventId: event?.id,
      steps,
      nativeBody:
        block.kind === "summary-card" ? (
          <MessageMarkdown
            text={block.text}
            workspacePath={input.workspacePath}
            onOpenWorkspaceFileLine={input.onOpenWorkspaceFileLine}
          />
        ) : block.kind === "handoff" ? (
          <ProcessHandoffCard from={block.fromLabel} to={block.toLabel} summary={block.detail} />
        ) : undefined,
    };
  });
  titles[current] = {
    title: stripLancerZonePrefix(input.title),
    branch: chosen?.environment.branchName ?? chosen?.environment.label ?? "",
  };
  if (videoLearn && videoLearn.videoId && represented.some((lane) => lane.id === current)) {
    const learned = videoLearnProcessMessages(videoLearn);
    messages[current] = [...(messages[current] ?? []), ...learned];
    events.push(
      ...videoLearnProcessEvents(videoLearn).map((event) => ({ ...event, lane: current })),
    );
    if (videoLearn.relayTree) {
      const relay = buildRelayTree({ ...videoLearn.relayTree, snapshot: videoLearn });
      const existing = new Set(events.map((event) => event.id));
      const offset = events.filter((event) => event.lane === current).length;
      events.push(
        ...relay.events
          .filter((event) => !existing.has(event.id))
          .map((event, index) => ({
            ...event,
            lane: current,
            modelFamily: modelFamily(
              "",
              relay.actors.find((actor) => actor.id === event.actor)?.name,
            )?.id,
            row: offset + index,
            time: 25.5 + index / Math.max(1, relay.events.length),
          })),
      );
      messages[current].push(...Object.values(relay.messages).flat());
    }
    if (deliveries.length) {
      messages[current].push({
        id: `video-deliveries:${videoLearn.videoId}`,
        kind: "event",
        time: 26.5,
        nativeBody: <VideoDeliveryCards deliveries={deliveries} onOpen={input.onOpenDeliverable} />,
      });
    }
  }
  const projected = parallelTreeEvents(
    events,
    input.children ?? [],
    new Set(represented.map((lane) => lane.id)),
  );
  events.splice(0, events.length, ...projected);
  for (const event of events.filter(
    (e) => e.id.startsWith("branch:") || e.id.startsWith("return:"),
  )) {
    (messages[event.lane] ??= []).push({
      id: event.id,
      eventId: event.id,
      kind: "event",
      time: event.time,
      steps: [
        {
          id: `${event.id}:detail`,
          kind: "read",
          label: event.label,
          duration: "",
          detail: event.summary,
        },
      ],
    });
  }
  const actors = [
    ...REPLAY_FIXTURE.actors,
    ...represented.map((lane) => {
      const thread = input.threads.find(
        (thread) => thread.workspaceId === lane.workspaceId && thread.session.id === lane.sessionId,
      );
      return {
        id: `model:${lane.id}`,
        name: thread?.session.config?.modelId ?? "pi",
        icon:
          REPLAY_FIXTURE.actors.find(
            (actor) =>
              actor.id ===
              liveActor(thread?.session.config?.provider, thread?.session.config?.modelId),
          )?.icon ?? "openai",
      };
    }),
    { id: "video-local", name: "本地媒体处理", icon: "openai" },
    {
      id: "video-gateway",
      name: videoLearn?.stages.find((stage) => stage.id === "analysis")?.model ?? "视觉分析",
      short:
        videoLearn?.stages.find((stage) => stage.id === "analysis")?.model === "gpt-6.1-sol"
          ? "Sol · 看帧"
          : videoLearn?.stages.find((stage) => stage.id === "analysis")?.model === "gpt-6.1-terra"
            ? "Terra · 代码动画"
            : "视觉分析",
      icon: "openai",
    },
    {
      id: "video-handoff",
      name: videoLearn?.stages.find((stage) => stage.id === "handoff")?.model ?? "学习结论",
      short:
        videoLearn?.stages.find((stage) => stage.id === "handoff")?.model === "gpt-6-astra"
          ? "Astra · 学习结论"
          : videoLearn?.stages.find((stage) => stage.id === "handoff")?.model === "gpt-6.1-sol"
            ? "Sol · 总结"
            : "学习结论",
      icon: "openai",
    },
    {
      id: "selected-model",
      name: input.modelId ?? "未选择模型",
      short: input.modelId ?? "未选择模型",
      icon:
        REPLAY_FIXTURE.actors.find((actor) => actor.id === liveActor(input.provider, input.modelId))
          ?.icon ?? "openai",
    },
  ];
  return {
    lane: current,
    data: {
      videoDeliverables: deliveries,
      laneSummary: `${represented.filter((lane) => !input.children?.some((child) => child.childSessionId === lane.sessionId)).length} 个会话 · ${input.children?.filter((child) => represented.some((lane) => lane.sessionId === child.childSessionId)).length ?? 0} 条分支`,
      assistants: input.assistants,
      archivedSessions: input.archivedSessions,
      sidebarCollapsed: input.sidebarCollapsed,
      assistantId: input.assistantId,
      minimumGraphHeight: 66 + Math.max(0, ...events.map((event) => event.row ?? 0)) * 32,
      clockLabel: nativeClock(chosen?.session.updatedAt),
      statusLabel:
        videoLearn?.busy || input.threads.some((thread) => thread.session.status === "running")
          ? "运行中"
          : "已就绪",
      recentActors: [
        ...new Set(
          sidebar.flatMap((group) =>
            group.sessions.map((session) => (session.selected ? "selected-model" : session.actor)),
          ),
        ),
      ],
      actors,
      icons: REPLAY_FIXTURE.icons,
      lanes: represented.map((lane) => ({
        id: lane.id,
        name: stripLancerZonePrefix(lane.label),
        title: stripLancerZonePrefix(lane.label),
        treeError: input.trajectory.errorsBySessionId?.[lane.sessionId],
        color: conversationColor(JSON.stringify(conversationRoot(lane, input.children))),
        statusLabel:
          input.children?.find((child) => child.childSessionId === lane.sessionId)?.supervisionLoop
            ?.gate === "stop"
            ? "已停止"
            : (lane.id === current && videoLearn?.busy) ||
                input.threads.find((thread) => thread.session.id === lane.sessionId)?.session
                  .status === "running"
              ? "运行中"
              : (lane.id === current && videoLearn?.guiStatus === "FAILED") ||
                  input.threads.find((thread) => thread.session.id === lane.sessionId)?.session
                    .status === "failed"
                ? "失败"
                : sessionRunLabel(
                    input.threads.find((thread) => thread.session.id === lane.sessionId)?.session,
                    events.some((event) => event.lane === lane.id),
                  ),
        relay: [],
        available: true,
        parentLaneId: input.children?.find((child) => child.childSessionId === lane.sessionId)
          ?.parentSessionId
          ? `lane:${input.children.find((child) => child.childSessionId === lane.sessionId)!.parentSessionId}`
          : undefined,
      })),
      sidebar,
      reel: ["selected-model"],
      events,
      messages,
      titles,
    },
  };
}
