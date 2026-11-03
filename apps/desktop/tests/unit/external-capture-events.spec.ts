import { expect, test } from "@playwright/test";
import type { TurnChangeSummary } from "../../contracts/review";
import { externalCaptureEvents } from "../../src/features/conversation/lancer-process/external-capture-events";

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
    laneNodes: [{ id: "entry-1" }, { id: "entry-2" }, { id: "entry-3" }],
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
    laneNodes: [{ id: "entry-1" }],
    laneLength: 1,
    fallbackLabel: "External",
  });
  expect(events[0]).toMatchObject({ row: 1 + 1 / 2, summary: "External · +2 -0" });
});
