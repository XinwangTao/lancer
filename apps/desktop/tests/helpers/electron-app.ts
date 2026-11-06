import { execFile, spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import type { SessionDriverEvent, SessionRef } from "@lancer/session-driver";
import type { PiDesktopApi } from "../../contracts/ipc";
import type {
  DesktopAppState,
  NewThreadEnvironment,
  SelectedTranscriptRecord,
  SessionRecord,
  WorkspaceRecord,
} from "../../contracts/desktop-state";
import { resolvePackagedAppExecutable } from "./packaged-app";
import { desktopShortcut, TINY_PNG_BASE64 } from "./native-input";
import { formatSessionTitleForZone, stripLancerZonePrefix } from "../../contracts/lancer-zones";

export {
  copyAppBundle,
  extractAppBundleFromReleaseZip,
  extractPackagedReleaseZipAppBundle,
  resolveAppBundleExecutable,
  resolvePackagedAppBundle,
  resolvePackagedAppExecutable,
  resolvePackagedReleaseZip,
} from "./packaged-app";
export * from "./native-input";

const desktopDir = resolve(__dirname, "..", "..");
const execFileAsync = promisify(execFile);
const require = createRequire(__filename);
const electronExecutablePath = require("electron") as string;
const REAL_AUTH_ENV_VAR = "PI_APP_REAL_AUTH";
const REAL_AUTH_SOURCE_DIR_ENV_VAR = "PI_APP_REAL_AUTH_SOURCE_DIR";
const REQUIRED_REAL_AUTH_FILES = ["auth.json"] as const;
const OPTIONAL_REAL_AUTH_FILES = ["settings.json", "models.json"] as const;
// Provider auth env vars the pi runtime honors that do NOT end in `_API_KEY`
// (see the runtime's `Environment Variables` help block). Every `*_API_KEY`
// var is scrubbed dynamically below, so this only needs the exceptions.
const NON_API_KEY_PROVIDER_ENV_VARS = [
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_GATEWAY_ID",
] as const;

// Any ambient provider credential connects a provider in the isolated runtime,
// which silently poisons "no providers connected" assertions on developer
// machines that export keys the hardcoded list happened to miss. Scrub the full
// class instead: every `*_API_KEY` var plus the documented non-suffixed ones.
function isProviderAuthEnvVar(key: string): boolean {
  return (
    key.endsWith("_API_KEY") || (NON_API_KEY_PROVIDER_ENV_VARS as readonly string[]).includes(key)
  );
}
export type PiAppWindow = Window & { piApp?: PiDesktopApi };
export type DesktopTestMode = "foreground" | "background";

export interface DesktopHarness {
  electronApp: ElectronApplication;
  firstWindow(): Promise<Page>;
  focusWindow(): Promise<void>;
  close(): Promise<void>;
}

export interface LaunchDesktopOptions {
  readonly initialWorkspaces?: readonly string[];
  readonly notificationLogPath?: string;
  readonly testMode?: DesktopTestMode;
  readonly agentDir?: string;
  readonly realAuthSourceDir?: string;
  readonly enabledModels?: readonly string[];
  readonly scrubProviderEnv?: boolean;
  readonly envOverrides?: Readonly<Record<string, string | undefined>>;
  readonly inheritParentEnv?: boolean;
  readonly disableGpu?: boolean;
  readonly recordVideoDir?: string;
  readonly recordVideoSize?: { readonly width: number; readonly height: number };
}

export interface SeedAgentDirOptions {
  readonly withOpenAiAuth?: boolean;
  readonly withDefaultModel?: boolean;
  readonly enabledModels?: readonly string[];
}

export interface RealAuthConfig {
  readonly enabled: boolean;
  readonly sourceDir?: string;
  readonly skipReason?: string;
}

export function getRealAuthConfig(): RealAuthConfig {
  if (process.env[REAL_AUTH_ENV_VAR] !== "1") {
    return {
      enabled: false,
      skipReason: `Set ${REAL_AUTH_ENV_VAR}=1 and ${REAL_AUTH_SOURCE_DIR_ENV_VAR}=/absolute/path/to/agent to run this spec.`,
    };
  }

  const sourceDir = process.env[REAL_AUTH_SOURCE_DIR_ENV_VAR]?.trim();
  if (!sourceDir) {
    return {
      enabled: false,
      skipReason: `Set ${REAL_AUTH_SOURCE_DIR_ENV_VAR}=/absolute/path/to/agent when ${REAL_AUTH_ENV_VAR}=1.`,
    };
  }

  return {
    enabled: true,
    sourceDir: resolve(sourceDir),
  };
}

function isWorkspacePaths(
  options: readonly string[] | LaunchDesktopOptions,
): options is readonly string[] {
  return Array.isArray(options);
}

function normalizeLaunchOptions(
  options: readonly string[] | LaunchDesktopOptions,
): LaunchDesktopOptions {
  return isWorkspacePaths(options) ? { initialWorkspaces: options } : options;
}

function electronCliArgs(entry?: string, disableGpu = false): string[] {
  const args = entry ? [entry] : [];
  if (process.platform === "darwin") {
    // Each test owns an isolated application profile, but AppKit's crash/restore
    // state is shared by the Electron bundle ID. Its native reopen prompt can
    // block ready before any BrowserWindow exists (electron/electron#51488).
    // Scope this to the launched process; never change the user's global defaults.
    args.push("-ApplePersistenceIgnoreState", "YES");
  }
  if (process.platform === "linux") {
    // A never-shown X11 window draws ~1.5 frames/s, which starves rAF-driven layout
    // and native wheel scrolling in background test mode.
    args.push("--disable-gpu", "--no-sandbox", "--disable-frame-rate-limit");
  } else if (disableGpu) {
    args.push("--disable-gpu");
  }
  return args;
}

export async function launchDesktop(
  userDataDir: string,
  options: readonly string[] | LaunchDesktopOptions = [],
): Promise<DesktopHarness> {
  const normalized = normalizeLaunchOptions(options);
  const agentDir = await prepareAgentDir(userDataDir, normalized);
  const env = buildDesktopLaunchEnv(userDataDir, agentDir, normalized);
  // Playwright's Electron video recorder can stall loadURL on Linux, leaving a
  // placeholder BrowserWindow whose URL never leaves empty. Skip it there;
  // callers still capture screenshots and traces.
  const recordVideo =
    normalized.recordVideoDir && process.platform !== "linux"
      ? {
          recordVideo: {
            dir: normalized.recordVideoDir,
            ...(normalized.recordVideoSize ? { size: normalized.recordVideoSize } : {}),
          },
        }
      : {};
  const electronApp = await electron.launch({
    // Match packaged launches, without Playwright's extra app.whenReady shim.
    // The application owns readiness; the harness attaches to its real windows.
    executablePath: electronExecutablePath,
    args: electronCliArgs(desktopDir, normalized.disableGpu),
    cwd: desktopDir,
    env,
    ...recordVideo,
  });

  return createDesktopHarness(electronApp);
}

export async function spawnDesktopProcess(
  userDataDir: string,
  options: readonly string[] | LaunchDesktopOptions = [],
): Promise<ChildProcess> {
  const normalized = normalizeLaunchOptions(options);
  const agentDir = await prepareAgentDir(userDataDir, normalized);
  const env = buildDesktopLaunchEnv(userDataDir, agentDir, normalized);
  return spawn(electronExecutablePath, electronCliArgs(desktopDir, normalized.disableGpu), {
    cwd: desktopDir,
    env,
    stdio: "ignore",
  });
}

export async function launchPackagedDesktop(
  userDataDir: string,
  options: readonly string[] | LaunchDesktopOptions = [],
): Promise<DesktopHarness> {
  const normalized = normalizeLaunchOptions(options);
  const agentDir = await prepareAgentDir(userDataDir, normalized);
  const env = buildDesktopLaunchEnv(userDataDir, agentDir, normalized);
  const releaseDir = resolvePackagedReleaseDir(process.env.PI_APP_TEST_RELEASE_DIR);
  const executablePath = await resolvePackagedAppExecutable(releaseDir);
  return launchDesktopExecutable(executablePath, env);
}

export async function launchDesktopByExecutable(
  executablePath: string,
  userDataDir: string,
  options: readonly string[] | LaunchDesktopOptions = [],
): Promise<DesktopHarness> {
  const normalized = normalizeLaunchOptions(options);
  const agentDir = await prepareAgentDir(userDataDir, normalized);
  const env = buildDesktopLaunchEnv(userDataDir, agentDir, normalized);
  return launchDesktopExecutable(executablePath, env);
}

async function launchDesktopExecutable(
  executablePath: string,
  env: Record<string, string>,
): Promise<DesktopHarness> {
  const electronApp = await electron.launch({
    executablePath,
    args: electronCliArgs(),
    cwd: dirname(executablePath),
    env,
  });

  return createDesktopHarness(electronApp);
}

function isDesktopRendererPage(page: Page): boolean {
  const url = page.url();
  return url !== "" && url !== "about:blank" && !new URL(url).pathname.endsWith("/pi-orb.html");
}

async function waitForDesktopRendererPage(
  electronApp: ElectronApplication,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  const pick = () => electronApp.windows().find(isDesktopRendererPage);
  const existing = pick();
  if (existing) {
    return existing;
  }

  while (Date.now() < deadline) {
    const found = pick();
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const urls = electronApp.windows().map((candidate) => candidate.url() || "<empty>");
  throw new Error(
    `Timed out waiting for desktop renderer window (urls: ${urls.join(", ") || "<none>"})`,
  );
}

function createDesktopHarness(electronApp: ElectronApplication): DesktopHarness {
  let page: Page | undefined;

  async function getWindow(): Promise<Page> {
    if (!page) {
      // Playwright's Electron video recorder can expose an empty page before the
      // real BrowserWindow finishes loadURL. firstWindow() would attach to that
      // placeholder and hang on domcontentloaded.
      page = await waitForDesktopRendererPage(electronApp);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForFunction(() => Boolean(globalThis.window.piApp), undefined, {
        timeout: 15_000,
      });
    }
    return page;
  }

  return {
    electronApp,
    firstWindow: () => getWindow(),
    focusWindow: async () => {
      const appPage = await getWindow();
      await electronApp.evaluate(({ BrowserWindow, app }, url) => {
        const window = BrowserWindow.getAllWindows().find(
          (entry) => entry.webContents.getURL() === url,
        );
        window?.restore();
        window?.show();
        app.focus({ steal: true });
        window?.focus();
      }, appPage.url());
      if (process.platform === "darwin") {
        await focusElectronAppProcess(electronApp);
      }
      await electronApp.evaluate(({ BrowserWindow, app }, url) => {
        const window = BrowserWindow.getAllWindows().find(
          (entry) => entry.webContents.getURL() === url,
        );
        app.focus({ steal: true });
        window?.focus();
      }, appPage.url());
      await appPage.bringToFront();
      await expect
        .poll(
          async () => {
            const nativeFocused = await electronApp.evaluate(({ BrowserWindow }, url) => {
              const window = BrowserWindow.getAllWindows().find(
                (entry) => entry.webContents.getURL() === url,
              );
              return window?.isFocused() ?? false;
            }, appPage.url());
            if (nativeFocused) {
              return true;
            }
            return appPage.evaluate(() => document.hasFocus());
          },
          { timeout: 5_000 },
        )
        .toBe(true);
    },
    close: async () => {
      await electronApp.close();
    },
  };
}

async function focusElectronAppProcess(electronApp: ElectronApplication): Promise<void> {
  const pid = await electronApp.evaluate(() => process.pid);
  try {
    await execFileAsync(
      "osascript",
      [
        "-e",
        `tell application "System Events"
          repeat with idx from 1 to count of application processes
            if unix id of application process idx is ${pid} then
              set frontmost of application process idx to true
              return unix id of application process idx
            end if
          end repeat
          error "Owned Electron process is no longer running"
        end tell`,
      ],
      { timeout: 2_000 },
    );
  } catch {
    // Fall back to Electron/Playwright focus APIs when System Events access is unavailable.
  }
}

function buildDesktopLaunchEnv(
  userDataDir: string,
  agentDir: string,
  options: LaunchDesktopOptions,
): Record<string, string> {
  const baseEnv = options.inheritParentEnv === false ? {} : { ...process.env };
  // Ambient provider credentials must never turn a fixture test into a real request.
  // Explicit envOverrides remain available for tests of environment configuration.
  for (const key of Object.keys(baseEnv)) {
    if (isProviderAuthEnvVar(key)) delete baseEnv[key];
  }
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PI_APP_USER_DATA_DIR: userDataDir,
    PI_APP_INITIAL_WORKSPACES: (options.initialWorkspaces ?? []).join(delimiter),
    PI_APP_TEST_MODE: options.testMode ?? process.env.PI_APP_TEST_MODE ?? "foreground",
    PI_CODING_AGENT_DIR: agentDir,
    ...(options.notificationLogPath
      ? { PI_APP_NOTIFICATION_LOG_PATH: options.notificationLogPath }
      : {}),
    PI_APP_OPEN_DEVTOOLS: "0",
    ...(options.envOverrides ?? {}),
  };
  for (const [key, value] of Object.entries(options.envOverrides ?? {})) {
    if (value === undefined) {
      delete env[key];
    }
  }

  if (options.scrubProviderEnv || options.realAuthSourceDir) {
    for (const key of Object.keys(env)) {
      if (isProviderAuthEnvVar(key)) {
        delete env[key];
      }
    }
  }

  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function resolvePackagedReleaseDir(rawPath: string | undefined): string | undefined {
  const trimmed = rawPath?.trim();
  if (!trimmed) {
    return undefined;
  }
  return resolve(desktopDir, trimmed);
}

async function prepareAgentDir(
  userDataDir: string,
  options: LaunchDesktopOptions,
): Promise<string> {
  if (process.env.PI_APP_TEST_LANE === "core" && options.realAuthSourceDir) {
    throw new Error("Core tests must not use real provider credentials; use the live lane.");
  }
  if (options.agentDir && options.realAuthSourceDir) {
    throw new Error(
      "Pass either agentDir or realAuthSourceDir to the desktop launch helper, not both.",
    );
  }

  if (options.agentDir) {
    return options.agentDir;
  }

  const agentDir = join(userDataDir, "agent");
  if (options.realAuthSourceDir) {
    await seedAgentDirFromRealAuth(agentDir, options.realAuthSourceDir);
    await writeAgentEnabledModels(agentDir, options.enabledModels);
    return agentDir;
  }

  await seedAgentDir(agentDir, { enabledModels: options.enabledModels });
  return agentDir;
}

async function seedAgentDirFromRealAuth(agentDir: string, sourceDir: string): Promise<void> {
  const resolvedSourceDir = resolve(sourceDir);
  await mkdir(agentDir, { recursive: true });

  for (const fileName of REQUIRED_REAL_AUTH_FILES) {
    await copyAgentFile(resolvedSourceDir, agentDir, fileName, true);
  }

  for (const fileName of OPTIONAL_REAL_AUTH_FILES) {
    await copyAgentFile(resolvedSourceDir, agentDir, fileName, false);
  }
}

async function copyAgentFile(
  sourceDir: string,
  targetDir: string,
  fileName: string,
  required: boolean,
): Promise<void> {
  const sourcePath = join(sourceDir, fileName);
  try {
    await copyFile(sourcePath, join(targetDir, fileName));
  } catch (error) {
    if (required && isMissingPathError(error)) {
      throw new Error(
        `Real-auth source dir is missing required file ${fileName}: ${sourcePath}. ` +
          `Set ${REAL_AUTH_SOURCE_DIR_ENV_VAR} to an agent dir with the full provider state.`,
      );
    }

    if (!required && isMissingPathError(error)) {
      return;
    }

    throw error;
  }
}

async function writeAgentEnabledModels(
  agentDir: string,
  enabledModels: readonly string[] | undefined,
): Promise<void> {
  if (!enabledModels) {
    return;
  }

  const settingsPath = join(agentDir, "settings.json");
  const existingSettings = await readJsonObject(settingsPath);
  const firstModel = enabledModels[0];
  const defaultSelection = firstModel ? splitModelPattern(firstModel) : undefined;
  await writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        ...existingSettings,
        ...(defaultSelection
          ? {
              defaultProvider: defaultSelection.provider,
              defaultModel: defaultSelection.modelId,
            }
          : {}),
        enabledModels: [...enabledModels],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : {};
  } catch (error) {
    if (isMissingPathError(error)) {
      return {};
    }
    throw error;
  }
}

function splitModelPattern(pattern: string): { provider: string; modelId: string } | undefined {
  const separatorIndex = pattern.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= pattern.length - 1) {
    return undefined;
  }
  return {
    provider: pattern.slice(0, separatorIndex),
    modelId: pattern.slice(separatorIndex + 1),
  };
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function makeUserDataDir(prefix = "pi-gui-user-data-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function seedAgentDir(
  agentDir: string,
  options: SeedAgentDirOptions = {},
): Promise<void> {
  const {
    withOpenAiAuth = true,
    withDefaultModel = true,
    enabledModels = ["openai/gpt-5", "openai/gpt-4o"],
  } = options;
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    `${JSON.stringify(
      withOpenAiAuth
        ? {
            openai: { type: "api_key", key: "test-openai-key" },
          }
        : {},
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        ...(withDefaultModel ? { defaultProvider: "openai", defaultModel: "gpt-5" } : {}),
        defaultThinkingLevel: "medium",
        enabledModels,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function seedBranchedTreeSessionFixture(
  agentDir: string,
  workspacePath: string,
  options: { readonly detailCount?: number } = {},
): Promise<{
  readonly sessionId: string;
  readonly title: "Tree fixture session";
}> {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");

  return withAgentDirEnv(agentDir, async () => {
    const sessionManager = SessionManager.create(workspacePath);
    let timestamp = Date.now();
    const nextTimestamp = () => {
      timestamp += 1_000;
      return timestamp;
    };
    const appendUser = (content: string) =>
      sessionManager.appendMessage({
        role: "user",
        content,
        timestamp: nextTimestamp(),
      });
    const appendAssistant = (content: string) =>
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: content }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4",
        usage: demoAssistantUsage(),
        stopReason: "stop",
        timestamp: nextTimestamp(),
      });

    sessionManager.appendModelChange("openai", "gpt-5.4");
    sessionManager.appendThinkingLevelChange("high");
    appendUser("Root question");
    const rootAnswerId = appendAssistant("Root answer");
    appendUser("Branch alpha");
    appendAssistant("Alpha answer");

    sessionManager.branch(rootAnswerId);
    appendUser("Branch beta");
    const betaAnswerId = appendAssistant("Beta answer");
    appendUser("Beta detail one");
    appendAssistant("Beta detail answer one");
    appendUser("Beta detail two");
    appendAssistant("Beta detail answer two");
    for (let index = 3; index <= (options.detailCount ?? 40); index += 1) {
      appendUser(`Beta detail ${index}`);
      appendAssistant(`Beta detail answer ${index}`);
    }

    sessionManager.branch(betaAnswerId);
    sessionManager.appendSessionInfo("Tree fixture session");

    return {
      sessionId: sessionManager.getSessionId(),
      title: "Tree fixture session",
    };
  });
}

export async function seedExternalLinkSessionFixture(
  agentDir: string,
  workspacePath: string,
): Promise<{
  readonly sessionId: string;
  readonly title: "External link fixture session";
}> {
  const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as {
    SessionManager: {
      create(cwd: string): {
        appendMessage(message: {
          role: "user" | "assistant";
          content: string;
          timestamp: number;
        }): string;
        appendSessionInfo(name: string): string;
        getSessionId(): string;
      };
    };
  };

  return withAgentDirEnv(agentDir, async () => {
    const sessionManager = SessionManager.create(workspacePath);
    let timestamp = Date.now();
    const nextTimestamp = () => {
      timestamp += 1_000;
      return timestamp;
    };

    sessionManager.appendMessage({
      role: "user",
      content: "Show me the related issue.",
      timestamp: nextTimestamp(),
    });
    sessionManager.appendMessage({
      role: "assistant",
      content:
        "Track this in [GitHub issue](https://github.com/minghinmatthewlam/pi-gui/issues/20). Ignore [email fallback](mailto:test@example.com).",
      timestamp: nextTimestamp(),
    });
    sessionManager.appendSessionInfo("External link fixture session");

    return {
      sessionId: sessionManager.getSessionId(),
      title: "External link fixture session",
    };
  });
}

export async function seedNamedTextSessionFixture(
  agentDir: string,
  workspacePath: string,
  session: {
    readonly title: string;
    readonly userText: string;
    readonly assistantText: string;
  },
): Promise<{
  readonly sessionId: string;
  readonly title: string;
}> {
  const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as {
    SessionManager: {
      create(cwd: string): {
        appendMessage(message: {
          role: "user" | "assistant";
          content: string;
          timestamp: number;
        }): string;
        appendSessionInfo(name: string): string;
        getSessionId(): string;
      };
    };
  };

  return withAgentDirEnv(agentDir, async () => {
    const sessionManager = SessionManager.create(workspacePath);
    let timestamp = Date.now();
    const nextTimestamp = () => {
      timestamp += 1_000;
      return timestamp;
    };
    sessionManager.appendMessage({
      role: "user",
      content: session.userText,
      timestamp: nextTimestamp(),
    });
    sessionManager.appendMessage({
      role: "assistant",
      content: session.assistantText,
      timestamp: nextTimestamp(),
    });
    sessionManager.appendSessionInfo(session.title);
    return {
      sessionId: sessionManager.getSessionId(),
      title: session.title,
    };
  });
}

export async function seedToolResultTreeSessionFixture(
  agentDir: string,
  workspacePath: string,
  bashFailure = false,
): Promise<{
  readonly sessionId: string;
  readonly title: "Tree tool fixture session";
}> {
  const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as {
    SessionManager: {
      create(cwd: string): {
        appendMessage(message: Record<string, unknown>): string;
        appendSessionInfo(name: string): string;
        getSessionId(): string;
      };
    };
  };

  return withAgentDirEnv(agentDir, async () => {
    const sessionManager = SessionManager.create(workspacePath);
    let timestamp = Date.now();
    const nextTimestamp = () => {
      timestamp += 1_000;
      return timestamp;
    };

    sessionManager.appendMessage({
      role: "user",
      content: "Inspect README",
      timestamp: nextTimestamp(),
    });

    sessionManager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "read-readme-call",
          name: bashFailure ? "bash" : "read",
          arguments: {
            ...(bashFailure ? { command: "grep missing perf-docs" } : {}),
            path: join(workspacePath, "README.md"),
            offset: 1,
            limit: 20,
          },
        },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "toolUse",
      timestamp: nextTimestamp(),
    });

    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "read-readme-call",
      toolName: bashFailure ? "bash" : "read",
      content: [
        {
          type: "text",
          text: bashFailure
            ? "=== perf docs ===\n\nCommand exited with code 1"
            : "# tree-command-workspace",
        },
      ],
      isError: bashFailure,
      timestamp: nextTimestamp(),
    });

    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "README inspected." }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: nextTimestamp(),
    });

    sessionManager.appendSessionInfo("Tree tool fixture session");

    return {
      sessionId: sessionManager.getSessionId(),
      title: "Tree tool fixture session",
    };
  });
}

const PROCESS_TIMELINE_DEMO_TITLE = "Sol · session-store 增量同步 · fixture";

export const LANCER_SCREENSHOT_ENABLED_MODELS = [
  "openai/gpt-5",
  "openai/gpt-4o",
  "xai/grok-4.3",
  "anthropic/claude-opus-4-5",
  "openai/gpt-4o-mini",
  "openai/gpt-4.1",
  "openai/o3",
  "openai/o4-mini",
] as const;

export async function seedLancerScreenshotUiPrefs(userDataDir: string): Promise<void> {
  await writeFile(
    join(userDataDir, "ui-state.json"),
    `${JSON.stringify(
      {
        threadGrouping: "time",
        themeMode: "light",
        themePresetId: "default",
        language: "zh-CN",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function prepareLancerScreenshotChrome(
  window: Page,
  userDataDir: string,
  fixture: {
    readonly sessionId: string;
    readonly siblingSessions: readonly { readonly sessionId: string }[];
  },
): Promise<{ readonly workspaceId: string }> {
  await window.evaluate(async () => {
    const app = globalThis.window.piApp;
    if (!app) throw new Error("piApp unavailable");
    await app.setThreadGrouping("time");
    await app.setThemeMode("light");
  });

  let workspaceId = "";
  await expect
    .poll(async () => {
      const state = await getDesktopState(window);
      const workspace = state.workspaces.find((entry) =>
        entry.sessions.some((session) => session.id === fixture.sessionId),
      );
      if (!workspace) return 0;
      workspaceId = workspace.id;
      return state.workspaces
        .flatMap((entry) => entry.sessions)
        .filter(
          (session) =>
            session.id === fixture.sessionId ||
            fixture.siblingSessions.some((sibling) => sibling.sessionId === session.id),
        ).length;
    })
    .toBeGreaterThanOrEqual(1 + fixture.siblingSessions.length);

  const now = Date.now();
  const locations = (await getDesktopState(window)).workspaces;
  const stamps: Record<string, string> = {};
  for (const [index, sessionId] of [
    fixture.sessionId,
    ...fixture.siblingSessions.map((entry) => entry.sessionId),
  ].entries()) {
    const owner = locations.find((entry) =>
      entry.sessions.some((session) => session.id === sessionId),
    );
    if (owner) stamps[`${owner.id}:${sessionId}`] = new Date(now - index * 60_000).toISOString();
  }

  const uiStatePath = join(userDataDir, "ui-state.json");
  try {
    const uiState = JSON.parse(await readFile(uiStatePath, "utf8")) as Record<string, unknown>;
    await writeFile(
      uiStatePath,
      `${JSON.stringify(
        {
          ...uiState,
          threadGrouping: "time",
          themeMode: "light",
          lastInteractedAtBySession: {
            ...(typeof uiState.lastInteractedAtBySession === "object" &&
            uiState.lastInteractedAtBySession !== null
              ? uiState.lastInteractedAtBySession
              : {}),
            ...stamps,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch {
    // First-run may not have written ui-state yet; runtime grouping is already set.
  }

  await window.evaluate(async () => {
    const app = globalThis.window.piApp;
    if (!app) throw new Error("piApp unavailable");
    await app.refreshRuntime();
  });

  return { workspaceId };
}

function demoAssistantUsage() {
  return {
    input: 120,
    output: 48,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 168,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export async function seedProcessTimelineDemoFixture(
  agentDir: string,
  workspacePath: string,
  options: {
    readonly laneWorkspaces?: Readonly<Record<string, string>>;
    readonly extraSessions?: readonly {
      readonly workspacePath: string;
      readonly zone: string;
      readonly title: string;
      readonly provider: string;
      readonly model: string;
    }[];
  } = {},
): Promise<{
  readonly sessionId: string;
  readonly title: typeof PROCESS_TIMELINE_DEMO_TITLE;
  readonly siblingSessions: readonly { readonly sessionId: string; readonly title: string }[];
}> {
  const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as {
    SessionManager: {
      create(cwd: string): {
        appendMessage(message: Record<string, unknown>): string;
        appendModelChange(provider: string, modelId: string): string;
        appendThinkingLevelChange(thinkingLevel: string): string;
        appendCompaction(
          summary: string,
          firstKeptEntryId: string | null,
          tokensBefore: number,
        ): string;
        branch(entryId: string): void;
        branchWithSummary(branchFromId: string | null, summary: string): string;
        appendSessionInfo(name: string): string;
        getSessionId(): string;
      };
    };
  };

  return withAgentDirEnv(agentDir, async () => {
    const uiPath = join(workspacePath, "src", "ui.ts");
    await mkdir(dirname(uiPath), { recursive: true });
    await writeFile(uiPath, "export const laneCount = 1;\n", "utf8");
    for (const spec of options.extraSessions ?? []) {
      const manager = SessionManager.create(spec.workspacePath);
      manager.appendModelChange(spec.provider, spec.model);
      manager.appendMessage({
        role: "user",
        content: "Fixture 演示任务 · 不代表实际执行结果",
        timestamp: Date.now(),
      });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "演示会话已就绪。" }],
        api: "openai-responses",
        provider: spec.provider,
        model: spec.model,
        usage: demoAssistantUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      });
      manager.appendSessionInfo(formatSessionTitleForZone(spec.zone, spec.title));
    }
    const sessionManager = SessionManager.create(workspacePath);
    let timestamp = Date.now();
    const nextTimestamp = () => {
      timestamp += 2_000;
      return timestamp;
    };
    const appendUser = (content: string) =>
      sessionManager.appendMessage({
        role: "user",
        content,
        timestamp: nextTimestamp(),
      });
    const appendAssistantText = (content: string) =>
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: content }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        usage: demoAssistantUsage(),
        stopReason: "stop",
        timestamp: nextTimestamp(),
      });

    sessionManager.appendModelChange("openai", "gpt-5");
    sessionManager.appendThinkingLevelChange("high");

    const firstUserId = appendUser("Fixture 演示 · 对齐多任务线：阶段可折叠，交接上下文完整保留。");
    appendAssistantText("收到。先检查布局与会话存储，再补上任务线和检查点。");

    sessionManager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "demo-read",
          name: "read",
          arguments: { path: "README.md", offset: 1, limit: 24 },
        },
        {
          type: "toolCall",
          id: "demo-edit",
          name: "edit",
          arguments: {
            path: "src/ui.ts",
            old_string: "laneCount = 1",
            new_string: "laneCount = 2",
          },
        },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5",
      usage: demoAssistantUsage(),
      stopReason: "toolUse",
      timestamp: nextTimestamp(),
    });

    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "demo-read",
      toolName: "read",
      content: [{ type: "text", text: "# process-timeline-workspace\n" }],
      isError: false,
      timestamp: nextTimestamp(),
    });
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "demo-edit",
      toolName: "edit",
      content: [{ type: "text", text: "Updated src/ui.ts" }],
      isError: false,
      timestamp: nextTimestamp(),
    });

    appendAssistantText("布局已更新。把检索上下文交给 Grok Bot，继续验证增量同步。");

    appendAssistantText(
      "Handoff · GPT-5 → Grok Bot\n上下文 8.8k → 8.8k · 无损交接\n产物：notes.md · 下一步：核对 digest.md 的引用与来源。",
    );

    sessionManager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "demo-bash",
          name: "bash",
          arguments: { command: "pnpm -r typecheck --filter @lancer/desktop" },
        },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5",
      usage: demoAssistantUsage(),
      stopReason: "toolUse",
      timestamp: nextTimestamp(),
    });
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "demo-bash",
      toolName: "bash",
      content: [{ type: "text", text: "typecheck ok" }],
      isError: false,
      timestamp: nextTimestamp(),
    });

    const turnOneCloseId = appendAssistantText(
      "检查通过。增量同步与任务线已接入，折叠只保留阶段标题。",
    );

    sessionManager.branch(turnOneCloseId);
    sessionManager.branchWithSummary(
      turnOneCloseId,
      "分支检查点：保留阶段分组，尝试更紧凑的任务线间距。",
    );
    appendUser("分叉：试验更紧凑的泳道布局。");
    appendAssistantText("保留 1px 细线，节点与交接曲线保持对齐。");

    sessionManager.branch(turnOneCloseId);
    appendUser("展开检查步骤，再点工作树定位对应阶段。");
    appendAssistantText("已完成。展开内容保持正常对比度，收起后不留下幽灵文字。");

    sessionManager.appendCompaction(
      "上下文压缩：保留阶段分组、产物路径与任务线定位锚点。",
      firstUserId,
      48_000,
    );
    sessionManager.appendSessionInfo(
      formatSessionTitleForZone("lancer", PROCESS_TIMELINE_DEMO_TITLE),
    );

    const siblingSessions: { sessionId: string; title: string }[] = [];
    for (const spec of [
      { zone: "video", title: "Grok · 看抖音关键帧", provider: "xai", model: "grok-4.3" },
      { zone: "research", title: "Grok Bot · digest.md", provider: "xai", model: "grok-4.3" },
      { zone: "xhs", title: "Kimi · 本周选题", provider: "moonshot", model: "kimi-k2" },
    ]) {
      const laneManager = SessionManager.create(
        options.laneWorkspaces?.[spec.zone] ?? workspacePath,
      );
      let laneTs = Date.now();
      laneManager.appendModelChange(spec.provider, spec.model);
      const user = (content: string) =>
        laneManager.appendMessage({
          role: "user",
          content,
          timestamp: (laneTs += 2_000),
        });
      const assistant = (content: string) =>
        laneManager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: content }],
          api: "openai-responses",
          provider: spec.provider,
          model: spec.model,
          usage: demoAssistantUsage(),
          stopReason: "stop",
          timestamp: (laneTs += 2_000),
        });
      const artifact =
        spec.zone === "video"
          ? "keyframes.md"
          : spec.zone === "research"
            ? "digest.md"
            : "topics.md";
      user(
        spec.zone === "research"
          ? "接收交接 · 核对引用与来源"
          : spec.zone === "video"
            ? "链接已粘贴 · 抽取视频关键帧"
            : "本周选题 · 整理高收藏内容",
      );
      assistant(
        spec.zone === "video"
          ? "已收到视频，先抽关键帧。"
          : spec.zone === "research"
            ? "收到上下文，开始检索来源。"
            : "先整理选题，再检查标题与封面。",
      );
      laneManager.appendMessage({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: `demo-${spec.zone}-write`,
            name: "write",
            arguments: { path: artifact, content: "# 调研产物\n" },
          },
        ],
        api: "openai-responses",
        provider: spec.provider,
        model: spec.model,
        usage: demoAssistantUsage(),
        stopReason: "toolUse",
        timestamp: (laneTs += 2_000),
      });
      laneManager.appendMessage({
        role: "toolResult",
        toolCallId: `demo-${spec.zone}-write`,
        toolName: "write",
        content: [{ type: "text", text: `已保存 ${artifact}` }],
        isError: false,
        timestamp: (laneTs += 2_000),
      });
      const events =
        spec.zone === "video"
          ? [
              "产物 · keyframes ×6",
              "模型切换 · Grok → Opus",
              "跨线引用 · digest.md",
              "错误 · 渲染 GPU 超时",
              "重试 #2 · 从学习卡片恢复",
              "检查点 · 学习卡片定稿",
            ]
          : spec.zone === "research"
            ? [
                "提交/保存 · digest.md",
                "测试 2 失败 · 阻尼参数",
                "重试 #1 · 修正阻尼参数",
                "测试 2 通过 · 12/12",
                "审查通过 · 无阻塞问题",
                "合并 · wt/motion-demo → main",
              ]
            : [
                "提交/保存 · 文案 v1",
                "等待你 · 确认标题 A/B",
                "检查点 · 保留文案",
                "跨线引用 · keyframes.md",
                "产物 · post-copy.md",
                "工具调用 · 检查标题",
              ];
      for (const event of events) assistant(`${event} [fixture]`);
      laneManager.appendSessionInfo(formatSessionTitleForZone(spec.zone, spec.title));
      siblingSessions.push({ sessionId: laneManager.getSessionId(), title: spec.title });
    }

    return {
      sessionId: sessionManager.getSessionId(),
      title: PROCESS_TIMELINE_DEMO_TITLE,
      siblingSessions,
    };
  });
}

export async function seedForkSessionFixture(
  agentDir: string,
  workspacePath: string,
): Promise<{
  readonly sessionId: string;
  readonly title: "Fork fixture session";
}> {
  const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as {
    SessionManager: {
      create(cwd: string): {
        appendMessage(message: {
          role: "user" | "assistant";
          content: string;
          timestamp: number;
        }): string;
        appendModelChange(provider: string, modelId: string): string;
        appendSessionInfo(name: string): string;
        appendThinkingLevelChange(thinkingLevel: string): string;
        getSessionId(): string;
      };
    };
  };

  return withAgentDirEnv(agentDir, async () => {
    const sessionManager = SessionManager.create(workspacePath);
    let timestamp = Date.now();
    const nextTimestamp = () => {
      timestamp += 1_000;
      return timestamp;
    };
    const appendUser = (content: string) =>
      sessionManager.appendMessage({ role: "user", content, timestamp: nextTimestamp() });
    const appendAssistant = (content: string) =>
      sessionManager.appendMessage({ role: "assistant", content, timestamp: nextTimestamp() });

    sessionManager.appendModelChange("openai", "gpt-5.4");
    sessionManager.appendThinkingLevelChange("high");
    appendUser("First fork question");
    appendAssistant("First fork answer");
    appendUser("Second fork question");
    appendAssistant("Second fork answer");
    appendUser("Third fork question");
    appendAssistant("Third fork answer");

    sessionManager.appendSessionInfo("Fork fixture session");

    return {
      sessionId: sessionManager.getSessionId(),
      title: "Fork fixture session",
    };
  });
}

async function withAgentDirEnv<T>(agentDir: string, action: () => Promise<T>): Promise<T> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await action();
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }
}

export async function makeWorkspace(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-workspace-"));
  const workspacePath = join(root, name);
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "README.md"), `# ${name}\n`, "utf8");
  return realpath(workspacePath);
}

export async function makeGitWorkspace(name: string): Promise<string> {
  const workspacePath = await makeWorkspace(name);
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "init");
  return workspacePath;
}

export async function writeProjectExtension(
  workspacePath: string,
  fileName: string,
  source: string,
): Promise<string> {
  const extensionsDir = join(workspacePath, ".pi", "extensions");
  await mkdir(extensionsDir, { recursive: true });
  const extensionPath = join(extensionsDir, fileName);
  await writeFile(extensionPath, source, "utf8");
  return extensionPath;
}

export async function initGitRepo(workspacePath: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: workspacePath });
  await execFileAsync("git", ["config", "user.name", "Pi App Tests"], { cwd: workspacePath });
  await execFileAsync("git", ["config", "user.email", "pi-gui-tests@example.com"], {
    cwd: workspacePath,
  });
}

export async function commitAllInGitRepo(workspacePath: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: workspacePath });
  await execFileAsync("git", ["commit", "-m", message], { cwd: workspacePath });
}

export async function writeTinyPng(filePath: string): Promise<void> {
  await writeFile(filePath, Buffer.from(TINY_PNG_BASE64, "base64"));
}

export async function writeTextFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, "utf8");
}

