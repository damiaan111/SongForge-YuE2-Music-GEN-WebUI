"use client";

/**
 * Score tab - the YuE2 capability nothing Suno-shaped has.
 *
 * The model writes a symbolic ABC score before it sings, and will accept an
 * edited one back. This tab is where that loop happens: read the score, change
 * it, then render audio from it with the seed pinned so only the arrangement
 * moves.
 */
import * as React from "react";
import { Check, Download, ListMusic, Music4, Save, Sparkles } from "lucide-react";

import { LineDiff } from "@/components/line-diff";
import {
  Badge,
  Banner,
  Button,
  buttonClasses,
  Card,
  Textarea,
} from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useStore } from "@/lib/store";
import type { ProjectDetail, Version } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Header fields ABC requires or commonly carries, for the guided view. */
const HEADER_FIELDS: { key: string; label: string }[] = [
  { key: "X", label: "Reference number" },
  { key: "T", label: "Title" },
  { key: "M", label: "Metre" },
  { key: "L", label: "Default note length" },
  { key: "Q", label: "Tempo" },
  { key: "K", label: "Key" },
];

interface Parsed {
  headers: Record<string, string>;
  voices: string[];
  sections: string[];
  bars: number;
  /** Stops the score parsing or renders it meaningless. */
  problems: string[];
  /** Parses, but the model is left guessing something it could be told. */
  notes: string[];
}

/** Optional headers worth having, and what their absence costs. */
const SOFT_HEADERS: { key: string; note: string }[] = [
  { key: "M", note: "No M: metre, so the bar length is assumed." },
  { key: "L", note: "No L: default note length, so durations are guessed from the metre." },
  { key: "Q", note: "No Q: tempo. The style tags are then the only tempo hint." },
  { key: "T", note: "No T: title. Harmless, but it travels with the score." },
];

function parseAbc(text: string): Parsed {
  const headers: Record<string, string> = {};
  const voices: string[] = [];
  const sections: string[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  let bars = 0;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const header = /^([A-Za-z]):\s*(.*)$/.exec(line);
    if (header) {
      const [, key, value] = header;
      if (key === "V") {
        const name = /name="([^"]+)"/.exec(value)?.[1] ?? value.split(/\s+/)[0];
        if (name && !voices.includes(name)) voices.push(name);
      } else if (!(key in headers)) {
        headers[key] = value;
      }
      continue;
    }
    if (line.startsWith("%")) {
      const label = line.replace(/^%+\s*/, "");
      if (label) sections.push(label);
      continue;
    }
    // Body: count bar lines, ignoring the repeat and double-bar variants.
    bars += (line.match(/\|/g) ?? []).length;
  }

  if (text.trim()) {
    if (!headers.X) problems.push("Missing X: reference number.");
    if (!headers.K) problems.push("Missing K: key signature.");
    // K must be last in the header block; a body before it is a common mistake.
    const keyIndex = text.indexOf("\nK:");
    const firstBar = text.indexOf("|");
    if (keyIndex >= 0 && firstBar >= 0 && firstBar < keyIndex) {
      problems.push("K: must come after the other header fields.");
    }
    for (const { key, note } of SOFT_HEADERS) {
      if (!headers[key]) notes.push(note);
    }
    if (voices.length === 0) {
      notes.push("No V: voices, so this reads as a single part.");
    }
    if (bars === 0) {
      problems.push("No bar lines in the body; there is nothing to play.");
    }
  }

  return { headers, voices, sections, bars, problems, notes };
}

