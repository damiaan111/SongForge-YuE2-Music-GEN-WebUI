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
    <div className={cn("space-y-5", className)}>
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
        <legend className="mb-2 text-[13px] font-medium text-ink">Seed</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {SEED_MODES.map(([mode, label, description, Icon]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={value.seed_mode === mode}
              onClick={() => onChange({ seed_mode: mode })}
              className={cn(
                "rounded-xl border p-3 text-left transition-colors",
                value.seed_mode === mode
                  ? "border-accent/60 bg-accent/10"
                  : "border-edge bg-raised hover:border-edge-strong hover:bg-overlay",
              )}
            >
              <span
                className={cn(
                  "flex items-center gap-2 text-[13px] font-medium",
                  value.seed_mode === mode ? "text-accent" : "text-ink",
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-ink-faint">
                {description}
              </span>
            </button>
          ))}
        </div>
        {value.seed_mode === "manual" && (
          <div className="mt-3 max-w-xs">
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
        <p className="mt-2 text-xs leading-relaxed text-ink-faint">
          The same seed, lyrics, style and score reproduce the same audio, bit for
          bit. That is what makes editing a score meaningful.
        </p>
      </fieldset>

      <div className="space-y-4 border-t border-edge pt-5">
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
        <p className="text-xs text-ink-faint">
          The 24-bit / 48 kHz FLAC master is always written, with or without FFmpeg.
        </p>
      </div>
    </div>
  );
}

/** A one-line summary of the settings the next render will use. */
export function GenerationSummary({
  value,
  takes,
}: {
  value: GenerationSettings;
  /** How many versions one press of Generate will queue. */
  takes?: number;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {takes !== undefined && takes > 1 && <Badge tone="accent">{takes} takes</Badge>}
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
 * One take by default.
 *
 * YuE2's published benchmark baseline is the better of two candidates, and
 * best-of-8 is how its headline score was measured, so more takes do give a
 * better song. But each take is a whole render, and the default is what a
 * newcomer waits through before hearing anything at all: on a mid-range card
 * two takes turned an eleven-minute first song into twenty-two. One take is
 * the quickest honest answer to "does this work?"; the control sits right
 * beside the Generate button for the song that deserves more.
 */
export const DEFAULT_ADVANCED: AdvancedGeneration = {
  candidates: 1,
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

const TAKE_CHOICES = [1, 2, 3, 4, 6, 8] as const;

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
  const minutes = takeMinutes(songSeconds, value.candidates);
  // With nothing typed yet the figure is for an assumed three-minute song, and
  // it has to say so: "for a song this long" beside a meter reading 0:27 is a
  // contradiction.
  const measured = Boolean(songSeconds && songSeconds >= TOO_SHORT_TO_QUOTE);
  const forWhat = measured ? "for a song this long" : "for a typical three-minute song";
  const labelId = fieldId("adv", "candidates-label");
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p id={labelId} className="text-[13px] font-medium text-ink">
          Takes
        </p>
        <p className="text-xs tabular-nums text-ink-faint">about {minutes} min</p>
      </div>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="mt-2 grid grid-cols-6 gap-1 rounded-[0.8rem] border border-edge bg-sunken p-1"
      >
        {TAKE_CHOICES.map((count) => {
          const active = value.candidates === count;
          return (
            <button
              key={count}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={count === 1 ? "1 take" : `${count} takes`}
              onClick={() => onChange({ ...value, candidates: count })}
              className={cn(
                "sf-focus-inset h-8 rounded-[0.55rem] text-[13px] font-medium tabular-nums transition-colors",
                active
                  ? "bg-elevated text-ink shadow-[var(--sf-highlight),var(--sf-shadow-sm)]"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              {count}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-faint">
        {value.candidates > 1
          ? `${value.candidates} separate renders, one after another, each with its own seed — about ${minutes} minutes${on} ${forWhat}. Compare them in Versions and keep the best.`
          : `One render — about ${minutes} minutes${on} ${forWhat}. YuE2 varies a lot from take to take, so for a song you care about pick 2 or more and keep the best.`}
      </p>
    </div>
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
        <details className="sf-disclosure rounded-xl border border-edge bg-sunken/50 p-4" open={customised || undefined}>
          <summary className="text-[13px] font-medium text-ink">
            Sampling and synthesis
            {customised && (
              <Badge tone="accent" className="ml-2">
                customised
              </Badge>
            )}
          </summary>
          <p className="mt-3 text-xs leading-relaxed text-ink-faint">
            Leave a field blank to keep YuE2&rsquo;s default, shown greyed out. Score
            sampling shapes the melody and chords; audio sampling shapes the performance.
          </p>

          <div className="mt-4 grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {(["abc", "semantic"] as const).map((stage) => (
              <fieldset
                key={stage}
                disabled={stage === "semantic" && planOnly}
                className="space-y-2 disabled:opacity-50"
              >
                <legend className="mb-2 text-[13px] font-semibold text-ink">
                  {stage === "abc" ? "Score sampling" : "Audio sampling"}
                </legend>
                {SAMPLING_FIELDS.map((field) => (
                  <div key={field.key} className="flex items-center justify-between gap-3">
                    <label
                      htmlFor={fieldId(`adv-${stage}`, field.key)}
                      className="text-[13px] text-ink-muted"
                    >
                      {field.label}
                    </label>
                    <NumberInput
                      id={fieldId(`adv-${stage}`, field.key)}
                      className="h-8 w-28 text-right text-[13px]"
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

          <p className="mt-4 text-xs leading-relaxed text-ink-faint">
            Audio max tokens is a ceiling, not a length target: about{" "}
            {SEMANTIC_TOKENS_PER_SECOND} tokens per second of music, so {maxTokens} tokens is
            about {maxMinutes} minutes. A song that reaches it is cut short and marked as such.
          </p>

          <div className="mt-4 border-t border-edge pt-4">
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
            <ul className="mt-3 space-y-0.5 text-xs text-danger" role="alert">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          {customised && (
            <button
              type="button"
              className="mt-3 text-[13px] font-medium text-accent hover:underline"
              onClick={() => onChange({ ...DEFAULT_ADVANCED, candidates: value.candidates })}
            >
              Reset sampling to defaults
            </button>
          )}
        </details>
      ) : (
        <p className="text-xs leading-relaxed text-ink-faint">
          Sampling and synthesis-step controls are unavailable with the current runner
          {caps?.kind === "yue2_cli"
            ? ". Reset the command template in Settings to enable them."
            : "."}
        </p>
      )}
    </div>
  );
}