export async function getDesktopState(window: Page): Promise<DesktopAppState> {
  const state = await window.evaluate(() => {
    const app = globalThis.window.piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    return app.getState();
  });

  if (!state) {
    throw new Error("Desktop state was unavailable");
  }

  return state;
}

export async function getSelectedTranscript(
  window: Page,
): Promise<SelectedTranscriptRecord | null> {
  return window.evaluate(async () => {
    const app = globalThis.window.piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    return app.getSelectedTranscript();
  });
}

export async function waitForSelectedSessionReady(
  window: Page,
  target: {
    readonly sessionId: string;
    readonly workspaceId?: string;
  },
  timeout = 15_000,
): Promise<void> {
  let expectedComposerDraft = "";
  let expectedTitle = "";

  await expect
    .poll(
      async () => {
        const [state, selectedTranscript] = await Promise.all([
          getDesktopState(window),
          getSelectedTranscript(window),
        ]);
        const workspace = state.workspaces.find(
          (entry) =>
            (!target.workspaceId || entry.id === target.workspaceId) &&
            entry.sessions.some((session) => session.id === target.sessionId),
        );
        const session = workspace?.sessions.find((entry) => entry.id === target.sessionId);
        if (
          !workspace ||
          !session ||
          !state.runtimeByWorkspace[workspace.id] ||
          state.selectedWorkspaceId !== workspace.id ||
          state.selectedSessionId !== session.id ||
          selectedTranscript?.workspaceId !== workspace.id ||
          selectedTranscript.sessionId !== session.id
        ) {
          return false;
        }
        expectedComposerDraft = state.composerDraft;
        expectedTitle = session.title;
        return true;
      },
      {
        intervals: [50, 100, 250, 500],
        message: `wait for selected session ${target.sessionId} to finish hydrating`,
        timeout,
      },
    )
    .toBe(true);

  const header = window.locator('[data-testid="thread-title"], .chat-header__title');
  if ((await header.count()) > 0) {
    await expect(header).toHaveText(stripLancerZonePrefix(expectedTitle), { timeout });
  } else {
    await expect(window.getByTestId("model-reel")).toBeVisible({ timeout });
  }
  await expect(window.getByTestId("transcript-skeleton")).toHaveCount(0, { timeout });
  await expect(window.getByTestId("composer")).toHaveValue(expectedComposerDraft, { timeout });

  let previousLayout = "";
  await expect
    .poll(
      async () => {
        const layout = await window.evaluate(() => {
          const composer = document.querySelector<HTMLElement>(".composer__surface");
          const timeline = document.querySelector<HTMLElement>('[data-testid="timeline-pane"]');
          if (!composer || !timeline) {
            return "";
          }
          return [
            composer.getBoundingClientRect().height,
            timeline.getBoundingClientRect().height,
            timeline.clientHeight,
            timeline.scrollHeight,
          ].join(":");
        });
        const stable = Boolean(layout) && layout === previousLayout;
        previousLayout = layout;
        return stable;
      },
      {
        intervals: [50, 100, 250],
        message: `wait for selected session ${target.sessionId} layout to settle`,
        timeout,
      },
    )
    .toBe(true);
}