export function ScoreTab({
  project,
  version,
  onSaved,
  onRender,
  canPlan,
  onPlan,
  busy,
}: {
  project: ProjectDetail;
  version: Version | undefined;
  onSaved: () => void;
  onRender: () => void;
  canPlan: boolean;
  onPlan: () => void;
  busy: boolean;
}) {
  const { settings, notify } = useStore();
  const [text, setText] = React.useState(project.score_abc ?? "");
  const [view, setView] = React.useState<"guided" | "raw">("guided");
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  // Adopt a score that changed on the server (a plan run finished, a take was
  // reused). Adjusted during render rather than in an effect, so the editor
  // never paints the old score first. `saved` is deliberately not reset here:
  // our own save triggers this same reload and would wipe the confirmation.
  const incoming = project.score_abc ?? "";
  const [lastIncoming, setLastIncoming] = React.useState(incoming);
  if (incoming !== lastIncoming) {
    setLastIncoming(incoming);
    setText(incoming);
  }

  const parsed = React.useMemo(() => parseAbc(text), [text]);
  const dirty = text !== (project.score_abc ?? "");
  const supported = settings?.capabilities.supports_score_abc ?? false;

  const save = async () => {
    setSaving(true);
    try {
      await api.saveScore(project.id, text);
      setSaved(true);
      onSaved();
    } catch (cause) {
      notify({
        tone: "danger",
        title: "Could not save the score",
        body: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setSaving(false);
    }
  };

  const versionScore = version?.score_abc;

  if (!supported) {
    return (
      <Banner tone="info" title="This runner does not use a score">
        Switch to the YuE2 runner in Settings to plan and edit scores.
      </Banner>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Symbolic score</h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-[var(--sf-text-muted)]">
              YuE2 writes the melody and chords as ABC notation before it sings.
              Edit this and render again to reharmonise, change a melody or
              develop a solo, without regenerating from scratch.
            </p>
          </div>
          <div
            className="flex overflow-hidden rounded-lg border border-[var(--sf-border)]"
            role="group"
            aria-label="Score view"
          >
            {(["guided", "raw"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                aria-pressed={view === mode}
                className={cn(
                  "px-3 py-1.5 text-xs capitalize",
                  view === mode
                    ? "bg-[var(--sf-bg-overlay)] text-[var(--sf-text)]"
                    : "text-[var(--sf-text-muted)] hover:text-[var(--sf-text)]",
                )}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        {!text.trim() ? (
          <div className="rounded-lg border border-dashed border-[var(--sf-border)] p-8 text-center">
            <Music4
              className="mx-auto mb-3 h-8 w-8 text-[var(--sf-text-faint)]"
              aria-hidden="true"
            />
            <p className="text-sm">No score yet</p>
            <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-[var(--sf-text-muted)]">
              Run <strong>Plan only</strong> to write the score without spending
              the time on audio. Then edit it here and render.
            </p>
            {canPlan && (
              <Button
                variant="primary"
                className="mt-4"
                onClick={onPlan}
                loading={busy}
              >
                <ListMusic className="h-4 w-4" aria-hidden="true" />
                Plan the score
              </Button>
            )}
          </div>
        ) : (
          <>
            {view === "guided" && (
              <div className="mb-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-[var(--sf-border)] p-3">
                  <p className="mb-2 text-[11px] font-medium text-[var(--sf-text-muted)]">
                    Header
                  </p>
                  <dl className="space-y-1 text-xs">
                    {HEADER_FIELDS.map((field) => (
                      <div key={field.key} className="flex justify-between gap-2">
                        <dt className="text-[var(--sf-text-faint)]">{field.label}</dt>
                        <dd className="font-mono">
                          {parsed.headers[field.key] ?? (
                            <span className="text-[var(--sf-text-faint)]">—</span>
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <div className="rounded-lg border border-[var(--sf-border)] p-3">
                  <p className="mb-2 text-[11px] font-medium text-[var(--sf-text-muted)]">
                    Structure
                  </p>
                  {parsed.voices.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1">
                      {parsed.voices.map((voice) => (
                        <Badge key={voice} tone="accent">
                          {voice}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {parsed.sections.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {parsed.sections.map((section, index) => (
                        <Badge key={`${section}-${index}`} tone="neutral">
                          {section}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--sf-text-faint)]">
                      No section comments found.
                    </p>
                  )}
                  <p className="mt-2 text-[11px] text-[var(--sf-text-faint)]">
                    {parsed.bars} bar {parsed.bars === 1 ? "line" : "lines"}
                    {parsed.voices.length > 1 && ` across ${parsed.voices.length} voices`}
                  </p>
                </div>
              </div>
            )}

            {parsed.problems.length > 0 && (
              <div className="mb-3">
                <Banner tone="warning" title="This score may not parse">
                  <ul className="list-inside list-disc space-y-0.5">
                    {parsed.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </Banner>
              </div>
            )}

            {/* Soft notes only in the guided view: the raw view is for people
                who already know what they left out. */}
            {view === "guided" && parsed.notes.length > 0 && (
              <ul className="mb-3 space-y-1 text-[11px] text-[var(--sf-text-faint)]">
                {parsed.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}

            <Textarea
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setSaved(false);
              }}
              rows={view === "raw" ? 26 : 16}
              spellCheck={false}
              aria-label="ABC score"
              className="font-mono text-[12px] leading-5"
            />

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant={dirty ? "primary" : "secondary"}
                onClick={save}
                loading={saving}
                disabled={!dirty}
              >
                {saved && !dirty ? (
                  <Check className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Save className="h-4 w-4" aria-hidden="true" />
                )}
                {saved && !dirty ? "Saved" : "Save score"}
              </Button>

              <Button
                onClick={async () => {
                  if (dirty) await save();
                  onRender();
                }}
                loading={busy}
              >
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                Render audio from this score
              </Button>

              {/* A plan-only version is precisely the one whose only artifact
                  is the score, so gate on the score, not on the audio. */}
              {version && version.score_abc && (
                <a
                  href={api.downloadUrl(project.id, "score", version.number)}
                  className={buttonClasses("ghost", "md", "gap-2")}
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  Download .abc
                </a>
              )}

              {dirty && (
                <span className="text-[11px] text-[var(--sf-text-faint)]">
                  Unsaved changes
                </span>
              )}
            </div>
          </>
        )}
      </Card>

      {versionScore && versionScore !== text && (
        <Card className="p-5">
          <h2 className="mb-1 text-sm font-semibold">
            Version {version?.number}&rsquo;s score
          </h2>
          <p className="mb-3 text-xs text-[var(--sf-text-muted)]">
            The score that produced this version. It never changes; your edits
            above become the next one. Switch versions at the top of the page to
            compare against a different take.
          </p>
          <LineDiff
            before={versionScore}
            after={text}
            beforeLabel={`version ${version?.number ?? ""}`.trim()}
            afterLabel="the editor"
          />
          <details className="mt-3">
            <summary className="cursor-pointer text-[11px] text-[var(--sf-text-faint)]">
              Show the whole score
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-[var(--sf-bg)] p-3 font-mono text-[11px] leading-5 text-[var(--sf-text-muted)]">
              {versionScore}
            </pre>
          </details>
          <Button
            className="mt-3"
            variant="subtle"
            onClick={() => {
              setText(versionScore);
              setSaved(false);
            }}
          >
            Load into the editor
          </Button>
        </Card>
      )}
    </div>
  );
}
