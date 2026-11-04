import { runVideoLearnFiles } from "./video-learn/engine";
import { videoLearnSessionOptions } from "./video-learn/runtime-options";
import { DoubaoAppService } from "./doubao-app/service";
import { nativeDoubaoClient } from "./doubao-app/native-client";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  shell,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
} from "electron";
import { isValidHttpBaseUrl } from "@lancer/pi-sdk-driver";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type {
  AgentToolResult,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { constants as fsConstants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { augmentPosixPath } from "../scripts/augment-path.cjs";
import { DesktopAppStore } from "./application/app-store";
import { WindowOwner } from "./windows/window-owner";
import { createPiOrbWindow } from "./windows/pi-orb-window";
import { ControlService } from "./control/control-service";
import { ControlServer } from "./control/control-server";
import { TurnCheckpointStore } from "./workbench/checkpoint-store";
import {
  DesktopExtensionViewOwner,
  DESKTOP_EXTENSION_SCHEME,
} from "./extensions/extension-view-owner";
import { performExtensionViewHostAction } from "./extensions/extension-view-actions";
import { extensionFrameDocument } from "./extensions/extension-frame-document";
import { ReviewOwner } from "./workbench/review-owner";
import { registerDesktopIpc } from "./ipc/register-desktop-ipc";
import { startLocalApp } from "./local-app-launcher";
import {
  createOrchestrationRuntimeExtension,
  createOrchestrationRuntimeTools,
  type OrchestrationRuntimeBridge,
} from "./orchestration/orchestration-runtime";
import {
  createScheduledTaskRuntimeExtension,
  createScheduledTaskRuntimeTools,
  type ScheduledTaskRuntimeBridge,
} from "./scheduled-tasks/scheduled-task-runtime";
import { getChangedFiles, getFileDiff, stageFile } from "./platform/files/app-store-diff";
import { listWorkspaceFiles, readWorkspaceFile } from "./platform/files/app-store-files";
import { resolveExistingWorkspacePath } from "./platform/files/workspace-paths";
import { MAIN_DEV_RELOAD_MARKER } from "./dev-reload-main-probe";
import { NotificationManager } from "./platform/notification-manager";
import { NotificationPermissionService } from "./platform/notification-permission";
import {
  isLanguagePreference,
  localeFromLanguageTags,
  resolveLocale,
  setLocale,
  t,
  type Locale,
} from "../contracts/i18n";
import { ThemeManager } from "./platform/theme-manager";
import { windowBackgroundFor } from "../contracts/theme";
import { TerminalService } from "./platform/terminal-service";
import type { DesktopAppState, DesktopAppViewState } from "../contracts/desktop-state";
import {
  desktopCommands,
  desktopIpc,
  getDesktopCommandFromShortcut,
  isSinglePressCommand,
  isCloseFocusedSurfaceShortcut,
  getSidePanelTabCommand,
  platformShortcutModifier,
  type CustomProviderProbeInput,
  type CustomProviderProbeResult,
} from "../contracts/ipc";
import {
  assertComposerImageBytes,
  assertComposerImageFileSizes,
  assertComposerImagePixels,
  SUPPORTED_COMPOSER_IMAGE_TYPES,
  type ClipboardImageRead,
} from "../contracts/composer-attachments";
import type {
  ComposerAttachment,
  ComposerFileAttachment,
  ComposerImageAttachment,
} from "../contracts/desktop-state";
import type { SessionDriverEvent } from "@lancer/session-driver";
import type { GenerateThreadTitleOptions } from "@lancer/pi-sdk-driver";
import type { SessionRef, WorkspaceRef } from "@lancer/session-driver";

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_EXTENSION_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
const appTestMode = resolveAppTestMode(process.env.PI_APP_TEST_MODE);
const windowTestMode = appTestMode ?? "foreground";
const devReloadMarkersEnabled = process.env.PI_APP_DEV_RELOAD_MARKERS === "1";
const TURN_CAPTURE_BACKSTOP_MS = 10_000;
let store: DesktopAppStore;
let extensionViewOwner: DesktopExtensionViewOwner | undefined;
let windowOwner: WindowOwner;
const themeManager = new ThemeManager();
let mainWindow: BrowserWindow | null = null;
let notificationManager: NotificationManager | undefined;
let notificationPermissionService: NotificationPermissionService | undefined;
let terminalService: TerminalService | undefined;
let integratedTerminalShell = "";
let applicationRelaunchRequested = false;

function requestApplicationRelaunch(): void {
  if (applicationRelaunchRequested) {
    return;
  }
  applicationRelaunchRequested = true;
  app.relaunch();
  app.quit();
}

interface OrchestrationRuntimeToolTestInput {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly sessionRef: SessionRef;
  readonly params: unknown;
}

interface ScheduledTaskRuntimeToolTestInput {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly sessionRef: SessionRef;
  readonly params: unknown;
}

function createStoreBackedScheduledTaskRuntimeBridge(): ScheduledTaskRuntimeBridge {
  return {
    createScheduledTask: async (ctx, input) => {
      await store.initialize();
      return store.createScheduledTaskToolResult(sessionRefFromExtensionContext(ctx), input);
    },
    listScheduledTasks: async () => {
      await store.initialize();
      return store.listScheduledTasksToolResult();
    },
    updateScheduledTask: async (_ctx, input) => {
      await store.initialize();
      return store.updateScheduledTaskToolResult(input);
    },
  };
}

async function runScheduledTaskRuntimeToolForTest(
  bridge: ScheduledTaskRuntimeBridge,
  input: ScheduledTaskRuntimeToolTestInput,
): Promise<AgentToolResult<unknown>> {
  await store.initialize();
  const tool = createScheduledTaskRuntimeTools(bridge, () => input.sessionRef.workspaceId).find(
    (entry) => entry.name === input.toolName,
  );
  if (!tool) {
    throw new Error(`Unknown scheduled-task runtime tool: ${input.toolName}`);
  }
  return tool.execute(
    input.toolCallId ?? `test-${input.toolName}`,
    input.params,
    undefined,
    undefined,
    createTestExtensionContext(input.sessionRef),
  );
}

let stopNotifications: (() => void) | undefined;
let stopPruningTerminals: (() => void) | undefined;
let retainedTerminalWorkspacePathSignature = "";
const terminalFocusedWebContentsIds = new Set<number>();
const sidePanelFocusedWebContentsIds = new Set<number>();
const surfaceCloseShortcutIds = new Set<number>();
let quittingAfterStoreFlush = false;
let controlServer: ControlServer | undefined;
let stopControlSubscription: (() => void) | undefined;

const SUPPORTED_IMAGE_TYPES = SUPPORTED_COMPOSER_IMAGE_TYPES;
const SUPPORTED_IMAGE_MIME_TYPES = new Set<string>(
  SUPPORTED_IMAGE_TYPES.map((type) => type.mimeType),
);
const NEW_WINDOW_MENU_ITEM_ID = "file.new-window";

function createStoreBackedOrchestrationRuntimeBridge(): OrchestrationRuntimeBridge {
  return {
    createChildThread: async (ctx, input) => {
      await store.initialize();
      return store.createChildThreadToolResult(sessionRefFromExtensionContext(ctx), input);
    },
    listThreads: async (ctx) => {
      await store.initialize();
      return store.listThreadsToolResult(sessionRefFromExtensionContext(ctx));
    },
    readThread: async (ctx, threadId) => {
      await store.initialize();
      return store.readThreadToolResult(sessionRefFromExtensionContext(ctx), threadId);
    },
    sendMessageToThread: async (ctx, input) => {
      await store.initialize();
      return store.sendMessageToThreadToolResult(sessionRefFromExtensionContext(ctx), input);
    },
  };
}

function sessionRefFromExtensionContext(ctx: ExtensionContext): SessionRef {
  const sessionId = ctx.sessionManager.getSessionId();
  const cwd = path.resolve(ctx.sessionManager.getCwd?.() ?? ctx.cwd);
  const sessionRef = store.findSessionRefByCwdAndSessionId(cwd, sessionId);
  if (!sessionRef) {
    throw new Error(`Unable to resolve orchestration session for ${cwd}:${sessionId}`);
  }
  return sessionRef;
}

async function runOrchestrationRuntimeToolForTest(
  bridge: OrchestrationRuntimeBridge,
  input: OrchestrationRuntimeToolTestInput,
): Promise<AgentToolResult<unknown>> {
  await store.initialize();
  const tool = createOrchestrationRuntimeTools(bridge).find(
    (entry) => entry.name === input.toolName,
  );
  if (!tool) {
    throw new Error(`Unknown orchestration runtime tool: ${input.toolName}`);
  }
  return tool.execute(
    input.toolCallId ?? `test-${input.toolName}`,
    input.params,
    undefined,
    undefined,
    createTestExtensionContext(input.sessionRef),
  );
}

function createTestExtensionContext(sessionRef: SessionRef): ExtensionToolContext {
  const workspace = store
    .snapshot()
    .workspaces.find(
      (entry) =>
        entry.id === sessionRef.workspaceId &&
        entry.sessions.some((session) => session.id === sessionRef.sessionId),
    );
  if (!workspace) {
    throw new Error(`Unknown test session: ${sessionRef.workspaceId}:${sessionRef.sessionId}`);
  }

  return {
    hasUI: false,
    mode: "json",
    cwd: workspace.path,
    sessionManager: {
      getSessionId: () => sessionRef.sessionId,
      getCwd: () => workspace.path,
    } as ExtensionContext["sessionManager"],
    ui: {} as ExtensionContext["ui"],
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    scopedModels: [],
    model: undefined,
    signal: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
    tools: [],
    executeTool: async () =>
      ({
        isError: true,
        toolCall: {
          type: "toolCall",
          id: "nested-unavailable",
          name: "unavailable",
          arguments: {},
        },
        result: {
          content: [
            { type: "text", text: "Nested tool execution is unavailable in test context." },
          ],
        },
      }) as Awaited<ReturnType<ExtensionToolContext["executeTool"]>>,
  };
}
const OPEN_FOLDER_MENU_ITEM_ID = "file.open-folder";
const MODELS_AND_ACCOUNTS_MENU_ITEM_ID = "app.models-and-accounts";
const QUIT_FLUSH_TIMEOUT_MS = 5_000;

function getTerminalService(): TerminalService {
  if (!terminalService) {
    terminalService = new TerminalService({
      getWorkspacePath: (workspaceId) => store.getWorkspacePath(workspaceId),
      getIntegratedTerminalShell: () => integratedTerminalShell,
      isPackaged: app.isPackaged,
    });
  }
  return terminalService;
}

// Resolve the bundled application icon. In dev the repo's `resources/icon.png`
// sits two levels up from the compiled `out/main/main.js`; in a packaged build
// it is copied to `process.resourcesPath` via `extraResources` in
// electron-builder.yml. On macOS packaged builds the window/dock icon already
// comes from `icon.icns` in the app bundle, so we only need the PNG for dev
// and for Linux/Windows window chrome.
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.png")
  : path.join(__dirname, "..", "..", "resources", "icon.png");
const appIcon = nativeImage.createFromPath(appIconPath);

function parseExternalWebUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function appRendererUrl(): string {
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    return process.env.ELECTRON_RENDERER_URL;
  }
  const indexPath = path.join(__dirname, "..", "renderer", "index.html");
  return pathToFileURL(indexPath).toString();
}

function isInAppNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const appUrl = new URL(appRendererUrl());
    return parsed.href === appUrl.href || (isDev && parsed.origin === appUrl.origin);
  } catch {
    return false;
  }
}

