import { mkdtemp, mkdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { DoubaoAppService, mergeMessages } from "../../electron/doubao-app/service";
import {
  decodeNativeSnapshot,
  type NativeDoubaoCall,
  type NativeDoubaoSnapshot,
} from "../../electron/doubao-app/native-client";
import { createDownloadDirectory, DoubaoVideoReceiver } from "../../electron/doubao-app/videos";
import { canCreateSymlinks, SYMLINK_SKIP_REASON } from "../helpers/platform";

const target = { workspaceId: "w", sessionId: "s" };
function response(overrides: Partial<NativeDoubaoSnapshot> = {}): NativeDoubaoSnapshot {
  return {
    ok: true,
    permission: true,
    conversationId: "123456",
    title: "测试会话",
    messages: [],
    busy: false,
    ...overrides,
  };
}
async function fixture(native: NativeDoubaoCall) {
  const root = await mkdtemp(path.join(tmpdir(), "lancer-doubao-test-"));
  const options = {
    userDataDir: path.join(root, "profile"),
    native,
    resolveWorkspace: (ref: typeof target) =>
      ref.workspaceId === "w" && ["s", "other"].includes(ref.sessionId) ? root : undefined,
    openVideo: async (_file: string) => {},
    platform: "darwin",
  };
  return { root, options, service: new DoubaoAppService(options) };
}
test("binding persists, disable preserves history, and another task cannot bind the same App conversation", async () => {
  const f = await fixture(async () =>
    response({ messages: [{ role: "assistant", text: "hello" }] }),
  );
  const bound = await f.service.bind({ target });
  expect(bound.enabled).toBe(true);
  expect(bound.binding?.conversationId).toBe("123456");
  const restart = new DoubaoAppService(f.options);
  expect(await restart.status(target)).toEqual(bound);
  expect((await restart.setEnabled(target, false)).binding).toEqual(bound.binding);
  expect((await restart.status(target)).messages).toEqual(bound.messages);
  expect((await restart.bind({ target: { ...target, sessionId: "other" } })).errorCode).toBe(
    "E_ALREADY_BOUND",
  );
  await expect(restart.status({ ...target, sessionId: "unknown" })).rejects.toThrow(
    "E_UNKNOWN_SESSION",
  );
});
test("refresh is passive and a mismatched App conversation never imports its messages", async () => {
  const actions: string[] = [];
  let current = response({ messages: [{ role: "assistant", text: "owned" }] });
  const f = await fixture(async (request) => {
    actions.push(request.action);
    return current;
  });
  await f.service.bind({ target });
  current = response({
    conversationId: "999",
    messages: [{ role: "assistant", text: "unrelated" }],
  });
  const result = await f.service.refresh(target);
  expect(result.errorCode).toBe("E_CONVERSATION_MISMATCH");
  expect(result.messages).toEqual([{ role: "assistant", text: "owned" }]);
  expect(actions).toEqual(["snapshot", "snapshot"]);
});
test("send rejects overlapping operations and never retries an unconfirmed send", async () => {
  let release: ((snapshot: NativeDoubaoSnapshot) => void) | undefined;
  let started: (() => void) | undefined;
  const sending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let sends = 0;
  const f = await fixture(async (request) => {
    if (request.action !== "send") return response();
    sends++;
    started!();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  await f.service.bind({ target });
  const first = f.service.send({ target, text: "one" });
  await sending;
  expect((await f.service.send({ target, text: "two" })).errorCode).toBe("E_BUSY");
  release!(response({ ok: false, error: "E_SEND_UNCONFIRMED" }));
  expect((await first).errorCode).toBe("E_SEND_UNCONFIRMED");
  expect(sends).toBe(1);
  expect((await f.service.refresh(target)).errorCode).toBe("E_SEND_UNCONFIRMED");
});
test("streaming full and virtualized snapshots update only the assistant tail without duplicating turns", () => {
  const previous = [
    { role: "user" as const, text: "question" },
    { role: "assistant" as const, text: "ans" },
  ];
  const grown = [
    { role: "user" as const, text: "question" },
    { role: "assistant" as const, text: "answer" },
  ];
  expect(mergeMessages(previous, grown)).toEqual(grown);
  expect(mergeMessages(grown, [{ role: "assistant", text: "answer completed" }])).toEqual([
    grown[0],
    { role: "assistant", text: "answer completed" },
  ]);
  expect(mergeMessages(grown, grown)).toBe(grown);
});
test("virtualized history inserts newly visible users between anchors without repeating batches", () => {
  const assistant = (text: string) => ({ role: "assistant" as const, text });
  const user = (text: string) => ({ role: "user" as const, text });
  const a = assistant("A"),
    b = assistant("B"),
    c = assistant("C"),
    u = user("U");
  const history = mergeMessages([a, b, c], [b, u, c]);
  expect(history).toEqual([a, b, u, c]);
  expect(mergeMessages(history, [a, b, u, c])).toBe(history);
  expect(mergeMessages(history, [b, c])).toBe(history);
  const next = [user("next"), assistant("new answer")];
  expect(mergeMessages(history, [b, u, c, ...next])).toEqual([...history, ...next]);
  expect(mergeMessages(history, next)).toEqual([...history, ...next]);
  // Equal replies in distinct turns are legitimate and must survive.
  expect(mergeMessages(history, [user("different question"), c])).toEqual([
    ...history,
    user("different question"),
    c,
  ]);
  expect(mergeMessages([a, b, a, b], [a, b, c])).toEqual([a, b, a, b, c]);
});
test("partial native history places newly visible earlier instructions before their answers", () => {
  const a = { role: "assistant" as const, text: "Earlier answer" };
  const b = { role: "assistant" as const, text: "Final delivery" };
  const u = { role: "user" as const, text: "Instruction sent before delivery" };
  expect(mergeMessages([a, b], [u, a, b])).toEqual([u, a, b]);
  // Repair a previously appended instruction without dropping unseen older history.
  const older = { role: "user" as const, text: "Older request" };
  expect(mergeMessages([older, a, b, u], [a, u, b])).toEqual([older, a, u, b]);
  expect(mergeMessages([older, a, b, u], [u, a, b])).toEqual([older, u, a, b]);
  expect(mergeMessages([older, a, b, u, a], [a, u, b])).toEqual([older, a, u, b, a]);
});
test("unchanged refresh does not rewrite persistence and downloads are appended only on explicit request", async () => {
  const texts: string[] = [];
  const f = await fixture(async (request) => {
    if (request.action === "send") texts.push(request.text ?? "");
    return response({ sent: request.action === "send" });
  });
  const bound = await f.service.bind({ target });
  const file = path.join(f.options.userDataDir, "doubao-app.json");
  const before = await stat(file);
  await f.service.refresh(target);
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  await f.service.send({ target, text: "plain" });
  await f.service.send({ target, text: "download", download: true });
  expect(texts[0]).toBe("plain");
  expect(texts[1]).toContain(bound.binding!.downloadDirectory);
});
test("received media is hashed, cached, and target-only open is revalidated", async () => {
  let probes = 0;
  const opened: string[] = [];
  const learned: string[] = [];
  const f = await fixture(async (request) => {
    if (request.action === "inspectVideo") {
      probes++;
      return response({
        durationMs: 1000,
        hasVideo: !request.path?.includes("invalid"),
        hasAudio: false,
      });
    }
    return response();
  });
  const service = new DoubaoAppService({
    ...f.options,
    onVideoReceived: (_target, video) => {
      learned.push(video.id);
    },
    openVideo: async (file) => {
      opened.push(file);
    },
  });
  const bound = await service.bind({ target });
  const directory = bound.binding!.downloadDirectory;
  const video = path.join(directory, "sample.mp4");
  await writeFile(video, "mock media bytes");
  const old = new Date(Date.now() - 5000);
  await utimes(video, old, old);
  const received = await service.refresh(target);
  expect(received.videos).toHaveLength(1);
  expect(received.videos[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
  await service.refresh(target);
  expect(probes).toBe(1);
  expect(learned).toEqual([received.videos[0]!.id]);
  const invalid = path.join(directory, "invalid.mp4");
  await writeFile(invalid, "bad");
  await utimes(invalid, old, old);
  await service.openVideo(target, received.videos[0]!.id);
  expect(opened).toEqual([video]);
  await writeFile(video, "tampered bytes");
  await utimes(video, old, old);
  await expect(service.openVideo(target, received.videos[0]!.id)).rejects.toThrow(
    "E_VIDEO_CHANGED",
  );
});

test("received media and download roots reject symlink escapes", async () => {
  test.skip(!(await canCreateSymlinks()), SYMLINK_SKIP_REASON);
  const f = await fixture(async () => response());
  const bound = await f.service.bind({ target });
  const directory = bound.binding!.downloadDirectory;
  const outside = path.join(f.root, "external.mp4");
  await writeFile(outside, "outside");
  await symlink(outside, path.join(directory, "link.mp4"));
  const receiver = new DoubaoVideoReceiver(f.options.native);
  await expect(receiver.verify(f.root, directory, "link.mp4")).rejects.toThrow("E_DOWNLOAD_PATH");
  const other = await mkdtemp(path.join(tmpdir(), "lancer-doubao-symlink-"));
  await symlink(f.root, path.join(other, ".lancer"));
  await expect(createDownloadDirectory(other, "key")).rejects.toThrow("E_DOWNLOAD_PATH");
});
test("corrupt binding persistence is preserved and native output cannot introduce unknown message roles", async () => {
  const f = await fixture(async () => response());
  await mkdir(f.options.userDataDir, { recursive: true });
  const file = path.join(f.options.userDataDir, "doubao-app.json");
  await writeFile(file, '{"broken":');
  await expect(f.service.status(target)).rejects.toThrow("E_STATE_INVALID");
  expect(await readFile(file, "utf8")).toBe('{"broken":');
  expect(() =>
    decodeNativeSnapshot(response({ messages: [{ role: "system" as "user", text: "bad" }] })),
  ).toThrow("E_NATIVE_RESPONSE");
});

// Actual Swift JSONEncoder output captured in doubao-native-proof/media-results.json:
// nil optional conversationId is omitted, not encoded as null.
test("native Swift media and permission responses accept omitted optional conversationId", () => {
  const actualMedia = {
    busy: false,
    messages: [],
    title: "",
    durationMs: 178967,
    ok: true,
    permission: true,
    hasVideo: true,
    hasAudio: true,
  };
  expect(decodeNativeSnapshot(actualMedia)).toMatchObject({
    conversationId: null,
    durationMs: 178967,
    hasVideo: true,
    hasAudio: true,
  });
  const actualFailure = {
    ok: false,
    busy: false,
    messages: [],
    title: "",
    error: "E_NOT_VIDEO",
    permission: true,
  };
  expect(decodeNativeSnapshot(actualFailure)).toMatchObject({
    conversationId: null,
    error: "E_NOT_VIDEO",
  });
  expect(
    decodeNativeSnapshot({
      ...actualFailure,
      error: "E_ACCESSIBILITY_REQUIRED",
      permission: false,
    }),
  ).toMatchObject({ conversationId: null, permission: false });
});

test("completed-only snapshots archive legacy progress once and keep long task history bounded", async () => {
  const user = { role: "user" as const, text: "long task" };
  const legacy = [
    user,
    { role: "assistant" as const, text: "tool step 1" },
    { role: "assistant" as const, text: "tool step 1\ntool step 2" },
  ];
  let current = response({ messages: legacy });
  const f = await fixture(async () => current);
  await f.service.bind({ target });
  current = response({ transcriptVersion: 2, busy: true, messages: [user] });
  for (let i = 0; i < 20; i++) {
    const running = await f.service.refresh(target);
    expect(running.busy).toBe(true);
    expect(running.messages).toEqual([user]);
  }
  const restarted = new DoubaoAppService(f.options);
  expect((await restarted.status(target)).busy).toBe(true);
  const final = { role: "assistant" as const, text: "LONG_TASK_DONE" };
  current = response({ transcriptVersion: 2, messages: [user, final] });
  for (let i = 0; i < 4; i++) {
    const done = await restarted.refresh(target);
    expect(done.busy).toBe(false);
    expect(done.messages).toEqual([user, final]);
  }
  const disk = JSON.parse(
    await readFile(path.join(f.options.userDataDir, "doubao-app.json"), "utf8"),
  ) as { bindings: Record<string, unknown> };
  const saved = Object.values(disk.bindings)[0] as {
    legacyMessages: unknown;
    transcriptVersion: number;
  };
  expect(saved.legacyMessages).toEqual(legacy);
  expect(saved.transcriptVersion).toBe(2);
  expect(decodeNativeSnapshot(current).transcriptVersion).toBe(2);
});

test("body-only migration archives the entire old mirror once and preserves repeated turns after restart", async () => {
  const unseen = { role: "user" as const, text: "Older question outside the native viewport" };
  const answer = { role: "assistant" as const, text: "Answer\n昨天 10:16" };
  const legacy = [unseen, answer, answer];
  let current = response({ transcriptVersion: 2, messages: legacy });
  const f = await fixture(async () => current);
  await f.service.bind({ target });
  const user = { role: "user" as const, text: "Keep this literal date:\n今天 10:16" };
  const native = [user, { role: "assistant" as const, text: "Answer" }];
  current = response({ transcriptVersion: 3, messages: native });
  const refreshed = await f.service.refresh(target);
  expect(refreshed.messages).toEqual(native);
  expect(refreshed.archivedMessages).toEqual(legacy);
  const restarted = new DoubaoAppService(f.options);
  expect(await restarted.refresh(target)).toEqual(refreshed);
  current = response({ transcriptVersion: 3, messages: [...native, ...native] });
  expect((await restarted.refresh(target)).messages).toEqual([...native, ...native]);
  expect((await restarted.status(target)).archivedMessages).toEqual(legacy);
  const disk = JSON.parse(
    await readFile(path.join(f.options.userDataDir, "doubao-app.json"), "utf8"),
  ) as { bindings: Record<string, { archivedMessages: unknown; transcriptVersion: number }> };
  expect(Object.values(disk.bindings)[0]).toMatchObject({
    transcriptVersion: 3,
    archivedMessages: legacy,
  });
  expect(decodeNativeSnapshot(current).transcriptVersion).toBe(3);
});
