import { expect, test } from "@playwright/test";
import type { RuntimeExtensionRecord } from "@lancer/session-driver/runtime-types";
import { setLocale } from "../../contracts/i18n";
import {
  extensionGroupLabel,
  extensionScopeLabel,
  extensionSourceSummary,
  isPiGuiBuiltinExtension,
  sourceScopeGroupLabel,
} from "../../src/features/extensions/extension-display";

function extension(
  sourceInfo: Partial<RuntimeExtensionRecord["sourceInfo"]> = {},
): RuntimeExtensionRecord {
  return {
    path: "/tmp/review-tools",
    displayName: "Review tools",
    enabled: true,
    sourceInfo: {
      path: "/tmp/review-tools/index.ts",
      source: "user",
      scope: "user",
      origin: "top-level",
      ...sourceInfo,
    },
    commands: [],
    tools: [],
    flags: [],
    shortcuts: [],
    diagnostics: [],
  };
}

test.afterEach(() => {
  setLocale("en");
});

test("treats only top-level built-ins as Lancer's own tools", () => {
  const builtin = extension({ source: "builtin", origin: "top-level", scope: "project" });
  expect(isPiGuiBuiltinExtension(builtin)).toBe(true);
  expect(extensionScopeLabel(builtin)).toBe("Lancer tools");
  expect(extensionGroupLabel(builtin)).toBe("Lancer tools");
  expect(extensionSourceSummary(builtin)).toBe("Lancer tools · top-level");

  // A builtin nested in a package is discovered through that package's folder, so it
  // groups with the user's extensions instead of Lancer's built-in tools.
  const packaged = extension({ source: "builtin", origin: "package", scope: "project" });
  expect(isPiGuiBuiltinExtension(packaged)).toBe(false);
  expect(extensionGroupLabel(packaged)).toBe("Workspace");
});

test("group headings name where an extension was discovered", () => {
  expect(sourceScopeGroupLabel("project")).toBe("Workspace");
  expect(sourceScopeGroupLabel("user")).toBe("User");
  expect(sourceScopeGroupLabel("temporary")).toBe("This session");

  setLocale("zh-CN");
  expect(sourceScopeGroupLabel("project")).toBe("工作区");
  expect(sourceScopeGroupLabel("user")).toBe("用户");
  expect(sourceScopeGroupLabel("temporary")).toBe("本次会话");
});

test("summarizes discovered extensions by scope and origin", () => {
  const user = extension({ source: "user", scope: "user", origin: "top-level" });
  expect(extensionScopeLabel(user)).toBe("user");
  expect(extensionGroupLabel(user)).toBe("User");
  expect(extensionSourceSummary(user)).toBe("user · top-level");

  const temporary = extension({ source: "project", scope: "temporary", origin: "package" });
  expect(extensionGroupLabel(temporary)).toBe("This session");

  setLocale("zh-CN");
  expect(extensionGroupLabel(user)).toBe("用户");
});