export interface TimelineScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly remainingFromBottom: number;
}

export async function getTimelineScrollMetrics(window: Page): Promise<TimelineScrollMetrics> {
  return window.evaluate(() => {
    const pane = document.querySelector<HTMLDivElement>("[data-testid='timeline-pane']");
    if (!pane) {
      throw new Error("Timeline pane was unavailable");
    }

    return {
      scrollTop: pane.scrollTop,
      scrollHeight: pane.scrollHeight,
      clientHeight: pane.clientHeight,
      remainingFromBottom: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
    };
  });
}

export async function jumpTimelineToBottom(window: Page): Promise<void> {
  await window.evaluate(() => {
    const pane = document.querySelector<HTMLDivElement>("[data-testid='timeline-pane']");
    if (!pane) {
      throw new Error("Timeline pane was unavailable");
    }
    pane.scrollTop = pane.scrollHeight;
    pane.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

export async function scrollTimelineAwayFromBottom(window: Page, pixels = 160): Promise<void> {
  const minimumRemainingFromBottom = Math.min(500, Math.max(1, pixels * 0.5));
  await expect
    .poll(async () =>
      window.evaluate(
        async ({ distance, minimumRemaining }) => {
          const pane = document.querySelector<HTMLDivElement>("[data-testid='timeline-pane']");
          if (!pane) {
            throw new Error("Timeline pane was unavailable");
          }

          const maxScrollTop = pane.scrollHeight - pane.clientHeight;
          if (maxScrollTop <= minimumRemaining) {
            return maxScrollTop;
          }

          pane.dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -distance }),
          );
          pane.scrollTop = Math.max(0, maxScrollTop - distance);
          pane.dispatchEvent(new Event("scroll", { bubbles: true }));
          await new Promise<void>((resolve) => {
            globalThis.window.requestAnimationFrame(() => {
              globalThis.window.requestAnimationFrame(() => resolve());
            });
          });
          return pane.scrollHeight - pane.scrollTop - pane.clientHeight;
        },
        { distance: pixels, minimumRemaining: minimumRemainingFromBottom },
      ),
    )
    .toBeGreaterThan(minimumRemainingFromBottom);
}

