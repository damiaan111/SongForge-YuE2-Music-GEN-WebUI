"use client";

/** Versions: compare takes side by side, set the primary, restore settings. */
import * as React from "react";
import { Crown, Trash2 } from "lucide-react";

import { Player } from "@/components/player";
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Select,
} from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useStore } from "@/lib/store";
import type {
  AdvancedGeneration,
  GenerationSettings,
} from "@/components/song/generation-settings";
import { DEFAULT_ADVANCED } from "@/components/song/generation-settings";
import type { CotMode, JobStatus, ProjectDetail, SamplingOverride, Version } from "@/lib/types";
import { cn, formatDate, formatDuration } from "@/lib/utils";

const COT_MODES: CotMode[] = ["full", "melody", "off"];

/**
 * Recover the settings a take was generated with.
 *
 * `Version.seed` is a column; everything else lives in the request the runner
 * was handed, so it is read defensively - an older version may not carry all
 * of it, and a field that is absent must leave the current control alone
 * rather than resetting it to a default.
 */
function settingsFromVersion(version: Version): Partial<GenerationSettings> {
  const request = (version.request ?? {}) as Record<string, unknown>;
  const restored: Partial<GenerationSettings> = {};

  if (typeof version.seed === "number") {
    restored.seed = version.seed;
    restored.seed_mode = "manual";
  }
  const cot = request.cot;
  if (typeof cot === "string" && (COT_MODES as string[]).includes(cot)) {
    restored.cot = cot as CotMode;
  }
  if (typeof request.cfg_scale === "number") restored.cfg_scale = request.cfg_scale;
  if (typeof request.instrumental === "boolean") {
    restored.instrumental = request.instrumental;
  }
  if (typeof request.language === "string") restored.language = request.language;
  if (typeof request.vocal_preference === "string") {
    restored.vocal_preference = request.vocal_preference;
  }
  return restored;
}

const STATUS_TEXT: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Generating",
  completed: "Completed",
  failed: "Failed — no audio",
  cancelled: "Cancelled — no audio",
  interrupted: "Interrupted",
};

const STATUS_TONE: Record<JobStatus, "neutral" | "info" | "warning" | "danger"> = {
  queued: "neutral",
  running: "info",
  completed: "neutral",
  failed: "danger",
  cancelled: "warning",
  interrupted: "warning",
};

/** The sampling overrides and step count a take was generated with. */
function advancedFromVersion(version: Version): AdvancedGeneration {
  const extra = ((version.request ?? {}) as Record<string, unknown>).extra;
  const data = (extra && typeof extra === "object" ? extra : {}) as Record<string, unknown>;
  const sampling = (value: unknown): SamplingOverride =>
    value && typeof value === "object" ? { ...(value as SamplingOverride) } : {};
  return {
    ...DEFAULT_ADVANCED,
    abc: sampling(data.abc_sampling),
    semantic: sampling(data.semantic_sampling),
    ode_steps: typeof data.ode_steps === "number" ? data.ode_steps : null,
  };
}

