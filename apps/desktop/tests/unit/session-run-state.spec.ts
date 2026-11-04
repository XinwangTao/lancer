import { test, expect } from "@playwright/test";
import { sessionRunLabel, runOutcomePatch } from "../../contracts/session-run-state";
const ref = { workspaceId: "w", sessionId: "root" };
const now = "2026-11-02T00:00:00.000Z";
test("cancelled, interrupted, failed and completed have distinct durable labels", () => {
  for (const [lastRunOutcome, label] of [
    ["cancelled", "已取消"],
    ["interrupted", "已中断"],
    ["failed", "失败"],
    ["completed", "完成"],
  ] as const)
    expect(sessionRunLabel({ status: "idle", lastRunOutcome }, true)).toBe(label);
  expect(sessionRunLabel({ status: "idle" }, true)).toBe("已结束");
  const event = {
    type: "sessionUpdated" as const,
    sessionRef: ref,
    timestamp: now,
    outcome: "aborted" as const,
    snapshot: { ref, title: "A", status: "idle" as const, updatedAt: now },
  };
  expect(runOutcomePatch(event)).toMatchObject({
    lastRunOutcome: "cancelled",
    runtimeStatus: "failed",
  });
});