export interface OrchestrationRuntimeToolTestInput {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly sessionRef: SessionRef;
  readonly params: unknown;
}

export interface OrchestrationRuntimeToolTestResult {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly details?: Readonly<Record<string, unknown>>;
}

export async function runOrchestrationRuntimeTool(
  harness: DesktopHarness,
  input: OrchestrationRuntimeToolTestInput,
): Promise<OrchestrationRuntimeToolTestResult> {
  await harness.firstWindow();
  return harness.electronApp.evaluate(async (_, payload) => {
    const hooks = (
      globalThis as {
        __PI_APP_TEST_HOOKS?: {
          runOrchestrationRuntimeTool?: (
            input: OrchestrationRuntimeToolTestInput,
          ) => Promise<OrchestrationRuntimeToolTestResult>;
        };
      }
    ).__PI_APP_TEST_HOOKS;
    if (!hooks?.runOrchestrationRuntimeTool) {
      throw new Error("Orchestration runtime-tool hook is unavailable");
    }
    return hooks.runOrchestrationRuntimeTool(payload);
  }, input);
}

export async function runScheduledTaskRuntimeTool(
  harness: DesktopHarness,
  input: OrchestrationRuntimeToolTestInput,
): Promise<OrchestrationRuntimeToolTestResult> {
  await harness.firstWindow();
  return harness.electronApp.evaluate(async (_, payload) => {
    const hooks = (
      globalThis as {
        __PI_APP_TEST_HOOKS?: {
          runScheduledTaskRuntimeTool?: (
            input: OrchestrationRuntimeToolTestInput,
          ) => Promise<OrchestrationRuntimeToolTestResult>;
        };
      }
    ).__PI_APP_TEST_HOOKS;
    if (!hooks?.runScheduledTaskRuntimeTool) {
      throw new Error("Scheduled-task runtime-tool hook is unavailable");
    }
    return hooks.runScheduledTaskRuntimeTool(payload);
  }, input);
}

