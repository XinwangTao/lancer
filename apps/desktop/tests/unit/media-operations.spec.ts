import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readMediaOperations,
  recordMediaOperations,
  runMediaOperation,
} from "../../electron/video-learn/media-operations";
import {
  canCreateDirectoryLinks,
  createDirectoryLink,
  DIRECTORY_LINK_SKIP_REASON,
} from "../helpers/platform";

test("media operations retain the executed command, output, duration and a genuine failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "media-operations-"));
  const notify = recordMediaOperations(root, "video-test");
  await runMediaOperation(
    "probe",
    "读取视频信息",
    process.execPath,
    ["-e", "console.log('actual output')"],
    5000,
    notify,
  );
  await expect(
    runMediaOperation("extract", "抽帧", process.execPath, ["-e", "process.exit(3)"], 5000, notify),
  ).rejects.toThrow();
  const records = readMediaOperations(root, "video-test");
  expect(records[0]).toMatchObject({ status: "success", output: "actual output" });
  expect(records[0]!.command).toContain("console.log");
  expect(records[0]!.durationMs).toBeGreaterThan(0);
  expect(records[1]).toMatchObject({ status: "error" });
  expect(records[1]!.error).toBeTruthy();
  expect(readMediaOperations(root, "historical-run-without-trace")).toEqual([]);
});

test("media trace ignores an oversized operations file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "media-trace-bounds-"));
  const directory = path.join(root, "learning", "video-test");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "media-operations.json");
  writeFileSync(file, " ".repeat(65000));
  expect(readMediaOperations(root, "video-test")).toEqual([]);
});

test("media trace ignores an outside-project symlinked run", async () => {
  test.skip(!(await canCreateDirectoryLinks()), DIRECTORY_LINK_SKIP_REASON);
  const root = mkdtempSync(path.join(tmpdir(), "media-trace-bounds-"));
  const directory = path.join(root, "learning", "video-test");
  mkdirSync(directory, { recursive: true });
  const outside = mkdtempSync(path.join(tmpdir(), "media-trace-outside-"));
  writeFileSync(
    path.join(outside, "media-operations.json"),
    JSON.stringify({ videoId: "escaped", operations: [] }),
  );
  await createDirectoryLink(outside, path.join(root, "learning", "escaped"));
  expect(readMediaOperations(root, "escaped")).toEqual([]);
});
