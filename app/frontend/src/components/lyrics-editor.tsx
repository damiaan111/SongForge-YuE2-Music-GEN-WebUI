"use client";

/**
 * Lyrics editor with section tags, counters, templates and revision history.
 *
 * YuE2 reads `[Verse]` / `[Chorus]` markers inside the lyric block, so the
 * insert buttons write real structure rather than decoration. Nothing here ever
 * replaces the user's text without an explicit confirmation.
 */
import Link from "next/link";
import * as React from "react";
import { ChevronDown, History, LayoutTemplate, RotateCcw, Wand2 } from "lucide-react";

import { LineDiff } from "@/components/line-diff";
import {
  LyricsWriter,
  lyricsWriterAvailable,
  type LyricsWriterProps,
} from "@/components/lyrics-writer";
import * as api from "@/lib/api";
import type { LyricsResult } from "@/lib/types";
import { Button, Dialog, Menu, MenuItem, Textarea } from "@/components/ui/primitives";
import { lintLyrics } from "@/lib/lyrics-lint";
import { countText } from "@/lib/utils";

const SECTIONS = [
  "Intro",
  "Verse",
  "Pre-Chorus",
  "Chorus",
  "Bridge",
  "Outro",
] as const;

const TEMPLATES: { name: string; description: string; body: string }[] = [
  {
    name: "Verse / Chorus",
    description: "The common pop shape",
    body: `[Verse]


[Chorus]


[Verse]


[Chorus]


[Outro]
`,
  },
  {
    name: "With a bridge",
    description: "Adds a contrasting section before the last chorus",
    body: `[Intro]

[Verse]


[Pre-Chorus]


[Chorus]


[Verse]


[Chorus]


[Bridge]


[Chorus]


[Outro]
`,
  },
  {
    name: "Simple ballad",
    description: "Two verses and a repeated chorus",
    body: `[Verse]


[Chorus]


[Verse]


[Chorus]
`,
  },
];

export interface LyricsEditorProps {
  value: string;
  onChange: (next: string) => void;
  id?: string;
  disabled?: boolean;
  rows?: number;
  /** Shown under the counters, e.g. the length-to-duration hint. */
  hint?: React.ReactNode;
  /**
   * Persist revision history in this browser under this key (e.g. a project
   * id). Without it history lives only as long as the editor is mounted, which
   * in the song workspace meant it vanished on every tab switch.
   */
  historyKey?: string;
  /**
   * Show a "Generate lyrics" button that opens the local lyrics writer inline.
   * `onResult` receives the title and style the writer suggests; the lyrics
   * themselves go through `onChange`, after the current text is kept in history.
   */
  writer?: Omit<LyricsWriterProps, "currentLyrics" | "onUse" | "onWriteAndRender"> & {
    onResult?: (result: LyricsResult, options: { applyStyle: boolean; applyTitle: boolean }) => void;
    onWriteAndRender?: (result: LyricsResult) => Promise<void> | void;
    /** Open the writer on first render, e.g. when the editor is empty. */
    openInitially?: boolean;
  };
}

type HistoryEntry = { at: number; text: string };

const HISTORY_LIMIT = 20;

function historyStorageKey(key: string) {
  return `songforge.lyrics-history.${key}`;
}