export async function fireDueScheduledTasks(
  harness: DesktopHarness,
  nowIso?: string,
): Promise<DesktopAppState> {
  await harness.firstWindow();
  return harness.electronApp.evaluate(async (_, payload) => {
    const hooks = (
      globalThis as {
        __PI_APP_TEST_HOOKS?: {
          fireDueScheduledTasks?: (nowIso?: string) => Promise<DesktopAppState>;
        };
      }
    ).__PI_APP_TEST_HOOKS;
    if (!hooks?.fireDueScheduledTasks) {
      throw new Error("Scheduled-task fire hook is unavailable");
    }
    return hooks.fireDueScheduledTasks(payload);
  }, nowIso);
}

export async function emitTestSessionEvent(
  harness: DesktopHarness,
  event: SessionDriverEvent,
): Promise<void> {
  await emitTestSessionEvents(harness, [event]);
}

export async function emitTestSessionEvents(
  harness: DesktopHarness,
  events: readonly SessionDriverEvent[],
): Promise<void> {
  await harness.electronApp.evaluate(async (_, payloads) => {
    const hooks = (
      globalThis as {
        __PI_APP_TEST_HOOKS?: { emitSessionEvent?: (event: SessionDriverEvent) => Promise<void> };
      }
    ).__PI_APP_TEST_HOOKS;
    if (!hooks?.emitSessionEvent) {
      throw new Error("Test session-event hook is unavailable");
    }
    for (const payload of payloads) {
      await hooks.emitSessionEvent(payload);
    }
  }, events);
}

/**
 * Deterministically drive the main-process window-activation path (the same one
 * the real `focus` event fires), so a test can assert the focus reconcile without
 * depending on flaky native focus stealing.
 */
