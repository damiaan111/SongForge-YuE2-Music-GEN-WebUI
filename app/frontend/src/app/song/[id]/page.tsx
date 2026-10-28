"use client";

/**
 * Song workspace.
 *
 * Edits here are drafts. A completed version is never modified - "Generate new
 * version" is the only way to produce audio, which keeps every take immutable.
 */
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import * as React from "react";
import {
  ArrowLeft,
  Check,
  Download,
  FileMusic,
  Heart,
  ListMusic,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";

import { LineDiff } from "@/components/line-diff";
import { LyricsEditor } from "@/components/lyrics-editor";
import { Player } from "@/components/player";
import { StageRail } from "@/components/stage-rail";
import {
  AdvancedGenerationPanel,
  DEFAULT_ADVANCED,
  GenerationSettingsPanel,
  GenerationSummary,
  advancedErrors,
  advancedPayload,
  generationPayload,
  type AdvancedGeneration,
  type GenerationSettings,
} from "@/components/song/generation-settings";
import { VersionsTab } from "@/components/song/versions-tab";
import { FilesTab } from "@/components/song/files-tab";
import { LogsTab } from "@/components/song/logs-tab";
import { ScoreTab } from "@/components/song/score-tab";
import {
  Badge,
  Banner,
  Button,
  buttonClasses,
  Card,
  Dialog,
  Field,
  Input,
  Skeleton,
  Textarea,
} from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useStore } from "@/lib/store";
import type { GenerateRequest, Job, ProjectDetail, Version } from "@/lib/types";
import { cn, debounce, formatDate, formatDuration } from "@/lib/utils";

const TABS = [
  "Overview",
  "Lyrics",
  "Style",
  "Score",
  "Versions",
  "Files",
  "Logs",
] as const;
type Tab = (typeof TABS)[number];

