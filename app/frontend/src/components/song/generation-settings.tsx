"use client";

/**
 * The generation controls for the next version of a song.
 *
 * These are not project fields - they describe the run that is about to happen,
 * so they live in the workspace and are sent with every Generate. Keeping them
 * here is what makes "reproduce this take" possible: restoring a version copies
 * its seed, planning mode and guidance back into this panel, and the next
 * render uses them verbatim.
 */
import * as React from "react";
import { Dices, Lock, Pencil } from "lucide-react";

import { Badge, Field, Input, NumberInput, Select, Toggle } from "@/components/ui/primitives";
import type {
  CotMode,
  GenerateRequest,
  RunnerCapabilities,
  SamplingOverride,
  SeedMode,
} from "@/lib/types";
import { cn, fieldId } from "@/lib/utils";

export interface GenerationSettings {
  cot: CotMode;
  seed_mode: SeedMode;
  seed: number | null;
  cfg_scale: number | null;
  instrumental: boolean;
  language: string;
  vocal_preference: string;
  export_mp3: boolean;
  export_wav: boolean;
}

const SEED_MODES: [SeedMode, string, string, React.ComponentType<{ className?: string }>][] = [
  ["random", "New each time", "A different arrangement every render.", Dices],
  ["locked", "Same as last", "Reuse this song's previous seed.", Lock],
  ["manual", "Exact value", "Type a seed to reproduce a take.", Pencil],
];

/** What to send to POST /generate, with nothing the runner cannot honour. */
export function generationPayload(
  value: GenerationSettings,
  caps: RunnerCapabilities | undefined,
): GenerateRequest {
  return {
    cot: caps?.supports_planning ? value.cot : undefined,
    seed_mode: caps?.supports_seed ? value.seed_mode : undefined,
    seed: caps?.supports_seed && value.seed_mode === "manual" ? value.seed : undefined,
    cfg_scale: caps?.supports_cfg_scale ? value.cfg_scale : undefined,
    instrumental: caps?.supports_instrumental ? value.instrumental : undefined,
    language: value.language.trim() || undefined,
    vocal_preference: value.vocal_preference.trim() || undefined,
    export_mp3: value.export_mp3,
    export_wav: value.export_wav,
  };
}