export async function triggerWindowActivation(harness: DesktopHarness): Promise<void> {
  await harness.electronApp.evaluate(async () => {
    const hooks = (
      globalThis as {
        __PI_APP_TEST_HOOKS?: { handleWindowActivation?: () => void };
      }
    ).__PI_APP_TEST_HOOKS;
    if (!hooks?.handleWindowActivation) {
      throw new Error("Window-activation hook is unavailable");
    }
    hooks.handleWindowActivation();
  });
}

export async function setDeferredThreadTitleMode(harness: DesktopHarness): Promise<void> {
  await harness.electronApp.evaluate(() => {
    const hooks = (
      globalThis as {
        __PI_APP_TEST_HOOKS?: { setDeferredThreadTitleMode?: () => void };
      }
    ).__PI_APP_TEST_HOOKS;
    if (!hooks?.setDeferredThreadTitleMode) {
      throw new Error("Deferred thread-title hook is unavailable");
    }
    hooks.setDeferredThreadTitleMode();
  });
}

export async function waitForDeferredThreadTitleRequest(
  harness: DesktopHarness,
  timeout = 15_000,
): Promise<void> {
  await expect
    .poll(
      async () =>
        harness.electronApp.evaluate(() => {
          const hooks = (
            globalThis as {
              __PI_APP_TEST_HOOKS?: { hasDeferredThreadTitle?: () => boolean };
            }
          ).__PI_APP_TEST_HOOKS;
          if (!hooks?.hasDeferredThreadTitle) {
            throw new Error("Deferred thread-title hook is unavailable");
          }
          return hooks.hasDeferredThreadTitle();
        }),
      { timeout },
    )
    .toBe(true);
}

export async function resolveDeferredThreadTitleEventually(
  harness: DesktopHarness,
  title: string,
  timeout = 15_000,
): Promise<void> {
  let resolved = false;
  await expect
    .poll(
      async () => {
        if (resolved) {
          return "resolved";
        }
        try {
          await resolveDeferredThreadTitle(harness, title);
          resolved = true;
          return "resolved";
        } catch (error) {
          if (String(error).includes("Deferred thread-title request is unavailable")) {
            return "pending";
          }
          throw error;
        }
      },
      { timeout },
    )
    .toBe("resolved");
}

// This hook is synchronous. Do not create a transient Promise in Electron's
// inspector context just to acknowledge it (Playwright #33737 / #41826).
export async function resolveDeferredThreadTitle(
  harness: DesktopHarness,
  title: string,
): Promise<void> {
  await harness.electronApp.evaluate((_, nextTitle) => {
    const hooks = (
      globalThis as {
        __PI_APP_TEST_HOOKS?: { resolveDeferredThreadTitle?: (title: string) => void };
      }
    ).__PI_APP_TEST_HOOKS;
    if (!hooks?.resolveDeferredThreadTitle) {
      throw new Error("Deferred thread-title resolve hook is unavailable");
    }
    hooks.resolveDeferredThreadTitle(nextTitle);
  }, title);
}

export async function rejectDeferredThreadTitle(harness: DesktopHarness): Promise<void> {
  await harness.electronApp.evaluate(() => {
    const hooks = (
      globalThis as {
        __PI_APP_TEST_HOOKS?: { rejectDeferredThreadTitle?: () => void };
      }
    ).__PI_APP_TEST_HOOKS;
    if (!hooks?.rejectDeferredThreadTitle) {
      throw new Error("Deferred thread-title reject hook is unavailable");
    }
    hooks.rejectDeferredThreadTitle();
  });
}

export async function seedTranscriptMessages(
  harness: DesktopHarness,
  window: Page,
  options: {
    readonly count: number;
    readonly textFactory?: (index: number) => string;
  },
): Promise<{ readonly sessionRef: SessionRef; readonly messages: readonly string[] }> {
  const state = await getDesktopState(window);
  const selectedWorkspace = state.workspaces.find(
    (workspace) => workspace.id === state.selectedWorkspaceId,
  );
  const selectedSession = selectedWorkspace?.sessions.find(
    (session) => session.id === state.selectedSessionId,
  );
  assertExists(selectedWorkspace, "Expected selected workspace while seeding transcript");
  assertExists(selectedSession, "Expected selected session while seeding transcript");

  const sessionRef = {
    workspaceId: selectedWorkspace.id,
    sessionId: selectedSession.id,
  } satisfies SessionRef;
  const workspace = {
    workspaceId: selectedWorkspace.id,
    path: selectedWorkspace.path,
    displayName: selectedWorkspace.name,
  };
  const messages = Array.from({ length: options.count }, (_, index) =>
    options.textFactory ? options.textFactory(index) : `seeded transcript row ${index}`,
  );

  for (const [index, text] of messages.entries()) {
    const startedAt = new Date(Date.now() + index * 2_000).toISOString();
    const completedAt = new Date(Date.now() + index * 2_000 + 1_000).toISOString();
    const runId = `test-run-${index}`;

    await emitTestSessionEvent(harness, {
      type: "sessionUpdated",
      sessionRef,
      timestamp: startedAt,
      runId,
      snapshot: {
        ref: sessionRef,
        workspace,
        title: selectedSession.title,
        status: "running",
        updatedAt: startedAt,
        preview: text,
        runningRunId: runId,
      },
    });
    await emitTestSessionEvent(harness, {
      type: "assistantDelta",
      sessionRef,
      timestamp: startedAt,
      runId,
      text,
    });
    await emitSuccessfulRunCompletion(harness, {
      sessionRef,
      workspace,
      title: selectedSession.title,
      runId,
      completedAt,
      preview: text,
    });
  }

  return { sessionRef, messages };
}

export async function streamAssistantDeltas(
  harness: DesktopHarness,
  window: Page,
  chunks: readonly string[],
  runId = `stream-run-${Date.now()}`,
): Promise<{ readonly sessionRef: SessionRef; readonly fullText: string }> {
  const state = await getDesktopState(window);
  const selectedWorkspace = state.workspaces.find(
    (workspace) => workspace.id === state.selectedWorkspaceId,
  );
  const selectedSession = selectedWorkspace?.sessions.find(
    (session) => session.id === state.selectedSessionId,
  );
  assertExists(selectedWorkspace, "Expected selected workspace while streaming transcript");
  assertExists(selectedSession, "Expected selected session while streaming transcript");

  const sessionRef = {
    workspaceId: selectedWorkspace.id,
    sessionId: selectedSession.id,
  } satisfies SessionRef;
  const workspace = {
    workspaceId: selectedWorkspace.id,
    path: selectedWorkspace.path,
    displayName: selectedWorkspace.name,
  };
  const startedAt = new Date().toISOString();
  const completedAt = new Date(Date.now() + chunks.length * 1_000 + 1_000).toISOString();
  const fullText = chunks.join("");

  await emitTestSessionEvent(harness, {
    type: "sessionUpdated",
    sessionRef,
    timestamp: startedAt,
    runId,
    snapshot: {
      ref: sessionRef,
      workspace,
      title: selectedSession.title,
      status: "running",
      updatedAt: startedAt,
      preview: fullText,
      runningRunId: runId,
    },
  });

  for (const [index, chunk] of chunks.entries()) {
    await emitTestSessionEvent(harness, {
      type: "assistantDelta",
      sessionRef,
      timestamp: new Date(Date.now() + index * 1_000).toISOString(),
      runId,
      text: chunk,
    });
  }

  await emitSuccessfulRunCompletion(harness, {
    sessionRef,
    workspace,
    title: selectedSession.title,
    runId,
    completedAt,
    preview: fullText,
  });

  return { sessionRef, fullText };
}

async function emitSuccessfulRunCompletion(
  harness: DesktopHarness,
  options: {
    readonly sessionRef: SessionRef;
    readonly workspace: {
      readonly workspaceId: string;
      readonly path: string;
      readonly displayName: string;
    };
    readonly title: string;
    readonly runId: string;
    readonly completedAt: string;
    readonly preview: string;
  },
): Promise<void> {
  const { completedAt, preview, runId, sessionRef, title, workspace } = options;

  await emitTestSessionEvent(harness, {
    type: "runCompleted",
    sessionRef,
    timestamp: completedAt,
    runId,
    snapshot: {
      ref: sessionRef,
      workspace,
      title,
      status: "idle",
      updatedAt: completedAt,
      preview,
    },
  });
}

export function persistedSessionDataPaths(
  userDataDir: string,
  sessionRef: SessionRef,
): {
  transcriptPath: string;
  attachmentPath: string;
  encodedSessionKey: string;
  rawSessionKey: string;
} {
  const rawSessionKey = `${sessionRef.workspaceId}:${sessionRef.sessionId}`;
  const encodedSessionKey = encodeURIComponent(rawSessionKey);
  return {
    transcriptPath: join(userDataDir, "transcripts", `${encodedSessionKey}.json`),
    attachmentPath: join(userDataDir, "attachments", `${encodedSessionKey}.json`),
    encodedSessionKey,
    rawSessionKey,
  };
}

export function assertExists<T>(value: T | undefined | null, message: string): asserts value is T {
  if (value == null) {
    throw new Error(message);
  }
}

export async function waitForWorkspaceByPath(
  window: Page,
  workspacePath: string,
  timeout = 15_000,
): Promise<WorkspaceRecord> {
  await expect
    .poll(
      async () => {
        const state = await getDesktopState(window);
        return state.workspaces.find((workspace) => workspace.path === workspacePath) ?? null;
      },
      { timeout },
    )
    .not.toBeNull();

  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) => entry.path === workspacePath);
  assertExists(workspace, `Expected workspace for path ${workspacePath}`);
  return workspace;
}

export async function addWorkspaceViaIpc(window: Page, workspacePath: string): Promise<void> {
  await window.evaluate(async (pathValue) => {
    const app = globalThis.window.piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    await app.addWorkspacePath(pathValue);
  }, workspacePath);
}

