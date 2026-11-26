"use client";

/**
 * How much song fits.
 *
 * YuE2 has no duration control: length follows the lyrics, and it stops after
 * about six minutes wherever it happens to be. Before this meter existed, the
 * only way to discover that was to spend four minutes of GPU time and listen to
 * the last verse go missing. The numbers come from the backend (POST
 * /api/estimate) so the UI and the runner never disagree about the ceilings.
 */
import Link from "next/link";
import * as React from "react";

import * as api from "@/lib/api";
import type { CotMode, Estimate } from "@/lib/types";
import { cn } from "@/lib/utils";

const TONES: Record<Estimate["verdict"], { colour: string; label: string }> = {
  ok: { colour: "var(--sf-success)", label: "Fits" },
  tight: { colour: "var(--sf-warning)", label: "Close to the limit" },
  over_length: { colour: "var(--sf-danger)", label: "Too long" },
  over_context: { colour: "var(--sf-danger)", label: "Will be refused" },
};

export interface BudgetInput {
  style: string;
  lyrics: string;
  scoreAbc?: string;
  cot?: CotMode;
  instrumental?: boolean;
}

/**
 * Ask the backend for an estimate, debounced. Returns null until the first
 * answer arrives, and keeps the previous answer while a new one is in flight so
 * the meter does not flicker on every keystroke.
 */
export function useBudget(input: BudgetInput): Estimate | null {
  const [estimate, setEstimate] = React.useState<Estimate | null>(null);
  const { style, lyrics, scoreAbc, cot, instrumental } = input;

  React.useEffect(() => {
    // The cleanup both debounces (the timer is cleared on every keystroke) and
    // discards a reply that is already stale, so no ref-based request token is
    // needed and a slow answer can never overwrite a newer one.
    let cancelled = false;
    const timer = setTimeout(() => {
      void api
        .estimate({
          style_prompt: style,
          lyrics,
          score_abc: scoreAbc ?? "",
          cot: cot ?? "full",
          instrumental: instrumental ?? false,
        })
        .then((result) => {
          if (!cancelled) setEstimate(result);
        })
        .catch(() => {
          /* the backend-offline banner already says this */
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [style, lyrics, scoreAbc, cot, instrumental]);

  return estimate;
}

export function BudgetMeter({
  estimate,
  className,
}: {
  estimate: Estimate | null;
  className?: string;
}) {
  if (!estimate) return null;
  const tone = TONES[estimate.verdict];
  const fraction = Math.min(1, estimate.seconds / estimate.max_seconds);
  const overflowing = estimate.seconds > estimate.max_seconds;
  const ceilingMinutes = Math.round(estimate.max_seconds / 60);
  // A tick per minute, so the bar reads as a ruler rather than a mystery fill.
  const ticks = Array.from({ length: Math.max(0, ceilingMinutes - 1) }, (_, index) => index + 1);

  return (
    <div className={cn("rounded-xl border border-edge bg-sunken/60 p-4", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-faint">
            Estimated length
          </p>
          <p className="mt-0.5 text-[15px] font-semibold text-ink">{estimate.headline}</p>
        </div>
        <span
          className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
          style={{
            color: tone.colour,
            borderColor: `color-mix(in oklab, ${tone.colour} 30%, transparent)`,
            backgroundColor: `color-mix(in oklab, ${tone.colour} 12%, transparent)`,
          }}
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
          {tone.label}
        </span>
      </div>

      {/* The bar is the whole six minutes, so the ceiling is always visible. */}
      <div
        className="relative mt-3"
        role="img"
        aria-label={`${estimate.headline}. ${estimate.detail}`}
      >
        <div className="h-2 w-full overflow-hidden rounded-full bg-elevated">
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{
              width: `${Math.max(2, fraction * 100)}%`,
              backgroundColor: tone.colour,
            }}
          />
        </div>
        {ticks.map((minute) => (
          <span
            key={minute}
            aria-hidden="true"
            className="absolute top-0 h-2 w-px bg-sunken/70"
            style={{ left: `${(minute / ceilingMinutes) * 100}%` }}
          />
        ))}
        <div className="mt-1 flex justify-between text-xs tabular-nums text-ink-faint" aria-hidden="true">
          <span>0:00</span>
          <span>{ceilingMinutes}:00 limit</span>
        </div>
      </div>

      <p className="mt-2.5 text-[13px] leading-relaxed text-ink-muted">
        {estimate.detail}
        {estimate.advice && <> {estimate.advice}</>}{" "}
        <Link
          href="/learn/length"
          className="font-medium text-accent underline-offset-2 hover:underline"
        >
          Why songs get cut short
        </Link>
      </p>

      <details className="sf-disclosure mt-3 border-t border-edge pt-3">
        <summary className="text-xs font-medium text-ink-faint hover:text-ink-muted">
          Token budget
        </summary>
        <dl className="mt-2.5 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-xs text-ink-muted">
          <dt>Music</dt>
          <dd className={cn("text-right tabular-nums", overflowing && "text-danger")}>
            {estimate.music_tokens.toLocaleString()} of {estimate.music_cap.toLocaleString()}
          </dd>
          <dt>Style and lyrics</dt>
          <dd className="text-right tabular-nums">{estimate.prompt_tokens.toLocaleString()}</dd>
          <dt>Score plan (reserved)</dt>
          <dd className="text-right tabular-nums">{estimate.plan_tokens.toLocaleString()}</dd>
          <dt>Context in total</dt>
          <dd
            className={cn(
              "text-right tabular-nums",
              estimate.context_tokens > estimate.context_total && "text-danger",
            )}
          >
            {estimate.context_tokens.toLocaleString()} of{" "}
            {estimate.context_total.toLocaleString()}
          </dd>
        </dl>
      </details>
    </div>
  );
}