function readHistory(key: string | undefined): HistoryEntry[] {
  if (!key || typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(historyStorageKey(key)) ?? "[]");
    return Array.isArray(parsed)
      ? parsed
          .filter(
            (entry): entry is HistoryEntry =>
              entry && typeof entry.at === "number" && typeof entry.text === "string",
          )
          .slice(0, HISTORY_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function LyricsEditor({
  value,
  onChange,
  id = "lyrics",
  disabled,
  rows = 14,
  hint,
  historyKey,
  writer,
}: LyricsEditorProps) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  // The writer opens by itself only when it can actually be used. Opening a
  // panel that says "not installed" on every empty song is a nag, and the
  // writer is optional: someone who skipped it should never be reminded of it
  // unless they go looking.
  const [showWriter, setShowWriter] = React.useState(false);
  const [writerAvailable, setWriterAvailable] = React.useState<boolean | null>(null);
  const writerTouched = React.useRef(false);
  const wantsWriter = Boolean(writer);
  const openInitially = Boolean(writer?.openInitially);
  React.useEffect(() => {
    if (!wantsWriter) return;
    let cancelled = false;
    api
      .getLyricsStatus()
      .then((status) => {
        if (cancelled) return;
        const available = lyricsWriterAvailable(status);
        setWriterAvailable(available);
        if (available && openInitially && !writerTouched.current) setShowWriter(true);
      })
      .catch(() => {
        if (!cancelled) setWriterAvailable(false);
      });
    return () => {
      cancelled = true;
    };
    // Checked once per mount: `openInitially` describes the first render only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsWriter]);
  // Only keyed editors read storage, and those render client-side after their
  // data has loaded, so the lazy read cannot cause a hydration mismatch.
  const [history, setHistory] = React.useState<HistoryEntry[]>(() => readHistory(historyKey));
  const [expanded, setExpanded] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!historyKey) return;
    try {
      localStorage.setItem(historyStorageKey(historyKey), JSON.stringify(history));
    } catch {
      /* storage full or unavailable: history still works for this session */
    }
  }, [history, historyKey]);
  const [showHistory, setShowHistory] = React.useState(false);
  const [pendingTemplate, setPendingTemplate] = React.useState<
    (typeof TEMPLATES)[number] | null
  >(null);

  const counts = countText(value);
  // Notes, not validation: nothing here prevents a render.
  const findings = React.useMemo(() => lintLyrics(value), [value]);

  // Snapshot before each destructive change, so nothing is lost silently.
  const snapshot = React.useCallback(
    (text: string) => {
      setHistory((current) =>
        [{ at: Date.now(), text }, ...current.filter((e) => e.text !== text)].slice(
          0,
          HISTORY_LIMIT,
        ),
      );
    },
    [],
  );

  const insertSection = (section: string) => {
    const textarea = textareaRef.current;
    const tag = `[${section}]\n`;
    if (!textarea) {
      onChange(value ? `${value.replace(/\n*$/, "")}\n\n${tag}` : tag);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = value.slice(0, start);
    const after = value.slice(end);
    // Keep a blank line before the tag unless we are at the very start.
    const prefix = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
    const next = `${before}${prefix}${tag}${after}`;
    onChange(next);
    requestAnimationFrame(() => {
      const caret = before.length + prefix.length + tag.length;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  };

  const applyTemplate = (template: (typeof TEMPLATES)[number]) => {
    if (value.trim()) {
      // Never overwrite written lyrics without asking.
      setPendingTemplate(template);
      return;
    }
    snapshot(value);
    onChange(template.body);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Insert a section tag">
          {SECTIONS.map((section) => (
            <button
              key={section}
              type="button"
              disabled={disabled}
              onClick={() => insertSection(section)}
              title={`Insert [${section}]`}
              className="h-8 rounded-lg border border-edge bg-raised px-2.5 font-mono text-xs text-ink-muted transition-colors hover:border-accent/60 hover:bg-accent/10 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {section}
            </button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1">
          <TemplateMenu disabled={disabled} onPick={applyTemplate} />

          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || history.length === 0}
            onClick={() => setShowHistory(true)}
          >
            <History className="h-3.5 w-3.5" aria-hidden="true" />
            History
            {history.length > 0 && (
              <span className="tabular-nums text-ink-faint">{history.length}</span>
            )}
          </Button>

          {writer && (
            <Button
              // Prominent when it works, a plain link when it is not set up.
              variant={showWriter ? "secondary" : writerAvailable ? "primary" : "subtle"}
              size="sm"
              disabled={disabled}
              aria-expanded={showWriter}
              aria-controls={`${id}-writer`}
              onClick={() => {
                writerTouched.current = true;
                setShowWriter((open) => !open);
              }}
            >
              <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
              {showWriter ? "Hide writer" : "Write for me"}
            </Button>
          )}
        </div>
      </div>

      {writer && showWriter && (
        <div
          id={`${id}-writer`}
          className="sf-rise rounded-xl border border-edge-strong bg-overlay/50 p-4 sm:p-5"
        >
          <LyricsWriter
            {...writer}
            currentLyrics={value}
            onUse={(result, options) => {
              // Keep what was there, so "Use these lyrics" is always undoable.
              if (value.trim()) snapshot(value);
              onChange(result.lyrics);
              writer.onResult?.(result, options);
              setShowWriter(false);
            }}
            onWriteAndRender={
              writer.onWriteAndRender
                ? async (result) => {
                    if (value.trim()) snapshot(value);
                    onChange(result.lyrics);
                    await writer.onWriteAndRender?.(result);
                  }
                : undefined
            }
          />
        </div>
      )}

      <Textarea
        id={id}
        ref={textareaRef}
        value={value}
        rows={rows}
        disabled={disabled}
        aria-label="Lyrics"
        aria-describedby={`${id}-counts`}
        spellCheck
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => {
          if (value.trim()) snapshot(value);
        }}
        placeholder={"[Verse]\nWrite the first line here\n\n[Chorus]\nAnd the hook here"}
        className="font-mono text-sm leading-7"
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-faint">
        <span id={`${id}-counts`} className="tabular-nums">
          {counts.characters.toLocaleString()} characters · {counts.lines}{" "}
          {counts.lines === 1 ? "line" : "lines"} · {counts.words} words
        </span>
        {hint}
      </div>

      {findings.length > 0 && (
        <div className="rounded-xl border border-edge bg-sunken/60 p-3.5">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-ink-faint">
            Notes on these lyrics
          </p>
          <ul className="space-y-2">
            {findings.map((finding) => (
              <li key={finding.id} className="flex items-start gap-2 text-[13px] leading-relaxed">
                <span
                  aria-hidden="true"
                  className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor:
                      finding.severity === "warning"
                        ? "var(--sf-warning)"
                        : "var(--sf-text-faint)",
                  }}
                />
                <span className="text-ink-muted">
                  <strong className="font-medium text-ink">{finding.message}.</strong>{" "}
                  {finding.why}
                </span>
              </li>
            ))}
          </ul>
          <Link
            href="/learn/lyrics"
            className="mt-2.5 inline-block text-[13px] font-medium text-accent underline-offset-2 hover:underline"
          >
            Writing lyrics YuE2 will sing
          </Link>
        </div>
      )}

      {/* --- Confirm before replacing written lyrics --- */}
      <Dialog
        open={pendingTemplate !== null}
        onClose={() => setPendingTemplate(null)}
        title="Replace your lyrics?"
        description={`Applying the “${pendingTemplate?.name ?? ""}” template will replace what you have written. The current text is kept in History so you can restore it.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingTemplate(null)}>
              Keep my lyrics
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (pendingTemplate) {
                  snapshot(value);
                  onChange(pendingTemplate.body);
                }
                setPendingTemplate(null);
              }}
            >
              Replace
            </Button>
          </>
        }
      />

      {/* --- Revision history --- */}
      <Dialog
        open={showHistory}
        onClose={() => setShowHistory(false)}
        title="Lyrics history"
        size="lg"
        description={
          historyKey
            ? "Earlier drafts of these lyrics, kept in this browser. Restoring keeps the current text in history too."
            : "Earlier versions from this editing session. Restoring keeps the current text in history too."
        }
        footer={
          <Button variant="ghost" onClick={() => setShowHistory(false)}>
            Close
          </Button>
        }
      >
        <div className="space-y-2 pb-1">
          {history.length === 0 && (
            <p className="text-sm text-ink-muted">Nothing saved yet.</p>
          )}
          {history.map((entry) => (
            <div
              key={entry.at}
              className="rounded-xl border border-edge bg-sunken/60 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-ink-faint">
                  {new Date(entry.at).toLocaleString()}
                </span>
                <button
                  type="button"
                  className="ml-auto text-[13px] font-medium text-accent hover:underline"
                  aria-expanded={expanded === entry.at}
                  onClick={() => setExpanded((current) => (current === entry.at ? null : entry.at))}
                >
                  {expanded === entry.at ? "Hide changes" : "Compare with current"}
                </button>
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={() => {
                    snapshot(value);
                    onChange(entry.text);
                    setShowHistory(false);
                  }}
                >
                  <RotateCcw className="h-3 w-3" aria-hidden="true" />
                  Restore
                </Button>
              </div>
              {expanded === entry.at ? (
                <LineDiff
                  className="mt-2"
                  before={entry.text}
                  after={value}
                  beforeLabel="this draft"
                  afterLabel="current"
                />
              ) : (
                <pre className="mt-2 max-h-24 overflow-hidden whitespace-pre-wrap font-mono text-xs leading-5 text-ink-muted">
                  {entry.text.slice(0, 300)}
                  {entry.text.length > 300 ? "…" : ""}
                </pre>
              )}
            </div>
          ))}
        </div>
      </Dialog>
    </div>
  );
}

function TemplateMenu({
  disabled,
  onPick,
}: {
  disabled?: boolean;
  onPick: (template: (typeof TEMPLATES)[number]) => void;
}) {
  return (
    <Menu
      align="end"
      label="Lyric templates"
      trigger={(props) => (
        <Button {...props} variant="ghost" size="sm" disabled={disabled}>
          <LayoutTemplate className="h-3.5 w-3.5" aria-hidden="true" />
          Template
          <ChevronDown className="h-3 w-3 opacity-70" aria-hidden="true" />
        </Button>
      )}
    >
      {(close) => (
        <div className="w-64">
          {TEMPLATES.map((template) => (
            <MenuItem
              key={template.name}
              description={template.description}
              onClick={() => {
                close();
                onPick(template);
              }}
            >
              <span className="font-medium text-ink">{template.name}</span>
            </MenuItem>
          ))}
        </div>
      )}
    </Menu>
  );
}
