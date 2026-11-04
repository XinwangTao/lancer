import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionCatalogEntry, SessionLaneMetadata } from "../dist/index.js";
import { JsonCatalogStore } from "../dist/node/index.js";
import { parseState } from "../dist/node/catalog-codec.js";

const session: SessionCatalogEntry = {
  sessionRef: { workspaceId: "workspace", sessionId: "session" },
  workspaceId: "workspace",
  title: "Lane",
  updatedAt: "2026-07-27T00:00:00.000Z",
  status: "idle",
};

function serialized(entry: unknown, version = 2): string {
  return JSON.stringify({
    version,
    sessions: [entry],
    workspaces: [],
    worktrees: [],
    sessionFiles: {},
  });
}

await test("legacy v1 and v2 sessions retain their exact shape without lane defaults", () => {
  for (const version of [1, 2]) {
    assert.deepEqual(parseState(serialized(session, version), "catalog.json").sessions, [session]);
  }
});

await test("lane metadata survives disk writes, unrelated mutations, and reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lane-metadata-"));
  const catalogFilePath = join(dir, "catalog.json");
  const store = new JsonCatalogStore({ catalogFilePath });
  const metadata: SessionLaneMetadata = {
    laneGroup: "group-1",
    orchestratorId: "lead-session",
    role: "lane",
    startedAt: "2026-07-27T00:00:00.000Z",
    finishedAt: "2026-07-27T00:01:00.000Z",
    stage: "testing",
    progress: 0.5,
    resultPath: "out/result.json",
  };
  for (const variant of [
    metadata,
    { ...metadata, role: "lead" as const, stage: null, progress: null },
  ]) {
    const entry = { ...session, ...variant };
    await store.sessions.upsertSession(entry);
    await store.sessions.upsertSession({
      ...session,
      sessionRef: { ...session.sessionRef, sessionId: "other" },
    });
    const reopened = new JsonCatalogStore({ catalogFilePath });
    const entries = (await reopened.sessions.listSessions()).sessions;
    assert.deepEqual(
      entries.find((item) => item.sessionRef.sessionId === "session"),
      entry,
    );
  }
});

await test("atomic control patches survive driver upserts without replacing session fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-control-metadata-"));
  const catalogFilePath = join(dir, "catalog.json");
  const store = new JsonCatalogStore({ catalogFilePath });
  const other = new JsonCatalogStore({ catalogFilePath });
  const ref = session.sessionRef;
  assert.equal(await store.sessions.getControlMetadata(ref), null);
  await assert.rejects(
    store.sessions.updateControlMetadata(ref, { stage: "test" }),
    /Session not found/,
  );
  await store.sessions.upsertSession(session);
  assert.deepEqual(await store.sessions.getControlMetadata(ref), {});
  await Promise.all([
    store.sessions.updateControlMetadata(ref, { laneGroup: "g", stage: "test" }),
    other.sessions.upsertSession({ ...session, title: "Driver title", status: "running" }),
    other.sessions.updateControlMetadata(ref, { progress: 0.5 }),
  ]);
  const reopened = new JsonCatalogStore({ catalogFilePath });
  assert.deepEqual(await reopened.sessions.getControlMetadata(ref), {
    laneGroup: "g",
    stage: "test",
    progress: 0.5,
  });
  assert.equal((await reopened.sessions.getSession(ref))?.title, "Driver title");
  const before = await readFile(catalogFilePath, "utf8");
  await assert.rejects(
    store.sessions.updateControlMetadata(ref, { progress: Infinity }),
    /Invalid session runtime metadata/,
  );
  assert.equal(await readFile(catalogFilePath, "utf8"), before);
  await store.sessions.updateControlMetadata(ref, { stage: null, progress: null });
  await other.sessions.upsertSession(session);
  assert.deepEqual(await store.sessions.getControlMetadata(ref), {
    laneGroup: "g",
    stage: null,
    progress: null,
  });
});

await test("flat runtime statuses and nullable timestamps persist across restart and driver upserts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-runtime-status-"));
  const catalogFilePath = join(dir, "catalog.json");
  const store = new JsonCatalogStore({ catalogFilePath });
  await store.sessions.upsertSession(session);
  for (const runtimeStatus of ["running", "queued", "waiting", "done", "failed", "idle"] as const) {
    const metadata = { runtimeStatus, startedAt: null, finishedAt: null };
    await store.sessions.updateControlMetadata(session.sessionRef, metadata);
    await store.sessions.upsertSession({ ...session, title: "Driver update" });
    const reopened = new JsonCatalogStore({ catalogFilePath });
    assert.deepEqual(await reopened.sessions.getControlMetadata(session.sessionRef), metadata);
    assert.equal((await reopened.sessions.getSession(session.sessionRef))?.status, "idle");
  }
  await store.sessions.updateControlMetadata(session.sessionRef, {
    runtimeStatus: "done",
    startedAt: session.updatedAt,
    finishedAt: session.updatedAt,
  });
  const reopened = new JsonCatalogStore({ catalogFilePath });
  assert.deepEqual(await reopened.sessions.getControlMetadata(session.sessionRef), {
    runtimeStatus: "done",
    startedAt: session.updatedAt,
    finishedAt: session.updatedAt,
  });
});

