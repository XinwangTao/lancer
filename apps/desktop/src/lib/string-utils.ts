import { t } from "../../contracts/i18n";

export function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatRelativeTime(value: string): string {
  if (!value) {
    return "";
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
  if (diffMinutes < 1) return t("workbench.relative.now");
  if (diffMinutes < 60) return t("workbench.relative.minutes", { count: diffMinutes });
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return t("workbench.relative.hours", { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return t("workbench.relative.days", { count: diffDays });
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffDays < 30) return t("workbench.relative.weeks", { count: diffWeeks });
  const diffMonths = Math.floor(diffDays / 30);
  // A month is approximated as 30 days, so 360-364 days reaches twelve months before the year
  // boundary at 365. Branch on days rather than the month count or that window renders "0y".
  if (diffDays < 365) return t("workbench.relative.months", { count: diffMonths });
  const diffYears = Math.floor(diffDays / 365);
  return t("workbench.relative.years", { count: diffYears });
}
