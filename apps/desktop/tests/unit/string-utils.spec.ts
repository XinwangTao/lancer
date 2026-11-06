import { expect, test } from "@playwright/test";
import { formatRelativeTime, titleCase } from "../../src/lib/string-utils";

function ago(milliseconds: number): string {
  return new Date(Date.now() - milliseconds).toISOString();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("titleCase splits separators and capitalizes each part", () => {
  expect(titleCase("code-review_skill")).toBe("Code Review Skill");
  expect(titleCase("--leading--and--trailing--")).toBe("Leading And Trailing");
  expect(titleCase("")).toBe("");
});

test("formatRelativeTime keeps unparseable and empty values as-is", () => {
  expect(formatRelativeTime("")).toBe("");
  expect(formatRelativeTime("not a timestamp")).toBe("not a timestamp");
});

test("formatRelativeTime reports each unit at its own scale", () => {
  expect(formatRelativeTime(ago(30_000))).toBe("now");
  expect(formatRelativeTime(ago(90 * MINUTE))).toBe("1h");
  expect(formatRelativeTime(ago(25 * HOUR))).toBe("1d");
  expect(formatRelativeTime(ago(10 * DAY))).toBe("1w");
  expect(formatRelativeTime(ago(90 * DAY))).toBe("3mo");
  expect(formatRelativeTime(ago(400 * DAY))).toBe("1y");
});

test("formatRelativeTime keeps late in the year in months instead of zero years", () => {
  // Months stop at 12, but a year starts at 365 days: 360-364 days must not fall through to
  // `floor(364 / 365)` and render "0y".
  expect(formatRelativeTime(ago(360 * DAY))).toBe("12mo");
  expect(formatRelativeTime(ago(364 * DAY))).toBe("12mo");
  expect(formatRelativeTime(ago(365 * DAY))).toBe("1y");
});

test("formatRelativeTime clamps future timestamps to now", () => {
  expect(formatRelativeTime(new Date(Date.now() + 10 * MINUTE).toISOString())).toBe("now");
});