export function GenerationSettingsPanel({
  value,
  onChange,
  caps,
  ffmpeg,
  className,
}: {
  value: GenerationSettings;
  onChange: (patch: Partial<GenerationSettings>) => void;
  caps: RunnerCapabilities | undefined;
  ffmpeg: boolean;
  className?: string;
}) {
  return (
    <div className={cn("space-y-4", className)}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Language"
          htmlFor={fieldId("gen", "language")}
          hint="Sent to the model inside the style text — YuE2 has no separate language field."
        >
          <Input
            id={fieldId("gen", "language")}
            value={value.language}
            placeholder="English"
            onChange={(event) => onChange({ language: event.target.value })}
          />
        </Field>

        <Field
          label="Vocal preference"
          htmlFor={fieldId("gen", "vocal")}
          hint="Free text, e.g. warm female alto. Also travels in the style text."
        >
          <Input
            id={fieldId("gen", "vocal")}
            value={value.vocal_preference}
            disabled={value.instrumental}
            placeholder="any"
            onChange={(event) => onChange({ vocal_preference: event.target.value })}
          />
        </Field>

        <Field
          label="Planning mode"
          htmlFor={fieldId("gen", "cot")}
          hint={
            value.cot === "off"
              ? "No score is written, so the Score tab will be empty for this version."
              : "The model writes a score first; you can edit it and re-render."
          }
        >
          <Select
            id={fieldId("gen", "cot")}
            value={value.cot}
            disabled={!caps?.supports_planning}
            onChange={(event) => onChange({ cot: event.target.value as CotMode })}
          >
            <option value="full">Full — melody and chords</option>
            <option value="melody">Melody only — best for covers</option>
            <option value="off">Off — no score, ~15% faster</option>
          </Select>
        </Field>

        <Field
          label="Text guidance (CFG)"
          htmlFor={fieldId("gen", "cfg")}
          hint="1.0 is the model's default. Any other value doubles generation time."
        >
          <NumberInput
            id={fieldId("gen", "cfg")}
            min={0}
            max={20}
            step={0.1}
            allowEmpty
            disabled={!caps?.supports_cfg_scale}
            value={value.cfg_scale}
            onValueChange={(next) => onChange({ cfg_scale: next })}
          />
        </Field>
      </div>

      <fieldset disabled={!caps?.supports_seed} className="disabled:opacity-50">
        <legend className="mb-1.5 text-xs font-medium text-[var(--sf-text-muted)]">
          Seed
        </legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {SEED_MODES.map(([mode, label, description, Icon]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={value.seed_mode === mode}
              onClick={() => onChange({ seed_mode: mode })}
              className={cn(
                "rounded-lg border p-2.5 text-left transition-colors",
                value.seed_mode === mode
                  ? "border-[var(--sf-accent)] bg-[var(--sf-accent)]/10"
                  : "border-[var(--sf-border)] hover:bg-[var(--sf-bg-overlay)]",
              )}
            >
              <span className="flex items-center gap-1.5 text-xs text-[var(--sf-text)]">
                <Icon className="h-3.5 w-3.5" />
                {label}
              </span>
              <span className="mt-0.5 block text-[11px] text-[var(--sf-text-faint)]">
                {description}
              </span>
            </button>
          ))}
        </div>
        {value.seed_mode === "manual" && (
          <div className="mt-2">
            <Field label="Seed value" htmlFor={fieldId("gen", "seed")}>
              <NumberInput
                id={fieldId("gen", "seed")}
                min={0}
                step={1}
                allowEmpty
                value={value.seed}
                placeholder="0"
                onValueChange={(next) => onChange({ seed: next })}
              />
            </Field>
          </div>
        )}
        <p className="mt-1.5 text-xs text-[var(--sf-text-faint)]">
          The same seed, lyrics, style and score reproduce the same audio, bit for
          bit. That is what makes editing a score meaningful.
        </p>
      </fieldset>

      <div className="space-y-3 border-t border-[var(--sf-border)] pt-4">
        <Toggle
          id={fieldId("gen", "instrumental")}
          checked={value.instrumental}
          disabled={!caps?.supports_instrumental}
          onChange={(next) => onChange({ instrumental: next })}
          label="Instrumental"
          description="Adds an instrumental directive to the style and allows empty lyrics. YuE2 has no instrumental flag, so this is prompt-level."
        />
        <Toggle
          id={fieldId("gen", "mp3")}
          checked={value.export_mp3}
          disabled={!ffmpeg}
          onChange={(next) => onChange({ export_mp3: next })}
          label="Also export MP3"
          description={ffmpeg ? "Lossy, convenient." : "Needs FFmpeg on PATH."}
        />
        <Toggle
          id={fieldId("gen", "wav")}
          checked={value.export_wav}
          disabled={!ffmpeg}
          onChange={(next) => onChange({ export_wav: next })}
          label="Also export WAV"
          description={ffmpeg ? "Uncompressed, for a DAW." : "Needs FFmpeg on PATH."}
        />
        <p className="text-xs text-[var(--sf-text-faint)]">
          The 24-bit / 48 kHz FLAC master is always written, with or without FFmpeg.
        </p>
      </div>
    </div>
  );
}

/** A one-line summary of the settings the next render will use. */
export function GenerationSummary({ value }: { value: GenerationSettings }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge tone="neutral">
        {value.cot === "off" ? "no score" : `${value.cot} planning`}
      </Badge>
      <Badge tone="neutral">
        {value.seed_mode === "manual"
          ? `seed ${value.seed ?? "?"}`
          : value.seed_mode === "locked"
            ? "seed locked"
            : "new seed"}
      </Badge>
      {value.cfg_scale !== null && <Badge tone="neutral">cfg {value.cfg_scale}</Badge>}
      {value.instrumental && <Badge tone="accent">instrumental</Badge>}
    </div>
  );
}

// ------------------------------------------------------------------ advanced

/** Best-of-N and the model's sampling knobs. Blank fields keep yue2's defaults. */
export interface AdvancedGeneration {
  candidates: number;
  abc: SamplingOverride;
  semantic: SamplingOverride;
  ode_steps: number | null;
}

