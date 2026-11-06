import { expect, test } from "@playwright/test";
import type { TurnChangeSummary } from "../../contracts/review";
import { externalCaptureEvents } from "../../src/features/conversation/lancer-process/external-capture-events";
import { parallelTreeEvents } from "../../src/features/conversation/lancer-process/parallel-tree";
import type { ProcessEvent } from "../../src/features/conversation/lancer-process/process-types";

function turn(overrides: Partial<TurnChangeSummary> = {}): TurnChangeSummary {
  return {
    checkpointId: "checkpoint-1",
    checkoutId: "workspace",
    entryIds: ["entry-1", "entry-2"],
    files: [],
    ...overrides,
  };
}

test("external capture files become commit points anchored after the turn", () => {
  const events = externalCaptureEvents({
    turns: [
      turn({
        files: [
          { path: "src/app.ts", lines: { added: 1, removed: 0 } },
          {
            path: "notes/x.md",
            lines: { added: 3, removed: 1 },
            origin: "external",
            originLabel: "Obsidian",
          },
          { path: "notes/y.md", lines: null, origin: "external" },
        ],
      }),
    ],
    lane: "lane-1",
    laneNodes: [
      { id: "entry-1", timestamp: "2026-01-01T00:00:01.000Z" },
      { id: "entry-2", timestamp: "2026-01-01T00:00:02.000Z" },
      { id: "entry-3", timestamp: "2026-01-01T00:00:03.000Z" },
    ],
    laneLength: 3,
    fallbackLabel: "External",
  });

  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    id: "external:checkpoint-1:notes/x.md",
    lane: "lane-1",
    kind: "commit",
    label: "notes/x.md",
    summary: "Obsidian · +3 -1",
    evidenceTimestamp: "2026-01-01T00:00:02.000Z",
    index: 1 + 1 / 3,
    row: 2 + 1 / 3,
  });
  expect(events[1]).toMatchObject({
    label: "notes/y.md",
    summary: "External",
    row: 2 + 2 / 3,
  });
});

test("workspace-only turns and missing turns produce no external points", () => {
  expect(
    externalCaptureEvents({
      turns: [turn({ files: [{ path: "src/app.ts", lines: null }] })],
      lane: "lane-1",
      laneNodes: [],
      laneLength: 1,
      fallbackLabel: "External",
    }),
  ).toEqual([]);
  expect(
    externalCaptureEvents({
      turns: undefined,
      lane: "lane-1",
      laneNodes: [],
      laneLength: 1,
      fallbackLabel: "External",
    }),
  ).toEqual([]);
});

test("files without a matching entry land at the end of the lane", () => {
  const events = externalCaptureEvents({
    turns: [
      turn({
        entryIds: ["missing-entry"],
        files: [{ path: "notes/z.md", lines: { added: 2, removed: 0 }, origin: "external" }],
      }),
    ],
    lane: "lane-1",
    laneNodes: [{ id: "entry-1", timestamp: "2026-01-01T00:00:01.000Z" }],
    laneLength: 1,
    fallbackLabel: "External",
  });
  expect(events[0]).toMatchObject({
    evidenceTimestamp: "2026-01-01T00:00:01.000Z",
    index: 0.5,
    row: 1 + 1 / 2,
    summary: "External · +2 -0",
  });
});

test("capture points keep their place when the tree re-sorts timestamped entries", () => {
  const lane = "lane-1";
  const entries = ["entry-1", "entry-2", "entry-3"];
  const timestampAt = (index: number) => `2026-01-01T00:00:0${index + 1}.000Z`;
  const native: ProcessEvent[] = entries.map((id, index) => ({
    id: `${lane}:${id}`,
    index,
    time: 0,
    row: index,
    lane,
    kind: "tool",
    actor: "selected-model",
    label: id,
    summary: id,
    evidenceTimestamp: timestampAt(index),
  }));
  const external = externalCaptureEvents({
    turns: [turn({ files: [{ path: "notes/x.md", lines: null, origin: "external" }] })],
    lane,
    laneNodes: entries.map((id, index) => ({ id, timestamp: timestampAt(index) })),
    laneLength: 3,
    fallbackLabel: "External",
  });

  const projected = parallelTreeEvents([...native, ...external], [], new Set([lane]));
  const rows = new Map(projected.map((event) => [event.id, event.row]));
  const captureRow = rows.get("external:checkpoint-1:notes/x.md")!;
  expect(captureRow).toBeGreaterThan(rows.get(`${lane}:entry-2`)!);
  expect(captureRow).toBeLessThan(rows.get(`${lane}:entry-3`)!);
});
