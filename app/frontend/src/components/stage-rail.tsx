"use client";

/**
 * Pipeline stage indicator.
 *
 * Renders exactly the stages the active runner declares, and shows a percentage
 * only when the runner genuinely produces one. Where the runner reports a
 * per-stage figure in its message (e.g. "18/32 steps (56%)") that text is shown
 * as-is rather than being folded into a misleading overall bar.
 */
import * as React from "react";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useStore } from "@/lib/store";
import type { Job, JobStage } from "@/lib/types";
import { STAGE_LABELS, STAGE_ORDER } from "@/lib/types";
import { cn } from "@/lib/utils";

export function StageRail({
  job,
  stages,
}: {
  job: Job;
  stages?: JobStage[];
}) {
  const { refreshJobs, notify } = useStore();
  const [cancelling, setCancelling] = React.useState(false);

  // "queued" is the state before the pipeline, and "completed" is its end
  // rather than a step in it: neither is something the job is ever "doing".
  const shown = (stages && stages.length > 0 ? stages : STAGE_ORDER).filter(
    (stage) => stage !== "queued" && stage !== "completed",
  );
  // A queued job matches nothing here, which is correct: no stage is lit yet.
  const currentIndex = shown.findIndex((stage) => stage === job.stage);
  const running = job.status === "running";
  const percent = job.supports_progress_percent
    ? Math.round(job.progress * 100)
    : null;

  const cancel = async () => {
    setCancelling(true);
    try {
      await api.cancelJob(job.id);
      await refreshJobs();
    } catch (cause) {
      notify({
        tone: "danger",
        title: "Could not cancel",
        body: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-accent/25" />
            <span className="sf-ember relative h-3 w-3 rounded-full" />
          </span>
          <div className="min-w-0">
            <p className="text-[15px] font-semibold text-ink">
              {job.status === "queued"
                ? `Waiting in the queue — position ${job.queue_position ?? "?"}`
                : (STAGE_LABELS[job.stage] ?? job.stage)}
              {percent !== null && running && (
                <span className="ml-2 font-normal tabular-nums text-ink-muted">{percent}%</span>
              )}
            </p>
            {job.message ? (
              <p className="truncate text-[13px] text-ink-faint" title={job.message}>
                {job.message}
              </p>
            ) : (
              <p className="text-[13px] text-ink-faint">
                You can keep working; this page updates on its own.
              </p>
            )}
          </div>
        </div>
        <Button size="sm" variant="subtle" loading={cancelling} onClick={cancel}>
          {!cancelling && <X className="h-3.5 w-3.5" aria-hidden="true" />}
          Cancel
        </Button>
      </div>

      <ol className="mt-5 flex items-start" aria-label="Generation stages">
        {shown.map((stage, index) => {
          const done = running && currentIndex > index;
          const active = running && index === currentIndex;
          return (
            <li
              key={stage}
              aria-current={active ? "step" : undefined}
              className="relative flex min-w-0 flex-1 flex-col items-center text-center"
            >
              {/* The connector to the previous step. */}
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute right-1/2 top-[0.6875rem] h-0.5 w-full -translate-y-1/2",
                    done || active ? "bg-accent/70" : "bg-edge-strong/60",
                  )}
                />
              )}
              <span
                className={cn(
                  "relative z-[1] flex h-[1.375rem] w-[1.375rem] items-center justify-center rounded-full border-2 text-xs transition-colors",
                  done && "border-accent bg-accent text-accent-ink",
                  active && "border-accent bg-raised",
                  !done && !active && "border-edge-strong bg-raised",
                )}
              >
                {done && <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />}
                {active && <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />}
              </span>
              <span
                className={cn(
                  "mt-2 w-full truncate px-1 text-xs",
                  active ? "font-medium text-ink" : done ? "text-ink-muted" : "text-ink-faint",
                )}
              >
                {STAGE_LABELS[stage] ?? stage}
              </span>
            </li>
          );
        })}
      </ol>

      {percent !== null && running ? (
        <div
          className="mt-4 h-1.5 overflow-hidden rounded-full bg-elevated"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Generation progress"
        >
          <div
            className="sf-ember h-full rounded-full transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : (
        running && (
          <p className="mt-4 text-xs text-ink-faint">
            This engine reports progress stage by stage rather than as a percentage.
          </p>
        )
      )}
    </div>
  );
}
