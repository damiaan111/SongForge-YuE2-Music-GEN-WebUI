"use client";

/**
 * Learn - the in-app guide.
 *
 * Three short pages plus a troubleshooting table keyed to the warnings this app
 * actually emits, so a warning can be looked up rather than guessed at.
 */
import Link from "next/link";
import { BookOpen, Clock, ExternalLink, Mic2, Wrench } from "lucide-react";

import { Card } from "@/components/ui/primitives";

const PAGES = [
  {
    href: "/learn/style",
    icon: Mic2,
    title: "Writing style tags",
    body: "What goes in the style box, in which order, and why the first few words matter most.",
  },
  {
    href: "/learn/lyrics",
    icon: BookOpen,
    title: "Writing lyrics YuE2 will sing",
    body: "Section tags, how long a section should be, and the four habits that cause dropped or rushed words.",
  },
  {
    href: "/learn/length",
    icon: Clock,
    title: "Why songs get cut short",
    body: "The six-minute ceiling, the shared context window, and how to read the budget meter.",
  },
];

/** Keyed to the exact wording the app uses, so a warning can be searched for. */
const TROUBLESHOOTING: [string, string][] = [
  [
    "The song hit the six-minute ceiling",
    "The lyrics were longer than YuE2 can perform in one render. Remove a section and render again; the budget meter on Create warns before you spend the GPU time.",
  ],
  [
    "The score plan ran out of room",
    "Planning stopped before the end, so later sections had no plan. Fewer sections, or shorter ones, fixes it.",
  ],
  [
    "This prompt does not fit YuE2's context",
    "Style, lyrics and score together leave no room for the music. YuE2 refuses rather than truncating, so the job fails outright. Shorten the style tags first - they are usually the easiest to cut.",
  ],
  [
    "The writer hit its output limit",
    "The local lyrics model stopped mid-song. Ask for a shorter song, or finish the last section yourself in the editor.",
  ],
  [
    "A repeated section was written out in full",
    "Not a problem: the app expanded an \"x2\" marker for you, because YuE2 sings such markers instead of expanding them.",
  ],
  [
    "No section tags were written",
    "The lyrics arrived without [Verse] or [Chorus], so everything was marked as one verse. Add tags before rendering; structure is most of what the planner has to work with.",
  ],
  [
    "OutOfMemoryError during a render",
    "The card is full. Check that the lyrics model was unloaded (Lyrics page, Unload), that no other GPU process is running, and that the memory budget in Settings matches your card.",
  ],
];

const SOURCES: [string, string][] = [
  ["YuE2-3B model card (m-a-p)", "https://huggingface.co/m-a-p/YuE2-3B"],
  ["YuE2 repository", "https://github.com/multimodal-art-projection/YuE"],
  ["YuE2 project page", "https://map-yue2.github.io/"],
  ["ComfyUI YuE2 tutorial - token budgets and modes", "https://docs.comfy.org/tutorials/audio/yue2/yue2"],
  ["Prompt guide: style tags and lyric formatting", "https://chunks.md/yue2-prompt-guide"],
  ["Prompt guide: planning modes and takes", "https://songcreator.pro/blog/yue2-prompting-guide"],
];

export default function LearnPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Learn</h1>
        <p className="mt-0.5 text-sm text-[var(--sf-text-muted)]">
          How to get the most out of YuE2 on this machine. Written for the model that
          is installed here, not for Suno.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        {PAGES.map(({ href, icon: Icon, title, body }) => (
          <Link
            key={href}
            href={href}
            className="rounded-xl border border-[var(--sf-border)] bg-[var(--sf-bg-raised)] p-4 transition-colors hover:border-[var(--sf-border-strong)]"
          >
            <Icon className="h-4 w-4 text-[var(--sf-accent)]" aria-hidden="true" />
            <p className="mt-2 text-sm font-medium">{title}</p>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--sf-text-muted)]">
              {body}
            </p>
          </Link>
        ))}
      </div>

      <Card className="mt-4 p-5">
        <h2 className="text-sm font-semibold">The short version</h2>
        <ol className="mt-2 list-inside list-decimal space-y-1.5 text-sm text-[var(--sf-text-muted)]">
          <li>
            Style as comma-separated tags, most important first: language, genre, vocal,
            instruments, mood, tempo.
          </li>
          <li>
            Lyrics with a <code className="font-mono text-[12px]">[Section]</code> tag on
            its own line, four to six lines each, every repeat written out in full.
          </li>
          <li>Keep the whole song under six minutes - watch the meter on Create.</li>
          <li>
            Render two takes and keep the better one. This is the single biggest
            improvement available, and it is the model&apos;s own baseline.
          </li>
          <li>Change one thing at a time, and keep the seed fixed while comparing.</li>
        </ol>
      </Card>

      <Card className="mt-4 p-5">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
          When the app warns you
        </h2>
        <dl className="mt-3 divide-y divide-[var(--sf-border)]">
          {TROUBLESHOOTING.map(([warning, fix]) => (
            <div key={warning} className="py-2.5 first:pt-0 last:pb-0">
              <dt className="text-[13px] font-medium text-[var(--sf-text)]">{warning}</dt>
              <dd className="mt-0.5 text-[12px] leading-relaxed text-[var(--sf-text-muted)]">
                {fix}
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card className="mt-4 p-5">
        <h2 className="text-sm font-semibold">Sources</h2>
        <p className="mt-1 text-[12px] text-[var(--sf-text-muted)]">
          These need an internet connection; the pages above do not.
        </p>
        <ul className="mt-2 space-y-1.5">
          {SOURCES.map(([label, href]) => (
            <li key={href}>
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1.5 text-[13px] text-[var(--sf-accent)] underline-offset-2 hover:underline"
              >
                {label}
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
