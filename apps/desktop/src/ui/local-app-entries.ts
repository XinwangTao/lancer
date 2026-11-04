import type { LocalAppId } from "../../contracts/ipc";

export interface LocalAppEntry {
  readonly id: LocalAppId;
  readonly label: string;
  /** Shown under the launch row so each app states what it actually opens. */
  readonly hint: string;
}

/**
 * Companion desktop apps listed after the model families in the reel. They are
 * not model providers: they have no catalog, and selecting one starts the app.
 */
export const LOCAL_APP_ENTRIES: readonly LocalAppEntry[] = [
  { id: "workbuddy", label: "WorkBuddy", hint: "GUI 对话" },
  { id: "marvis", label: "Marvis", hint: "电脑操作" },
  { id: "opencode", label: "OpenCode", hint: "终端 CLI" },
];