export default function SongPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;
  const { settings, notify, trackJob, refreshJobs, jobs, onJobSettled } = useStore();
  const caps = settings?.capabilities;

  const [project, setProject] = React.useState<ProjectDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>("Overview");
  const [selectedVersion, setSelectedVersion] = React.useState<number | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [generating, setGenerating] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  // Draft state, separate from the loaded project so edits are explicit.
  const [title, setTitle] = React.useState("");
  const [lyrics, setLyrics] = React.useState("");
  const [style, setStyle] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [dirty, setDirty] = React.useState(false);

  // How the NEXT version should be generated. Not a project field: it describes
  // the run, and it is what "restore this take's settings" writes back into.
  const [gen, setGen] = React.useState<GenerationSettings | null>(null);
  const editGen = (patch: Partial<GenerationSettings>) =>
    setGen((current) => (current ? { ...current, ...patch } : current));
  const [advanced, setAdvanced] = React.useState<AdvancedGeneration>(DEFAULT_ADVANCED);

  const load = React.useCallback(async () => {
    try {
      const detail = await api.getProject(projectId);
      setProject(detail);
      setLoadError(null);
      // Only overwrite the editor when the user has no unsaved changes.
      setDirty((isDirty) => {
        if (!isDirty) {
          setTitle(detail.title);
          setLyrics(detail.lyrics);
          setStyle(detail.style_prompt);
          setNotes(detail.notes);
        }
        return isDirty;
      });
      setSelectedVersion((current) => {
        if (current !== null && detail.versions.some((v) => v.number === current)) {
          return current;
        }
        return detail.primary_version ?? detail.latest_version ?? null;
      });
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  React.useEffect(() => {
    // The state is set after an await inside load(); the rule cannot see across
    // the async boundary, so there is no synchronous cascade to avoid here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Seeded once, from the project and the global defaults. Deliberately not
  // re-synced afterwards: a reload while the user is choosing settings must not
  // silently discard the choices.
  if (!gen && project && settings) {
    setGen({
      cot: settings.default_cot,
      seed_mode: "random",
      seed: null,
      cfg_scale: settings.default_cfg_scale,
      instrumental: project.instrumental,
      language: project.language ?? settings.default_language,
      vocal_preference: project.vocal_preference ?? "",
      export_mp3: settings.export_mp3,
      export_wav: settings.export_wav,
    });
  }

  // Refresh when this project's job finishes.
  React.useEffect(
    () =>
      onJobSettled((event) => {
        if (event.project_id === projectId) void load();
      }),
    [onJobSettled, projectId, load],
  );

  const activeJob: Job | undefined = React.useMemo(
    () =>
      jobs.find(
        (job) =>
          job.project_id === projectId &&
          (job.status === "running" || job.status === "queued"),
      ),
    [jobs, projectId],
  );

  const lastJob: Job | undefined = React.useMemo(
    () =>
      jobs
        .filter((job) => job.project_id === projectId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0],
    [jobs, projectId],
  );

  // Autosave the draft, both locally and on the server.
  const save = React.useMemo(
    () =>
      debounce(
        (draft: { title: string; lyrics: string; style_prompt: string; notes: string }) => {
          setSaving(true);
          api
            .saveDraft(projectId, draft)
            .then(() => {
              setSavedAt(Date.now());
              setDirty(false);
            })
            .catch((cause: unknown) =>
              notify({
                tone: "danger",
                title: "Could not save the draft",
                body: cause instanceof Error ? cause.message : String(cause),
              }),
            )
            .finally(() => setSaving(false));
        },
        900,
      ),
    [projectId, notify],
  );

  const edit = (patch: Partial<{ title: string; lyrics: string; style: string; notes: string }>) => {
    const next = {
      title: patch.title ?? title,
      lyrics: patch.lyrics ?? lyrics,
      style: patch.style ?? style,
      notes: patch.notes ?? notes,
    };
    if (patch.title !== undefined) setTitle(patch.title);
    if (patch.lyrics !== undefined) setLyrics(patch.lyrics);
    if (patch.style !== undefined) setStyle(patch.style);
    if (patch.notes !== undefined) setNotes(patch.notes);
    setDirty(true);
    save({
      title: next.title,
      lyrics: next.lyrics,
      style_prompt: next.style,
      notes: next.notes,
    });
  };

  const generate = async (
    stage: "plan" | "audio",
    overrides: Partial<GenerateRequest> = {},
    draft: Partial<{ title: string; lyrics: string; style: string }> = {},
  ) => {
    const problems = advancedErrors(advanced);
    if (problems.length > 0) {
      notify({ tone: "warning", title: "Check the sampling settings", body: problems[0] });
      setTab("Style");
      return;
    }
    setGenerating(true);
    try {
      // Flush any pending draft first, so the version records what is on screen.
      save.cancel();
      // `draft` carries values set in this same event (the one-click lyrics
      // flow), which React state has not re-rendered with yet.
      await api.saveDraft(projectId, {
        title: draft.title ?? title,
        lyrics: draft.lyrics ?? lyrics,
        style_prompt: draft.style ?? style,
        notes,
      });
      setDirty(false);
      const job = await api.generate(projectId, {
        stage,
        ...(gen ? generationPayload(gen, caps) : {}),
        ...advancedPayload(advanced, caps),
        ...overrides,
      });
      trackJob(job);
      const takes = 1 + (job.sibling_job_ids?.length ?? 0);
      // The siblings exist only on the server so far; pull them into the queue.
      if (takes > 1) void refreshJobs();
      notify({
        tone: "info",
        title:
          stage === "plan"
            ? "Planning queued"
            : takes > 1
              ? `${takes} takes queued`
              : "Generation queued",
        body:
          takes > 1
            ? "They run one after another. Compare them in Versions when they finish."
            : job.queue_position && job.queue_position > 0
              ? `Position ${job.queue_position} in the queue.`
              : "Starting now.",
      });
      await load();
    } catch (cause) {
      notify({
        tone: "danger",
        title: "Could not start generation",
        body: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (loadError || !project) {
    return (
      <div className="mx-auto max-w-2xl">
        <Banner tone="danger" title="Could not open this song">
          <p>{loadError ?? "It may have been deleted."}</p>
        </Banner>
        <Link href="/" className={buttonClasses("secondary", "md", "mt-4 gap-2")}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to library
        </Link>
      </div>
    );
  }

  const version: Version | undefined =
    project.versions.find((v) => v.number === selectedVersion) ??
    project.versions[project.versions.length - 1];
  // Only a finished take with audio on disk can play. A queued or failed
  // version row exists too, and streaming it would surface a 404 as an error.
  const playable =
    version &&
    !version.is_plan_only &&
    version.status === "completed" &&
    (version.has_flac || version.has_mp3 || version.has_wav);

  return (
    <div className="mx-auto max-w-5xl">
      {/* --- Header --- */}
      <div className="mb-4 flex items-center gap-2">
        <Link
          href="/"
          className={buttonClasses("ghost", "icon")}
          aria-label="Back to library"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Link>
        <Input
          value={title}
          onChange={(event) => edit({ title: event.target.value })}
          aria-label="Song title"
          className="flex-1 border-transparent bg-transparent px-2 text-lg font-semibold hover:border-[var(--sf-border)]"
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={async () => {
            await api.updateProject(projectId, { favourite: !project.favourite });
            await load();
          }}
          aria-pressed={project.favourite}
          aria-label={project.favourite ? "Remove from favourites" : "Add to favourites"}
        >
          <Heart
            className={cn(
              "h-4 w-4",
              project.favourite
                ? "fill-[var(--sf-accent)] text-[var(--sf-accent)]"
                : "text-[var(--sf-text-faint)]",
            )}
            aria-hidden="true"
          />
        </Button>
      </div>

      <p className="mb-4 flex items-center gap-2 px-1 text-[11px] text-[var(--sf-text-faint)]">
        {saving ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Saving draft…
          </>
        ) : dirty ? (
          "Unsaved changes"
        ) : savedAt ? (
          <>
            <Check className="h-3 w-3" aria-hidden="true" /> Draft saved
          </>
        ) : (
          `Created ${formatDate(project.created_at)}`
        )}
        <span aria-hidden="true">·</span>
        Edits are drafts until you generate a new version.
      </p>

      {/* --- Active job --- */}
      {activeJob && (
        <Card className="mb-4 p-4">
          <StageRail job={activeJob} stages={caps?.stages} />
        </Card>
      )}

      {/* --- Player --- */}
      <Card className="mb-4 overflow-hidden">
        <div className="flex flex-col gap-4 p-4">
          <div className="flex min-w-0 flex-1 flex-col justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {project.versions.length > 0 && (
                <select
                  value={selectedVersion ?? ""}
                  onChange={(event) => setSelectedVersion(Number(event.target.value))}
                  aria-label="Version"
                  className="rounded-lg border border-[var(--sf-border)] bg-[var(--sf-bg)] px-2.5 py-1.5 text-xs"
                >
                  {project.versions.map((entry) => (
                    <option key={entry.id} value={entry.number}>
                      Version {entry.number}
                      {entry.is_primary ? " (primary)" : ""}
                      {entry.is_plan_only ? " — score only" : ""}
                    </option>
                  ))}
                </select>
              )}
              {version?.is_plan_only && <Badge tone="info">Score only</Badge>}
              {version?.duration_seconds != null && (
                <Badge tone="neutral">{formatDuration(version.duration_seconds)}</Badge>
              )}
              {version?.seed != null && (
                <Badge tone="neutral">seed {version.seed}</Badge>
              )}
              {isTruncated(version) && (
                <Badge tone="warning">Cut short at the token limit</Badge>
              )}
            </div>

            <TruncationNotice version={version} />

            {playable ? (
              <Player
                projectId={projectId}
                version={version.number}
                title={project.title}
                duration={version.duration_seconds}
                className="border-0 bg-transparent p-0"
              />
            ) : (
              <p className="text-sm text-[var(--sf-text-muted)]">
                {!version
                  ? "No audio yet. Generate a version to hear it."
                  : version.status === "queued" || version.status === "running"
                    ? `Version ${version.number} is ${version.status === "queued" ? "waiting in the queue" : "generating"}. It will play here when it finishes.`
                    : version.status === "failed" || version.status === "interrupted"
                      ? `Version ${version.number} did not finish, so it has no audio. The Logs tab shows why.`
                      : version.status === "cancelled"
                        ? `Version ${version.number} was cancelled before it produced audio.`
                        : version.is_plan_only
                          ? "This version is a score. Review it in the Score tab, then render the audio."
                          : "This version has no audio file on disk."}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                loading={generating}
                disabled={Boolean(activeJob)}
                onClick={() => void generate("audio")}
              >
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                {version?.is_plan_only ? "Render audio" : "Generate new version"}
              </Button>
              {caps?.supports_plan_stage && (
                <Button
                  loading={generating}
                  disabled={Boolean(activeJob)}
                  onClick={() => void generate("plan")}
                  title="Write only the score, so you can edit it before rendering"
                >
                  <ListMusic className="h-4 w-4" aria-hidden="true" />
                  Plan only
                </Button>
              )}
            </div>

            {/* What the buttons above will actually use, so nobody has to open
                the Style tab to find out. */}
            {gen && (
              <button
                type="button"
                onClick={() => setTab("Style")}
                className="mt-2 text-left"
                title="Change these in Style & Settings"
              >
                <GenerationSummary value={gen} />
              </button>
            )}
          </div>
        </div>
      </Card>

      {/* --- Tabs --- */}
      <div
        className="mb-4 flex gap-1 overflow-x-auto border-b border-[var(--sf-border)]"
        role="tablist"
        aria-label="Song sections"
        onKeyDown={(event) => {
          // Declaring role="tab" promises arrow-key navigation; without this
          // the pattern is announced and then does not work.
          const delta =
            event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (!delta && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          const index = TABS.indexOf(tab);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? TABS.length - 1
                : (index + delta + TABS.length) % TABS.length;
          setTab(TABS[next]);
          document.getElementById(`tab-${TABS[next]}`)?.focus();
        }}
      >
        {TABS.map((name) => (
          <button
            key={name}
            id={`tab-${name}`}
            role="tab"
            type="button"
            aria-selected={tab === name}
            aria-controls="song-tabpanel"
            // Roving tabindex: one stop for the whole tablist, arrows move within.
            tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}
            className={cn(
              "whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors",
              tab === name
                ? "border-[var(--sf-accent)] text-[var(--sf-text)]"
                : "border-transparent text-[var(--sf-text-muted)] hover:text-[var(--sf-text)]",
            )}
          >
            {name}
          </button>
        ))}
      </div>

      <div id="song-tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={-1}>
        {tab === "Overview" && (
          <OverviewTab
            project={project}
            version={version}
            notes={notes}
            onNotesChange={(value) => edit({ notes: value })}
            onReload={load}
            onDelete={() => setConfirmDelete(true)}
          />
        )}

        {tab === "Lyrics" && (
          <Card className="p-5">
            <LyricsEditor
              value={lyrics}
              onChange={(value) => edit({ lyrics: value })}
              historyKey={projectId}
              writer={{
                storageKey: `songforge.lyrics-writer.${projectId}`,
                defaults: {
                  styleHint: style,
                  language: project.language ?? settings?.default_language ?? "English",
                },
                openInitially: !lyrics.trim(),
                onResult: (result, { applyStyle, applyTitle }) => {
                  edit({
                    ...(applyStyle && result.style ? { style: result.style } : {}),
                    ...(applyTitle && result.title ? { title: result.title } : {}),
                  });
                },
                onWriteAndRender: async (result) => {
                  const nextStyle = style.trim() || result.style;
                  const nextTitle = title.trim() && title !== "Untitled" ? title : result.title;
                  edit({ lyrics: result.lyrics, style: nextStyle, title: nextTitle });
                  await generate("audio", {}, {
                    lyrics: result.lyrics, style: nextStyle, title: nextTitle,
                  });
                  setTab("Logs");
                },
              }}
              hint={
                version && version.lyrics !== lyrics ? (
                  <span className="text-[var(--sf-warning)]">
                    Differs from version {version.number}
                  </span>
                ) : undefined
              }
            />
            {version && version.lyrics !== lyrics && (
              <details className="mt-4 rounded-lg border border-[var(--sf-border)] p-3">
                <summary className="cursor-pointer text-xs font-medium text-[var(--sf-text-muted)]">
                  Changes since version {version.number}
                </summary>
                <LineDiff
                  className="mt-2"
                  before={version.lyrics}
                  after={lyrics}
                  beforeLabel={`version ${version.number}`}
                  afterLabel="the draft"
                />
              </details>
            )}
          </Card>
        )}

        {tab === "Style" && (
          <Card className="p-5">
            <Field
              label="Style prompt"
              htmlFor="style"
              hint="Genre, instruments, mood and vocal character. This is the only style channel YuE2 has."
            >
              <Textarea
                id="style"
                value={style}
                rows={5}
                onChange={(event) => edit({ style: event.target.value })}
              />
            </Field>
            {project.tags.length > 0 && (
              <div className="mt-4">
                <p className="mb-1.5 text-[11px] font-medium text-[var(--sf-text-muted)]">
                  Tags
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {project.tags.map((value) => (
                    <Badge key={value} tone="neutral">
                      {value}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {version && version.style_prompt !== style && (
              <p className="mt-3 text-xs text-[var(--sf-warning)]">
                This differs from what version {version.number} was generated with.
              </p>
            )}

            {gen && (
              <div className="mt-6 border-t border-[var(--sf-border)] pt-5">
                <h3 className="text-sm font-semibold tracking-wide">
                  Settings for the next version
                </h3>
                <p className="mt-1 mb-4 text-xs leading-relaxed text-[var(--sf-text-muted)]">
                  These apply to the next Generate. Completed versions keep the
                  settings they were made with.
                </p>
                <GenerationSettingsPanel
                  value={gen}
                  onChange={editGen}
                  caps={caps}
                  ffmpeg={Boolean(settings?.ffmpeg_available)}
                />
                <div className="mt-5 border-t border-[var(--sf-border)] pt-5">
                  <AdvancedGenerationPanel
                    value={advanced}
                    onChange={setAdvanced}
                    caps={caps}
                  />
                </div>
              </div>
            )}
          </Card>
        )}

        {/* onRender pins the seed: re-rendering an edited score must change the
            arrangement only where the score changed, not everywhere. */}
        {tab === "Score" && (
          <ScoreTab
            project={project}
            version={version}
            onSaved={load}
            onRender={() => void generate("audio", { seed_mode: "locked" })}
            canPlan={Boolean(caps?.supports_plan_stage)}
            onPlan={() => void generate("plan")}
            busy={generating || Boolean(activeJob)}
          />
        )}

        {tab === "Versions" && (
          <VersionsTab
            project={project}
            selected={selectedVersion}
            onSelect={setSelectedVersion}
            onChanged={load}
            onRestoreSettings={(restored, restoredAdvanced) => {
              editGen(restored);
              // Restoring one take reproduces one take, whatever the set size.
              setAdvanced(restoredAdvanced);
              setTab("Style");
            }}
          />
        )}

        {tab === "Files" && <FilesTab project={project} version={version} />}

        {tab === "Logs" && (
          <LogsTab job={activeJob ?? lastJob} version={version} onRetry={load} />
        )}
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete “${project.title}”?`}
        description="This permanently removes the project, every version and all its audio from disk. It cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                setConfirmDelete(false);
                try {
                  await api.deleteProject(projectId);
                  router.push("/");
                } catch (cause) {
                  notify({
                    tone: "danger",
                    title: "Could not delete",
                    body: cause instanceof Error ? cause.message : String(cause),
                  });
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

function isTruncated(version: Version | undefined): boolean {
  const truncated = version?.result?.truncated as
    | Record<string, boolean>
    | undefined;
  return Boolean(truncated && Object.values(truncated).some(Boolean));
}

/**
 * Says what a token limit actually cost, because "cut short" on its own does
 * not tell you whether to shorten the lyrics or simplify the arrangement.
 *
 * The two stages fail differently: the score plan running out means the
 * structure for the later sections was never written, so whole sections can be
 * missing from the middle of the song; the music budget running out means the
 * audio simply stops at about six minutes.
 */
function TruncationNotice({ version }: { version: Version | undefined }) {
  const truncated = version?.result?.truncated as
    | Record<string, boolean>
    | undefined;
  if (!truncated) return null;
  const abc = Boolean(truncated.abc);
  const semantic = Boolean(truncated.semantic);
  if (!abc && !semantic) return null;

  return (
    <div className="mt-3">
      <Banner
        tone="warning"
        title={abc ? "The score plan ran out of room" : "The song hit the six-minute ceiling"}
      >
        {abc && (
          <p>
            YuE2 stopped writing the score before the end, so the later sections had no
            plan to sing from and may be missing or improvised. Shorten the lyrics or
            use fewer sections, then render again.
          </p>
        )}
        {semantic && (
          <p className={abc ? "mt-1.5" : undefined}>
            The audio stopped at YuE2&apos;s 9,000-token music budget, about six
            minutes, so the ending was not sung. The lyrics were longer than the model
            can perform in one render.
          </p>
        )}
        <p className="mt-1.5">
          <Link
            href="/learn/length"
            className="text-[var(--sf-accent)] underline-offset-2 hover:underline"
          >
            Why songs get cut short
          </Link>
        </p>
      </Banner>
    </div>
  );
}

function OverviewTab({
  project,
  version,
  notes,
  onNotesChange,
  onReload,
  onDelete,
}: {
  project: ProjectDetail;
  version: Version | undefined;
  notes: string;
  onNotesChange: (value: string) => void;
  onReload: () => void;
  onDelete: () => void;
}) {
  const timing = version?.result?.timing as Record<string, unknown> | undefined;
  const identity = version?.result?.identity as string | undefined;

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold">Details</h2>
        <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          <Detail label="Status" value={project.status} />
          <Detail label="Versions" value={String(project.version_count)} />
          <Detail label="Created" value={formatDate(project.created_at)} />
          <Detail label="Plays" value={String(project.play_count)} />
          {project.language && <Detail label="Language" value={project.language} />}
          {project.vocal_preference && (
            <Detail label="Vocal" value={project.vocal_preference} />
          )}
          {version?.sample_rate && (
            <Detail
              label="Audio"
              value={`24-bit / ${(version.sample_rate / 1000).toFixed(0)} kHz FLAC`}
            />
          )}
          {version?.seed != null && <Detail label="Seed" value={String(version.seed)} />}
        </dl>
      </Card>

      {/* Provenance is genuinely unusual for this class of app: the model and
          VAE checksums plus an identity hash make a run reproducible. */}
      {(identity || timing) && (
        <Card className="p-5">
          <h2 className="mb-1 text-sm font-semibold">Provenance</h2>
          <p className="mb-3 text-xs text-[var(--sf-text-muted)]">
            Reported by the runner for version {version?.number}. With the same
            seed and settings, this identity reproduces the same song.
          </p>
          <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
            {identity && (
              <Detail label="Identity" value={identity.slice(0, 24) + "…"} mono />
            )}
            {typeof timing?.e2e_seconds === "number" && (
              <Detail
                label="Generated in"
                value={`${Math.round(timing.e2e_seconds as number)} s`}
              />
            )}
            {typeof timing?.output_tps === "number" && (
              <Detail
                label="Throughput"
                value={`${(timing.output_tps as number).toFixed(1)} tokens/s`}
              />
            )}
            {typeof timing?.attention === "string" && (
              <Detail label="Attention" value={timing.attention as string} />
            )}
            {typeof timing?.execution === "string" && (
              <Detail label="Execution" value={timing.execution as string} />
            )}
          </dl>
        </Card>
      )}

      <Card className="p-5">
        <Field label="Notes" htmlFor="notes" hint="Private to you; never sent to the model.">
          <Textarea
            id="notes"
            value={notes}
            rows={4}
            onChange={(event) => onNotesChange(event.target.value)}
            placeholder="What worked, what to try next…"
          />
        </Field>
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold">Actions</h2>
        <div className="flex flex-wrap gap-2">
          <a
            href={api.exportZipUrl(project.id)}
            className={buttonClasses("secondary", "md", "gap-2")}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Export everything (.zip)
          </a>
          <Button
            onClick={async () => {
              await api.duplicateProject(project.id);
              onReload();
            }}
          >
            <FileMusic className="h-4 w-4" aria-hidden="true" />
            Duplicate settings
          </Button>
          <Button
            onClick={async () => {
              await api.archiveProject(project.id, !project.archived);
              onReload();
            }}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {project.archived ? "Restore" : "Archive"}
          </Button>
          <Button variant="danger" onClick={onDelete}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Delete…
          </Button>
        </div>
      </Card>
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3 border-b border-[var(--sf-border)] pb-1.5 last:border-0">
      <dt className="text-[var(--sf-text-faint)]">{label}</dt>
      <dd className={cn("text-right text-[var(--sf-text)]", mono && "font-mono text-[11px]")}>
        {value}
      </dd>
    </div>
  );
}
