/** Byte acquisition, verified media decoding and evidence-bound image analysis. */
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { readRelayEvidence } from "./relay-evidence";
import { readMediaOperations, recordMediaOperations } from "./media-operations";
import {
  VIDEO_LEARN_PROCESS_ID,
  type VideoLearnSnapshot,
  type VideoLearnSessionRef,
  type VideoLearnStage,
} from "../../contracts/video-learn";
import { handoffLearning, type LearningItem } from "./handoff";
import { analyzeFrames, type AnalysisOptions } from "./analysis";
import { extractFrames, probeMedia, type MediaOptions } from "./media";
import {
  errorCode,
  readJson,
  record,
  runCommand,
  sha256File,
  VideoPassError,
  writeJson,
} from "./io";

const VIDEO_ID = /^[A-Za-z0-9_-]+$/;
const HEX64 = /^[a-f0-9]{64}$/;

/** Evidence records store paths relative to the project root with forward slashes. */
function portableRelativePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Accept manifests written by earlier Windows builds, which recorded `\` separators. */
function portableEvidencePath(value: string): string {
  return process.platform === "win32" ? value.replaceAll("\\", "/") : value;
}
export interface VideoLearnOptions extends MediaOptions, AnalysisOptions {
  readonly handoffModelId?: string;
  readonly ytDlpPath?: string;
}
const running = new Map<string, { id: string; stage: VideoLearnStage }>();
function progress(
  root: string,
  id: string,
  step: VideoLearnStage["id"],
  label: string,
  model?: string,
) {
  if (step !== "download" && running.get(root)?.id !== id) return;
  const stage: VideoLearnStage = {
    id: step,
    actor: model ? "gateway" : "local",
    statusCode: `${step}.running`,
    guiLabel: label,
    ok: false,
    running: true,
    ...(model ? { model } : {}),
  };
  running.set(root, { id, stage });
  writeJson(path.join(root, "_gates", `progress.${id}.json`), {
    step,
    label,
    model,
    finished: false,
  });
}
export interface RunFilesInput {
  readonly owner?: VideoLearnSessionRef;
  readonly url: string;
  readonly cookiesPath?: string;
  readonly localSource?: string;
  readonly expectedSha256?: string;
}
export interface DownloadRequest extends RunFilesInput {
  readonly projectRoot: string;
  readonly videoId: string;
}
export function conventionRoot(): string {
  const env = process.env.LANCER_VIDEO_LEARN_ROOT?.trim();
  if (env && existsSync(path.join(env, "PROCESS.json"))) return path.resolve(env);
  const bundled = process.resourcesPath && path.join(process.resourcesPath, "video-learn-process");
  if (bundled && existsSync(path.join(bundled, "PROCESS.json"))) return bundled;
  for (const start of [process.cwd(), __dirname]) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "packages/video-learn-process");
      if (existsSync(path.join(candidate, "PROCESS.json"))) return candidate;
      dir = path.dirname(dir);
    }
  }
  throw new Error("LANCER_VIDEO_LEARN_ROOT missing");
}
export function seedProject(root: string): void {
  for (const name of ["inbox/links", "raw/videos", "learning", "remake/out", "_gates"])
    mkdirSync(path.join(root, name), { recursive: true });
}
export function assertDouyinUrl(value: string): string {
  const url = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("INVALID_URL");
  }
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    !["douyin.com", "iesdouyin.com"].some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
    )
  )
    throw new Error("INVALID_URL");
  return url;
}
export function videoIdFromUrl(url: string): string {
  return `dy_${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
}
export function nowIsoShanghai(date = new Date()): string {
  return date.toISOString();
}
export function ingestLink(
  root: string,
  url: string,
  id = `${videoIdFromUrl(url)}_${randomUUID().slice(0, 8)}`,
): string {
  if (!VIDEO_ID.test(id)) throw new Error("INVALID_VIDEO_ID");
  seedProject(root);
  writeJson(path.join(root, "inbox/links", `${id}.url.json`), {
    video_id: id,
    douyin_url: url,
    created_at: nowIsoShanghai(),
  });
  writeJson(path.join(root, "_gates/active.json"), { video_id: id });
  return id;
}
function gate(
  root: string,
  id: string,
  step: "download" | "media" | "analysis",
  status: string,
  artifacts: Record<string, string>,
  sha?: string,
  error?: string,
  integrity?: { learning_spec_sha256: string; receipt_sha256: string },
): void {
  writeJson(path.join(root, "_gates", `${step}.${id}.json`), {
    process_id: VIDEO_LEARN_PROCESS_ID,
    video_id: id,
    step,
    status_code: status,
    ts: nowIsoShanghai(),
    artifacts,
    ...(sha ? { sha256: sha } : {}),
    error_code: error ?? null,
    ...integrity,
  });
}
function sourcePath(root: string, id: string, relative: unknown): string {
  const evidencePath = typeof relative === "string" ? portableEvidencePath(relative) : undefined;
  if (
    evidencePath === undefined ||
    !evidencePath.startsWith(`raw/videos/${id}/`) ||
    path.isAbsolute(evidencePath)
  )
    throw new VideoPassError("E_NOT_VIDEO");
  const file = path.resolve(root, evidencePath);
  const dir = path.resolve(root, "raw/videos", id);
  if (
    !file.startsWith(`${dir}${path.sep}`) ||
    !realpathSync(file).startsWith(`${realpathSync(dir)}${path.sep}`) ||
    !statSync(file).isFile()
  )
    throw new VideoPassError("E_NOT_VIDEO");
  return file;
}
export async function runDownload(
  request: DownloadRequest,
  options: VideoLearnOptions = {},
): Promise<"download.ok" | "download.fail"> {
  const { projectRoot: root, videoId: id } = request;
  const dir = path.join(root, "raw/videos", id);
  mkdirSync(dir, { recursive: true });
  try {
    let file: string;
    if (request.localSource) {
      if (!statSync(request.localSource).isFile() || statSync(request.localSource).size < 1)
        throw new VideoPassError("E_NOT_VIDEO");
      const ext = path.extname(request.localSource).slice(1).toLowerCase();
      file = path.join(dir, `source.${["mp4", "webm", "mov", "mkv"].includes(ext) ? ext : "bin"}`);
      const temp = `${file}.${randomUUID()}.tmp`;
      copyFileSync(request.localSource, temp);
      renameSync(temp, file);
    } else {
      const args = [
        "--no-playlist",
        "-f",
        "bv*+ba/b",
        "--merge-output-format",
        "mp4",
        "-o",
        path.join(dir, "source.%(ext)s"),
      ];
      const ffmpeg = options.ffmpegPath ?? process.env.FFMPEG;
      if (ffmpeg) args.push("--ffmpeg-location", ffmpeg);
      const cookies = request.cookiesPath ?? process.env.DOUYIN_COOKIES;
      if (cookies) args.push("--cookies", cookies);
      args.push("--", request.url);
      await runCommand(
        options.ytDlpPath ?? process.env.YT_DLP ?? "yt-dlp",
        args,
        options.commandTimeoutMs ?? 120_000,
      );
      file =
        ["mp4", "webm", "mkv", "mov"]
          .map((ext) => path.join(dir, `source.${ext}`))
          .find((p) => existsSync(p) && statSync(p).size > 0) ?? "";
      if (!file) throw new VideoPassError("E_NOT_VIDEO");
    }
    const relative = portableRelativePath(root, file);
    const sha = await sha256File(file);
    if (request.expectedSha256 && sha !== request.expectedSha256)
      throw new VideoPassError("E_NOT_VIDEO");
    const manifest = {
      schema_version: "manifest.v2",
      video_id: id,
      douyin_url: request.url,
      local_path: relative,
      sha256: sha,
      byte_size: statSync(file).size,
      status_code: "download.ok",
      downloaded_at: nowIsoShanghai(),
      downloader: request.localSource ? "local" : "yt-dlp",
      error_code: null,
    };
    writeJson(path.join(dir, "meta.json"), manifest);
    gate(
      root,
      id,
      "download",
      "download.ok",
      { manifest: `raw/videos/${id}/meta.json`, source: relative },
      sha,
    );
    return "download.ok";
  } catch (error) {
    gate(root, id, "download", "download.fail", {}, undefined, errorCode(error));
    return "download.fail";
  }
}
export async function runWatch(
  root: string,
  id: string,
  options: VideoLearnOptions = {},
): Promise<"analysis.ok" | "media.fail" | "analysis.fail"> {
  if (
    !VIDEO_ID.test(id) ||
    ["media", "analysis"].some((step) =>
      existsSync(path.join(root, "_gates", `${step}.${id}.json`)),
    )
  )
    throw new VideoPassError("E_PROBE_FAIL");
  if (readJson(path.join(root, "_gates", `download.${id}.json`))?.status_code !== "download.ok")
    throw new VideoPassError("E_NOT_VIDEO");
  let sha: string | undefined;
  let sourceRel = "";
  let step: "media" | "analysis" = "media";
  try {
    if (!VIDEO_ID.test(id)) throw new VideoPassError("E_NOT_VIDEO");
    const download = readJson(path.join(root, "_gates", `download.${id}.json`));
    const manifest = readJson(path.join(root, "raw/videos", id, "meta.json"));
    if (
      download?.status_code !== "download.ok" ||
      !manifest ||
      !validateManifest(manifest).ok ||
      download.sha256 !== manifest.sha256
    )
      throw new VideoPassError("E_NOT_VIDEO");
    const source = sourcePath(root, id, manifest.local_path);
    sourceRel = portableEvidencePath(String(manifest.local_path));
    sha = await sha256File(source);
    if (sha !== manifest.sha256 || statSync(source).size !== manifest.byte_size)
      throw new VideoPassError("E_NOT_VIDEO");
    progress(root, id, "media", "探测视频并抽取关键帧");
    const mediaOptions = { ...options, onOperation: recordMediaOperations(root, id) };
    const media = await probeMedia(source, mediaOptions);
    const { frames: _frames, ...metadata } = media;
    writeJson(path.join(root, "raw/videos", id, "media.json"), {
      schema_version: "media.v1",
      video_id: id,
      source_sha256: sha,
      ...metadata,
    });
    const frames = await extractFrames(root, id, source, sha, media, mediaOptions);
    if ((await sha256File(source)) !== sha) throw new VideoPassError("E_NOT_VIDEO");
    gate(
      root,
      id,
      "media",
      "media.ok",
      {
        media: `raw/videos/${id}/media.json`,
        frames: `learning/${id}/frames.json`,
        source: sourceRel,
      },
      sha,
    );
    step = "analysis";
    progress(root, id, "analysis", "正在分析画面", options.modelId);
    const { receipt, ...result } = await analyzeFrames(root, frames, media, options);
    if ((await sha256File(source)) !== sha) throw new VideoPassError("E_MODEL_BAD_REF");
    const spec = {
      schema_version: "learning_spec.v2",
      video_id: id,
      source_sha256: sha,
      source_path: sourceRel,
      status_code: "analysis.ok",
      duration_ms: media.duration_ms,
      fps: media.fps,
      frame_count: media.frame_count,
      ...result,
      learned_at: nowIsoShanghai(),
    };
    if (!validateLearningSpec(spec).ok) throw new VideoPassError("E_MODEL_BAD_REF");
    const specFile = path.join(root, "learning", id, "spec.json");
    const receiptFile = path.join(root, "learning", id, "analysis-receipt.json");
    writeJson(specFile, spec);
    writeJson(receiptFile, receipt);
    gate(
      root,
      id,
      "analysis",
      "analysis.ok",
      {
        learning_spec: `learning/${id}/spec.json`,
        receipt: `learning/${id}/analysis-receipt.json`,
        frames: `learning/${id}/frames.json`,
        source: sourceRel,
      },
      sha,
      undefined,
      {
        learning_spec_sha256: await sha256File(specFile),
        receipt_sha256: await sha256File(receiptFile),
      },
    );
    return "analysis.ok";
  } catch (error) {
    const code =
      error instanceof VideoPassError
        ? error.code
        : step === "analysis"
          ? "E_MODEL_FAIL"
          : errorCode(error);
    gate(root, id, step, `${step}.fail`, { source: sourceRel }, sha, code);
    return step === "media" ? "media.fail" : "analysis.fail";
  }
}
export async function runVideoLearnFiles(
  projectRoot: string,
  input: RunFilesInput,
  options: VideoLearnOptions = {},
): Promise<VideoLearnSnapshot> {
  const url = input.localSource && !input.url ? "" : assertDouyinUrl(input.url);
  seedProject(projectRoot);
  const root = realpathSync(projectRoot);
  const release = await lockfile.lock(root, {
    lockfilePath: path.join(root, "_gates/video-pass.lock"),
    retries: { retries: 60, minTimeout: 100, maxTimeout: 1000 },
    stale: 30_000,
    update: 5_000,
  });
  const id = ingestLink(root, url);
  try {
    if (input.owner) writeJson(path.join(root, "_gates", `owner.${id}.json`), input.owner);
    progress(root, id, "download", input.localSource ? "校验已接收视频" : "正在下载视频");
    if (
      (await runDownload({ ...input, url, projectRoot: root, videoId: id }, options)) ===
      "download.ok"
    ) {
      await runWatch(root, id, options);
      if (
        options.handoffModelId &&
        (await readVideoLearn(root, id))?.guiStatus !== "FAILED" &&
        readJson(path.join(root, "_gates", `analysis.${id}.json`))?.status_code === "analysis.ok"
      ) {
        progress(root, id, "handoff", "正在整理学习结论", options.handoffModelId);
        try {
          const result = await handoffLearning(root, id, options, options.handoffModelId);
          if ((await readVideoLearn(root, id))?.guiStatus === "FAILED")
            throw new VideoPassError("E_MODEL_BAD_REF");
          writeJson(path.join(root, "_gates", `handoff.${id}.json`), {
            process_id: VIDEO_LEARN_PROCESS_ID,
            video_id: id,
            step: "handoff",
            status_code: "handoff.ok",
            ts: nowIsoShanghai(),
            error_code: null,
            model: result.model,
            learning_spec_sha256: result.specHash,
            result_sha256: result.sha256,
            artifacts: { lessons: result.path },
          });
        } catch (error) {
          writeJson(path.join(root, "_gates", `handoff.${id}.json`), {
            process_id: VIDEO_LEARN_PROCESS_ID,
            video_id: id,
            step: "handoff",
            status_code: "handoff.fail",
            ts: nowIsoShanghai(),
            error_code: error instanceof VideoPassError ? error.code : "E_MODEL_FAIL",
            model: options.handoffModelId,
          });
        }
      }
    }
  } finally {
    running.delete(root);
    writeJson(path.join(root, "_gates", `progress.${id}.json`), { finished: true });
    await release();
  }
  return (await readVideoLearn(root, id))!;
}
export async function readVideoLearn(
  root: string,
  videoId?: string,
): Promise<VideoLearnSnapshot | null> {
  const id = videoId ?? String(readJson(path.join(root, "_gates/active.json"))?.video_id ?? "");
  if (!VIDEO_ID.test(id)) return null;
  const link = readJson(path.join(root, "inbox/links", `${id}.url.json`));
  const steps = ["download", "media", "analysis"] as const;
  const stages: VideoLearnStage[] = [];
  let failure: string | null = null;
  let previousGateTime = 0;
  for (const step of steps) {
    const g = readJson(path.join(root, "_gates", `${step}.${id}.json`));
    if (!g) break;
    const code = String(g.status_code);
    const gateTime = typeof g.ts === "string" ? Date.parse(g.ts) : NaN;
    const validGate =
      g.process_id === VIDEO_LEARN_PROCESS_ID &&
      g.video_id === id &&
      g.step === step &&
      Number.isFinite(gateTime) &&
      gateTime >= previousGateTime &&
      gateTime <= Date.now() + 1000 &&
      (code === `${step}.ok`
        ? g.error_code === null && typeof g.sha256 === "string" && HEX64.test(g.sha256)
        : code === `${step}.fail` &&
          typeof g.error_code === "string" &&
          [
            "E_NOT_VIDEO",
            "E_PROBE_MISSING",
            "E_PROBE_FAIL",
            "E_TIMEOUT",
            "E_MODEL_CONFIG",
            "E_MODEL_FAIL",
            "E_MODEL_BAD_REF",
          ].includes(g.error_code));
    previousGateTime = gateTime;
    const ok = validGate && code === `${step}.ok`;
    stages.push({
      id: step,
      actor: step === "analysis" ? "gateway" : "local",
      statusCode: code,
      guiLabel: ok
        ? { download: "文件已保存", media: "媒体已验证", analysis: "分析已验证" }[step]
        : "失败",
      ok,
    });
    if (!ok) {
      failure = validGate ? String(g.error_code) : "E_MODEL_BAD_REF";
      break;
    }
  }
  if (stages.at(-1)?.statusCode === "analysis.ok") {
    try {
      const manifest = readJson(path.join(root, "raw/videos", id, "meta.json"));
      const spec = readJson(path.join(root, "learning", id, "spec.json"));
      const frameManifest = readJson(path.join(root, "learning", id, "frames.json"));
      if (
        !manifest ||
        !validateManifest(manifest).ok ||
        !spec ||
        !validateLearningSpec(spec).ok ||
        spec.video_id !== id ||
        spec.source_sha256 !== manifest.sha256 ||
        frameManifest?.video_id !== id ||
        frameManifest.source_sha256 !== manifest.sha256 ||
        !Array.isArray(frameManifest.frames) ||
        !Array.isArray(spec.conclusions)
      )
        throw new VideoPassError("E_MODEL_BAD_REF");
      if ((await sha256File(sourcePath(root, id, manifest.local_path))) !== manifest.sha256)
        throw new VideoPassError("E_MODEL_BAD_REF");
      const media = readJson(path.join(root, "raw/videos", id, "media.json"));
      if (
        !media ||
        media.video_id !== id ||
        media.source_sha256 !== manifest.sha256 ||
        spec.source_path !== manifest.local_path ||
        spec.duration_ms !== media.duration_ms ||
        spec.frame_count !== media.frame_count ||
        spec.fps !== media.fps
      )
        throw new VideoPassError("E_MODEL_BAD_REF");
      for (const step of steps) {
        const evidenceGate = readJson(path.join(root, "_gates", `${step}.${id}.json`));
        if (evidenceGate?.video_id !== id || evidenceGate.sha256 !== manifest.sha256)
          throw new VideoPassError("E_MODEL_BAD_REF");
      }
      const finalGate = readJson(path.join(root, "_gates", `analysis.${id}.json`));
      const receiptFile = path.join(root, "learning", id, "analysis-receipt.json");
      const receipt = readJson(receiptFile);
      if (
        !receipt ||
        !finalGate ||
        receipt.finish_reason !== "stop" ||
        receipt.provider !== record(spec.model)?.provider ||
        receipt.model !== record(spec.model)?.id ||
        typeof receipt.response_id !== "string" ||
        !receipt.response_id ||
        !Array.isArray(receipt.submitted_frames) ||
        receipt.submitted_frames.length !== frameManifest.frames.length ||
        typeof receipt.ts !== "string" ||
        !Number.isFinite(Date.parse(receipt.ts)) ||
        Date.parse(receipt.ts) > Date.parse(String(finalGate.ts)) ||
        (await sha256File(path.join(root, "learning", id, "spec.json"))) !==
          finalGate.learning_spec_sha256 ||
        (await sha256File(receiptFile)) !== finalGate.receipt_sha256
      )
        throw new VideoPassError("E_MODEL_BAD_REF");
      const refs = frameManifest.frames.map(record);
      const seenFrames = new Set<number>();
      let previousPts = -1;
      for (const ref of refs) {
        if (
          !ref ||
          !Number.isSafeInteger(ref.frame_index) ||
          Number(ref.frame_index) < 0 ||
          Number(ref.frame_index) >= Number(media.frame_count) ||
          seenFrames.has(Number(ref.frame_index)) ||
          !Number.isSafeInteger(ref.pts_ms) ||
          Number(ref.pts_ms) < 0 ||
          Number(ref.pts_ms) < previousPts ||
          Number(ref.pts_ms) > Number(media.duration_ms) ||
          typeof ref.sha256 !== "string" ||
          !HEX64.test(ref.sha256) ||
          typeof ref.path !== "string" ||
          !ref.path.startsWith(`learning/${id}/frames/`) ||
          ref.path.split(/[\\/]/).includes("..")
        )
          throw new VideoPassError("E_MODEL_BAD_REF");
        seenFrames.add(Number(ref.frame_index));
        previousPts = Number(ref.pts_ms);
        const submitted = receipt.submitted_frames
          .map(record)
          .find((f) => f?.frame_index === ref.frame_index);
        if (!submitted || submitted.pts_ms !== ref.pts_ms || submitted.sha256 !== ref.sha256)
          throw new VideoPassError("E_MODEL_BAD_REF");
        const full = path.join(root, ref.path);
        if (
          !realpathSync(full).startsWith(
            `${realpathSync(path.join(root, "learning", id, "frames"))}${path.sep}`,
          ) ||
          (await sha256File(full)) !== ref.sha256
        )
          throw new VideoPassError("E_MODEL_BAD_REF");
      }
      for (const raw of spec.conclusions) {
        const c = record(raw);
        const ref = refs.find((f) => f?.frame_index === c?.frame_index);
        if (!c || !ref || ref.pts_ms !== c.pts_ms || ref.sha256 !== c.sha256)
          throw new VideoPassError("E_MODEL_BAD_REF");
      }
    } catch {
      failure = "E_MODEL_BAD_REF";
      const lastStage = stages.at(-1)!;
      stages[stages.length - 1] = {
        ...lastStage,
        statusCode: "analysis.fail",
        guiLabel: "证据校验失败",
        ok: false,
      };
    }
  }
  let lessons: LearningItem[] | undefined;
  const spec = readJson(path.join(root, "learning", id, "spec.json"));
  const analysisStage = stages.findIndex((stage) => stage.id === "analysis");
  if (analysisStage >= 0 && typeof record(spec?.model)?.id === "string")
    stages[analysisStage] = { ...stages[analysisStage]!, model: String(record(spec?.model)?.id) };
  const handoff = readJson(path.join(root, "_gates", `handoff.${id}.json`));
  if (!failure && stages.at(-1)?.statusCode === "analysis.ok" && handoff) {
    let ok = false;
    try {
      if (handoff.status_code !== "handoff.ok") throw new VideoPassError("E_MODEL_FAIL");
      const file = path.join(root, "learning", id, "lessons.json");
      const output = readJson(file);
      if (
        handoff.video_id !== id ||
        handoff.process_id !== VIDEO_LEARN_PROCESS_ID ||
        handoff.step !== "handoff" ||
        handoff.error_code !== null ||
        !output ||
        output.finish_reason !== "stop" ||
        !output.response_id ||
        output.schema_version !== "learning_lessons.v1" ||
        output.video_id !== id ||
        output.source_sha256 !== spec?.source_sha256 ||
        record(output.model)?.id !== handoff.model ||
        (await sha256File(file)) !== handoff.result_sha256 ||
        (await sha256File(path.join(root, "learning", id, "spec.json"))) !==
          handoff.learning_spec_sha256 ||
        !Array.isArray(output.lessons) ||
        !output.lessons.length
      )
        throw new VideoPassError("E_MODEL_BAD_REF");
      const refs = Array.isArray(spec?.conclusions) ? spec.conclusions.map(record) : [];
      lessons = output.lessons.map((raw) => {
        const item = record(raw);
        if (
          !item ||
          typeof item.lesson !== "string" ||
          !item.lesson.trim() ||
          !refs.some(
            (ref) =>
              ref?.frame_index === item.frame_index &&
              ref?.pts_ms === item.pts_ms &&
              ref?.sha256 === item.sha256,
          )
        )
          throw new VideoPassError("E_MODEL_BAD_REF");
        return {
          lesson: item.lesson,
          frame_index: Number(item.frame_index),
          pts_ms: Number(item.pts_ms),
          sha256: String(item.sha256),
        };
      });
      ok = true;
    } catch {
      failure =
        handoff.status_code === "handoff.fail" ? String(handoff.error_code) : "E_MODEL_BAD_REF";
    }
    stages.push({
      id: "handoff",
      actor: "gateway",
      statusCode: ok ? "handoff.ok" : "handoff.fail",
      guiLabel: ok ? "学习结论已交接" : "交接失败",
      ok,
      model: String(handoff.model ?? ""),
    });
  }
  const active = running.get(root);
  const current = active?.id === id ? active.stage : undefined;
  const pending = readJson(path.join(root, "_gates", `progress.${id}.json`));
  if (!failure && current && !stages.some((stage) => stage.id === current.id)) stages.push(current);
  if (!failure && !current && pending?.finished === false) failure = "E_INTERRUPTED";
  const last = stages.at(-1);
  return {
    relayTree: await readRelayEvidence(root, id),
    operations: readMediaOperations(root, id),
    processId: VIDEO_LEARN_PROCESS_ID,
    projectRoot: root,
    videoId: id,
    douyinUrl: String(link?.douyin_url ?? ""),
    busy: Boolean(current) && !failure,
    sourceSha256: String(readJson(path.join(root, "raw/videos", id, "meta.json"))?.sha256 ?? ""),
    ...(lessons && !failure ? { lessons } : {}),
    guiStatus: failure
      ? "FAILED"
      : current
        ? "RUNNING"
        : last?.id === "handoff" && last.ok
          ? "HANDED_OFF"
          : last?.id === "analysis" && last.ok
            ? "ANALYZED"
            : last?.id === "media" && last.ok
              ? "MEDIA_READY"
              : last?.ok
                ? "READY_HASH_OK"
                : "PENDING_DOWNLOAD",
    stages,
    handoff: null,
    errorCode: failure,
    sessions: (() => {
      const owner = readJson(path.join(root, "_gates", `owner.${id}.json`));
      return owner &&
        typeof owner.workspaceId === "string" &&
        typeof owner.sessionId === "string" &&
        (owner.role === "download" || owner.role === "watch")
        ? [{ workspaceId: owner.workspaceId, sessionId: owner.sessionId, role: owner.role }]
        : [];
    })(),
    sessionError: null,
  };
}
export function validateManifest(value: Record<string, unknown>): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (value.schema_version !== "manifest.v2") errors.push("schema_version");
  if (typeof value.video_id !== "string" || !VIDEO_ID.test(value.video_id)) errors.push("video_id");
  if (typeof value.sha256 !== "string" || !HEX64.test(value.sha256)) errors.push("sha256");
  if (
    typeof value.local_path !== "string" ||
    !value.local_path.startsWith(`raw/videos/${String(value.video_id)}/`) ||
    value.local_path.split(/[\\/]/).includes("..")
  )
    errors.push("local_path");
  if (!Number.isSafeInteger(value.byte_size) || Number(value.byte_size) < 1)
    errors.push("byte_size");
  if (value.status_code !== "download.ok" || value.error_code !== null) errors.push("status_code");
  return { ok: !errors.length, errors };
}
export function validateLearningSpec(value: Record<string, unknown>): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (value.schema_version !== "learning_spec.v2" || value.status_code !== "analysis.ok")
    errors.push("schema_version");
  if (typeof value.source_sha256 !== "string" || !HEX64.test(value.source_sha256))
    errors.push("source_sha256");
  if (typeof value.video_id !== "string" || !VIDEO_ID.test(value.video_id)) errors.push("video_id");
  if (
    typeof value.source_path !== "string" ||
    !value.source_path.startsWith(`raw/videos/${String(value.video_id)}/`) ||
    value.source_path.split(/[\\/]/).includes("..")
  )
    errors.push("source_path");
  if (
    !Number.isSafeInteger(value.duration_ms) ||
    Number(value.duration_ms) < 1 ||
    !Number.isSafeInteger(value.frame_count) ||
    Number(value.frame_count) < 1 ||
    typeof value.fps !== "number" ||
    !Number.isFinite(value.fps) ||
    value.fps <= 0
  )
    errors.push("media");
  const model = record(value.model);
  if (
    typeof model?.provider !== "string" ||
    !model.provider ||
    typeof model.id !== "string" ||
    !model.id
  )
    errors.push("model");
  if (typeof value.learned_at !== "string" || !Number.isFinite(Date.parse(value.learned_at)))
    errors.push("learned_at");
  if (!Array.isArray(value.conclusions) || !value.conclusions.length) errors.push("conclusions");
  else
    for (const c of value.conclusions) {
      const r = record(c);
      if (
        !r ||
        typeof r.observation !== "string" ||
        !r.observation.trim() ||
        !Number.isInteger(r.frame_index) ||
        Number(r.frame_index) < 0 ||
        Number(r.frame_index) >= Number(value.frame_count) ||
        !Number.isInteger(r.pts_ms) ||
        Number(r.pts_ms) < 0 ||
        Number(r.pts_ms) > Number(value.duration_ms) ||
        typeof r.sha256 !== "string" ||
        !HEX64.test(r.sha256)
      )
        errors.push("conclusion");
    }
  return { ok: !errors.length, errors };
}
