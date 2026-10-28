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
import { Check, Minus } from "lucide-react";

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
    <div>
      <Field
        label="Style"
        htmlFor="style"
        required
        error={error}
        hint={
          <>
            Comma-separated tags, most important first. The first few carry the most
            weight.{" "}
            <Link
              href="/learn/style"
              className="text-[var(--sf-accent)] underline-offset-2 hover:underline"
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

      <div className="mt-4 space-y-3">
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
            label="Avoid"
            options={AVOIDABLE}
            selected={draft.avoid}
            onToggle={(value) => toggle("avoid", value)}
            hint="Keeps out something the genre would otherwise imply."
          />
        )}
      </div>

      {!compact && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Tempo" htmlFor="bpm" hint="A guide, not a guarantee.">
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
      <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
        {checks.map((check) => (
          <li
            key={check.label}
            title={check.hint}
            className={cn(
              "inline-flex items-center gap-1 text-[11px]",
              check.ok ? "text-[var(--sf-success)]" : "text-[var(--sf-text-faint)]",
            )}
          >
            {check.ok ? (
              <Check className="h-3 w-3" aria-hidden="true" />
            ) : (
              <Minus className="h-3 w-3" aria-hidden="true" />
            )}
            {check.label}
            <span className="sr-only">{check.ok ? " is set" : ` is missing. ${check.hint}`}</span>
          </li>
        ))}
      </ul>

      {preview && (
        <p className="mt-3 rounded-md bg-[var(--sf-bg)] p-2 text-[11px] leading-relaxed text-[var(--sf-text-faint)]">
          <span className="text-[var(--sf-text-muted)]">Sent to the model:</span> {preview}
        </p>
      )}
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
    <div className="mt-2 space-y-2">
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
    <div>
      <p className="mb-1.5 text-[11px] font-medium text-[var(--sf-text-muted)]">
        {label}
        {hint && <span className="ml-1.5 font-normal text-[var(--sf-text-faint)]">{hint}</span>}
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
