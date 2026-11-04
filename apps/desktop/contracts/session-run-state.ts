import type { SessionDriverEvent, SessionRuntimeMetadata } from "@lancer/session-driver";

export function runOutcomePatch(
  event: SessionDriverEvent,
  previousStatus?: string,
): Partial<SessionRuntimeMetadata> | undefined {
  if (
    event.type === "sessionUpdated" &&
    event.snapshot.status === "running" &&
    previousStatus !== "running"
  )
    return {
      lastRunOutcome: null,
      runtimeStatus: "running",
      startedAt: event.timestamp,
      finishedAt: null,
    };
  if (event.type === "runFailed")
    return { lastRunOutcome: "failed", runtimeStatus: "failed", finishedAt: event.timestamp };
  if (
    (event.type === "sessionUpdated" || event.type === "runCompleted") &&
    event.outcome === "aborted"
  )
    return { lastRunOutcome: "cancelled", runtimeStatus: "failed", finishedAt: event.timestamp };
  if (event.type === "runCompleted")
    return { lastRunOutcome: "completed", runtimeStatus: "done", finishedAt: event.timestamp };
  return undefined;
}

export function sessionRunLabel(
  session:
    | {
        readonly status: string;
        readonly lastRunOutcome?: SessionRuntimeMetadata["lastRunOutcome"];
      }
    | undefined,
  hasHistory: boolean,
): string {
  if (session?.status === "running") return "运行中";
  if (session?.lastRunOutcome === "cancelled") return "已取消";
  if (session?.lastRunOutcome === "interrupted") return "已中断";
  if (session?.status === "failed" || session?.lastRunOutcome === "failed") return "失败";
  if (session?.lastRunOutcome === "completed") return "完成";
  return hasHistory ? "已结束" : "待开始";
}
