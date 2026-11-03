import type { TurnChangeSummary } from "../../../../contracts/review";
import type { ProcessEvent } from "./process-types";

export interface ExternalCaptureLaneNode {
  readonly id: string;
}

export interface ExternalCaptureEventsInput {
  readonly turns: readonly TurnChangeSummary[] | undefined;
  readonly lane: string;
  readonly laneNodes: readonly ExternalCaptureLaneNode[];
  /** Longest lane length, used to spread rows over the same time range as native events. */
  readonly laneLength: number;
  /** Label used when the capture root did not configure one. */
  readonly fallbackLabel: string;
}

/**
 * Knowledge bases and other captured roots live outside the workspace checkout, so they
 * produce no native trajectory node. Surface each changed file as its own commit point,
 * placed between the turn's last entry and the next native node.
 */
export function externalCaptureEvents(input: ExternalCaptureEventsInput): ProcessEvent[] {
  const events: ProcessEvent[] = [];
  const nodes = input.laneNodes;
  for (const turn of input.turns ?? []) {
    const files = turn.files.filter((file) => file.origin === "external");
    if (!files.length) continue;
    let anchor = -1;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      if (turn.entryIds.includes(nodes[index]!.id)) {
        anchor = index;
        break;
      }
    }
    const baseRow = anchor >= 0 ? anchor + 1 : nodes.length;
    files.forEach((file, offset) => {
      // Fractional rows keep external points between native nodes instead of landing
      // on the same row (and therefore the same pixel) as the next one.
      const row = baseRow + (offset + 1) / (files.length + 1);
      const label = file.originLabel ?? input.fallbackLabel;
      events.push({
        id: `external:${turn.checkpointId}:${file.path}`,
        index: anchor + (offset + 1) / 1000,
        time: 0.5 + (row / Math.max(1, input.laneLength - 1)) * 25,
        row,
        lane: input.lane,
        kind: "commit",
        actor: "selected-model",
        label: file.path,
        summary: file.lines ? `${label} · +${file.lines.added} -${file.lines.removed}` : label,
        hash: turn.checkpointId.slice(-7),
        emits: false,
      });
    });
  }
  return events;
}
