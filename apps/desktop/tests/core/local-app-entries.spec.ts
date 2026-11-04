import { writeFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { join } from "node:path";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  openNewThread,
} from "../helpers/electron-app";

test("the model reel lists the companion apps after GLM and offers to open them", async () => {
  const profile = await makeUserDataDir(),
    agentDir = join(profile, "agent"),
    workspace = await makeWorkspace("local-app-entries");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  const harness = await launchDesktop(profile, {
    agentDir,
    initialWorkspaces: [workspace],
    testMode: "background",
    scrubProviderEnv: true,
  });
  try {
    const page = await harness.firstWindow();
    await openNewThread(page);
    const reel = page.getByTestId("model-reel");
    await expect(reel).toBeVisible();

    // The apps follow GLM instead of joining the model families.
    const anchors = await reel
      .locator("[data-anchor-key]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-anchor-key")));
    const glm = anchors.indexOf("family:zhipu");
    expect(glm).toBeGreaterThanOrEqual(0);
    expect(anchors.slice(glm + 1)).toEqual(["app:workbuddy", "app:marvis", "app:opencode"]);

    // At the default window size the new group must be on screen, not scrolled off.
    const row = await reel.locator(".model-catalog__families").boundingBox();
    const lastApp = await reel.locator('[data-anchor-key="app:opencode"]').boundingBox();
    expect(row).not.toBeNull();
    expect(lastApp).not.toBeNull();
    expect(lastApp!.x + lastApp!.width).toBeLessThanOrEqual(row!.x + row!.width + 1);

    const workbuddy = reel.locator('[data-anchor-key="app:workbuddy"]');
    await expect(workbuddy).toHaveAttribute("title", "WorkBuddy · GUI 对话");
    await workbuddy.click();

    const catalog = page.locator(".model-catalog__popover:popover-open");
    await expect(catalog).toContainText("WorkBuddy");
    await expect(catalog).toContainText("本机 App");
    await expect(catalog).not.toContainText("个模型");
    await expect(catalog).not.toContainText("尚未配置");
    // The launch action is offered; the app itself is only started on a real click.
    await expect(catalog.getByTestId("catalog-local-app-workbuddy")).toBeVisible();
    await expect(catalog.getByRole("button", { name: "打开 WorkBuddy" })).toBeEnabled();
    await page.keyboard.press("Escape");

    // Dismissing the panel must give the current family its highlight back.
    await expect(workbuddy).toHaveAttribute("aria-pressed", "false");

    const opencode = reel.locator('[data-anchor-key="app:opencode"]');
    await expect(opencode).toHaveAttribute("title", "OpenCode · 终端 CLI");
    await opencode.click();
    await expect(page.locator(".model-catalog__popover:popover-open")).toContainText("终端 CLI");
  } finally {
    await harness.close();
  }
});

test("the app entries keep their affordances on the light surface", async () => {
  const profile = await makeUserDataDir(),
    agentDir = join(profile, "agent"),
    workspace = await makeWorkspace("local-app-entries-light");
  await writeFile(
    join(profile, "ui-state.json"),
    JSON.stringify({ themeMode: "light", language: "en" }),
  );
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  const harness = await launchDesktop(profile, {
    agentDir,
    initialWorkspaces: [workspace],
    testMode: "background",
    scrubProviderEnv: true,
  });
  try {
    const page = await harness.firstWindow();
    await openNewThread(page);
    const marvis = page.getByTestId("model-reel").locator('[data-anchor-key="app:marvis"]');
    await marvis.click();
    await expect(page.locator(".model-catalog__popover:popover-open")).toContainText("Marvis");

    // The selected app gets the same light-surface highlight as a model family.
    const selected = await marvis.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        pressed: element.getAttribute("aria-pressed"),
        background: style.backgroundColor,
        shadow: style.boxShadow,
      };
    });
    expect(selected.pressed).toBe("true");
    expect(selected.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(selected.shadow).not.toBe("none");

    const probe = await page.evaluate(() => {
      const divider = document.querySelector(".model-catalog__divider");
      const panel = document.querySelector(".model-catalog__popover");
      const root = getComputedStyle(document.documentElement);
      return {
        surface: panel ? getComputedStyle(panel).backgroundColor : "",
        divider: divider ? getComputedStyle(divider).backgroundColor : "",
        errorInk: root.getPropertyValue("--error-ink").trim(),
      };
    });
    // A light surface means every channel stays high; a stranded dark palette would fail here.
    const channels = (probe.surface.match(/\d+/gu) ?? []).slice(0, 3).map(Number);
    expect(channels).toHaveLength(3);
    expect(Math.min(...channels)).toBeGreaterThan(200);
    // The separator must still draw a line instead of vanishing into the light surface.
    expect(probe.divider).not.toBe("rgba(0, 0, 0, 0)");
    expect(probe.divider).not.toBe("");
    expect(probe.errorInk).not.toBe("");
  } finally {
    await harness.close();
  }
});
