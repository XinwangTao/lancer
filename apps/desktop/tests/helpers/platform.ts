import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Symlink fixtures need a real link, but Windows only permits creating one with Developer Mode
 * or elevation. Probe the capability instead of assuming a platform: tests that prove escape
 * handling skip with this reason when the host cannot build the fixture.
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
