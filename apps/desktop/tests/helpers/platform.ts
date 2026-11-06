import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Symlink fixtures need a real link, but Windows only permits creating a file link with
 * Developer Mode or elevation. Probe the capability instead of assuming a platform: tests that
 * prove escape handling skip with this reason when the host cannot build the fixture.
 */
export async function canCreateSymlinks(): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "lancer-symlink-probe-"));
  try {
    await symlink(join(root, "target"), join(root, "link"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export const SYMLINK_SKIP_REASON =
  "Creating symlinks requires Developer Mode or elevation on Windows.";

/**
 * Directory links use a junction on Windows, which works without Developer Mode. Keep this
 * separate from `canCreateSymlinks` so directory-escape fixtures run on hosts that cannot
 * create file links.
 */
function directoryLinkType(): "junction" | "dir" {
  return process.platform === "win32" ? "junction" : "dir";
}

export async function canCreateDirectoryLinks(): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "lancer-dir-link-probe-"));
  try {
    await mkdir(join(root, "target"));
    await symlink(join(root, "target"), join(root, "link"), directoryLinkType());
    return true;
  } catch {
    return false;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function createDirectoryLink(target: string, path: string): Promise<void> {
  return symlink(target, path, directoryLinkType());
}

export const DIRECTORY_LINK_SKIP_REASON =
  "The host cannot create a directory link fixture for this escape test.";
