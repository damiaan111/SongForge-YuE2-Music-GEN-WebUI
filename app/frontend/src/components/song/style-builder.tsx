"use client";

/**
 * The style field, built as tags.
 *
 * The box itself stays free text - that is what YuE2 takes - but the chips and
 * the two hint fields compose into it in the order the model was trained on,
 * and the checklist says which of the four high-impact tags are missing. The
 * preview is the exact string the runner will be given, including the language
 * and vocal tags the backend prefixes.
 */
import Link from "next/link";
import * as React from "react";
import { Check, CircleDashed } from "lucide-react";

import { Chip, Field, Input, Textarea } from "@/components/ui/primitives";
import {
  AVOIDABLE,
  GENRES,
  MOODS,
  VOCAL_GENDERS,
  VOCAL_TONES,
  previewStyle,
  styleChecklist,
  type StyleDraft,
} from "@/lib/style-tags";
import { cn } from "@/lib/utils";

export function StyleBuilder({
  draft,
  onChange,
  context,
  rows = 3,
  error,
  compact = false,
}: {
  draft: StyleDraft;
  onChange: (next: StyleDraft) => void;
  context: { language?: string; vocal?: string; instrumental?: boolean };
  rows?: number;
  error?: string;
  /** Quick mode hides the exclusion row, key and tempo. */
  compact?: boolean;
}) {
  const set = <K extends keyof StyleDraft>(key: K, value: StyleDraft[K]) =>
    onChange({ ...draft, [key]: value });

  const toggle = (key: "genres" | "moods" | "avoid", value: string) => {
    const list = draft[key];
    set(key, list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  };

  const preview = previewStyle(draft, context);
  const checks = styleChecklist(draft, context);

  return (
    <div className="space-y-5">
      <Field
        label="Describe the sound"
        htmlFor="style"
        required
        error={error}
        hint={
          <>
            Comma-separated tags, most important first — the first few carry the most
            weight.{" "}
            <Link
              href="/learn/style"
              className="font-medium text-accent underline-offset-2 hover:underline"
            >
              How to write these
            </Link>
          </>
        }
      >
        <Textarea
          id="style"
          value={draft.description}
          onChange={(event) => set("description", event.target.value)}
          rows={rows}
          aria-invalid={Boolean(error)}
          placeholder="indie folk, fingerpicked acoustic guitar, close-mic'd, rainy afternoon"
        />
      </Field>

      <ChipRow
        label="Genre"
        options={GENRES}
        selected={draft.genres}
        onToggle={(value) => toggle("genres", value)}
      />
      <ChipRow
        label="Mood"
        options={MOODS}
        selected={draft.moods}
        onToggle={(value) => toggle("moods", value)}
      />
      {!compact && (
        <ChipRow
          label="Leave out"
          options={AVOIDABLE}
          selected={draft.avoid}
          onToggle={(value) => toggle("avoid", value)}
          hint="Keeps out something the genre would otherwise imply."
        />
      )}

      {!compact && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tempo (BPM)" htmlFor="bpm" hint="A guide, not a guarantee.">
            <Input
              id="bpm"
              value={draft.bpm}
              inputMode="numeric"
              onChange={(event) => set("bpm", event.target.value)}
              placeholder="92"
            />
          </Field>
          <Field label="Key" htmlFor="key" hint="Optional; the planner often ignores it.">
            <Input
              id="key"
              value={draft.musicalKey}
              onChange={(event) => set("musicalKey", event.target.value)}
              placeholder="C minor"
            />
          </Field>
        </div>
      )}

      {/* Four tags, not validation: a song renders without any of them. */}
      <div className="rounded-xl border border-edge bg-sunken/60 p-3.5">
        <ul className="flex flex-wrap gap-x-5 gap-y-1.5" aria-label="High-impact tags">
          {checks.map((check) => (
            <li
              key={check.label}
              title={check.hint}
              className={cn(
                "inline-flex items-center gap-1.5 text-[13px]",
                check.ok ? "text-success" : "text-ink-faint",
              )}
            >
              {check.ok ? (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <CircleDashed className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {check.label}
              <span className="sr-only">{check.ok ? " is set" : ` is missing. ${check.hint}`}</span>
            </li>
          ))}
        </ul>
        {preview ? (
          <p className="mt-2.5 border-t border-edge pt-2.5 text-[13px] leading-relaxed text-ink-muted">
            <span className="mr-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-ink-faint">
              Sent to the model
            </span>
            {preview}
          </p>
        ) : (
          <p className="mt-2 text-xs text-ink-faint">
            These four change the result most. None is required.
          </p>
        )}
      </div>
    </div>
  );
}

/** Suggestions for the vocal field, as chips that write into it. */
export function VocalChips({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  if (disabled) return null;
  const current = value.toLowerCase();
  const apply = (tag: string) => {
    if (current.includes(tag.toLowerCase())) {
      onChange(
        value
          .split(/,\s*/)
          .filter((part) => part.toLowerCase() !== tag.toLowerCase())
          .join(", "),
      );
      return;
    }
    onChange(value.trim() ? `${value.trim()}, ${tag}` : tag);
  };

  return (
    <div className="mt-4 space-y-4">
      <ChipRow
        label="Voice"
        options={VOCAL_GENDERS}
        selected={VOCAL_GENDERS.filter((tag) => current.includes(tag.toLowerCase()))}
        onToggle={apply}
      />
      <ChipRow
        label="Tone"
        options={VOCAL_TONES}
        selected={VOCAL_TONES.filter((tag) => current.includes(tag.toLowerCase()))}
        onToggle={apply}
      />
    </div>
  );
}

function ChipRow({
  label,
  options,
  selected,
  onToggle,
  hint,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
  hint?: string;
}) {
  return (
    <div role="group" aria-label={label}>
      <p className="mb-2 flex flex-wrap items-baseline gap-x-2 text-[13px] font-medium text-ink">
        {label}
        {selected.length > 0 && (
          <span className="text-xs font-normal tabular-nums text-accent">
            {selected.length} selected
          </span>
        )}
        {hint && <span className="text-xs font-normal text-ink-faint">{hint}</span>}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <Chip
            key={option}
            selected={selected.includes(option)}
            onClick={() => onToggle(option)}
          >
            {option}
          </Chip>
        ))}
      </div>
    </div>
  );
}
