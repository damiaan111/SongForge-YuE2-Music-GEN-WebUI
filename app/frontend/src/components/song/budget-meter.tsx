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

  return (
    <div
      className={cn(
        "rounded-lg border border-[var(--sf-border)] bg-[var(--sf-bg)] p-3",
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-[var(--sf-text)]">{estimate.headline}</p>
        <span className="shrink-0 text-[11px]" style={{ color: tone.colour }}>
          {tone.label}
        </span>
      </div>

      {/* The bar is the whole six minutes, so the ceiling is always visible. */}
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--sf-bg-overlay)]"
        role="img"
        aria-label={`${estimate.headline}. ${estimate.detail}`}
      >
        <div
          className="h-full rounded-full transition-[width]"
          style={{
            width: `${Math.max(2, fraction * 100)}%`,
            backgroundColor: tone.colour,
          }}
        />
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-[var(--sf-text-muted)]">
        {estimate.detail}
        {estimate.advice && <> {estimate.advice}</>}{" "}
        <Link
          href="/learn/length"
          className="text-[var(--sf-accent)] underline-offset-2 hover:underline"
        >
          Why songs get cut short
        </Link>
      </p>

      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-[var(--sf-text-faint)]">
          Token budget
        </summary>
        <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-[var(--sf-text-faint)]">
          <dt>Music</dt>
          <dd className={overflowing ? "text-[var(--sf-danger)]" : undefined}>
            {estimate.music_tokens.toLocaleString()} of {estimate.music_cap.toLocaleString()}
          </dd>
          <dt>Style and lyrics</dt>
          <dd>{estimate.prompt_tokens.toLocaleString()}</dd>
          <dt>Score plan (reserved)</dt>
          <dd>{estimate.plan_tokens.toLocaleString()}</dd>
          <dt>Context in total</dt>
          <dd
            className={
              estimate.context_tokens > estimate.context_total
                ? "text-[var(--sf-danger)]"
                : undefined
            }
          >
            {estimate.context_tokens.toLocaleString()} of{" "}
            {estimate.context_total.toLocaleString()}
          </dd>
        </dl>
      </details>
    </div>
  );
}