await test("run outcomes survive reopening and driver catalog refresh without becoming success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-run-outcome-"));
  const catalogFilePath = join(dir, "catalog.json");
  const store = new JsonCatalogStore({ catalogFilePath });
  await store.sessions.upsertSession(session);
  for (const lastRunOutcome of ["completed", "cancelled", "failed", "interrupted", null] as const) {
    await store.sessions.updateControlMetadata(session.sessionRef, { lastRunOutcome });
    await store.sessions.upsertSession({ ...session, title: "Refreshed" });
    // Startup rescans the full workspace, rather than only upserting one session.
    await store.replaceWorkspaceSessions(
      session.workspaceId,
      [{ ...session, title: "Rescanned" }],
      {},
    );
    const reopened = new JsonCatalogStore({ catalogFilePath });
    assert.equal(
      (await reopened.sessions.getControlMetadata(session.sessionRef))?.lastRunOutcome,
      lastRunOutcome,
    );
    assert.equal((await reopened.sessions.getSession(session.sessionRef))?.title, "Rescanned");
  }
});

await test("undefined metadata is ignored while null explicitly clears run timestamps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-metadata-undefined-"));
  const catalogFilePath = join(dir, "catalog.json");
  const store = new JsonCatalogStore({ catalogFilePath });
  const metadata = {
    laneGroup: "group",
    orchestratorId: "lead",
    role: "lane" as const,
    startedAt: session.updatedAt,
    finishedAt: session.updatedAt,
    runtimeStatus: "done" as const,
    stage: "complete",
    progress: 1,
    resultPath: "result.txt",
  };
  const undefinedPatch = {
    laneGroup: undefined,
    orchestratorId: undefined,
    role: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    runtimeStatus: undefined,
    stage: undefined,
    progress: undefined,
    resultPath: undefined,
  };
  await store.sessions.upsertSession({ ...session, ...metadata });
  await store.sessions.updateControlMetadata(session.sessionRef, undefinedPatch);
  assert.deepEqual(await store.sessions.getControlMetadata(session.sessionRef), metadata);
  await store.sessions.upsertSession({ ...session, ...undefinedPatch });
  assert.deepEqual(await store.sessions.getControlMetadata(session.sessionRef), metadata);
  await store.sessions.updateControlMetadata(session.sessionRef, {
    startedAt: null,
    finishedAt: null,
    runtimeStatus: undefined,
  });
  const reopened = new JsonCatalogStore({ catalogFilePath });
  assert.deepEqual(await reopened.sessions.getControlMetadata(session.sessionRef), {
    ...metadata,
    startedAt: null,
    finishedAt: null,
  });
});

await test("progress includes both endpoints", () => {
  for (const progress of [0, 1]) {
    assert.equal(
      parseState(serialized({ ...session, progress }), "catalog.json").sessions[0]?.progress,
      progress,
    );
  }
});

await test("invalid lane fields fail decoding and leave saved bytes unchanged", async () => {
  const invalid = [
    { lastRunOutcome: "invented" },
    { laneGroup: null },
    { orchestratorId: 7 },
    { role: "worker" },
    { role: null },
    { startedAt: 123 },
    { finishedAt: false },
    { runtimeStatus: null },
    { runtimeStatus: "completed" },
    { runtimeStatus: 1 },
    { stage: 2 },
    { resultPath: [] },
    { progress: -0.01 },
    { progress: 1.01 },
    { progress: "0.5" },
    { progress: true },
  ];
  const dir = await mkdtemp(join(tmpdir(), "pi-invalid-lane-metadata-"));
  for (const [index, fields] of invalid.entries()) {
    const catalogFilePath = join(dir, `catalog-${index}.json`);
    const raw = serialized({ ...session, ...fields });
    await writeFile(catalogFilePath, raw);
    const store = new JsonCatalogStore({ catalogFilePath });
    await assert.rejects(store.sessions.listSessions(), /Invalid catalog file contents/);
    await assert.rejects(store.sessions.upsertSession(session), /Invalid catalog file contents/);
    assert.equal(await readFile(catalogFilePath, "utf8"), raw);
  }
  // JSON can parse an overflowing number, even though JSON.stringify emits null for Infinity.
  assert.throws(
    () =>
      parseState(
        serialized({ ...session, progress: "overflow" }).replace('"overflow"', "1e400"),
        "catalog.json",
      ),
    /Invalid catalog file contents/,
  );
});
