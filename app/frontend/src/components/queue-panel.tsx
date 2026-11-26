"use client";

/**
 * Persistent queue panel.
 *
 * Shows the running job's real stage and the waiting jobs' positions. It never
 * renders a percentage bar for a runner that does not produce one - that is
 * what `supports_progress_percent` is for.
 */
import Link from "next/link";
import * as React from "react";
import { ListMusic, X } from "lucide-react";

import { Spinner } from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useStore } from "@/lib/store";
import type { Job } from "@/lib/types";
import { STAGE_LABELS } from "@/lib/types";
import { cn } from "@/lib/utils";

export function QueuePanel({
  className,
  showHeading = true,
}: {
  className?: string;
  /** False inside a dialog that already carries the "Queue" title. */
  showHeading?: boolean;
}) {
  const { activeJob, queued, refreshJobs, notify } = useStore();
  const [cancelling, setCancelling] = React.useState<string | null>(null);

  const cancel = async (job: Job) => {
    setCancelling(job.id);
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
      setCancelling(null);
    }
  };

  if (!activeJob && queued.length === 0) {
    return (
      <p className={cn("flex items-center gap-2 px-1 py-1 text-xs text-ink-faint", className)}>
        <ListMusic className="h-3.5 w-3.5" aria-hidden="true" />
        Nothing in the queue
      </p>
    );
  }

  const count = queued.length + (activeJob ? 1 : 0);

  return (
    <section className={cn("space-y-2", className)} aria-label="Generation queue">
      {showHeading && (
        <h2 className="flex items-center justify-between px-1 font-sans text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">
          Queue
          <span className="tabular-nums">{count}</span>
        </h2>
      )}

      {activeJob && (
        <QueueRow
          job={activeJob}
          onCancel={() => cancel(activeJob)}
          cancelling={cancelling === activeJob.id}
        />
      )}

      {queued.map((job) => (
        <QueueRow
          key={job.id}
          job={job}
          onCancel={() => cancel(job)}
          cancelling={cancelling === job.id}
        />
      ))}
    </section>
  );
}

function QueueRow({
  job,
  onCancel,
  cancelling,
}: {
  job: Job;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const running = job.status === "running";
  const percent = job.supports_progress_percent
    ? Math.round(job.progress * 100)
    : null;

  return (
    <div
      className={cn(
        "rounded-control border bg-raised p-2.5",
        running ? "border-accent/35" : "border-edge",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Link
            href={`/song/${job.project_id}`}
            className="block truncate text-[13px] font-medium text-ink hover:text-accent"
          >
            {job.project_title || "Untitled"}
          </Link>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-muted">
            {running ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-60" />
                  <span className="relative h-2 w-2 rounded-full bg-accent" />
                </span>
                {STAGE_LABELS[job.stage] ?? job.stage}
                {percent !== null && <span className="tabular-nums">· {percent}%</span>}
              </>
            ) : (
              <>Waiting · position {job.queue_position ?? "?"}</>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          aria-label={`Cancel ${job.project_title || "job"}`}
          title="Cancel"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-danger/12 hover:text-danger disabled:opacity-50"
        >
          {cancelling ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : (
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      </div>

      {running && (
        <div className="mt-2">
          {percent !== null ? (
            <div
              className="h-1 overflow-hidden rounded-full bg-elevated"
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
            // No honest percentage exists for this runner, so show motion
            // without implying a position.
            <div
              className="sf-indeterminate h-1 rounded-full bg-elevated"
              role="status"
              aria-label="Generating; progress is reported by stage"
            />
          )}
          {job.message && (
            <p className="mt-1.5 truncate text-xs text-ink-faint" title={job.message}>
              {job.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
