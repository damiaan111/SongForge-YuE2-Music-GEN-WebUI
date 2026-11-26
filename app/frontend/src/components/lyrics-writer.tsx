"use client";

/**
 * Lyrics writer: a local language model (Ollama) writes or revises lyrics.
 *
 * The model runs on the same GPU YuE2 renders on, and on most cards the two
 * do not fit at once. The backend refuses while a song is queued or rendering and
 * unloads the model before every render, so this panel only has to explain
 * the state it is in - and warm the model up when the GPU is free, so the
 * ~17 s load happens while the user is still typing.
 *
 * The writer is optional. Someone who skipped it during setup gets one quiet
 * card saying so, not a form full of disabled controls.
 */
import Link from "next/link";
import * as React from "react";
import { Check, Cpu, PenLine, RotateCcw, Sparkles, Square, Wand2 } from "lucide-react";

import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Field,
  Input,
  Slider,
  Spinner,
  Textarea,
  Toggle,
} from "@/components/ui/primitives";
import * as api from "@/lib/api";
import type { LyricsResult, LyricsStatus } from "@/lib/types";
import { cn, formatDuration } from "@/lib/utils";

const LANGUAGES = [
  "English", "Dutch", "German", "French", "Spanish", "Italian", "Portuguese",
  "Swedish", "Norwegian", "Danish", "Polish", "Turkish", "Japanese", "Korean",
  "Mandarin Chinese",
];

export interface LyricsWriterDefaults {
  idea?: string;
  language?: string;
  minutes?: number;
  styleHint?: string;
  mood?: string;
}

export interface LyricsWriterProps {
  defaults?: LyricsWriterDefaults;
  /** Lyrics already in the editor; enables revise mode. */
  currentLyrics?: string;
  /** Put the result into the song. */
  onUse: (result: LyricsResult, options: { applyStyle: boolean; applyTitle: boolean }) => void;
  /**
   * One continuous flow: write, then immediately use the result and start the
   * render. Shown as a second button when provided.
   */
  onWriteAndRender?: (result: LyricsResult) => Promise<void> | void;
  renderLabel?: string;
  /** Remember the form between visits (per surface). */
  storageKey?: string;
  className?: string;
}

type Phase = "idle" | "loading" | "writing" | "done" | "error";

/** True when the writer can actually be used right now (GPU aside). */
export function lyricsWriterAvailable(status: LyricsStatus | null): boolean {
  return Boolean(status?.enabled && status.ollama_running && status.model_installed);
}

function readSaved(key: string | undefined): LyricsWriterDefaults {
  if (!key || typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as LyricsWriterDefaults;
  } catch {
    return {};
  }
}

