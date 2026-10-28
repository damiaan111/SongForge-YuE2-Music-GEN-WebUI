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
import { Ban, Loader2, ListMusic } from "lucide-react";

import { Button } from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useStore } from "@/lib/store";
import type { Job } from "@/lib/types";
import { STAGE_LABELS } from "@/lib/types";
import { cn } from "@/lib/utils";

export function QueuePanel({ className }: { className?: string }) {
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
      <div className={cn("px-1 py-2", className)}>
        <p className="flex items-center gap-1.5 text-[11px] text-[var(--sf-text-faint)]">
          <ListMusic className="h-3.5 w-3.5" aria-hidden="true" />
          Queue is empty
        </p>
      </div>
    );
  }

  return (
    <section className={cn("space-y-2", className)} aria-label="Generation queue">
      <h2 className="px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--sf-text-faint)]">
        Queue
      </h2>

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
    <div className="rounded-lg border border-[var(--sf-border)] bg-[var(--sf-bg)] p-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Link
            href={`/song/${job.project_id}`}
            className="block truncate text-xs font-medium hover:text-[var(--sf-accent)]"
          >
            {job.project_title || "Untitled"}
          </Link>
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-[var(--sf-text-muted)]">
            {running ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                {STAGE_LABELS[job.stage] ?? job.stage}
                {percent !== null && <span>· {percent}%</span>}
              </>
            ) : (
              <>Waiting · position {job.queue_position ?? "?"}</>
            )}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onCancel}
          loading={cancelling}
          aria-label={`Cancel ${job.project_title || "job"}`}
          title="Cancel"
        >
          {!cancelling && <Ban className="h-3.5 w-3.5" aria-hidden="true" />}
        </Button>
      </div>

      {running && (
        <div className="mt-2">
          {percent !== null ? (
            <div
              className="h-1 overflow-hidden rounded-full bg-[var(--sf-bg-overlay)]"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Generation progress"
            >
              <div
                className="h-full rounded-full bg-[var(--sf-accent)] transition-[width] duration-500"
                style={{ width: `${percent}%` }}
              />
            </div>
          ) : (
            // No honest percentage exists for this runner, so show motion
            // without implying a position.
            <div
              className="h-1 overflow-hidden rounded-full bg-[var(--sf-bg-overlay)]"
              role="status"
              aria-label="Generating; progress is reported by stage"
            >
              <div className="sf-shimmer h-full w-full rounded-full opacity-70" />
            </div>
          )}
          {job.message && (
            <p className="mt-1.5 truncate text-[10px] text-[var(--sf-text-faint)]">
              {job.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