function openExternalWebUrl(url: string): boolean {
  const parsed = parseExternalWebUrl(url);
  if (!parsed) {
    return false;
  }
  void shell.openExternal(parsed.toString()).catch((error) => {
    console.error(`Failed to open external URL: ${parsed.toString()}`, error);
  });
  return true;
}

function readClipboardImageAttachment(): ClipboardImageRead {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return { ok: false };
  }

  const size = image.getSize();
  try {
    assertComposerImagePixels(size.width, size.height);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const png = image.toPNG();
  if (png.length === 0) {
    return { ok: false };
  }
  try {
    assertComposerImageBytes(png.length);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    ok: true,
    attachment: {
      id: randomUUID(),
      kind: "image",
      name: "pasted-image.png",
      mimeType: "image/png",
      data: png.toString("base64"),
    },
  };
}

function dispatchCloseFocusedSurface(window: BrowserWindow, event: Electron.Event): void {
  event.preventDefault();
  const webContentsId = window.webContents.id;
  surfaceCloseShortcutIds.add(webContentsId);
  setImmediate(() => {
    surfaceCloseShortcutIds.delete(webContentsId);
  });
  window.webContents.send(desktopIpc.appCommand, desktopCommands.closeFocusedSurface);
}

// The native window colour matches the renderer's theme, so load, reload and
// resize never flash another theme's colour.
function currentWindowBackground(): string {
  return windowBackgroundFor(
    store?.snapshot().themePresetId ?? "default",
    themeManager.getResolvedTheme(),
  );
}

// Windows created transparent keep their glass until the next launch.
const opaqueAppWindows = new Set<BrowserWindow>();

function refreshWindowBackgrounds(): void {
  if (!store) return;
  const color = currentWindowBackground();
  for (const window of opaqueAppWindows) {
    if (!window.isDestroyed()) window.setBackgroundColor(color);
  }
}

