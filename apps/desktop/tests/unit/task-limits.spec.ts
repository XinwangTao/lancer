import { expect, test } from "@playwright/test";
import type { SessionUsageSnapshot } from "@lancer/session-driver";
import type { OrchestrationChildThreadStatus } from "../../contracts/desktop-state";
import {
  assertTaskTokenBudget,
  TaskAdmission,
  taskAncestry,
  taskLimits,
  type TaskLimits,
} from "../../electron/orchestration/task-limits";

const ref = (sessionId: string) => ({ workspaceId: "workspace", sessionId });
const child = (
  id: string,
  parent: string,
  status: OrchestrationChildThreadStatus = "complete",
) => ({
  parentWorkspaceId: "workspace",
  parentSessionId: parent,
  childWorkspaceId: "workspace",
  childSessionId: id,
  status,
});
const limits = { concurrent: 2, depth: 3, children: 4, tokens: 100 };

test("parallel admissions reserve capacity before asynchronous creation and release on failure", () => {
  const admission = new TaskAdmission();
  const releaseA = admission.reserve([], ref("root"), limits);
  const releaseB = admission.reserve([], ref("other"), limits);
  expect(() => admission.reserve([], ref("root"), limits)).toThrow("并行分支");
  releaseA();
  releaseA();
  const releaseC = admission.reserve([], ref("root"), limits);
  releaseB();
  releaseC();
  expect(() =>
    admission.reserve([child("running", "root", "running")], ref("root"), limits),
  ).not.toThrow();
});

test("grandchildren keep their root budget; independent conversations do not share tree counts", () => {
  const children = [child("a", "root"), child("b", "a"), child("c", "b")];
  expect(taskAncestry(children, ref("c"))).toEqual({ root: ref("root"), depth: 3 });
  const admission = new TaskAdmission();
  expect(() => admission.reserve(children, ref("c"), limits)).toThrow("3 层");
  const release = admission.reserve(children, ref("b"), limits);
  expect(() => admission.reserve(children, ref("root"), limits)).toThrow("4 个分支");
  expect(() => admission.reserve(children, ref("another root"), limits)).not.toThrow();
  release();
});

test("cyclic persisted ancestry fails closed instead of recursing forever", () => {
  expect(() => taskAncestry([child("a", "b"), child("b", "a")], ref("a"))).toThrow("循环");
});

test("provider-reported input, output and cache count once for the whole tree", () => {
  const usage = (n: number): SessionUsageSnapshot => ({
    cache: {},
    subscription: true,
    totals: { input: n, output: n, cacheRead: n, cacheWrite: n, cost: 0 },
  });
  const values = new Map([
    ["root", usage(10)],
    ["a", usage(10)],
    ["b", usage(5)],
    ["other", usage(1000)],
  ]);
  const children = [child("a", "root"), child("b", "a"), child("unrelated", "other")];
  expect(() =>
    assertTaskTokenBudget(children, ref("b"), (r) => values.get(r.sessionId), limits),
  ).toThrow("100 Token");
  values.delete("b");
  expect(() =>
    assertTaskTokenBudget(children, ref("a"), (r) => values.get(r.sessionId), limits),
  ).not.toThrow();
});

test("invalid limits cannot silently disable admission checks", () => {
  expect(taskLimits({}).depth).toBe(4);
  for (const value of ["0", "-1", "NaN", "1.5", "lots"])
    expect(() => taskLimits({ LANCER_MAX_CONCURRENT_BRANCHES: value })).toThrow("必须");
});

test("defaults stay in place and no ceiling rejects a larger number", () => {
  expect(taskLimits({})).toEqual({ concurrent: 8, depth: 4, children: 32, tokens: 500_000 });
  expect(
    taskLimits({
      LANCER_MAX_CONCURRENT_BRANCHES: "1000",
      LANCER_MAX_BRANCH_DEPTH: "1000",
      LANCER_MAX_TREE_BRANCHES: "10000",
      LANCER_MAX_TREE_TOKENS: "250000000",
    }),
  ).toEqual({ concurrent: 1000, depth: 1000, children: 10_000, tokens: 250_000_000 });
});

test("every limit accepts an explicit opt-out and rejects typos", () => {
  const names = [
    "LANCER_MAX_CONCURRENT_BRANCHES",
    "LANCER_MAX_BRANCH_DEPTH",
    "LANCER_MAX_TREE_BRANCHES",
    "LANCER_MAX_TREE_TOKENS",
  ] as const;
  for (const name of names) {
    for (const value of ["unlimited", "OFF", " unlimited "])
      expect(taskLimits({ [name]: value })[fieldOf(name)]).toBe(Number.POSITIVE_INFINITY);
    for (const value of ["0", "-1", "NaN", "1.5", "lots"])
      expect(() => taskLimits({ [name]: value })).toThrow("正整数");
  }
});

test("unlimited limits admit every branch instead of failing closed", () => {
  const usage: SessionUsageSnapshot = {
    cache: {},
    subscription: true,
    totals: { input: 10, output: 10, cacheRead: 10, cacheWrite: 10, cost: 0 },
  };
  const deep = [child("a", "root"), child("b", "a"), child("c", "b")];
  const unlimited = {
    concurrent: Number.POSITIVE_INFINITY,
    depth: Number.POSITIVE_INFINITY,
    children: Number.POSITIVE_INFINITY,
    tokens: Number.POSITIVE_INFINITY,
  };
  const admission = new TaskAdmission();
  const releases = Array.from({ length: 40 }, () => admission.reserve(deep, ref("c"), unlimited));
  expect(releases).toHaveLength(40);
  for (const release of releases) release();
  expect(() => assertTaskTokenBudget(deep, ref("c"), () => usage, unlimited)).not.toThrow();
  expect(() => assertTaskTokenBudget(deep, ref("c"), () => usage, limits)).toThrow("100 Token");
});

function fieldOf(name: string): keyof TaskLimits {
  if (name === "LANCER_MAX_CONCURRENT_BRANCHES") return "concurrent";
  if (name === "LANCER_MAX_BRANCH_DEPTH") return "depth";
  if (name === "LANCER_MAX_TREE_BRANCHES") return "children";
  return "tokens";
}
