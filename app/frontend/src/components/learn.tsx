/**
 * Shared furniture for the Learn pages.
 *
 * These pages are the in-app version of the YuE2 prompting guidance, kept local
 * because this machine runs offline and the guidance is scattered across a
 * model card, a repo, a ComfyUI tutorial and a handful of blogs. Every claim
 * here is either from the installed yue2 package or from a source linked at the
 * bottom of /learn.
 */
import Link from "next/link";
import * as React from "react";

import { Card } from "@/components/ui/primitives";

export function LearnPage({
  title,
  lede,
  children,
}: {
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/learn"
        className="text-xs text-[var(--sf-text-muted)] underline-offset-2 hover:text-[var(--sf-text)] hover:underline"
      >
        &larr; Learn
      </Link>
      <header className="mt-2 mb-5">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-[var(--sf-text-muted)]">{lede}</p>
      </header>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-[var(--sf-text-muted)]">
        {children}
      </div>
    </Card>
  );
}

/** A monospace block for prompts, tags and lyrics. */
export function Example({ children, label }: { children: string; label?: string }) {
  return (
    <figure className="mt-3">
      {label && (
        <figcaption className="mb-1 text-[11px] font-medium text-[var(--sf-text-faint)]">
          {label}
        </figcaption>
      )}
      <pre className="overflow-x-auto rounded-md border border-[var(--sf-border)] bg-[var(--sf-bg)] p-3 font-mono text-[12px] leading-relaxed text-[var(--sf-text)]">
        {children}
      </pre>
    </figure>
  );
}

/** Two columns of short rules: what to do, and what breaks. */
export function DoDont({ good, bad }: { good: string[]; bad: string[] }) {
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {(
        [
          ["Do", good, "var(--sf-success)"],
          ["Avoid", bad, "var(--sf-danger)"],
        ] as const
      ).map(([heading, items, colour]) => (
        <div key={heading}>
          <p className="mb-1 text-[11px] font-medium" style={{ color: colour }}>
            {heading}
          </p>
          <ul className="space-y-1 text-[12px] text-[var(--sf-text-muted)]">
            {items.map((item) => (
              <li key={item} className="flex gap-1.5">
                <span aria-hidden="true" style={{ color: colour }}>
                  &bull;
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** A labelled fact, for the numbers people come back to look up. */
export function Figures({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="mt-3 divide-y divide-[var(--sf-border)] rounded-md border border-[var(--sf-border)]">
      {rows.map(([term, value]) => (
        <div key={term} className="flex items-baseline justify-between gap-3 px-3 py-2">
          <dt className="text-[12px] text-[var(--sf-text-muted)]">{term}</dt>
          <dd className="shrink-0 font-mono text-[12px] text-[var(--sf-text)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