function createWindow(): BrowserWindow {
  const backgroundTestMode = windowTestMode === "background";
  const enableTransparency = store ? store.snapshot().enableTransparency : false;
  const window = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 560,
    minHeight: 600,
    transparent: enableTransparency,
    vibrancy: process.platform === "darwin" && enableTransparency ? "under-window" : undefined,
    titleBarStyle: "hiddenInset",
    autoHideMenuBar: process.platform !== "darwin",
    backgroundColor: enableTransparency ? "#00000000" : currentWindowBackground(),
    // The 44px custom title strip is full-bleed. On macOS the overlay reports
    // the traffic-light group's right edge as env(titlebar-area-x).
    ...(process.platform === "darwin" ? { titleBarOverlay: { height: 44 } } : {}),
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep hidden test windows responsive so Playwright exercises the same UI flows.
      backgroundThrottling: !backgroundTestMode,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInAppNavigationUrl(url)) {
      openExternalWebUrl(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) return;
    try {
      const url = new URL(event.url);
      if (
        url.protocol !== `${DESKTOP_EXTENSION_SCHEME}:` ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("Unexpected frame navigation");
      if (!extensionViewOwner) throw new Error("Extension host unavailable");
      extensionViewOwner.getConnectionContext(url.hostname, window.webContents.id);
    } catch {
      event.preventDefault();
    }
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isInAppNavigationUrl(url)) {
      return;
    }
    event.preventDefault();
    openExternalWebUrl(url);
  });

  window.on("close", (event) => {
    if (!surfaceCloseShortcutIds.has(window.webContents.id)) {
      return;
    }
    event.preventDefault();
    surfaceCloseShortcutIds.delete(window.webContents.id);
  });
  window.once("ready-to-show", () => {
    if (!backgroundTestMode) {
      window.show();
    }
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") {
      return;
    }

    // Side panel tab chords act from the terminal and extension views too. The
    // key is not consumed: that would also swallow the modifier's keyup, leaving
    // the tab hints up, and on Windows and Linux it would let the Alt release
    // open the hidden menu bar. The page takes no default action for these keys,
    // and the renderer's own handling of the same keydown is idempotent.
    const sidePanelTabCommand = getSidePanelTabCommand(process.platform, input);
    if (sidePanelTabCommand) {
      if (!input.isAutoRepeat) window.webContents.send(desktopIpc.appCommand, sidePanelTabCommand);
      return;
    }

    const lowerKey = input.key.toLowerCase();
    const platformModifier = platformShortcutModifier(process.platform, input);
    const command = getDesktopCommandFromShortcut({
      modifier: platformModifier,
      alt: input.alt,
      shift: input.shift,
      key: input.key,
      code: input.code,
    });
    const webContentsId = window.webContents.id;
    const terminalFocused = terminalFocusedWebContentsIds.has(webContentsId);
    const closeFocusedSurface =
      isCloseFocusedSurfaceShortcut({
        meta: input.meta,
        control: input.control,
        alt: input.alt,
        shift: input.shift,
        key: input.key,
        code: input.code,
        platform: process.platform,
      }) &&
      (terminalFocused || sidePanelFocusedWebContentsIds.has(webContentsId));
    if (terminalFocused) {
      // Control chords belong to the shell, so only macOS Command chords open
      // a palette or act on the thread from the terminal.
      if (process.platform === "darwin" && isSinglePressCommand(command)) {
        event.preventDefault();
        if (!input.isAutoRepeat) window.webContents.send(desktopIpc.appCommand, command);
      } else if (command === desktopCommands.toggleSidePanel) {
        event.preventDefault();
        window.webContents.send(desktopIpc.appCommand, command);
      } else if (closeFocusedSurface) {
        dispatchCloseFocusedSurface(window, event);
      }
      return;
    }
    if (closeFocusedSurface) {
      dispatchCloseFocusedSurface(window, event);
      return;
    }
    if (platformModifier && input.shift && lowerKey === "n") {
      event.preventDefault();
      createAppWindow(windowOwner.viewForWindow(window));
      return;
    }

    if (platformModifier && !input.shift && lowerKey === "o") {
      event.preventDefault();
      void pickWorkspaceViaDialog(window).catch((error: unknown) => {
        console.error("[main] pickWorkspaceViaDialog failed", error);
      });
      return;
    }

    if (platformModifier && !input.shift && lowerKey === "v") {
      const clipboardImage = readClipboardImageAttachment();
      if (clipboardImage.ok || clipboardImage.message) {
        event.preventDefault();
        window.webContents.send(desktopIpc.clipboardImagePasted, clipboardImage);
        return;
      }
    }

    if (command) {
      event.preventDefault();
      // Holding a palette chord would open and close it at the repeat rate.
      if (isSinglePressCommand(command) && input.isAutoRepeat) {
        return;
      }
      window.webContents.send(desktopIpc.appCommand, command);
    }
  });

  if (isDev) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL as string).catch((error: unknown) => {
      console.error("[main] loadURL failed", error);
    });
    if (process.env.PI_APP_OPEN_DEVTOOLS !== "0") {
      window.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    void window.loadURL(appRendererUrl()).catch((error: unknown) => {
      console.error("[main] loadURL failed", error);
    });
  }

  if (!enableTransparency) {
    opaqueAppWindows.add(window);
    window.once("closed", () => opaqueAppWindows.delete(window));
  }

  return window;
}

function createAppWindow(sourceView?: DesktopAppViewState): BrowserWindow {
  const window = createWindow();
  const webContentsId = window.webContents.id;
  windowOwner.add(window, sourceView);
  themeManager.trackWindow(window);

  window.once("closed", () => {
    windowOwner.remove(window);
    terminalFocusedWebContentsIds.delete(webContentsId);
    sidePanelFocusedWebContentsIds.delete(webContentsId);
    surfaceCloseShortcutIds.delete(webContentsId);
    terminalService?.disposeWebContents(webContentsId);
    void store
      .cancelPendingDialogsWithoutVisibleWindow((sessionRef) =>
        windowOwner.isSessionVisibleInAnotherWindow(sessionRef),
      )
      .catch((error: unknown) => {
        console.error("[main] cancelPendingDialogsWithoutVisibleWindow failed", error);
      });
    if (windowOwner.size() === 0) {
      terminalService?.dispose();
      terminalService = undefined;
    }
  });

  return window;
}

function canPublishToWindow(window: BrowserWindow): boolean {
  return (
    !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed()
  );
}

function resolveAppTestMode(value: string | undefined): "foreground" | "background" | undefined {
  return value === "foreground" || value === "background" ? value : undefined;
}

function resolveDialogWindow(parentWindow?: BrowserWindow | null): BrowserWindow | undefined {
  return windowOwner.resolveDialogWindow(parentWindow);
}

async function stateForWindow(window?: BrowserWindow | null): Promise<DesktopAppState> {
  return windowOwner.stateForWindow(window);
}

function runWindowScopedForWindow(
  window: BrowserWindow | null | undefined,
  action: () => Promise<DesktopAppState>,
  options: { readonly forceActiveWindow?: boolean } = {},
): Promise<DesktopAppState> {
  return windowOwner.runStateAction(window, action, options);
}

async function pickWorkspacePathViaDialog(
  parentWindow?: BrowserWindow | null,
): Promise<string | undefined> {
  const window = resolveDialogWindow(parentWindow);
  const result = window
    ? await dialog.showOpenDialog(window, {
        properties: ["openDirectory"],
        title: t("dialog.openWorkspaceFolder"),
      })
    : await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: t("dialog.openWorkspaceFolder"),
      });
  if (result.canceled || result.filePaths.length === 0) {
    return undefined;
  }
  return result.filePaths[0] as string;
}