export async function waitForSessionByTitle(
  window: Page,
  workspaceId: string,
  title: string,
  timeout = 15_000,
): Promise<SessionRecord> {
  await expect
    .poll(
      async () => {
        const state = await getDesktopState(window);
        const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
        return (
          workspace?.sessions.find(
            (session) => session.title === title || stripLancerZonePrefix(session.title) === title,
          ) ?? null
        );
      },
      { timeout },
    )
    .not.toBeNull();

  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
  const session = workspace?.sessions.find(
    (entry) => entry.title === title || stripLancerZonePrefix(entry.title) === title,
  );
  assertExists(session, `Expected session ${title}`);
  return session;
}

export async function selectSession(window: Page, sessionTitle: string): Promise<void> {
  await clickSession(window, sessionTitle);
  const header = window.locator('[data-testid="thread-title"], .chat-header__title');
  const transcript = window.getByTestId("transcript");
  const composer = window.getByTestId("composer");
  await expect
    .poll(
      async () =>
        (await header.count()) > 0 ||
        (await transcript.count()) > 0 ||
        (await composer.count()) > 0,
      { timeout: 10_000 },
    )
    .toBe(true);
  if ((await header.count()) > 0) {
    await expect(header).toHaveText(sessionTitle);
    return;
  }
  if ((await transcript.count()) > 0) {
    await expect(transcript).toBeVisible();
    return;
  }
  await expect(composer).toBeVisible();
}

/**
 * Waits until transcript rows stop moving. Rows are placed from estimates and move once
 * measured; a click whose press and release straddle that move is lost without an error.
 * A resize (such as opening the side panel) reaches the timeline only after the next
 * layout, so let one full frame run before reading the state.
 */
export async function waitForTimelineLayout(window: Page): Promise<void> {
  await window.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(window.getByTestId("timeline-pane")).toHaveAttribute("data-layout", "settled");
}

export async function selectSidePanel(
  window: Page,
  choice: "Files" | "Review" | "Terminal",
): Promise<void> {
  const workbench = window.getByTestId("workbench");
  if (!(await workbench.isVisible())) {
    await window.getByTestId("toggle-side-panel").click();
  }
  const existing = workbench.getByRole("tab", { name: choice, exact: true });
  if (await existing.count()) {
    await existing.click();
  } else {
    const chooser = window.getByTestId("workbench-chooser");
    if (!(await chooser.isVisible())) {
      await window.getByTestId("workbench-add-tab").click();
    }
    await chooser.getByRole("button", { name: choice, exact: true }).click();
  }
  await expect(existing).toHaveAttribute("aria-selected", "true");
}

export type ReviewScopeLabel =
  "Last Turn" | "Selected Turn" | "Uncommitted" | "Unstaged" | "Staged" | "Branch";

/** Chooses a comparison from the Review panel's scope menu. */
export async function chooseReviewScope(window: Page, scope: ReviewScopeLabel): Promise<void> {
  await window.getByRole("button", { name: "Review scope", exact: true }).click();
  await window
    .getByRole("menu", { name: "Review scope", exact: true })
    .getByRole("menuitemradio", { name: scope, exact: true })
    .click();
  await expect(reviewScopeButton(window)).toHaveText(scope);
}

/** Opens the Review "…" menu, which lists checkouts and the resolved comparison. */
export async function openReviewOptions(window: Page) {
  await window.getByRole("button", { name: "Review options", exact: true }).click();
  return window.getByRole("menu", { name: "Review options", exact: true });
}

export async function chooseReviewCheckout(window: Page, checkoutId: string): Promise<void> {
  const menu = await openReviewOptions(window);
  await menu.locator(`[role="menuitemradio"][data-option-id="${checkoutId}"]`).click();
}

/** The resolved comparison shown at the top of the Review "…" menu; press Escape to close. */
export async function reviewComparisonIdentity(window: Page) {
  return (await openReviewOptions(window)).getByTestId("review-comparison-identity");
}

export function reviewScopeButton(window: Page) {
  return window.getByRole("button", { name: "Review scope", exact: true });
}

export async function clickSession(window: Page, sessionTitle: string): Promise<void> {
  const row = window
    .locator(
      '[data-testid="process-session-row"], .lancer-zone-sidebar__row, .session-row__select',
      {
        hasText: sessionTitle,
      },
    )
    .first();
  // Cross-module navigation uses the same searchable command palette as users.
  if (!(await row.isVisible())) {
    await window.keyboard.press(desktopShortcut("K"));
    const palette = window.getByTestId("command-palette");
    await expect(palette).toBeVisible();
    await window.getByTestId("command-palette-input").fill(sessionTitle);
    await palette
      .locator('[role="group"][aria-labelledby$="-section-chats"]')
      .getByRole("option")
      .filter({ hasText: sessionTitle })
      .first()
      .click();
    await expect(palette).toHaveCount(0);
  }
  await expect(row).toBeVisible();
  await row.click();
}

export async function setThreadPinned(window: Page, title: string, pinned: boolean): Promise<void> {
  const row = window.locator(".lst > .session-row", { hasText: title });
  await row.click({ button: "right" });
  await window
    .getByRole("menu")
    .getByRole("button", { name: pinned ? "Pin thread" : "Unpin thread", exact: true })
    .click();
  await expect(row).toHaveAttribute("data-session-pinned", String(pinned));
}

export async function openNewThread(window: Page): Promise<void> {
  const composer = window.getByTestId("new-thread-composer");
  if (await composer.isVisible().catch(() => false)) {
    return;
  }
  const button = window
    .locator(".sidebar, .side")
    .getByRole("button", { name: "New thread", exact: true });
  await expect(button).toBeVisible({ timeout: 15_000 });
  await expect(button).toBeEnabled({ timeout: 15_000 });
  await button.click();
  await expect(composer).toBeVisible({ timeout: 15_000 });
}

/** Settings now live behind the workspace tools button/keyboard shortcut. */
export async function openSettingsSection(window: Page, section: string): Promise<void> {
  if (!(await window.getByTestId("settings-surface").isVisible())) {
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
  }
  if (section === "Extensions" || section === "Skills") {
    await window.getByRole("button", { name: "Skills and extensions", exact: true }).click();
    await window.getByRole("tab", { name: new RegExp(section) }).click();
  } else {
    await window.getByRole("button", { name: section, exact: true }).click();
  }
}

/** Scheduled work remains available from the global action palette. */
export async function openScheduledTasks(window: Page): Promise<void> {
  await window.keyboard.press(desktopShortcut("K"));
  const palette = window.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await window.getByTestId("command-palette-input").fill("Scheduled tasks");
  await palette.getByRole("option").filter({ hasText: "Scheduled tasks" }).click();
  await expect(window.getByTestId("scheduled-tasks-view")).toBeVisible();
}

export async function expectNewThreadWorkspace(window: Page, workspacePath: string): Promise<void> {
  const workspace = await waitForWorkspaceByPath(window, workspacePath);
  await expect(window.getByTestId("new-thread-composer")).toBeVisible({ timeout: 15_000 });
  await expect(window.getByRole("combobox", { name: "Workspace", exact: true })).toHaveValue(
    workspace.id,
  );
}

export async function startThreadFromSurface(
  window: Page,
  options: {
    readonly environment?: NewThreadEnvironment;
    readonly prompt?: string;
    readonly workspaceName?: string;
  } = {},
): Promise<void> {
  const { environment = "local", prompt = "Start thread", workspaceName } = options;

  await openNewThread(window);
  if (workspaceName) {
    await window.getByRole("combobox", { name: "Workspace", exact: true }).selectOption({
      label: workspaceName,
    });
  }
  if (environment === "worktree") {
    await window.getByRole("button", { name: "Worktree", exact: true }).click();
  } else {
    await window.getByRole("button", { name: "Local", exact: true }).click();
  }
  const startButton = window.getByRole("button", { name: "Start thread" });
  if (prompt) {
    await window.getByLabel("New thread prompt").fill(prompt);
  }
  await expect(startButton).toBeEnabled({ timeout: 15_000 });
  await startButton.click();
  await expect(window.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
  await expect(window.getByTestId("composer")).toBeFocused({ timeout: 15_000 });
}

export async function startThreadViaIpc(
  window: Page,
  options: {
    readonly environment?: NewThreadEnvironment;
    readonly prompt?: string;
    readonly provider?: string;
    readonly modelId?: string;
    readonly thinkingLevel?: string;
    readonly workspaceName?: string;
  } = {},
): Promise<void> {
  const {
    environment = "local",
    prompt = "Start thread",
    provider,
    modelId,
    thinkingLevel,
    workspaceName,
  } = options;

  const rootWorkspaceId = await window.evaluate(
    async ({ requestedWorkspaceName }) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }

      const state = await app.getState();
      const targetWorkspace = requestedWorkspaceName
        ? state.workspaces.find((workspace) => workspace.name === requestedWorkspaceName)
        : state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
      if (!targetWorkspace) {
        throw new Error(
          requestedWorkspaceName
            ? `Workspace not found: ${requestedWorkspaceName}`
            : "No selected workspace while starting thread",
        );
      }
      return targetWorkspace.rootWorkspaceId ?? targetWorkspace.id;
    },
    { requestedWorkspaceName: workspaceName },
  );

  await window.evaluate(
    async ({
      rootWorkspaceId,
      nextEnvironment,
      nextPrompt,
      nextProvider,
      nextModelId,
      nextThinkingLevel,
    }) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      await app.startThread({
        rootWorkspaceId,
        environment: nextEnvironment,
        prompt: nextPrompt,
        provider: nextProvider,
        modelId: nextModelId,
        thinkingLevel: nextThinkingLevel,
      });
    },
    {
      rootWorkspaceId,
      nextEnvironment: environment,
      nextPrompt: prompt,
      nextProvider: provider,
      nextModelId: modelId,
      nextThinkingLevel: thinkingLevel,
    },
  );
  await expect(window.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
}