/**
 * Two takes by default.
 *
 * YuE2's published benchmark baseline is the better of two candidates, and
 * best-of-8 is how its headline score was measured - a single take is the model
 * at its worst, not its average. The cost is roughly double the render time -
 * about half an hour for two takes of a five-minute song on the reference
 * 12 GB card - which is the trade the default makes for you.
 */
export const DEFAULT_ADVANCED: AdvancedGeneration = {
  candidates: 2,
  abc: {},
  semantic: {},
  ode_steps: null,
};

type SamplingKey = keyof SamplingOverride;

/**
 * yue2's own defaults (yue2/protocol.py GenerationConfig), shown as
 * placeholders so a blank field says what it will actually use.
 */
const SAMPLING_FIELDS: {
  key: SamplingKey;
  label: string;
  abc: number;
  semantic: number;
  step: number;
  integer?: boolean;
}[] = [
  { key: "temperature", label: "Temperature", abc: 0.7, semantic: 1.0, step: 0.05 },
  { key: "top_p", label: "Top-p", abc: 0.9, semantic: 0.95, step: 0.01 },
  { key: "top_k", label: "Top-k", abc: 30, semantic: 100, step: 1, integer: true },
  { key: "repetition_penalty", label: "Repetition penalty", abc: 1.005, semantic: 1.2, step: 0.005 },
  { key: "penalty_window", label: "Penalty window", abc: 100, semantic: 50, step: 1, integer: true },
  { key: "min_tokens", label: "Min tokens", abc: 32, semantic: 200, step: 1, integer: true },
  { key: "max_tokens", label: "Max tokens", abc: 4096, semantic: 9000, step: 1, integer: true },
];

/** Audio tokens per second of music, measured on a real run: 1802 tokens → 72.08 s. */
const SEMANTIC_TOKENS_PER_SECOND = 25;

/**
 * Seconds of wall clock per second of finished audio, on the reference card
 * this was measured on (a 12 GB RTX 3060).
 *
 * Render time scales with the length of the song, so a flat "minutes per take"
 * was wrong for anything but the short run it was measured on. Two real runs:
 * 72 s of audio took 220 s (3.1x), and 275 s of audio took 993 s (3.6x: abc 224,
 * semantic 574, NAR 181, VAE 14). The longer figure is the honest one to quote,
 * since a full song is what people actually render.
 *
 * On a different card the true ratio differs; the figure is labelled with the
 * user's own GPU name rather than the reference one, and is a guide, not a
 * promise.
 */
const WALL_CLOCK_RATIO = 3.6;

/** Fallback when no lyrics have been typed yet: roughly a three-minute song. */
const ASSUMED_SONG_SECONDS = 180;

/**
 * Below this the form is effectively empty - an estimate of a few seconds would
 * promise a one-minute render that no real song could keep.
 */
const TOO_SHORT_TO_QUOTE = 45;

function takeMinutes(songSeconds: number | undefined, takes: number) {
  const song =
    songSeconds && songSeconds >= TOO_SHORT_TO_QUOTE ? songSeconds : ASSUMED_SONG_SECONDS;
  return Math.max(1, Math.round((song * WALL_CLOCK_RATIO * takes) / 60));
}

function hasKeys(value: object) {
  return Object.keys(value).length > 0;
}

/**
 * Best-of-N, on its own.
 *
 * This lives outside the Advanced panel as well, because it is the single
 * highest-impact choice on the page and burying it under "Advanced" meant most
 * songs were rendered one take at a time.
 */
