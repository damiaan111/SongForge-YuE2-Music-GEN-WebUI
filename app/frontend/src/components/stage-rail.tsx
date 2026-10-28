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
import { Ban, Check, Loader2 } from "lucide-react";

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

  const shown = (stages && stages.length > 0 ? stages : STAGE_ORDER).filter(
    (stage) => stage !== "queued",
  );
  // A queued job matches nothing here, which is correct: no stage is lit yet.
  const currentIndex = shown.findIndex((stage) => stage === job.stage);
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
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Loader2
            className="h-4 w-4 shrink-0 animate-spin text-[var(--sf-accent)]"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {job.status === "queued"
                ? `Waiting — position ${job.queue_position ?? "?"}`
                : (STAGE_LABELS[job.stage] ?? job.stage)}
              {percent !== null && job.status === "running" && (
                <span className="ml-1.5 text-[var(--sf-text-muted)]">{percent}%</span>
              )}
            </p>
            {job.message && (
              <p className="truncate text-[11px] text-[var(--sf-text-faint)]">
                {job.message}
              </p>
            )}
          </div>
        </div>
        <Button size="sm" variant="subtle" loading={cancelling} onClick={cancel}>
          {!cancelling && <Ban className="h-3.5 w-3.5" aria-hidden="true" />}
          Cancel
        </Button>
      </div>

      <ol className="flex flex-wrap gap-1.5" aria-label="Generation stages">
        {shown.map((stage, index) => {
          const done = job.status === "running" && index < currentIndex;
          const active = job.status === "running" && index === currentIndex;
          return (
            <li
              key={stage}
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] transition-colors",
                active
                  ? "bg-[var(--sf-accent)]/15 text-[var(--sf-accent)]"
                  : done
                    ? "bg-[var(--sf-success)]/10 text-[var(--sf-success)]"
                    : "bg-[var(--sf-bg-overlay)] text-[var(--sf-text-faint)]",
              )}
            >
              {done && <Check className="h-3 w-3" aria-hidden="true" />}
              {STAGE_LABELS[stage] ?? stage}
            </li>
          );
        })}
      </ol>

      {percent === null && job.status === "running" && (
        <p className="mt-2 text-[11px] text-[var(--sf-text-faint)]">
          This runner reports progress by stage rather than as a percentage, so
          there is no overall bar to show.
        </p>
      )}
    </div>
  );
}