export async function createNamedThread(
  window: Page,
  title: string,
  options: {
    readonly environment?: NewThreadEnvironment;
    readonly workspaceName?: string;
  } = {},
): Promise<void> {
  const { environment = "local", workspaceName } = options;
  if (environment !== "local") {
    await startThreadFromSurface(window, {
      environment,
      prompt: title,
      workspaceName,
    });
    return;
  }

  const targetWorkspaceId = await window.evaluate(
    ({ requestedWorkspaceName }) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      return app.getState().then((state) => {
        if (requestedWorkspaceName) {
          const namedWorkspace = state.workspaces.find(
            (workspace) => workspace.name === requestedWorkspaceName,
          );
          if (!namedWorkspace) {
            throw new Error(`Workspace not found: ${requestedWorkspaceName}`);
          }
          return namedWorkspace.id;
        }

        if (!state.selectedWorkspaceId) {
          throw new Error("No selected workspace");
        }

        return state.selectedWorkspaceId;
      });
    },
    { requestedWorkspaceName: workspaceName },
  );

  await createSessionViaIpc(window, targetWorkspaceId, title);
  await selectSession(window, title);
  const composer = window.getByTestId("composer");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();
  await expect(composer).toBeFocused({ timeout: 15_000 });
}

export async function chooseThreadGrouping(
  window: Page,
  grouping: "time" | "workspace",
): Promise<void> {
  const label = grouping === "time" ? "Time" : "Workspace";
  await window.getByRole("button", { name: "Customize Sidebar" }).click();
  await window.getByRole("menuitem", { name: "Grouping" }).click();
  await window.getByRole("menuitemradio", { name: label, exact: true }).click();
  await expectThreadGrouping(window, grouping);
}

export async function expectThreadGrouping(
  window: Page,
  grouping: "time" | "workspace",
): Promise<void> {
  const label = grouping === "time" ? "Time" : "Workspace";
  await window.getByRole("button", { name: "Customize Sidebar" }).click();
  await window.getByRole("menuitem", { name: "Grouping" }).click();
  await expect(window.getByRole("menuitemradio", { name: label, exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expectCompactGroupingMenu(window);
  await window.keyboard.press("Escape");
  await expect(window.getByRole("menu", { name: "Customize Sidebar" })).toBeHidden();
}

async function expectCompactGroupingMenu(window: Page): Promise<void> {
  const viewportWidth = await window.evaluate(() => document.documentElement.clientWidth);
  const submenu = window.getByRole("menu", { name: "Grouping" });
  const submenuBox = await submenu.boundingBox();
  const timeBox = await window
    .getByRole("menuitemradio", { name: "Time", exact: true })
    .boundingBox();
  expect(submenuBox, "Grouping submenu should be visible").not.toBeNull();
  expect(timeBox, "Time option should be visible").not.toBeNull();
  expect(
    submenuBox!.width,
    `Grouping submenu is ${submenuBox!.width}px in a ${viewportWidth}px window`,
  ).toBeLessThan(viewportWidth / 2);
  expect(submenuBox!.width).toBeLessThan(240);
  expect(timeBox!.width).toBeGreaterThan(submenuBox!.width * 0.7);
}

export async function createSessionViaIpc(
  window: Page,
  workspaceIdOrPath: string,
  title: string,
): Promise<void> {
  await window.evaluate(
    async ({ workspaceTarget, targetTitle }) => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const state = await app.getState();
        const workspace = state.workspaces.find(
          (entry) => entry.id === workspaceTarget || entry.path === workspaceTarget,
        );
        if (workspace) {
          await app.createSession({ workspaceId: workspace.id, title: targetTitle });
          return;
        }
        await new Promise((resolve) => globalThis.window.setTimeout(resolve, 100));
      }

      throw new Error(`Workspace not found: ${workspaceTarget}`);
    },
    { workspaceTarget: workspaceIdOrPath, targetTitle: title },
  );

  await expect(
    window
      .locator(
        '[data-testid="process-session-row"], .lancer-zone-sidebar__row, .session-row__select',
        { hasText: title },
      )
      .first(),
  ).toBeVisible({
    timeout: 15_000,
  });
}

export const HYDRATE_TEST_SENTINEL = "hydrate-test-sentinel-token=/private/secret-path";

export type IpcInvokeControlMode = "passthrough" | "reject" | "replace" | "record";

export interface IpcInvokeControlSnapshot {
  readonly mode: IpcInvokeControlMode;
  readonly invokeCount: number;
  readonly rejectCount: number;
  readonly sentinel: string;
}

export async function installIpcInvokeControl(
  harness: DesktopHarness,
  channel: string,
  options: {
    readonly mode: IpcInvokeControlMode;
    readonly sentinel?: string;
    readonly replacement?: unknown;
  },
): Promise<void> {
  await harness.electronApp.evaluate(
    ({ ipcMain }, payload) => {
      type InvokeHandler = (...args: unknown[]) => unknown;
      type Control = {
        mode: "passthrough" | "reject" | "replace" | "record";
        invokeCount: number;
        rejectCount: number;
        sentinel: string;
        replacement?: unknown;
        original: InvokeHandler;
      };
      const invokeHandlers = (
        ipcMain as typeof ipcMain & { readonly _invokeHandlers?: Map<string, InvokeHandler> }
      )._invokeHandlers;
      const originalHandler = invokeHandlers?.get(payload.channel);
      if (!originalHandler) {
        throw new Error(`No IPC handler registered for ${payload.channel}`);
      }

      const store = globalThis as typeof globalThis & {
        __PI_TEST_IPC_INVOKE_CONTROL__?: Record<string, Control>;
      };
      store.__PI_TEST_IPC_INVOKE_CONTROL__ ??= {};
      const existing = store.__PI_TEST_IPC_INVOKE_CONTROL__[payload.channel];
      if (existing) {
        existing.mode = payload.mode;
        existing.sentinel = payload.sentinel;
        existing.replacement = payload.replacement;
        return;
      }

      const control: Control = {
        mode: payload.mode,
        invokeCount: 0,
        rejectCount: 0,
        sentinel: payload.sentinel,
        replacement: payload.replacement,
        original: originalHandler,
      };
      store.__PI_TEST_IPC_INVOKE_CONTROL__[payload.channel] = control;

      ipcMain.removeHandler(payload.channel);
      ipcMain.handle(payload.channel, async (...args) => {
        control.invokeCount += 1;
        if (control.mode === "reject") {
          control.rejectCount += 1;
          throw new Error(control.sentinel);
        }
        if (control.mode === "replace") {
          return control.replacement;
        }
        if (control.mode === "record") {
          return undefined;
        }
        return control.original(...args);
      });
    },
    {
      channel,
      mode: options.mode,
      sentinel: options.sentinel ?? HYDRATE_TEST_SENTINEL,
      replacement: options.replacement,
    },
  );
}

export async function setIpcInvokeControl(
  harness: DesktopHarness,
  channel: string,
  patch: {
    readonly mode?: IpcInvokeControlMode;
    readonly replacement?: unknown;
  },
): Promise<void> {
  await harness.electronApp.evaluate(
    (_electron, payload) => {
      type Control = {
        mode: "passthrough" | "reject" | "replace" | "record";
        invokeCount: number;
        rejectCount: number;
        sentinel: string;
        replacement?: unknown;
      };
      const store = globalThis as typeof globalThis & {
        __PI_TEST_IPC_INVOKE_CONTROL__?: Record<string, Control>;
      };
      const control = store.__PI_TEST_IPC_INVOKE_CONTROL__?.[payload.channel];
      if (!control) {
        throw new Error(`No IPC invoke control installed for ${payload.channel}`);
      }
      if (payload.mode !== undefined) {
        control.mode = payload.mode;
      }
      if (payload.replacement !== undefined) {
        control.replacement = payload.replacement;
      }
    },
    { channel, mode: patch.mode, replacement: patch.replacement },
  );
}

export async function readIpcInvokeControl(
  harness: DesktopHarness,
  channel: string,
): Promise<IpcInvokeControlSnapshot> {
  return harness.electronApp.evaluate((_electron, targetChannel) => {
    type Control = {
      mode: "passthrough" | "reject" | "replace" | "record";
      invokeCount: number;
      rejectCount: number;
      sentinel: string;
    };
    const store = globalThis as typeof globalThis & {
      __PI_TEST_IPC_INVOKE_CONTROL__?: Record<string, Control>;
    };
    const control = store.__PI_TEST_IPC_INVOKE_CONTROL__?.[targetChannel];
    if (!control) {
      throw new Error(`No IPC invoke control installed for ${targetChannel}`);
    }
    return {
      mode: control.mode,
      invokeCount: control.invokeCount,
      rejectCount: control.rejectCount,
      sentinel: control.sentinel,
    };
  }, channel);
}

export async function reloadDesktopRenderer(window: Page): Promise<void> {
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(() => Boolean(globalThis.window.piApp), undefined, {
    timeout: 15_000,
  });
}

export async function rejectIpcInvokes(
  harness: DesktopHarness,
  channel: string,
  sentinel = HYDRATE_TEST_SENTINEL,
): Promise<void> {
  await installIpcInvokeControl(harness, channel, { mode: "reject", sentinel });
}