export function VersionsTab({
  project,
  selected,
  onSelect,
  onChanged,
  onRestoreSettings,
}: {
  project: ProjectDetail;
  selected: number | null;
  onSelect: (number: number) => void;
  onChanged: () => void;
  /** Push a take's generation settings back into the workspace controls. */
  onRestoreSettings: (
    settings: Partial<GenerationSettings>,
    advanced: AdvancedGeneration,
  ) => void;
}) {
  const { notify } = useStore();
  const playable = project.versions.filter((v) => !v.is_plan_only && v.has_flac);

  // "Take 2 of 4" for versions queued together by one Generate press.
  const takeLabel = React.useMemo(() => {
    const groups = new Map<string, number[]>();
    for (const v of project.versions) {
      if (!v.candidate_group) continue;
      groups.set(v.candidate_group, [...(groups.get(v.candidate_group) ?? []), v.number]);
    }
    const labels = new Map<number, string>();
    for (const numbers of groups.values()) {
      numbers.sort((a, b) => a - b);
      numbers.forEach((n, i) => labels.set(n, `Take ${i + 1} of ${numbers.length}`));
    }
    return labels;
  }, [project.versions]);

  const [compare, setCompare] = React.useState(false);
  const [slotA, setSlotA] = React.useState<number | null>(null);
  const [slotB, setSlotB] = React.useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<Version | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Derived, not seeded: null means "not chosen yet", and the default is the
  // last two takes. An effect here re-ran on every render because `playable`
  // is rebuilt each time.
  const compareA =
    slotA ?? (playable.length >= 2 ? playable[playable.length - 2].number : null);
  const compareB =
    slotB ?? (playable.length >= 2 ? playable[playable.length - 1].number : null);

  const act = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (cause) {
      notify({
        tone: "danger",
        title: label,
        body: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(false);
    }
  };

  if (project.versions.length === 0) {
    return (
      <EmptyState
        title="No versions yet"
        description="Generate one and it will appear here, with everything needed to reproduce it."
      />
    );
  }

  return (
    <div className="space-y-4">
      {playable.length >= 2 && (
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Compare takes</h2>
              <p className="mt-0.5 text-xs text-[var(--sf-text-muted)]">
                Play two versions back to back to hear what changed.
              </p>
            </div>
            <Button size="sm" onClick={() => setCompare((value) => !value)}>
              {compare ? "Hide" : "Compare A / B"}
            </Button>
          </div>

          {compare && (
            <div className="grid gap-3 sm:grid-cols-2">
              {([
                ["A", compareA, setSlotA],
                ["B", compareB, setSlotB],
              ] as const).map(([label, value, setValue]) => (
                <div key={label} className="rounded-lg border border-[var(--sf-border)] p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Badge tone="accent">{label}</Badge>
                    <Select
                      value={value ?? ""}
                      onChange={(event) => setValue(Number(event.target.value))}
                      aria-label={`Version for slot ${label}`}
                      className="h-8 py-1 text-xs"
                    >
                      {playable.map((entry) => (
                        <option key={entry.id} value={entry.number}>
                          Version {entry.number}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {value !== null && (
                    <Player
                      projectId={project.id}
                      version={value}
                      compact
                      duration={
                        playable.find((v) => v.number === value)?.duration_seconds ?? null
                      }
                      className="border-0 bg-transparent p-0"
                    />
                  )}
                  <ChangeSummary
                    from={playable.find((v) => v.number === compareA)}
                    to={playable.find((v) => v.number === value)}
                    show={label === "B"}
                  />
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <div className="space-y-2">
        {[...project.versions].reverse().map((version) => (
          <Card
            key={version.id}
            className={cn(
              "p-4 transition-colors",
              selected === version.number && "border-[var(--sf-accent)]",
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onSelect(version.number)}
                    className="text-sm font-medium hover:text-[var(--sf-accent)]"
                  >
                    Version {version.number}
                  </button>
                  {version.is_primary && (
                    <Badge tone="accent">
                      <Crown className="h-3 w-3" aria-hidden="true" /> Primary
                    </Badge>
                  )}
                  {version.is_plan_only && <Badge tone="info">Score only</Badge>}
                  {version.status !== "completed" && (
                    <Badge tone={STATUS_TONE[version.status]}>
                      {STATUS_TEXT[version.status]}
                    </Badge>
                  )}
                  {version.candidate_group && takeLabel.get(version.number) && (
                    <Badge tone="neutral">{takeLabel.get(version.number)}</Badge>
                  )}
                  {version.duration_seconds != null && (
                    <Badge tone="neutral">
                      {formatDuration(version.duration_seconds)}
                    </Badge>
                  )}
                </div>

                <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--sf-text-faint)]">
                  <span>{formatDate(version.created_at)}</span>
                  {version.seed != null && <span>seed {version.seed}</span>}
                  {typeof version.request.cot === "string" && (
                    <span>planning: {version.request.cot}</span>
                  )}
                  {typeof version.request.cfg_scale === "number" && (
                    <span>CFG {version.request.cfg_scale}</span>
                  )}
                </dl>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {!version.is_primary && !version.is_plan_only && version.status === "completed" && (
                  <Button
                    size="sm"
                    loading={busy}
                    onClick={() =>
                      act("Could not set the primary version", () =>
                        api.updateProject(project.id, {
                          primary_version: version.number,
                        }),
                      )
                    }
                  >
                    Set primary
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="subtle"
                  loading={busy}
                  title="Put this take's lyrics, style, score, seed and generation settings back in the editor"
                  onClick={() =>
                    act("Could not restore this take", async () => {
                      await api.saveDraft(project.id, {
                        title: version.title,
                        lyrics: version.lyrics,
                        style_prompt: version.style_prompt,
                      });
                      if (version.score_abc) {
                        await api.saveScore(project.id, version.score_abc);
                      }
                      // The text goes to the server draft; the generation
                      // settings are not project fields, so they go straight
                      // into the workspace controls.
                      onRestoreSettings(
                        settingsFromVersion(version),
                        advancedFromVersion(version),
                      );
                    })
                  }
                >
                  Reuse this take
                </Button>
                {!version.is_primary && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmDelete(version)}
                    aria-label={`Delete version ${version.number}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                )}
              </div>
            </div>

            {!version.is_plan_only && version.has_flac && (
              <Player
                projectId={project.id}
                version={version.number}
                duration={version.duration_seconds}
                compact
                className="mt-3 border-0 bg-[var(--sf-bg)] p-2"
              />
            )}
          </Card>
        ))}
      </div>

      <Dialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={`Delete version ${confirmDelete?.number ?? ""}?`}
        description="This permanently removes this take's audio and files. Other versions are untouched."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                const target = confirmDelete;
                setConfirmDelete(null);
                if (target) {
                  await act("Could not delete the version", () =>
                    api.deleteVersion(project.id, target.number),
                  );
                }
              }}
            >
              Delete permanently
            </Button>
          </>
        }
      />
    </div>
  );
}

function ChangeSummary({
  from,
  to,
  show,
}: {
  from: Version | undefined;
  to: Version | undefined;
  show: boolean;
}) {
  if (!show || !from || !to || from.number === to.number) return null;

  const changes: string[] = [];
  if (from.style_prompt !== to.style_prompt) changes.push("style prompt");
  if (from.lyrics !== to.lyrics) changes.push("lyrics");
  if (from.score_abc !== to.score_abc) changes.push("score");
  if (from.seed !== to.seed) changes.push("seed");
  if (from.request.cot !== to.request.cot) changes.push("planning mode");
  if (from.request.cfg_scale !== to.request.cfg_scale) changes.push("CFG scale");

  return (
    <p className="mt-2 text-[11px] text-[var(--sf-text-faint)]">
      {changes.length === 0
        ? `Same settings as version ${from.number}; only the run differs.`
        : `Changed from version ${from.number}: ${changes.join(", ")}.`}
    </p>
  );
}
