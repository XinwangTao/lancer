import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  LOCAL_APP_IDS,
  isLocalAppId,
  resolveLocalAppExecutable,
  startLocalApp,
  type LocalAppFileSystem,
} from "../../electron/local-app-launcher";

/** Only the listed files exist, so resolution is proven without a real install. */
function fakeFileSystem(files: readonly string[]): LocalAppFileSystem {
  return {
    exists: (target) => files.includes(target),
    readDir: (directory) => {
      const prefix = `${directory}${path.sep}`;
      const names = new Set<string>();
      for (const file of files) {
        if (!file.startsWith(prefix)) continue;
        const [head] = file.slice(prefix.length).split(path.sep);
        if (head) names.add(head);
      }
      return [...names];
    },
  };
}

const env = { ProgramW6432: "C:\\Program Files" } as NodeJS.ProcessEnv;

test("workbuddy resolves from the declared program files root", () => {
  const executable = path.join("C:\\Program Files", "WorkBuddy", "WorkBuddy.exe");
  expect(resolveLocalAppExecutable("workbuddy", env, fakeFileSystem([executable]))).toBe(
    executable,
  );
  // Per-user Electron installs live under LocalAppData\Programs.
  const local = path.join(
    "C:\\Users\\tester\\AppData\\Local",
    "Programs",
    "WorkBuddy",
    "WorkBuddy.exe",
  );
  expect(
    resolveLocalAppExecutable(
      "workbuddy",
      { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" } as NodeJS.ProcessEnv,
      fakeFileSystem([local]),
    ),
  ).toBe(local);
  expect(resolveLocalAppExecutable("workbuddy", {}, fakeFileSystem([]))).toBeUndefined();
});

test("marvis prefers the official launcher and falls back to the newest version", () => {
  const base = path.join("C:\\Program Files", "Tencent", "Marvis", "Application");
  const launcher = path.join(base, "MarvisLauncher.exe");
  const older = path.join(base, "1.9.0", "Marvis.exe");
  const newer = path.join(base, "1.10.0", "Marvis.exe");
  expect(resolveLocalAppExecutable("marvis", env, fakeFileSystem([older, newer, launcher]))).toBe(
    launcher,
  );
  // An install without the launcher still resolves the newest version numerically.
  expect(resolveLocalAppExecutable("marvis", env, fakeFileSystem([older, newer]))).toBe(newer);
});

test("opencode resolves the npm shim that carries the CLI", () => {
  const shim = path.join("C:\\Users\\tester\\AppData\\Roaming", "npm", "opencode.cmd");
  const files = fakeFileSystem([shim]);
  const appData = { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" } as NodeJS.ProcessEnv;
  expect(resolveLocalAppExecutable("opencode", appData, files)).toBe(shim);
  expect(resolveLocalAppExecutable("opencode", {}, files)).toBeUndefined();
});

test("only allowlisted ids can start an app", async () => {
  expect(LOCAL_APP_IDS).toEqual(["workbuddy", "marvis", "opencode"]);
  expect(isLocalAppId("marvis")).toBe(true);
  expect(isLocalAppId("not-an-app")).toBe(false);
  // A renderer cannot smuggle a path through the id argument.
  await expect(
    startLocalApp("C:\\Windows\\System32\\calc.exe", env, fakeFileSystem([])),
  ).rejects.toThrow(/Unknown local app/u);
});

test("a missing install is reported instead of spawning anything", async () => {
  await expect(startLocalApp("workbuddy", {}, fakeFileSystem([]))).rejects.toThrow(
    /not installed/u,
  );
});

test("command scripts start through the shell with a quoted path", async () => {
  test.skip(process.platform !== "win32", "cmd.exe is a Windows shell");
  // The directory holds a space, which is exactly where naive quoting breaks.
  const root = await mkdtemp(join(tmpdir(), "local app "));
  try {
    const npmDir = join(root, "npm");
    await mkdir(npmDir, { recursive: true });
    const marker = join(root, "marker.txt");
    await writeFile(join(npmDir, "opencode.cmd"), `@echo off\r\necho ran>"${marker}"\r\n`);
    await startLocalApp("opencode", {
      ...process.env,
      APPDATA: root,
      LOCALAPPDATA: join(root, "absent"),
    } as NodeJS.ProcessEnv);
    // The marker proves the shim actually ran, so the quoting and shell hop are right.
    await expect.poll(() => existsSync(marker), { timeout: 20_000 }).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
