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

import { ArrowLeft } from "lucide-react";

import { Card, PageHeader } from "@/components/ui/primitives";

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
        className="mb-4 inline-flex items-center gap-1.5 rounded-lg py-1 pr-2 text-[13px] font-medium text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Learn
      </Link>
      <PageHeader title={title} description={lede} />
      <div className="space-y-5">{children}</div>
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
    <Card className="p-5 sm:p-6">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <div className="mt-2.5 space-y-2.5 text-[0.9375rem] leading-relaxed text-ink-muted">
        {children}
      </div>
    </Card>
  );
}

/** A monospace block for prompts, tags and lyrics. */
export function Example({ children, label }: { children: string; label?: string }) {
  return (
    <figure className="mt-4">
      {label && (
        <figcaption className="mb-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-ink-faint">
          {label}
        </figcaption>
      )}
      <pre className="overflow-x-auto rounded-xl border border-edge bg-sunken p-4 font-mono text-[13px] leading-relaxed text-ink">
        {children}
      </pre>
    </figure>
  );
}

/** Two columns of short rules: what to do, and what breaks. */
export function DoDont({ good, bad }: { good: string[]; bad: string[] }) {
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      {(
        [
          ["Do", good, "var(--sf-success)"],
          ["Avoid", bad, "var(--sf-danger)"],
        ] as const
      ).map(([heading, items, colour]) => (
        <div
          key={heading}
          className="rounded-xl border p-4"
          style={{
            borderColor: `color-mix(in oklab, ${colour} 30%, transparent)`,
            backgroundColor: `color-mix(in oklab, ${colour} 7%, transparent)`,
          }}
        >
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em]" style={{ color: colour }}>
            {heading}
          </p>
          <ul className="space-y-1.5 text-[13px] leading-relaxed text-ink-muted">
            {items.map((item) => (
              <li key={item} className="flex gap-2">
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
    <dl className="mt-4 divide-y divide-edge rounded-xl border border-edge bg-sunken/60">
      {rows.map(([term, value]) => (
        <div key={term} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
          <dt className="text-[13px] text-ink-muted">{term}</dt>
          <dd className="shrink-0 font-mono text-[13px] text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