async function addPickedWorkspace(
  window: BrowserWindow | null | undefined,
  workspacePath: string,
): Promise<DesktopAppState> {
  const nextState = await store.addWorkspace(workspacePath);
  if (!nextState.selectedWorkspaceId) {
    return nextState;
  }
  const newThreadState =
    nextState.activeView === "new-thread" ? nextState : await store.setActiveView("new-thread");
  if (window) {
    window.webContents.send(desktopIpc.workspacePicked, nextState.selectedWorkspaceId);
  }
  return newThreadState;
}

async function pickWorkspaceViaDialog(
  parentWindow?: BrowserWindow | null,
): Promise<DesktopAppState> {
  const window = resolveDialogWindow(parentWindow);
  const workspacePath = await pickWorkspacePathViaDialog(window);
  if (!workspacePath) {
    return stateForWindow(window);
  }
  return runWindowScopedForWindow(window, () => addPickedWorkspace(window, workspacePath));
}

function sendAppCommand(command: (typeof desktopCommands)[keyof typeof desktopCommands]): void {
  const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
  window?.webContents.send(desktopIpc.appCommand, command);
}

function installApplicationMenu(): void {
  if (process.platform !== "darwin") {
    return;
  }

  const appName = app.name;
  const template: MenuItemConstructorOptions[] = [
    {
      label: appName,
      submenu: [
        { role: "about", label: t("menu.about", { appName }) },
        { type: "separator" },
        {
          label: t("menu.settings"),
          accelerator: "CommandOrControl+,",
          // The renderer owns Cmd+, so the menu only shows the hint.
          registerAccelerator: false,
          click: () => sendAppCommand(desktopCommands.openSettings),
        },
        {
          id: MODELS_AND_ACCOUNTS_MENU_ITEM_ID,
          label: t("menu.modelsAndAccounts"),
          click: () => sendAppCommand(desktopCommands.openModelsAndAccounts),
        },
        { type: "separator" },
        { role: "services", label: t("menu.services") },
        { type: "separator" },
        { role: "hide", label: t("menu.hide", { appName }) },
        { role: "hideOthers", label: t("menu.hideOthers") },
        { role: "unhide", label: t("menu.showAll") },
        { type: "separator" },
        { role: "quit", label: t("menu.quit", { appName }) },
      ],
    },
    {
      label: t("menu.file"),
      submenu: [
        {
          label: t("menu.newThread"),
          accelerator: "CommandOrControl+N",
          click: () => sendAppCommand(desktopCommands.openNewThread),
        },
        {
          id: NEW_WINDOW_MENU_ITEM_ID,
          label: t("menu.newWindow"),
          accelerator: "CommandOrControl+Shift+N",
          click: () => {
            createAppWindow(windowOwner.foregroundView());
          },
        },
        { type: "separator" },
        {
          id: OPEN_FOLDER_MENU_ITEM_ID,
          label: t("menu.openFolder"),
          accelerator: "Command+O",
          click: () => {
            void pickWorkspaceViaDialog(mainWindow).catch((error: unknown) => {
              console.error("[main] pickWorkspaceViaDialog failed", error);
            });
          },
        },
        { type: "separator" },
        { role: "close", label: t("menu.closeWindow") },
      ],
    },
    {
      label: t("menu.edit"),
      submenu: [
        { role: "undo", label: t("menu.undo") },
        { role: "redo", label: t("menu.redo") },
        { type: "separator" },
        { role: "cut", label: t("menu.cut") },
        { role: "copy", label: t("menu.copy") },
        { role: "paste", label: t("menu.paste") },
        { role: "pasteAndMatchStyle", label: t("menu.pasteAndMatchStyle") },
        { role: "delete", label: t("menu.delete") },
        { role: "selectAll", label: t("menu.selectAll") },
        { type: "separator" },
        {
          label: t("menu.speech"),
          submenu: [
            { role: "startSpeaking", label: t("menu.startSpeaking") },
            { role: "stopSpeaking", label: t("menu.stopSpeaking") },
          ],
        },
      ],
    },
    {
      label: t("menu.view"),
      submenu: [
        // Cmd+R toggles Review and Shift+Cmd+R renames the thread, so neither
        // reload has a shortcut.
        {
          label: t("menu.reload"),
          click: () => BrowserWindow.getFocusedWindow()?.webContents.reload(),
        },
        {
          label: t("menu.forceReload"),
          click: () => BrowserWindow.getFocusedWindow()?.webContents.reloadIgnoringCache(),
        },
        { role: "toggleDevTools", label: t("menu.toggleDevTools") },
        { type: "separator" },
        { role: "resetZoom", label: t("menu.actualSize") },
        { role: "zoomIn", label: t("menu.zoomIn") },
        { role: "zoomOut", label: t("menu.zoomOut") },
        { type: "separator" },
        { role: "togglefullscreen", label: t("menu.toggleFullScreen") },
      ],
    },
    {
      label: t("menu.window"),
      role: "window",
      submenu: [
        { role: "minimize", label: t("menu.minimize") },
        { role: "zoom", label: t("menu.zoom") },
        { type: "separator" },
        { role: "front", label: t("menu.front") },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function resolveSystemLocale(): Locale {
  if (process.env.PI_APP_TEST_MODE) {
    return "en";
  }
  const forced = process.env.LANCER_LOCALE?.trim();
  if (forced && isLanguagePreference(forced) && forced !== "system") {
    return forced;
  }
  return localeFromLanguageTags([...app.getPreferredSystemLanguages(), app.getLocale()]);
}

// Ensure npm (and other Homebrew/npm-global binaries) are available even when
// Lancer is launched via Finder/Dock (which hands the process a minimal PATH).
// POSIX-only; on Windows the PATH is left untouched (see augmentPosixPath).
const augmentedPath = augmentPosixPath();
if (augmentedPath.changed) {
  process.env.PATH = augmentedPath.path;
}

// The app name drives the userData dir, so Lancer keeps its UI state apart from pi-gui
// ("pi"). The pi agent config (~/.pi/agent) is resolved independently and stays shared.
app.setName("Lancer");

const configuredUserDataDir = process.env.PI_APP_USER_DATA_DIR?.trim() || app.getPath("userData");
app.setPath("userData", configuredUserDataDir);
importUpstreamWorkspaceCatalog(configuredUserDataDir);

/**
 * First launch only: reuse pi-gui's workspace list so existing folders and threads appear
 * without re-adding them. pi-gui keeps its UI data in "<appData>/pi"; nothing is moved.
 */
function importUpstreamWorkspaceCatalog(userDataDir: string): void {
  if (process.env.PI_APP_USER_DATA_DIR?.trim() || process.env.PI_APP_TEST_MODE) {
    return;
  }
  const target = path.join(userDataDir, "catalogs.json");
  const source = path.join(app.getPath("appData"), "pi", "catalogs.json");
  if (existsSync(target) || !existsSync(source)) {
    return;
  }
  try {
    mkdirSync(userDataDir, { recursive: true });
    copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
    console.info(`[main] imported pi-gui workspace catalog from ${source}`);
  } catch (error) {
    console.warn("[main] could not import the pi-gui workspace catalog", error);
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // app.quit() before ready can leave a windowless macOS process alive.
  // Duplicate instances have no store or windows, so exit immediately.
  app.exit(0);
}

app.on("second-instance", () => {
  const window = windowOwner.foreground();
  if (!window) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
});

app
  .whenReady()
  .then(async () => {
    if (!hasSingleInstanceLock) {
      return;
    }

    // Use the bundled brand for running apps too, avoiding a stale Dock icon
    // retained by macOS across in-place application updates.
    if (process.platform === "darwin") {
      app.dock?.setIcon(appIcon);
    }

    let generateThreadTitleOverride:
      | ((
          workspace: WorkspaceRef,
          options: GenerateThreadTitleOptions,
        ) => Promise<string | null | undefined>)
      | undefined;
    let deferredThreadTitle:
      | {
          resolve: (title: string | null) => void;
          reject: (error: Error) => void;
        }
      | undefined;
    const orchestrationRuntimeBridge = createStoreBackedOrchestrationRuntimeBridge();
    const scheduledTaskRuntimeBridge = createStoreBackedScheduledTaskRuntimeBridge();
    const checkpoints = new TurnCheckpointStore(configuredUserDataDir);
    const extensionViews: DesktopExtensionViewOwner = new DesktopExtensionViewOwner({
      frameDocument: extensionFrameDocument,
      hostAssets: {
        "frame-bridge.js": {
          body: await readFile(
            createRequire(__filename).resolve("@lancer/extension-ui/frame-bridge"),
            "utf8",
          ),
          contentType: "text/javascript; charset=utf-8",
        },
      },
      onHostAction: (context) =>
        performExtensionViewHostAction(
          { store, windows: windowOwner, views: extensionViews },
          context,
        ),
      onDiagnostic: (target, source, message) =>
        console.error("[extension-view]", target.sessionId, source, message),
    });
    extensionViewOwner = extensionViews;
    protocol.handle(DESKTOP_EXTENSION_SCHEME, (request) =>
      extensionViews.assetResponse(request.url),
    );
    const driverOptions: NonNullable<
      ConstructorParameters<typeof DesktopAppStore>[0]["driverOptions"]
    > = {
      onTurnCaptureBoundary: (boundary, signal) => checkpoints.recordBoundary(boundary, signal),
      // The store bounds each capture from when it starts; this only stops a stuck boundary,
      // including one waiting behind another run's capture in the same checkout.
      turnCaptureTimeoutMs: TURN_CAPTURE_BACKSTOP_MS,
      desktopExtensions: {
        onChanged: (runtime) => extensionViews.replaceRuntime(runtime),
        onInvalidated: ({ target, generation }) =>
          extensionViews.invalidateRuntime(target, generation),
      },
      builtinExtensions: [
        {
          name: "pi-gui-thread-orchestration",
          displayName: "Thread orchestration",
          description: "Lets Lancer start, read and message other threads",
          factory: createOrchestrationRuntimeExtension(orchestrationRuntimeBridge),
        },
        {
          name: "pi-gui-scheduled-tasks",
          displayName: "Scheduled tasks",
          description: "Lets Lancer create and update local scheduled tasks",
          factory: createScheduledTaskRuntimeExtension(scheduledTaskRuntimeBridge, (ctx) => {
            try {
              return sessionRefFromExtensionContext(ctx).workspaceId;
            } catch {
              return undefined;
            }
          }),
        },
      ],
    };
    const systemLocale = resolveSystemLocale();
    store = new DesktopAppStore({
      userDataDir: configuredUserDataDir,
      systemLocale,
      initialWorkspacePaths: resolveInitialWorkspacePaths(),
      getWindow: () => mainWindow,
      shouldKeepSessionDialogs: (sessionRef) =>
        windowOwner?.isSessionVisibleInAnotherWindow(sessionRef) ?? false,
      driverOptions,
      generateThreadTitleOverride: async (workspace, options) =>
        generateThreadTitleOverride?.(workspace, options),
    });
    windowOwner = new WindowOwner(store, {
      onActiveWindowChanged: (window) => {
        mainWindow = window;
        notificationManager?.trackWindow(window);
        notificationPermissionService?.trackWindow(window);
      },
    });
    await store.initialize();
    const controlService = new ControlService(store, async ({ cwd, model, name }) => {
      const fullPath = path.resolve(cwd);
      if (!(await stat(fullPath)).isDirectory()) throw new Error("cwd must be a directory");
      const window = windowOwner.foreground();
      const state = await windowOwner.runStateAction(window, async () => {
        if (!store.snapshot().localControlEnabled) throw new Error("Local control was disabled");
        let workspace = store
          .snapshot()
          .workspaces.find((entry) => path.resolve(entry.path) === fullPath);
        if (!workspace) {
          const added = await store.addWorkspace(fullPath);
          if (added.lastError) throw new Error(added.lastError);
          workspace = added.workspaces.find((entry) => path.resolve(entry.path) === fullPath);
        }
        if (!workspace) throw new Error("Unable to register workspace");
        const created = await store.createSession({ workspaceId: workspace.id, title: name });
        if (created.lastError) throw new Error(created.lastError);
        if (model) {
          const slash = model.indexOf("/");
          const configured = await store.setSessionModel(
            { workspaceId: created.selectedWorkspaceId, sessionId: created.selectedSessionId },
            model.slice(0, slash),
            model.slice(slash + 1),
          );
          if (configured.lastError) throw new Error(configured.lastError);
          return configured;
        }
        return created;
      });
      return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
    });
    controlServer = new ControlServer(configuredUserDataDir, (input) =>
      controlService.handle(input),
    );
    let controlEnabled = store.snapshot().localControlEnabled;
    await controlServer.setEnabled(controlEnabled).catch((error: unknown) => {
      console.error("[local-control] startup failed (desktop remains available)", error);
    });
    stopControlSubscription = store.subscribe((state) => {
      if (state.localControlEnabled === controlEnabled) return;
      controlEnabled = state.localControlEnabled;
      if (controlServer) {
        void controlServer.setEnabled(controlEnabled).catch((error: unknown) => {
          console.error("[local-control] settings update failed", error);
        });
      }
    });
    let menuLocale = resolveLocale(store.snapshot().language, systemLocale);
    setLocale(menuLocale);
    themeManager.setMode(store.snapshot().themeMode);
    integratedTerminalShell = (await store.getState()).integratedTerminalShell;
    nativeTheme.on("updated", refreshWindowBackgrounds);
    let windowBackgroundPresetId = store.snapshot().themePresetId;
    stopPruningTerminals = store.subscribe((state) => {
      integratedTerminalShell = state.integratedTerminalShell;
      const nextLocale = resolveLocale(state.language, state.systemLocale);
      if (nextLocale !== menuLocale) {
        menuLocale = nextLocale;
        setLocale(nextLocale);
        installApplicationMenu();
      }
      if (state.themePresetId !== windowBackgroundPresetId) {
        windowBackgroundPresetId = state.themePresetId;
        refreshWindowBackgrounds();
      }
      const workspacePaths = state.workspaces.map((workspace) => workspace.path);
      const workspacePathSignature = workspacePaths.join("\0");
      if (workspacePathSignature !== retainedTerminalWorkspacePathSignature) {
        retainedTerminalWorkspacePathSignature = workspacePathSignature;
        terminalService?.retainWorkspacePaths(workspacePaths);
      }
    });
    installApplicationMenu();
    if (process.env.PI_APP_TEST_MODE) {
      Object.assign(globalThis, {
        __PI_APP_TEST_HOOKS: {
          emitSessionEvent: (event: SessionDriverEvent) => store.emitTestSessionEvent(event),
          handleWindowActivation: () => {
            if (mainWindow) {
              windowOwner.activate(mainWindow);
            }
          },
          promptForText: (message: string, placeholder?: string, allowEmpty?: boolean) =>
            promptForText(mainWindow, message, placeholder ?? "", allowEmpty ?? false),
          runOrchestrationRuntimeTool: (input: OrchestrationRuntimeToolTestInput) =>
            runOrchestrationRuntimeToolForTest(orchestrationRuntimeBridge, input),
          runScheduledTaskRuntimeTool: (input: ScheduledTaskRuntimeToolTestInput) =>
            runScheduledTaskRuntimeToolForTest(scheduledTaskRuntimeBridge, input),
          fireDueScheduledTasks: (nowIso?: string) =>
            store.fireDueScheduledTasks(nowIso ? new Date(nowIso) : undefined),
          setDeferredThreadTitleMode: () => {
            generateThreadTitleOverride = () =>
              new Promise<string | null>((resolve, reject) => {
                deferredThreadTitle = { resolve, reject };
              });
          },
          hasDeferredThreadTitle: () => Boolean(deferredThreadTitle),
          resolveDeferredThreadTitle: (title: string) => {
            if (!deferredThreadTitle) {
              throw new Error("Deferred thread-title request is unavailable");
            }
            const pending = deferredThreadTitle;
            deferredThreadTitle = undefined;
            pending.resolve(title);
          },
          rejectDeferredThreadTitle: () => {
            if (!deferredThreadTitle) {
              throw new Error("Deferred thread-title request is unavailable");
            }
            const pending = deferredThreadTitle;
            deferredThreadTitle = undefined;
            pending.reject(new Error("Deferred thread-title rejected by test"));
          },
        },
      });
    }
    notificationPermissionService = new NotificationPermissionService(() => mainWindow);
    notificationPermissionService.subscribe((status) => {
      for (const window of windowOwner.allWindows()) {
        if (canPublishToWindow(window)) {
          window.webContents.send(desktopIpc.notificationPermissionStatusChanged, status);
        }
      }
    });
    notificationManager = new NotificationManager(
      store,
      () => mainWindow,
      notificationPermissionService,
      async (sessionRef) => {
        const window = windowOwner.foreground();
        await runWindowScopedForWindow(window, () => store.selectSession(sessionRef), {
          forceActiveWindow: true,
        });
      },
    );
    stopNotifications = notificationManager.start();

    registerDesktopIpc({
      windows: windowOwner,
      owners: {
        state: store,
        workbench: store,
        extensionViews,
        review: new ReviewOwner({
          checkpoints,
          userDataDir: app.getPath("userData"),
          resolveCheckoutPath: (checkoutId) => store.getWorkspacePath(checkoutId),
          validateTask: (target) =>
            store
              .snapshot()
              .workspaces.some(
                (workspace) =>
                  workspace.id === target.workspaceId &&
                  workspace.sessions.some((session) => session.id === target.sessionId),
              ),
        }),
        workspace: store,
        conversation: store,
        orchestration: store,
        scheduledTasks: store,
        settings: store,
      },
      capabilities: {
        doubaoApp: new DoubaoAppService({
          onVideoReceived: (target, video) => {
            const root = store.getWorkspacePath(target.workspaceId);
            if (root)
              void store
                .getState()
                .then((state) =>
                  runVideoLearnFiles(
                    root,
                    {
                      url: "",
                      localSource: video.path,
                      expectedSha256: video.sha256,
                      owner: { ...target, role: "watch" },
                    },
                    videoLearnSessionOptions(app.getPath("userData"), state, target),
                  ),
                )
                .catch(() => {
                  // Pipeline failures have their own gates; keep the received video available.
                  console.error("[video-learn] could not start received-video analysis");
                });
          },
          userDataDir: app.getPath("userData"),
          ...(!app.isPackaged &&
          process.env.PI_APP_TEST_MODE &&
          process.env.PI_APP_DOUBAO_HELPER_PATH
            ? { platform: "darwin" }
            : {}),
          native: nativeDoubaoClient(
            app.isPackaged
              ? path.join(process.resourcesPath, "..", "MacOS", "lancer-doubao-bridge")
              : process.env.PI_APP_TEST_MODE && process.env.PI_APP_DOUBAO_HELPER_PATH
                ? path.resolve(process.env.PI_APP_DOUBAO_HELPER_PATH)
                : path.join(app.getAppPath(), "build", "native", "lancer-doubao-bridge"),
          ),
          resolveWorkspace: (target) => {
            const workspace = store.snapshot().workspaces.find((w) => w.id === target.workspaceId);
            return workspace?.sessions.some((s) => s.id === target.sessionId)
              ? store.getWorkspacePath(target.workspaceId)
              : undefined;
          },
          openVideo: async (file) => {
            const error = await shell.openPath(file);
            if (error) throw new Error("E_OPEN_VIDEO");
          },
        }),
        ping: () =>
          devReloadMarkersEnabled
            ? `pi desktop ready:${MAIN_DEV_RELOAD_MARKER}`
            : "pi desktop ready",
        theme: themeManager,
        openExternal: async (url) => {
          const parsed = parseExternalWebUrl(url);
          if (!parsed) {
            throw new Error(`Refusing to open unsupported URL: ${url}`);
          }
          await shell.openExternal(parsed.toString());
        },
        launchLocalApp: async (appId) => startLocalApp(appId),
        pickWorkspace: (window) => pickWorkspaceViaDialog(window),
        createLoginCallbacks: (window) => createRuntimeLoginCallbacks(window),
        probeCustomProviderModels,
        notificationPermission: () => notificationPermissionService,
        terminal: getTerminalService,
        optionalTerminal: () => terminalService,
        setTerminalFocused: (webContentsId, focused) => {
          if (focused) {
            terminalFocusedWebContentsIds.add(webContentsId);
          } else {
            terminalFocusedWebContentsIds.delete(webContentsId);
          }
        },
        setSidePanelFocused: (webContentsId, focused) => {
          if (focused) {
            sidePanelFocusedWebContentsIds.add(webContentsId);
          } else {
            sidePanelFocusedWebContentsIds.delete(webContentsId);
          }
        },
        videoLearnHost: store,
        setTransparency: (enabled) => {
          if (process.platform !== "darwin") {
            return;
          }
          for (const window of windowOwner.allWindows()) {
            if (!window.isDestroyed()) {
              window.setVibrancy(enabled ? "under-window" : null);
            }
          }
        },
        pickComposerAttachments: async (window, existing = []) => {
          const parent = resolveDialogWindow(window);
          const result = parent
            ? await dialog.showOpenDialog(parent, {
                properties: ["openFile", "multiSelections"],
                title: t("dialog.attachFiles"),
              })
            : await dialog.showOpenDialog({
                properties: ["openFile", "multiSelections"],
                title: t("dialog.attachFiles"),
              });
          if (result.canceled || result.filePaths.length === 0) {
            return undefined;
          }
          return readComposerAttachmentsFromPaths(result.filePaths, existing);
        },
        readClipboardImage: readClipboardImageAttachment,
        validateComposerAttachments: (attachments) =>
          attachments.flatMap(validateComposerAttachmentPayload),
        listWorkspaceFiles,
        readWorkspaceFile,
        revealWorkspaceFile: async (workspacePath, filePath) => {
          const resolved = await resolveExistingWorkspacePath(workspacePath, filePath);
          shell.showItemInFolder(resolved);
        },
        getChangedFiles,
        getFileDiff,
        stageFile,
        relaunchApplication: requestApplicationRelaunch,
      },
    });

    createAppWindow();
    if (!appTestMode || process.env.PI_APP_TEST_ORB === "1") {
      createPiOrbWindow(store, controlService, async (sessionRef) => {
        const window = windowOwner.foreground() ?? createAppWindow();
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        await runWindowScopedForWindow(window, () => store.selectSession(sessionRef), {
          forceActiveWindow: true,
        });
      });
    }
    void notificationPermissionService.getCurrentStatus().catch((error: unknown) => {
      console.error("[main] getCurrentStatus failed", error);
    });

    app.on("activate", () => {
      // The floating assistant is not a workspace window. Closing the workspace
      // must not make a later Dock click unable to reopen it while the orb lives.
      if (windowOwner.size() === 0) {
        createAppWindow();
        if (notificationPermissionService) {
          void notificationPermissionService.getCurrentStatus().catch((error: unknown) => {
            console.error("[main] getCurrentStatus failed", error);
          });
        }
      }
    });
  })
  .catch((error: unknown) => {
    console.error("[main] Application startup failed", error);
    app.exit(1);
  });

app.on("window-all-closed", () => {
  // macOS normally keeps the app alive after its final window closes. The
  // Electron harness closes windows to end each isolated run, so let explicit
  // test-mode launches quit instead of leaving their process behind forever.
  if (process.platform !== "darwin" || appTestMode !== undefined) {
    stopNotifications?.();
    stopNotifications = undefined;
    notificationManager = undefined;
    notificationPermissionService?.dispose();
    notificationPermissionService = undefined;
    stopPruningTerminals?.();
    stopPruningTerminals = undefined;
    terminalService?.dispose();
    terminalService = undefined;
    app.quit();
  }
});

app.on("before-quit", (event) => {
  stopControlSubscription?.();
  stopControlSubscription = undefined;
  stopNotifications?.();
  stopNotifications = undefined;
  notificationManager = undefined;
  notificationPermissionService?.dispose();
  notificationPermissionService = undefined;
  stopPruningTerminals?.();
  stopPruningTerminals = undefined;
  terminalService?.dispose();
  terminalService = undefined;
  if (quittingAfterStoreFlush || !store) {
    return;
  }

  event.preventDefault();
  quittingAfterStoreFlush = true;
  const flush = Promise.all([
    store.flushPersistence(),
    extensionViewOwner?.dispose(),
    controlServer?.setEnabled(false),
  ]).catch((error) => {
    console.error("[main] persistence flush failed during quit:", error);
  });
  // Never let a hung flush block quit forever — quit after a bounded wait.
  const flushDeadline = new Promise<void>((resolve) => {
    setTimeout(() => {
      console.warn("[main] persistence flush timed out during quit; quitting anyway.");
      resolve();
    }, QUIT_FLUSH_TIMEOUT_MS);
  });
  void Promise.race([flush, flushDeadline])
    .finally(() => {
      app.quit();
    })
    .catch((error: unknown) => {
      console.error("[main] Quit after persistence flush failed", error);
    });
});

function resolveInitialWorkspacePaths(): readonly string[] {
  const raw = process.env.PI_APP_INITIAL_WORKSPACES;
  if (raw !== undefined) {
    return raw
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

async function readComposerAttachmentsFromPaths(
  filePaths: readonly string[],
  existing: readonly ComposerAttachment[] = [],
): Promise<ComposerAttachment[]> {
  const planned = filePaths.map((filePath) => ({
    filePath,
    mimeType: mimeTypeForPath(filePath),
  }));
  const imageSizes = await Promise.all(
    planned
      .filter((entry) => entry.mimeType.startsWith("image/"))
      .map(async (entry) => (await stat(entry.filePath)).size),
  );
  assertComposerImageFileSizes(imageSizes, existing);
  return Promise.all(planned.map((entry) => readComposerAttachment(entry.filePath)));
}

async function readComposerAttachment(filePath: string): Promise<ComposerAttachment> {
  const mimeType = mimeTypeForPath(filePath);
  if (mimeType.startsWith("image/")) {
    return readComposerImageAttachment(filePath, mimeType);
  }

  const stats = await stat(filePath);
  return {
    id: randomUUID(),
    kind: "file",
    name: path.basename(filePath),
    mimeType,
    fsPath: filePath,
    ...(typeof stats.size === "number" ? { sizeBytes: stats.size } : {}),
  };
}

async function readComposerImageAttachment(
  filePath: string,
  mimeType: string,
): Promise<ComposerImageAttachment> {
  const stats = await stat(filePath);
  assertComposerImageBytes(stats.size);
  const buffer = await readFile(filePath);
  assertComposerImageBytes(buffer.length);
  const image = nativeImage.createFromBuffer(buffer);
  if (!image.isEmpty()) {
    const size = image.getSize();
    assertComposerImagePixels(size.width, size.height);
  }
  return {
    id: randomUUID(),
    kind: "image",
    name: path.basename(filePath),
    mimeType,
    data: buffer.toString("base64"),
  };
}

function mimeTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const supported = SUPPORTED_IMAGE_TYPES.find((type) => type.extension === extension);
  if (supported) {
    return supported.mimeType;
  }
  return "application/octet-stream";
}

function validateComposerAttachmentPayload(attachment: ComposerAttachment): ComposerAttachment[] {
  if (attachment.kind === "image") {
    if (
      typeof attachment.data !== "string" ||
      typeof attachment.mimeType !== "string" ||
      !SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mimeType)
    ) {
      return [];
    }
    return [
      {
        ...attachment,
        kind: "image",
      },
    ];
  }

  if (
    attachment.kind !== "file" ||
    typeof attachment.fsPath !== "string" ||
    typeof attachment.mimeType !== "string" ||
    typeof attachment.name !== "string"
  ) {
    return [];
  }

  const normalized: ComposerFileAttachment = {
    ...attachment,
    kind: "file",
    fsPath: attachment.fsPath.trim(),
    name: attachment.name.trim() || path.basename(attachment.fsPath),
  };
  if (!normalized.fsPath) {
    return [];
  }
  return [normalized];
}

function createRuntimeLoginCallbacks(window?: BrowserWindow | null) {
  return {
    onAuth: async ({
      url,
      instructions,
    }: {
      readonly url: string;
      readonly instructions?: string;
    }) => {
      await shell.openExternal(url);
      if (instructions?.trim()) {
        await showLoginInstructions(window, instructions.trim());
      }
    },
    onPrompt: async ({
      message,
      placeholder,
      allowEmpty,
    }: {
      readonly message: string;
      readonly placeholder?: string;
      readonly allowEmpty?: boolean;
    }) => promptForText(window, message, placeholder, allowEmpty ?? false),
  };
}

/**
 * Device-code logins (e.g. xAI SuperGrok, Copilot) arrive as "Enter code: X\nExpires in N seconds."
 * from the driver; rewrite that into the UI language and copy the code for pasting.
 */
function localizeLoginInstructions(message: string): { text: string; code?: string } {
  const codeMatch = /^Enter code:\s*(\S+)\s*$/m.exec(message);
  if (!codeMatch?.[1]) {
    return { text: message };
  }
  const code = codeMatch[1];
  const expiresMatch = /^Expires in (\d+) seconds\.\s*$/m.exec(message);
  const lines = [t("login.enterCode", { code })];
  if (expiresMatch?.[1]) {
    lines.push(t("login.expiresIn", { seconds: expiresMatch[1] }));
  }
  lines.push(t("login.codeCopied"));
  return { text: lines.join("\n"), code };
}

async function showLoginInstructions(
  parentWindow: BrowserWindow | null | undefined,
  message: string,
): Promise<void> {
  const window = resolveDialogWindow(parentWindow);
  if (!window) {
    throw new Error("Main window is not available for login instructions.");
  }
  window.show();
  window.focus();
  const { text, code } = localizeLoginInstructions(message);
  if (code) {
    clipboard.writeText(code);
  }
  const options: MessageBoxOptions = {
    type: "info",
    title: t("login.title"),
    message: t("login.openedBrowser"),
    detail: text,
    buttons: [t("common.ok")],
  };
  await dialog.showMessageBox(window, options);
}

// Electron does not implement window.prompt(), so provider-login text prompts
// are served by a small dedicated modal window instead.
async function promptForText(
  parentWindow: BrowserWindow | null | undefined,
  message: string,
  placeholder = "",
  allowEmpty = false,
): Promise<string> {
  const parent = resolveDialogWindow(parentWindow);
  if (!parent) {
    throw new Error("Main window is not available for login.");
  }
  parent.show();
  parent.focus();

  const modal = new BrowserWindow({
    parent,
    modal: true,
    show: false,
    width: 460,
    height: 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: process.platform !== "darwin",
    title: app.name,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });

  try {
    await modal.loadURL(promptDataUrl(message, placeholder));
    modal.show();
    modal.focus();

    const result = await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      // Closing the window (title-bar close) counts as a cancel.
      modal.once("closed", () => finish(null));
      // The page wires its own buttons on load and exposes the outcome as a
      // promise; awaiting it here avoids any handler-attachment race.
      modal.webContents
        .executeJavaScript("window.__piPromptResult", true)
        .then((value) => finish(typeof value === "string" ? value : null))
        .catch(() => finish(null));
    });

    if (result === null) {
      throw new Error("Login cancelled.");
    }
    const trimmedResult = result.trim();
    if (!allowEmpty && trimmedResult.length === 0) {
      throw new Error("Login cancelled.");
    }
    return trimmedResult;
  } finally {
    if (!modal.isDestroyed()) {
      modal.destroy();
    }
  }
}

function promptDataUrl(message: string, placeholder: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 18px 20px; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #f4f5f7; color: #1b1d22; display: flex; flex-direction: column; gap: 14px; height: 100vh; }
  @media (prefers-color-scheme: dark) { body { background: #23262d; color: #e7e9ee; } input { background: #171a1f; color: #e7e9ee; border-color: #3a3f4a; } }
  .msg { line-height: 1.4; white-space: pre-wrap; }
  input { width: 100%; padding: 8px 10px; font-size: 13px; border: 1px solid #c3c8d0; border-radius: 6px;
    background: #fff; color: inherit; }
  input:focus { outline: 2px solid #4a8cff; outline-offset: 0; border-color: #4a8cff; }
  .row { margin-top: auto; display: flex; justify-content: flex-end; gap: 8px; }
  button { padding: 6px 16px; font-size: 13px; border-radius: 6px; border: 1px solid transparent; cursor: pointer; }
  #pi-prompt-cancel { background: transparent; border-color: #b7bdc7; color: inherit; }
  #pi-prompt-ok { background: #2f6ae0; color: #fff; }
</style></head>
<body>
  <div class="msg">${escapeHtml(message)}</div>
  <input id="pi-prompt-input" type="text" placeholder="${escapeHtml(placeholder)}" autofocus />
  <div class="row">
    <button id="pi-prompt-cancel" type="button">${escapeHtml(t("common.cancel"))}</button>
    <button id="pi-prompt-ok" type="button">${escapeHtml(t("common.ok"))}</button>
  </div>
  <script>
    (function () {
      var resolveResult;
      window.__piPromptResult = new Promise(function (resolve) { resolveResult = resolve; });
      function wire() {
        var input = document.getElementById('pi-prompt-input');
        var ok = document.getElementById('pi-prompt-ok');
        var cancel = document.getElementById('pi-prompt-cancel');
        if (!input || !ok || !cancel) { resolveResult(null); return; }
        ok.addEventListener('click', function () { resolveResult(input.value); });
        cancel.addEventListener('click', function () { resolveResult(null); });
        input.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') { event.preventDefault(); resolveResult(input.value); }
          else if (event.key === 'Escape') { event.preventDefault(); resolveResult(null); }
        });
        input.focus();
        document.body.dataset.piReady = '1';
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
      } else {
        wire();
      }
    })();
  </script>
</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function probeCustomProviderModels(
  input: CustomProviderProbeInput,
): Promise<CustomProviderProbeResult> {
  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl || !isValidHttpBaseUrl(baseUrl)) {
    return { ok: false, error: "Base URL must start with http:// or https://" };
  }
  const target = `${baseUrl.replace(/\/+$/, "")}/models`;
  const apiKey = input.apiKey?.trim();
  try {
    const response = await net.fetch(target, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { ok: false, error: `${response.status} ${response.statusText} from ${target}` };
    }
    const payload = (await response.json()) as unknown;
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      return { ok: false, error: `Response from ${target} is missing a "data" array` };
    }
    const models = data
      .map((entry) => {
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as { id?: unknown }).id === "string"
        ) {
          return (entry as { id: string }).id;
        }
        return undefined;
      })
      .filter((id): id is string => Boolean(id && id.length > 0));
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: describeProbeError(error, target) };
  }
}

function describeProbeError(error: unknown, target: string): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `Timed out after 5s contacting ${target}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
