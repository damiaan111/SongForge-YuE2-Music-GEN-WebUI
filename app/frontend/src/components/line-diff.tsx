"use client";

/** Line-by-line comparison of two texts, for lyrics and scores. */
import * as React from "react";

import { cn, diffLines } from "@/lib/utils";

export function LineDiff({
  before,
  after,
  beforeLabel,
  afterLabel,
  className,
}: {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  className?: string;
}) {
  const ops = React.useMemo(() => diffLines(before, after), [before, after]);
  const added = ops.filter((op) => op.kind === "added").length;
  const removed = ops.filter((op) => op.kind === "removed").length;

  return (
    <div className={className}>
      <p className="mb-1.5 text-xs text-ink-faint">
        <span className="text-danger">− {removed} from {beforeLabel}</span>
        {"  ·  "}
        <span className="text-success">+ {added} in {afterLabel}</span>
      </p>
      {added === 0 && removed === 0 ? (
        <p className="text-xs text-ink-muted">No differences.</p>
      ) : (
        <pre
          className="max-h-80 overflow-auto rounded-lg border border-edge bg-sunken p-2 font-mono text-xs leading-5"
          aria-label={`Changes from ${beforeLabel} to ${afterLabel}`}
        >
          {ops.map((op, index) => (
            <div
              key={index}
              className={cn(
                "whitespace-pre-wrap px-1",
                op.kind === "added" && "bg-success/10 text-success",
                op.kind === "removed" && "bg-danger/10 text-danger",
                op.kind === "same" && "text-ink-faint",
              )}
            >
              <span aria-hidden="true" className="mr-2 select-none">
                {op.kind === "added" ? "+" : op.kind === "removed" ? "−" : " "}
              </span>
              <span className="sr-only">
                {op.kind === "added" ? "added: " : op.kind === "removed" ? "removed: " : ""}
              </span>
              {op.line || " "}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