export function LyricsWriter({
  defaults = {},
  currentLyrics = "",
  onUse,
  onWriteAndRender,
  renderLabel = "Write lyrics & render song",
  storageKey,
  className,
}: LyricsWriterProps) {
  const [saved] = React.useState(() => readSaved(storageKey));
  const [idea, setIdea] = React.useState(saved.idea ?? defaults.idea ?? "");
  const [language, setLanguage] = React.useState(saved.language ?? defaults.language ?? "English");
  const [minutes, setMinutes] = React.useState(saved.minutes ?? defaults.minutes ?? 3);
  const [mood, setMood] = React.useState(saved.mood ?? defaults.mood ?? "");
  const [revise, setRevise] = React.useState(false);
  const [instruction, setInstruction] = React.useState("");
  const [applyStyle, setApplyStyle] = React.useState(!defaults.styleHint?.trim());
  const [applyTitle, setApplyTitle] = React.useState(true);

  const [status, setStatus] = React.useState<LyricsStatus | null>(null);
  const [statusKnown, setStatusKnown] = React.useState(false);
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [phaseMessage, setPhaseMessage] = React.useState("");
  const [preview, setPreview] = React.useState("");
  const [result, setResult] = React.useState<LyricsResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [rendering, setRendering] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const previewRef = React.useRef<HTMLPreElement>(null);
  const warmedRef = React.useRef(false);

  const busy = phase === "loading" || phase === "writing";
  const canRevise = currentLyrics.trim().length > 0;
  const isRevising = revise && canRevise;

  // Remember the form (not the lyrics) so reopening the panel keeps the idea.
  React.useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ idea, language, minutes, mood }));
    } catch {
      /* storage is a convenience only */
    }
  }, [storageKey, idea, language, minutes, mood]);

  // Poll status while the panel is open: GPU availability changes when a
  // render starts or finishes.
  React.useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const next = await api.getLyricsStatus();
        if (stopped) return;
        setStatus(next);
        setStatusKnown(true);
        // Warm up once, only when it cannot interfere with a render.
        if (
          !warmedRef.current && next.enabled && next.ollama_running && next.model_installed &&
          !next.loaded && !next.gpu_busy && !next.writing
        ) {
          warmedRef.current = true;
          // Answered at once; the load runs in the background and shows up
          // in the next status poll.
          void api.warmUpLyrics().then(() => {
            if (!stopped) void api.getLyricsStatus().then((s) => !stopped && setStatus(s));
          });
        }
      } catch {
        if (!stopped) {
          setStatus(null);
          setStatusKnown(true);
        }
      }
    };
    void refresh();
    // Quicker than the old eight seconds, so "loading…" turns into "loaded"
    // soon after it is true.
    const timer = setInterval(refresh, 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  React.useEffect(() => {
    const box = previewRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [preview]);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const write = async (): Promise<LyricsResult | null> => {
    if (!isRevising && !idea.trim()) {
      setError("Describe what the song is about.");
      return null;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setResult(null);
    setPreview("");
    setPhase(status?.loaded ? "writing" : "loading");
    setPhaseMessage(status?.loaded ? "Writing lyrics…" : `Loading ${status?.model ?? "the model"} into the GPU…`);
    try {
      const written = await api.streamLyrics(
        {
          idea: idea.trim(),
          language: language.trim() || "English",
          minutes,
          style_hint: defaults.styleHint ?? "",
          mood: mood.trim(),
          existing_lyrics: isRevising ? currentLyrics : "",
          instruction: isRevising ? instruction.trim() : "",
        },
        {
          onStatus: (next, message) => {
            setPhase(next === "loading" ? "loading" : "writing");
            setPhaseMessage(message);
          },
          onToken: (text) => setPreview((current) => current + text),
        },
        controller.signal,
      );
      setResult(written);
      setPhase("done");
      void api.getLyricsStatus().then(setStatus).catch(() => undefined);
      return written;
    } catch (cause) {
      setPhase(controller.signal.aborted ? "idle" : "error");
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      return null;
    } finally {
      abortRef.current = null;
    }
  };

  const writeAndRender = async () => {
    if (!onWriteAndRender) return;
    const written = await write();
    if (!written) return;
    // One-click skips the review step, so anything the parser was unsure
    // about stops here: a render of flawed lyrics costs 10+ minutes of GPU.
    if (written.warnings.length > 0) {
      setError(
        "Not rendered: the lyrics need a look first (see the notes below). Use them and press Generate song when they read right.",
      );
      return;
    }
    setRendering(true);
    try {
      await onWriteAndRender(written);
    } finally {
      setRendering(false);
    }
  };

  const heading = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="flex items-center gap-2 text-[15px] font-semibold text-ink">
        <Wand2 className="h-4 w-4 text-accent" aria-hidden="true" />
        Lyrics writer
      </p>
      <ModelBadge status={status} known={statusKnown} />
    </div>
  );

  // --- Not set up: say so once, plainly, and get out of the way. ---
  if (statusKnown && !lyricsWriterAvailable(status)) {
    const reason = !status
      ? "SongForge could not check the lyrics writer just now."
      : !status.enabled
        ? "The lyrics writer is switched off in Settings."
        : !status.ollama_running
          ? "It needs Ollama, a free app that runs a language model on this computer, and Ollama is not running."
          : `Ollama is running, but the model ${status.model} has not been downloaded yet.`;
    const fix = !status
      ? null
      : !status.enabled
        ? "Turn it on under Settings → Lyrics writer."
        : !status.ollama_running
          ? "Install it from ollama.com (or start it), then run setup again and tick the lyrics writer."
          : `Run setup again and tick the lyrics writer, or run: ollama pull ${status.model}`;
    return (
      <div className={cn("space-y-3", className)}>
        {heading}
        <div className="flex items-start gap-3 rounded-xl border border-edge bg-sunken/60 p-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-overlay text-ink-muted">
            <PenLine className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 text-[13px] leading-relaxed">
            <p className="font-medium text-ink">
              Optional, and not set up on this computer
            </p>
            <p className="mt-0.5 text-ink-muted">
              {reason} SongForge works fully without it — write your own lyrics below.
            </p>
            {fix && <p className="mt-1.5 text-ink-faint">{fix}</p>}
            <Link
              href="/settings#lyrics-writer"
              className="mt-2 inline-block font-medium text-accent underline-offset-2 hover:underline"
            >
              Lyrics writer settings
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const displayed = result?.lyrics ?? extractLyrics(preview);
  const minuteLabel = formatDuration(minutes * 60);
  const blocked = !statusKnown || Boolean(status?.gpu_busy);

  return (
    <div className={cn("space-y-5", className)}>
      {heading}

      {status?.gpu_busy && !busy && (
        <Banner tone="info" title="The GPU is rendering a song">
          The lyrics model and YuE2 cannot share the graphics card. You can prepare
          your idea now; writing becomes available as soon as the queue is empty.
        </Banner>
      )}

      {canRevise && (
        <Toggle
          id="lyrics-writer-revise"
          checked={revise}
          onChange={setRevise}
          label="Revise the lyrics already in the editor"
          description="Keep what works and change only what you describe, instead of writing a new song."
        />
      )}

      {isRevising ? (
        <Field
          label="What should change?"
          htmlFor="lyrics-writer-instruction"
          hint="For example: make the chorus more hopeful, add a bridge, shorten the second verse."
        >
          <Textarea
            id="lyrics-writer-instruction"
            rows={2}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />
        </Field>
      ) : (
        <Field
          label="What is the song about?"
          htmlFor="lyrics-writer-idea"
          hint="A situation, a feeling, a story. Details make better lyrics than genres do."
        >
          <Textarea
            id="lyrics-writer-idea"
            rows={3}
            value={idea}
            placeholder="Driving home after the last shift, the city lights, missing someone who moved away"
            onChange={(event) => setIdea(event.target.value)}
          />
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Language" htmlFor="lyrics-writer-language" hint="Any language; tags stay English.">
          <Input
            id="lyrics-writer-language"
            value={language}
            list="lyrics-writer-languages"
            onChange={(event) => setLanguage(event.target.value)}
          />
        </Field>
        <datalist id="lyrics-writer-languages">
          {LANGUAGES.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>

        <Field label="Mood" htmlFor="lyrics-writer-mood" hint="Optional.">
          <Input
            id="lyrics-writer-mood"
            value={mood}
            placeholder="bittersweet"
            onChange={(event) => setMood(event.target.value)}
          />
        </Field>

        <Field
          label={
            <span className="flex w-full items-baseline justify-between gap-2">
              Length
              <span className="text-xs font-normal tabular-nums text-ink-muted">about {minuteLabel}</span>
            </span>
          }
          htmlFor="lyrics-writer-minutes"
          hint={isRevising ? "Used only if the revision adds or removes sections." : "Sets how many lines and sections to write."}
        >
          <Slider
            id="lyrics-writer-minutes"
            min={0.5}
            max={6}
            step={0.5}
            value={minutes}
            onChange={(event) => setMinutes(Number(event.target.value))}
            className="mt-2.5"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {busy ? (
          <Button variant="secondary" onClick={() => abortRef.current?.abort()}>
            <Square className="h-4 w-4 fill-current" aria-hidden="true" />
            Stop
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void write()} disabled={blocked || rendering}>
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {result ? "Write again" : isRevising ? "Revise lyrics" : "Write lyrics"}
          </Button>
        )}
        {onWriteAndRender && !busy && (
          <Button
            onClick={() => void writeAndRender()}
            loading={rendering}
            disabled={blocked}
            title="Writes the lyrics, unloads the lyrics model, and starts rendering the song with YuE2 - no review step."
          >
            <Wand2 className="h-4 w-4" aria-hidden="true" />
            {renderLabel}
          </Button>
        )}
        {status?.loaded && !busy && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void api.unloadLyrics().then(() => api.getLyricsStatus().then(setStatus))}
            title="Free the graphics card now. It happens automatically before every render."
          >
            <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
            Unload model
          </Button>
        )}
      </div>

      {error && <Banner tone="danger" title="Could not write lyrics">{error}</Banner>}

      {(busy || displayed) && (
        <div className="overflow-hidden rounded-xl border border-edge bg-sunken">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-4 py-2.5 text-[13px]">
            <span className="flex items-center gap-2 font-medium text-ink" aria-live="polite">
              {busy && <Spinner className="h-3.5 w-3.5 text-accent" />}
              {busy ? phaseMessage : result ? `“${result.title || "Untitled"}”` : ""}
            </span>
            {result && (
              <span className="text-xs text-ink-faint">
                about {formatDuration(result.estimated_seconds)} when sung · written in {result.seconds}s
              </span>
            )}
          </div>
          <pre
            ref={previewRef}
            className="max-h-80 overflow-auto whitespace-pre-wrap p-4 font-mono text-[13px] leading-6 text-ink"
          >
            {displayed || " "}
          </pre>
          {result?.style && (
            <p className="border-t border-edge px-4 py-2.5 text-[13px] text-ink-muted">
              <span className="mr-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-ink-faint">
                Suggested style
              </span>
              {result.style}
            </p>
          )}
        </div>
      )}

      {result && result.warnings.length > 0 && (
        <Banner tone="warning" title="Worth a look before rendering">
          <ul className="list-disc pl-4">
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Banner>
      )}

      {result && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border border-accent/40 bg-accent/8 p-3.5">
          <Button variant="primary" onClick={() => onUse(result, { applyStyle, applyTitle })}>
            <Check className="h-4 w-4" aria-hidden="true" />
            Use these lyrics
          </Button>
          {result.style && (
            <Checkbox checked={applyStyle} onChange={setApplyStyle}>
              Also use the suggested style
            </Checkbox>
          )}
          {result.title && (
            <Checkbox checked={applyTitle} onChange={setApplyTitle}>
              Use the title
            </Checkbox>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => {
              setResult(null);
              setPreview("");
              setPhase("idle");
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}

function ModelBadge({ status, known }: { status: LyricsStatus | null; known: boolean }) {
  if (!known) return <Badge tone="neutral">checking…</Badge>;
  if (!status || !status.enabled || !status.ollama_running || !status.model_installed) {
    return <Badge tone="neutral">not set up</Badge>;
  }
  if (status.gpu_busy) return <Badge tone="info" dot>{status.model} · GPU busy</Badge>;
  if (status.loading && !status.loaded) {
    return <Badge tone="info" dot="live">{status.model} · loading…</Badge>;
  }
  if (status.loaded) {
    // No memory figure: what Ollama reports here changed meaning between its
    // versions (a 7 GB model shows as 1.4 GB on a current one), and a wrong
    // number is worse than none.
    return (
      <Badge tone="success" dot>
        {status.model} · loaded
      </Badge>
    );
  }
  return <Badge tone="neutral">{status.model} · ready</Badge>;
}

/** While streaming, show only what comes after "LYRICS:", once it arrives. */
function extractLyrics(text: string): string {
  // Matches the backend parser: the model has written "LYRIC:" as well.
  const header = /^\s*#*\s*(?:song\s+)?LYRICS?\s*[:-]?\s*$/im;
  const marker = text.search(header);
  if (marker === -1) return text;
  return text.slice(marker).replace(header, "").replace(/^\n/, "");
}
