import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** "3:07". Returns a dash when the duration is unknown rather than "0:00". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "--:--";
  }
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86400],
    ["month", 2_592_000],
    ["year", 31_536_000],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  let chosen: [Intl.RelativeTimeFormatUnit, number] = units[0];
  for (const unit of units) {
    if (seconds >= unit[1]) chosen = unit;
  }
  return formatter.format(-Math.round(seconds / chosen[1]), chosen[0]);
}

/** A stable, readable id for form controls. */
export function fieldId(prefix: string, name: string): string {
  return `${prefix}-${name}`.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function pluralize(count: number, singular: string, plural?: string) {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

/** Character and line counts for the lyrics editor. */
export function countText(text: string) {
  const lines = text.length === 0 ? 0 : text.split("\n").length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return { characters: text.length, lines, words };
}

export type DiffOp = { kind: "same" | "added" | "removed"; line: string };

/**
 * Line diff by longest common subsequence.
 *
 * Quadratic, which is fine for lyrics (the 40 000-character limit is at most a
 * few thousand lines); above a size guard it degrades to "all removed, all
 * added" rather than freezing the tab.
 */
export function diffLines(before: string, after: string): DiffOp[] {
  const allA = before.split("\n");
  const allB = after.split("\n");

  // Unchanged head and tail are matched directly. Edits are usually local, so
  // this leaves only a small middle for the quadratic part.
  let head = 0;
  while (head < allA.length && head < allB.length && allA[head] === allB[head]) head++;
  let tail = 0;
  while (
    tail < allA.length - head &&
    tail < allB.length - head &&
    allA[allA.length - 1 - tail] === allB[allB.length - 1 - tail]
  ) {
    tail++;
  }
  const same = (line: string): DiffOp => ({ kind: "same", line });
  const prefix = allA.slice(0, head).map(same);
  const suffix = allA.slice(allA.length - tail).map(same);
  const a = allA.slice(head, allA.length - tail);
  const b = allB.slice(head, allB.length - tail);

  // Under this guard the shorter side has at most 3000 lines, so every LCS
  // length fits a 16-bit cell: the table peaks at about 18 MB.
  if (a.length * b.length > 9_000_000) {
    return [
      ...prefix,
      ...a.map((line) => ({ kind: "removed" as const, line })),
      ...b.map((line) => ({ kind: "added" as const, line })),
      ...suffix,
    ];
  }
  // lcs[i][j] = LCS length of a[i:] and b[j:], stored flat.
  const width = b.length + 1;
  const lcs = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", line: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      ops.push({ kind: "removed", line: a[i++] });
    } else {
      ops.push({ kind: "added", line: b[j++] });
    }
  }
  while (i < a.length) ops.push({ kind: "removed", line: a[i++] });
  while (j < b.length) ops.push({ kind: "added", line: b[j++] });
  return [...prefix, ...ops, ...suffix];
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Debounce for autosave. Returns a cancel function alongside the caller. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
  run.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return run;
}
