import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  assertDouyinUrl,
  readVideoLearn,
  runVideoLearnFiles,
} from "../../electron/video-learn/engine";
import { videoLearnStageDetail } from "../../src/features/conversation/video-learn-stages";
import {
  expectVideoLearnRunInput,
  expectVideoLearnStatusInput,
} from "../../electron/ipc/request-validation";
import {
  fixtureSha256,
  makeVideoLearnFixture,
  makeVideoPassRoot,
  writeVideoPassEvidence,
} from "../helpers/video-learn-fixture";

const URL = "https://v.douyin.com/video/7431908245560173823";
function videoId(root: string): string {
  return String(json(path.join(root, "_gates", "active.json")).video_id);
}
const PROSE = /请继续学习|已下载请|please continue learning/i;
const ffmpegPath = process.env.FFMPEG ?? "ffmpeg";
const ffprobePath = process.env.FFPROBE ?? "ffprobe";
let evidenceRoot: string;
let source: string;
interface Frame {
  frame_index: number;
  pts_ms: number;
  sha256: string;
  path: string;
}
interface Frames {
  source_sha256: string;
  frames: Frame[];
}
function json(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}
function caseRoot(name: string): string {
  const root = path.join(evidenceRoot, name);
  mkdirSync(path.join(root, "agent"), { recursive: true });
  writeFileSync(
    path.join(root, "agent", "models.json"),
    JSON.stringify({
      providers: {
        "video-fixture": {
          baseUrl: "https://video-fixture.invalid/v1",
          apiKey: "LOCAL_FIXTURE_ONLY",
          api: "openai-completions",
          models: [
            {
              id: "vision-fixture",
              name: "Vision fixture",
              input: ["text", "image"],
              reasoning: false,
              contextWindow: 8192,
              maxTokens: 2048,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  return root;
}
function options(root: string, fetcher: typeof fetch) {
  return {
    ffmpegPath,
    ffprobePath,
    agentDir: path.join(root, "agent"),
    providerId: "video-fixture",
    modelId: "vision-fixture",
    fetch: fetcher,
  };
}
function frames(root: string): Frames {
  return json(path.join(root, "learning", videoId(root), "frames.json")) as unknown as Frames;
}
function answer(
  root: string,
  invalidRef = false,
  hashMode: "exact" | "missing" | "wrong" = "exact",
): typeof fetch {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { messages?: unknown[] };
    expect(JSON.stringify(request.messages)).toContain("data:image/");
    const frame = frames(root).frames[0];
    expect(frame).toBeDefined();
    return new Response(
      JSON.stringify({
        id: "fixture-response",
        object: "chat.completion",
        model: "vision-fixture",
        created: Math.floor(Date.now() / 1000),
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              refusal: null,
              content: JSON.stringify({
                conclusions: [
                  {
                    observation: "Deterministic fixture observation; not a real model analysis.",
                    frame_index: invalidRef ? 999999 : frame.frame_index,
                    pts_ms: frame.pts_ms,
                    ...(hashMode === "missing"
                      ? {}
                      : { sha256: hashMode === "wrong" ? "0".repeat(64) : frame.sha256 }),
                  },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}
function gates(root: string) {
  return Object.fromEntries(
    ["download", "media", "analysis"].map((step) => {
      const file = path.join(root, "_gates", `${step}.${videoId(root)}.json`);
      return [step, { path: file, value: existsSync(file) ? json(file) : null }];
    }),
  );
}
async function record(root: string, name: string) {
  writeVideoPassEvidence(evidenceRoot, name, {
    case: name,
    proof: "real generated media + deterministic mock analysis",
    root,
    gates: gates(root),
    snapshot: await readVideoLearn(root, videoId(root)),
  });
}
async function expectFailure(
  root: string,
  expected: string[],
  failedStep: "download" | "media" | "analysis",
) {
  const state = (await readVideoLearn(root, videoId(root)))!;
  expect(state.guiStatus).toBe("FAILED");
  expect(expected).toContain(state.errorCode);
  expect(state.stages.some((stage) => stage.guiLabel.includes("已学习"))).toBe(false);
  const steps = ["download", "media", "analysis"];
  for (const step of steps.slice(steps.indexOf(failedStep) + 1)) {
    expect(existsSync(path.join(root, "_gates", `${step}.${videoId(root)}.json`))).toBe(false);
  }
  expect(existsSync(path.join(root, "learning", videoId(root), "spec.json"))).toBe(false);
  expect(state.stages.map((stage) => videoLearnStageDetail(state, stage)).join("\n")).not.toMatch(
    PROSE,
  );
}

test.beforeAll(() => {
  evidenceRoot = makeVideoPassRoot();
  source = makeVideoLearnFixture(path.join(evidenceRoot, "fixture"), ffmpegPath);
});

test("a: text disguised as MP4 fails media validation and never claims learned", async () => {
  const root = caseRoot("a-not-video");
  const corrupt = path.join(root, "text.mp4");
  writeFileSync(corrupt, "This is not a video.");
  const owner = { workspaceId: "workspace", sessionId: "video-session", role: "download" as const };
  await runVideoLearnFiles(
    root,
    { url: URL, localSource: corrupt, owner },
    options(root, answer(root)),
  );
  expect((await readVideoLearn(root, videoId(root)))?.sessions).toEqual([owner]);
  await record(root, "a-not-video");
  await expectFailure(root, ["E_NOT_VIDEO", "E_PROBE_FAIL"], "media");
});

test("b: unavailable ffprobe refuses downstream gates", async () => {
  const root = caseRoot("b-probe-missing");
  const originalPath = process.env.PATH;
  process.env.PATH = root;
  try {
    await runVideoLearnFiles(
      root,
      { url: URL, localSource: source },
      { ...options(root, answer(root)), ffprobePath: "ffprobe" },
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
  await record(root, "b-probe-missing");
  await expectFailure(root, ["E_PROBE_MISSING"], "media");
});

test("c: model deadline fails explicitly without a successful learning spec", async () => {
  const root = caseRoot("c-timeout");
  const stalled: typeof fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException("fixture timeout", "AbortError"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  await runVideoLearnFiles(
    root,
    { url: URL, localSource: source },
    { ...options(root, stalled), analysisTimeoutMs: 5 },
  );
  await record(root, "c-timeout");
  await expectFailure(root, ["E_TIMEOUT"], "analysis");
});

test("d: model HTTP error and nonexistent frame references both fail closed", async () => {
  for (const invalidRef of [false, true]) {
    const name = invalidRef ? "d-bad-reference" : "d-model-failure";
    const root = caseRoot(name);
    const fetcher: typeof fetch = invalidRef
      ? answer(root, true)
      : async () => new Response("fixture model failure", { status: 503 });
    await runVideoLearnFiles(root, { url: URL, localSource: source }, options(root, fetcher));
    await record(root, name);
    await expectFailure(root, [invalidRef ? "E_MODEL_BAD_REF" : "E_MODEL_FAIL"], "analysis");
  }
});

test("e: actual video, cut and audio produce verifiable frames and three gates (mock model)", async () => {
  const root = caseRoot("e-success-mock");
  const done = await runVideoLearnFiles(
    root,
    { url: URL, localSource: source },
    options(root, answer(root)),
  );
  await record(root, "e-success-mock");
  expect(done.guiStatus).toBe("ANALYZED");
  for (const step of ["download", "media", "analysis"]) {
    expect(json(path.join(root, "_gates", `${step}.${videoId(root)}.json`)).status_code).toBe(
      `${step}.ok`,
    );
  }
  const manifest = json(path.join(root, "raw", "videos", videoId(root), "meta.json"));
  expect(manifest.sha256).toBe(fixtureSha256(source));
  // Gates and specs only accept forward-slash evidence paths, including on Windows.
  expect(manifest.local_path).toBe(`raw/videos/${videoId(root)}/source.mp4`);
  const extracted = frames(root);
  expect(extracted.source_sha256).toBe(manifest.sha256);
  expect(extracted.frames.length).toBeGreaterThanOrEqual(2);
  expect(extracted.frames.some((frame) => frame.pts_ms < 2000)).toBe(true);
  expect(extracted.frames.some((frame) => frame.pts_ms >= 2000)).toBe(true);
  for (const frame of extracted.frames) {
    expect(frame.sha256).toBe(fixtureSha256(path.join(root, frame.path)));
    expect(frame.frame_index).toBeGreaterThanOrEqual(0);
    expect(frame.pts_ms).toBeGreaterThanOrEqual(0);
    expect(frame.pts_ms).toBeLessThan(4100);
  }
  expect(json(path.join(root, "learning", "frames.json"))).toEqual(extracted);
  const spec = json(path.join(root, "learning", videoId(root), "spec.json"));
  expect(spec).toMatchObject({
    schema_version: "learning_spec.v2",
    source_sha256: manifest.sha256,
    status_code: "analysis.ok",
    fps: 12,
    frame_count: 48,
    model: { provider: "video-fixture", id: "vision-fixture" },
  });
  expect(Number(spec.duration_ms)).toBeGreaterThanOrEqual(3900);
  expect(Number(spec.duration_ms)).toBeLessThanOrEqual(4100);
  const conclusions = spec.conclusions as Array<{
    frame_index: number;
    pts_ms: number;
    sha256: string;
  }>;
  expect(conclusions).toHaveLength(1);
  for (const conclusion of conclusions) {
    expect(extracted.frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          frame_index: conclusion.frame_index,
          pts_ms: conclusion.pts_ms,
          sha256: conclusion.sha256,
        }),
      ]),
    );
  }
  expect(JSON.stringify(spec)).not.toMatch(PROSE);
});

test("valid video with a one-millisecond probe deadline fails before analysis", async () => {
  const root = caseRoot("boundary-probe-timeout");
  await runVideoLearnFiles(
    root,
    { url: URL, localSource: source },
    {
      ...options(root, answer(root)),
      commandTimeoutMs: 1,
    },
  );
  await record(root, "boundary-probe-timeout");
  await expectFailure(root, ["E_TIMEOUT"], "media");
});

test("valid video without an audio stream records audio null", async () => {
  const root = caseRoot("boundary-no-audio");
  const silent = path.join(root, "without-audio.mp4");
  execFileSync(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      source,
      "-map",
      "0:v:0",
      "-c:v",
      "copy",
      "-an",
      silent,
    ],
    { timeout: 10_000 },
  );
  const done = await runVideoLearnFiles(
    root,
    { url: URL, localSource: silent },
    options(root, answer(root)),
  );
  await record(root, "boundary-no-audio");
  expect(done.guiStatus).toBe("ANALYZED");
  expect(json(path.join(root, "raw", "videos", done.videoId, "media.json")).audio).toBeNull();
});

test("a scene cut does not reset the fixed interval sampling grid", async () => {
  const root = caseRoot("boundary-scene-grid");
  const done = await runVideoLearnFiles(
    root,
    { url: URL, localSource: source },
    {
      ...options(root, answer(root)),
      frameIntervalSeconds: 3,
    },
  );
  await record(root, "boundary-scene-grid");
  expect(done.guiStatus).toBe("ANALYZED");
  expect(frames(root).frames.map((frame) => frame.pts_ms)).toEqual(
    expect.arrayContaining([0, 2000, 3000]),
  );
});

test("a modified extracted JPEG invalidates an earlier successful analysis on readback", async () => {
  const root = caseRoot("boundary-tampered-frame");
  const done = await runVideoLearnFiles(
    root,
    { url: URL, localSource: source },
    options(root, answer(root)),
  );
  expect(done.guiStatus).toBe("ANALYZED");
  const frame = frames(root).frames[0];
  const file = path.join(root, frame.path);
  writeFileSync(
    file,
    Buffer.concat([readFileSync(file), Buffer.from("tampered after model analysis")]),
  );
  const readback = await readVideoLearn(root, done.videoId);
  await record(root, "boundary-tampered-frame");
  expect(readback).toMatchObject({ guiStatus: "FAILED", errorCode: "E_MODEL_BAD_REF" });
  expect(readback!.stages.at(-1)).toMatchObject({ statusCode: "analysis.fail", ok: false });
});

test("non-douyin urls and prose handoff fields are rejected", () => {
  expect(() => assertDouyinUrl("https://example.com/video/1")).toThrow("INVALID_URL");
  expect(() => assertDouyinUrl("file:///tmp/x.mp4")).toThrow("INVALID_URL");
  expect(expectVideoLearnRunInput({ workspaceId: " w ", url: " https://v.douyin.com/a " })).toEqual(
    { workspaceId: "w", url: "https://v.douyin.com/a" },
  );
  expect(() => expectVideoLearnRunInput({ workspaceId: "w", url: "u", prompt: "继续" })).toThrow(
    "input.prompt is not supported",
  );
  expect(expectVideoLearnStatusInput({ workspaceId: "w", videoId: " dy_1 " })).toEqual({
    workspaceId: "w",
    videoId: "dy_1",
  });
});

for (const badRef of [false, true]) {
  test(`second model handoff validates evidence and progress (bad reference: ${badRef})`, async () => {
    const root = caseRoot(`handoff-${badRef}`);
    const configPath = path.join(root, "agent", "models.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      providers: Record<string, { models: { id: string; input: string[] }[] }>;
    };
    config.providers["video-fixture"].models.push({ id: "synthesis-fixture", input: ["text"] });
    writeFileSync(configPath, JSON.stringify(config));
    let secondCalls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        model: string;
        messages: { content: string }[];
      };
      if (request.model !== "synthesis-fixture") return answer(root)(input, init);
      secondCalls++;
      expect((request as { max_tokens?: number }).max_tokens).toBeGreaterThanOrEqual(8192);
      const current = await readVideoLearn(root);
      expect(current?.busy).toBe(true);
      expect(current?.stages.at(-1)).toMatchObject({ id: "handoff", running: true, ok: false });
      expect(request.messages[1].content).toContain("learning_spec_sha256");
      const frame = frames(root).frames[0]!;
      return new Response(
        JSON.stringify({
          id: "handoff-fixture",
          model: "synthesis-fixture",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  lessons: [
                    {
                      lesson: "Fixture synthesis",
                      frame_index: badRef ? 999999 : frame.frame_index,
                      pts_ms: frame.pts_ms,
                      sha256: frame.sha256,
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };
    const done = await runVideoLearnFiles(
      root,
      { url: "", localSource: source },
      { ...options(root, fetcher), handoffModelId: "synthesis-fixture" },
    );
    expect(secondCalls).toBe(1);
    expect(done.busy).toBe(false);
    expect(done.guiStatus).toBe(badRef ? "FAILED" : "HANDED_OFF");
    expect(done.errorCode).toBe(badRef ? "E_MODEL_BAD_REF" : null);
    if (!badRef) {
      expect(done.lessons).toHaveLength(1);
      const file = path.join(root, "learning", done.videoId, "lessons.json");
      writeFileSync(file, readFileSync(file, "utf8").replace("Fixture synthesis", "tampered"));
      expect(await readVideoLearn(root)).toMatchObject({
        guiStatus: "FAILED",
        errorCode: "E_MODEL_BAD_REF",
      });
    }
  });
}

test("failed analysis never invokes or creates a second-model handoff", async () => {
  const root = caseRoot("handoff-blocked");
  let calls = 0;
  const done = await runVideoLearnFiles(
    root,
    { url: URL, localSource: source },
    {
      ...options(root, async (input, init) => {
        calls++;
        return answer(root, true)(input, init);
      }),
      handoffModelId: "synthesis-fixture",
    },
  );
  expect(calls).toBe(1);
  expect(done.guiStatus).toBe("FAILED");
  expect(existsSync(path.join(root, "_gates", `handoff.${done.videoId}.json`))).toBe(false);
});

test("received-video IPC accepts identities but rejects arbitrary source paths", () => {
  expect(
    expectVideoLearnRunInput({ workspaceId: "w", received: { sessionId: "s", videoId: "v" } }),
  ).toEqual({ workspaceId: "w", received: { sessionId: "s", videoId: "v" } });
  expect(() =>
    expectVideoLearnRunInput({
      workspaceId: "w",
      received: { sessionId: "s", videoId: "v", path: "/tmp/x" },
    }),
  ).toThrow();
  expect(() =>
    expectVideoLearnRunInput({
      workspaceId: "w",
      received: { sessionId: "s", videoId: "v" },
      url: URL,
    }),
  ).toThrow();
});

for (const hashMode of ["missing", "wrong"] as const) {
  test(`frame hashes stay code-bound and conflicting model hashes fail: ${hashMode}`, async () => {
    const root = caseRoot(`model-hash-${hashMode}`);
    const done = await runVideoLearnFiles(
      root,
      { url: URL, localSource: source },
      options(root, answer(root, false, hashMode)),
    );
    expect(done.guiStatus).toBe(hashMode === "missing" ? "ANALYZED" : "FAILED");
    if (hashMode === "wrong") expect(done.errorCode).toBe("E_MODEL_BAD_REF");
    else {
      const spec = json(path.join(root, "learning", done.videoId, "spec.json"));
      expect(spec.conclusions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sha256: frames(root).frames[0]!.sha256 }),
        ]),
      );
    }
  });
}
