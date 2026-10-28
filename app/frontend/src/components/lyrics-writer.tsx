"use client";

/**
 * Lyrics writer: a local language model (Ollama) writes or revises lyrics.
 *
 * The model runs on the same GPU YuE2 renders on, and on most cards the two
 * do not fit at once. The backend refuses while a song is queued or rendering and
 * unloads the model before every render, so this panel only has to explain
 * the state it is in - and warm the model up when the GPU is free, so the
 * ~17 s load happens while the user is still typing.
 */
import * as React from "react";
import { Check, Cpu, Loader2, RotateCcw, Sparkles, Square, Wand2 } from "lucide-react";

import {
  Badge,
  Banner,
  Button,
  Field,
  Input,
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
        // Warm up once, only when it cannot interfere with a render.
        if (
          !warmedRef.current && next.enabled && next.ollama_running && next.model_installed &&
          !next.loaded && !next.gpu_busy && !next.writing
        ) {
          warmedRef.current = true;
          void api.warmUpLyrics().then(() => {
            if (!stopped) void api.getLyricsStatus().then((s) => !stopped && setStatus(s));
          });
        }
      } catch {
        if (!stopped) setStatus(null);
      }
    };
    void refresh();
    const timer = setInterval(refresh, 8000);
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

  // The writer is an optional extra, not a broken required part: every message
  // here says what to do AND that the app works without it. Someone who never
  // installs Ollama should still feel they have the whole application.
  const unavailable = !status
    ? "Checking the lyrics model..."
    : !status.enabled
      ? "The lyrics writer is turned off in Settings. Write your lyrics below, or turn it back on there."
      : !status.ollama_running
        ? "The optional lyrics writer is not running. SongForge works without it — write your own lyrics below. To use it, install Ollama from ollama.com and start SongForge again."
        : !status.model_installed
          ? `The optional model ${status.model} is not installed. Write your own lyrics below, or run "ollama pull ${status.model}" to add it.`
          : null;

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
    setPhaseMessage(status?.loaded ? "Writing lyrics..." : `Loading ${status?.model ?? "the model"} into the GPU...`);
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

  const displayed = result?.lyrics ?? extractLyrics(preview);
  const minuteLabel = formatDuration(minutes * 60);

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Wand2 className="h-4 w-4 text-[var(--sf-accent)]" aria-hidden="true" />
          Lyrics writer
        </p>
        <ModelBadge status={status} />
      </div>

      {/* Info, not warning: a missing optional component is not a fault. */}
      {unavailable && status && <Banner tone="info">{unavailable}</Banner>}
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
          label={`Length: about ${minuteLabel}`}
          htmlFor="lyrics-writer-minutes"
          hint={isRevising ? "Used only if the revision adds or removes sections." : "Sets how many lines and sections to write."}
        >
          <input
            id="lyrics-writer-minutes"
            type="range"
            min={0.5}
            max={6}
            step={0.5}
            value={minutes}
            onChange={(event) => setMinutes(Number(event.target.value))}
            className="mt-2 w-full accent-[var(--sf-accent)]"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {busy ? (
          <Button variant="secondary" onClick={() => abortRef.current?.abort()}>
            <Square className="h-4 w-4" aria-hidden="true" />
            Stop
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => void write()}
            disabled={Boolean(unavailable) || Boolean(status?.gpu_busy) || rendering}
          >
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {result ? "Write again" : isRevising ? "Revise lyrics" : "Generate lyrics"}
          </Button>
        )}
        {onWriteAndRender && !busy && (
          <Button
            onClick={() => void writeAndRender()}
            loading={rendering}
            disabled={Boolean(unavailable) || Boolean(status?.gpu_busy)}
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
        <div className="rounded-lg border border-[var(--sf-border)] bg-[var(--sf-bg)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--sf-border)] px-3 py-2 text-xs">
            <span className="flex items-center gap-2 text-[var(--sf-text-muted)]" aria-live="polite">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {busy ? phaseMessage : result ? `"${result.title || "Untitled"}"` : ""}
            </span>
            {result && (
              <span className="text-[var(--sf-text-faint)]">
                about {formatDuration(result.estimated_seconds)} when sung · written in {result.seconds}s
              </span>
            )}
          </div>
          <pre
            ref={previewRef}
            className="max-h-80 overflow-auto whitespace-pre-wrap p-3 font-mono text-[12px] leading-6 text-[var(--sf-text)]"
          >
            {displayed || " "}
          </pre>
          {result?.style && (
            <p className="border-t border-[var(--sf-border)] px-3 py-2 text-xs text-[var(--sf-text-muted)]">
              <span className="text-[var(--sf-text-faint)]">Suggested style: </span>
              {result.style}
            </p>
          )}
        </div>
      )}

      {result && result.warnings.length > 0 && (
        <Banner tone="warning">
          <ul className="list-disc pl-4">
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Banner>
      )}

      {result && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-[var(--sf-accent)]/40 bg-[var(--sf-accent)]/5 p-3">
          <Button variant="primary" size="sm" onClick={() => onUse(result, { applyStyle, applyTitle })}>
            <Check className="h-4 w-4" aria-hidden="true" />
            Use these lyrics
          </Button>
          {result.style && (
            <label className="flex items-center gap-2 text-xs text-[var(--sf-text-muted)]">
              <input
                type="checkbox"
                checked={applyStyle}
                onChange={(event) => setApplyStyle(event.target.checked)}
                className="accent-[var(--sf-accent)]"
              />
              Also use the suggested style
            </label>
          )}
          {result.title && (
            <label className="flex items-center gap-2 text-xs text-[var(--sf-text-muted)]">
              <input
                type="checkbox"
                checked={applyTitle}
                onChange={(event) => setApplyTitle(event.target.checked)}
                className="accent-[var(--sf-accent)]"
              />
              Use the title
            </label>
          )}
          <button
            type="button"
            className="ml-auto flex items-center gap-1 text-xs text-[var(--sf-text-faint)] hover:text-[var(--sf-text)]"
            onClick={() => {
              setResult(null);
              setPreview("");
              setPhase("idle");
            }}
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Discard
          </button>
        </div>
      )}
    </div>
  );
}

function ModelBadge({ status }: { status: LyricsStatus | null }) {
  if (!status) return <Badge tone="neutral">checking...</Badge>;
  if (!status.ollama_running) return <Badge tone="warning">model offline</Badge>;
  if (status.gpu_busy) return <Badge tone="info">{status.model} · GPU busy</Badge>;
  if (status.loaded) {
    return (
      <Badge tone="success">
        {status.model} · loaded ({(status.loaded_vram_bytes / 2 ** 30).toFixed(1)} GB)
      </Badge>
    );
  }
  return <Badge tone="neutral">{status.model} · not loaded</Badge>;
}

/** While streaming, show only what comes after "LYRICS:", once it arrives. */
function extractLyrics(text: string): string {
  // Matches the backend parser: the model has written "LYRIC:" as well.
  const header = /^\s*#*\s*(?:song\s+)?LYRICS?\s*[:-]?\s*$/im;
  const marker = text.search(header);
  if (marker === -1) return text;
  return text.slice(marker).replace(header, "").replace(/^\n/, "");
}
