import { expect, test } from "@playwright/test";
import {
  getLocale,
  hasMessage,
  localeFromLanguageTags,
  onLocaleChange,
  resolveLocale,
  setLocale,
  t,
  tPlural,
  translate,
} from "../../contracts/i18n";

test.afterEach(() => {
  setLocale("en");
});

test("localeFromLanguageTags picks the first recognized language tag", () => {
  expect(localeFromLanguageTags(["zh-Hans-CN", "en-US"])).toBe("zh-CN");
  expect(localeFromLanguageTags(["en-GB", "zh-CN"])).toBe("en");
  expect(localeFromLanguageTags(["fr-FR", "zh-TW"])).toBe("zh-CN");
});

test("localeFromLanguageTags ignores empty tags and falls back to English", () => {
  expect(localeFromLanguageTags([undefined, null, "", "fr-FR"])).toBe("en");
  expect(localeFromLanguageTags([])).toBe("en");
});

test("resolveLocale prefers an explicit preference over the system locale", () => {
  expect(resolveLocale("zh-CN", "en")).toBe("zh-CN");
  expect(resolveLocale("en", "zh-CN")).toBe("en");
  expect(resolveLocale("system", "zh-CN")).toBe("zh-CN");
  expect(resolveLocale(undefined, "en")).toBe("en");
});

test("translate interpolates known params and leaves unknown placeholders intact", () => {
  expect(translate("en", "workbench.relative.weeks", { count: 3 })).toBe("3w");
  expect(translate("zh-CN", "workbench.relative.weeks", { count: 3 })).toBe("3 周");
  expect(translate("en", "workbench.relative.weeks", { other: 3 })).toBe("{count}w");
  expect(translate("en", "workbench.relative.weeks")).toBe("{count}w");
});

test("t follows the current locale and notifies listeners only on change", () => {
  const seen: string[] = [];
  const unsubscribe = onLocaleChange((locale) => seen.push(locale));

  setLocale("zh-CN");
  expect(getLocale()).toBe("zh-CN");
  expect(t("workbench.relative.now")).toBe("刚刚");

  setLocale("zh-CN");
  unsubscribe();
  setLocale("en");

  expect(t("workbench.relative.now")).toBe("now");
  expect(seen).toEqual(["zh-CN"]);
});

test("tPlural picks the singular key exactly at one and keeps extra params", () => {
  expect(tPlural(1, "process.stage.stepOne", "process.stage.stepMany")).toBe("1 step");
  expect(tPlural(2, "process.stage.stepOne", "process.stage.stepMany")).toBe("2 steps");
  expect(tPlural(2, "process.stage.metaOne", "process.stage.metaMany", { duration: "3s" })).toBe(
    "2 steps · 3s",
  );
});

test("hasMessage rejects keys outside the catalog, including prototype names", () => {
  expect(hasMessage("workbench.relative.now")).toBe(true);
  expect(hasMessage("workbench.relative.never")).toBe(false);
  expect(hasMessage("toString")).toBe(false);
});