export function TakesField({
  value,
  onChange,
  songSeconds,
  gpuName,
}: {
  value: AdvancedGeneration;
  onChange: (next: AdvancedGeneration) => void;
  /** Estimated length of the song, so the cost in minutes is about this song. */
  songSeconds?: number;
  /** The card setup detected, so the estimate names the machine it is about. */
  gpuName?: string;
}) {
  // Named when known. The timing below was measured on one card; saying "on
  // an RTX 3060" to someone holding a 4090 is worse than saying nothing.
  const on = gpuName ? ` on your ${gpuName}` : "";
  return (
    <Field
      label="Takes per Generate"
      htmlFor={fieldId("adv", "candidates")}
      hint={
        value.candidates > 1
          ? `${value.candidates} separate runs, one after another, each with its own seed — about ${takeMinutes(songSeconds, value.candidates)} minutes${on} for a song this long. Compare them in Versions and keep the best.`
          : `One take is the model at its worst, not its average: YuE2's own baseline is the better of two. A song this long costs about ${takeMinutes(songSeconds, 1)} minutes per take${on}.`
      }
    >
      <Select
        id={fieldId("adv", "candidates")}
        value={String(value.candidates)}
        onChange={(event) => onChange({ ...value, candidates: Number(event.target.value) })}
      >
        {[1, 2, 3, 4, 6, 8].map((count) => (
          <option key={count} value={count}>
            {count === 1 ? "1 take" : `${count} takes`}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Just the takes, for the paths that do not expose sampling overrides. */
export function takesPayload(value: AdvancedGeneration): GenerateRequest {
  return { candidates: value.candidates > 1 ? value.candidates : undefined };
}

export function advancedPayload(
  value: AdvancedGeneration,
  caps: RunnerCapabilities | undefined,
): GenerateRequest {
  const overrides = caps?.supports_sampling_overrides;
  return {
    candidates: value.candidates > 1 ? value.candidates : undefined,
    abc_sampling: overrides && hasKeys(value.abc) ? value.abc : undefined,
    semantic_sampling: overrides && hasKeys(value.semantic) ? value.semantic : undefined,
    ode_steps: overrides && value.ode_steps !== null ? value.ode_steps : undefined,
  };
}

/** Client-side mirror of the server's bounds, for an immediate message. */
export function advancedErrors(value: AdvancedGeneration): string[] {
  const problems: string[] = [];
  const stages: [string, SamplingOverride][] = [
    ["Score", value.abc],
    ["Audio", value.semantic],
  ];
  for (const [stage, s] of stages) {
    if (s.temperature !== undefined && (s.temperature < 0 || s.temperature > 5)) {
      problems.push(`${stage} temperature must be between 0 and 5.`);
    }
    if (s.top_p !== undefined && (s.top_p <= 0 || s.top_p > 1)) {
      problems.push(`${stage} top-p must be above 0 and at most 1.`);
    }
    if (s.top_k !== undefined && s.top_k < 1) {
      problems.push(`${stage} top-k must be at least 1.`);
    }
    if (s.penalty_window !== undefined && (s.penalty_window < 1 || s.penalty_window > 100)) {
      problems.push(`${stage} penalty window must be between 1 and 100.`);
    }
    if (s.repetition_penalty !== undefined && s.repetition_penalty <= 0) {
      problems.push(`${stage} repetition penalty must be above 0.`);
    }
    if (s.max_tokens !== undefined && s.max_tokens < 1) {
      problems.push(`${stage} max tokens must be at least 1.`);
    }
    if (s.min_tokens !== undefined && s.min_tokens < 0) {
      problems.push(`${stage} min tokens cannot be negative.`);
    }
    if (s.min_tokens !== undefined && s.max_tokens !== undefined && s.min_tokens > s.max_tokens) {
      problems.push(`${stage} min tokens cannot exceed max tokens.`);
    }
  }
  if (value.ode_steps !== null && value.ode_steps < 1) {
    problems.push("Synthesis steps must be at least 1.");
  }
  return problems;
}

export function AdvancedGenerationPanel({
  value,
  onChange,
  caps,
  planOnly = false,
  showTakes = true,
}: {
  value: AdvancedGeneration;
  onChange: (next: AdvancedGeneration) => void;
  caps: RunnerCapabilities | undefined;
  /** A plan run never reaches the audio stage, so audio controls are moot. */
  planOnly?: boolean;
  /** False where the page already shows TakesField, to avoid a duplicate control. */
  showTakes?: boolean;
}) {
  const setSampling = (stage: "abc" | "semantic", key: SamplingKey, next: number | null) => {
    const current = { ...value[stage] };
    if (next === null) delete current[key];
    else current[key] = next;
    onChange({ ...value, [stage]: current });
  };
  const customised = hasKeys(value.abc) || hasKeys(value.semantic) || value.ode_steps !== null;
  const problems = advancedErrors(value);
  const maxTokens = value.semantic.max_tokens ?? 9000;
  const maxMinutes = Math.round((maxTokens / SEMANTIC_TOKENS_PER_SECOND / 60) * 10) / 10;

  return (
    <div className="space-y-4">
      {showTakes && <TakesField value={value} onChange={onChange} />}

      {caps?.supports_sampling_overrides ? (
        <details className="rounded-lg border border-[var(--sf-border)] p-3" open={customised || undefined}>
          <summary className="cursor-pointer text-xs font-medium text-[var(--sf-text-muted)]">
            Sampling and synthesis
            {customised && (
              <Badge tone="accent" className="ml-2">
                customised
              </Badge>
            )}
          </summary>
          <p className="mt-2 text-xs leading-relaxed text-[var(--sf-text-faint)]">
            Leave a field blank to keep YuE2&rsquo;s default, shown greyed out. Score
            sampling shapes the melody and chords; audio sampling shapes the performance.
          </p>

          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {(["abc", "semantic"] as const).map((stage) => (
              <fieldset
                key={stage}
                disabled={stage === "semantic" && planOnly}
                className="space-y-2 disabled:opacity-50"
              >
                <legend className="mb-1 text-xs font-semibold text-[var(--sf-text)]">
                  {stage === "abc" ? "Score sampling" : "Audio sampling"}
                </legend>
                {SAMPLING_FIELDS.map((field) => (
                  <div key={field.key} className="flex items-center justify-between gap-3">
                    <label
                      htmlFor={fieldId(`adv-${stage}`, field.key)}
                      className="text-xs text-[var(--sf-text-muted)]"
                    >
                      {field.label}
                    </label>
                    <NumberInput
                      id={fieldId(`adv-${stage}`, field.key)}
                      className="h-8 w-24 py-1 text-right text-xs"
                      allowEmpty
                      step={field.step}
                      placeholder={String(field[stage])}
                      value={value[stage][field.key] ?? null}
                      onValueChange={(next) =>
                        setSampling(
                          stage,
                          field.key,
                          next === null ? null : field.integer ? Math.round(next) : next,
                        )
                      }
                    />
                  </div>
                ))}
              </fieldset>
            ))}
          </div>

          <p className="mt-3 text-xs text-[var(--sf-text-faint)]">
            Audio max tokens is a ceiling, not a length target: about{" "}
            {SEMANTIC_TOKENS_PER_SECOND} tokens per second of music, so {maxTokens} tokens is
            about {maxMinutes} minutes. A song that reaches it is cut short and marked as such.
          </p>

          <div className="mt-3 border-t border-[var(--sf-border)] pt-3">
            <Field
              label="Synthesis steps"
              htmlFor={fieldId("adv", "ode_steps")}
              hint="Default 32. Fewer is faster and rougher; the synthesis stage scales roughly linearly."
            >
              <NumberInput
                id={fieldId("adv", "ode_steps")}
                className="w-32"
                allowEmpty
                step={1}
                placeholder="32"
                disabled={planOnly}
                value={value.ode_steps}
                onValueChange={(next) =>
                  onChange({ ...value, ode_steps: next === null ? null : Math.round(next) })
                }
              />
            </Field>
          </div>

          {problems.length > 0 && (
            <ul className="mt-3 space-y-0.5 text-xs text-[var(--sf-danger)]" role="alert">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          {customised && (
            <button
              type="button"
              className="mt-3 text-xs text-[var(--sf-accent)] hover:underline"
              onClick={() => onChange({ ...DEFAULT_ADVANCED, candidates: value.candidates })}
            >
              Reset sampling to defaults
            </button>
          )}
        </details>
      ) : (
        <p className="text-xs text-[var(--sf-text-faint)]">
          Sampling and synthesis-step controls are unavailable with the current runner
          {caps?.kind === "yue2_cli"
            ? ". Reset the command template in Settings to enable them."
            : "."}
        </p>
      )}
    </div>
  );
}
