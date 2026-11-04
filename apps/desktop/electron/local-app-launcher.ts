import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { LocalAppId } from "../contracts/ipc";

/**
 * Starts companion desktop apps from the model reel.
 *
 * The renderer sends an id, never a path: the table below is the whole
 * allowlist, so a compromised renderer cannot turn this into a command runner.
 */

export const LOCAL_APP_IDS = [
  "workbuddy",
  "marvis",
  "opencode",
] as const satisfies readonly LocalAppId[];

export interface LocalAppFileSystem {
  exists(target: string): boolean;
  readDir(directory: string): readonly string[];
}

const nodeFileSystem: LocalAppFileSystem = {
  exists: (target) => existsSync(target),
  readDir: (directory) => {
    try {
      return readdirSync(directory);
    } catch {
      return [];
    }
  },
};

export function isLocalAppId(value: string): value is LocalAppId {
  return (LOCAL_APP_IDS as readonly string[]).includes(value);
}
/** Windows install roots, plus the extra drives apps are commonly installed on. */
function installRoots(env: NodeJS.ProcessEnv): readonly string[] {
  const declared = [env["ProgramW6432"], env["ProgramFiles"], env["ProgramFiles(x86)"]];
  const fallback = ["C:", "D:", "E:", "F:"].map((drive) => `${drive}\\Program Files`);
  const roots = [...declared, ...fallback].filter((root): root is string => Boolean(root));
  return [...new Set(roots)];
}

/** One resolver per id, so supporting a new app is a table entry plus an id. */
const resolvers: Readonly<
  Record<LocalAppId, (env: NodeJS.ProcessEnv, fs: LocalAppFileSystem) => string | undefined>
> = {
  workbuddy: (env, fs) => {
    const candidates = [
      ...installRoots(env).map((root) => path.join(root, "WorkBuddy", "WorkBuddy.exe")),
      // Per-user Electron installs put the app under LocalAppData.
      env["LOCALAPPDATA"]
        ? path.join(env["LOCALAPPDATA"], "Programs", "WorkBuddy", "WorkBuddy.exe")
        : undefined,
    ];
    return candidates.find((candidate) => candidate !== undefined && fs.exists(candidate));
  },
  marvis: (env, fs) => {
    for (const root of installRoots(env)) {
      const base = path.join(root, "Tencent", "Marvis", "Application");
      // The Start menu shortcut targets MarvisLauncher, which also handles updates.
      const launcher = path.join(base, "MarvisLauncher.exe");
      if (fs.exists(launcher)) return launcher;
      // Older layouts install straight into a version directory.
      const installed = fs
        .readDir(base)
        .filter((version) => fs.exists(path.join(base, version, "Marvis.exe")))
        .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
      const newest = installed[installed.length - 1];
      if (newest) return path.join(base, newest, "Marvis.exe");
    }
    return undefined;
  },
  opencode: (env, fs) => {
    const appData = env["APPDATA"];
    const localAppData = env["LOCALAPPDATA"];
    const candidates = [
      appData ? path.join(appData, "npm", "opencode.cmd") : undefined,
      localAppData ? path.join(localAppData, "Programs", "opencode", "opencode.exe") : undefined,
    ];
    return candidates.find((candidate) => candidate !== undefined && fs.exists(candidate));
  },
};

export function resolveLocalAppExecutable(
  appId: LocalAppId,
  env: NodeJS.ProcessEnv = process.env,
  fs: LocalAppFileSystem = nodeFileSystem,
): string | undefined {
  return resolvers[appId](env, fs);
}

/** Starts the app detached so it outlives Lancer. Command scripts get a console. */
export async function startLocalApp(
  appId: string,
  env: NodeJS.ProcessEnv = process.env,
  fs: LocalAppFileSystem = nodeFileSystem,
): Promise<void> {
  if (!isLocalAppId(appId)) throw new Error(`Unknown local app: ${appId}`);
  const executable = resolveLocalAppExecutable(appId, env, fs);
  if (!executable) throw new Error(`Local app is not installed: ${appId}`);
  const isCommandScript = /\.(?:cmd|bat)$/iu.test(executable);
  // A CLI such as OpenCode needs a console window, or it starts invisibly. Node quotes the
  // argument, and a hand-quoted or verbatim form makes cmd.exe fail to resolve the shim.
  const child = isCommandScript
    ? spawn(env["ComSpec"] ?? "cmd.exe", ["/c", "start", "", executable], {
        detached: true,
        stdio: "ignore",
      })
    : spawn(executable, [], { detached: true, stdio: "ignore" });
  // A spawn failure (deleted binary, permissions) must reach the popover instead of only
  // the main-process log, so the caller can show it.
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (error) =>
      reject(new Error(`Failed to start local app: ${appId} (${error.message})`)),
    );
  });
  child.unref();
}
