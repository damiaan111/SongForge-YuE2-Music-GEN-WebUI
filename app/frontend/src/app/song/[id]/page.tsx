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
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  Copy,
  Crown,
  Download,
  Heart,
  ListMusic,
  MoreHorizontal,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";

import { Artwork } from "@/components/artwork";
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
  KeyValue,
  Menu,
  MenuItem,
  SectionTitle,
  Skeleton,
  Spinner,
  Tabs,
  Textarea,
} from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useAudio } from "@/lib/audio";
import { useStore } from "@/lib/store";
import type { GenerateRequest, Job, ProjectDetail, ProjectStatus, Version } from "@/lib/types";
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

const STATUS_TONE: Record<ProjectStatus, "neutral" | "accent" | "success" | "warning" | "danger" | "info"> = {
  draft: "neutral",
  queued: "info",
  generating: "accent",
  completed: "success",
  failed: "danger",
  cancelled: "warning",
  archived: "neutral",
};

const STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: "Draft",
  queued: "Queued",
  generating: "Generating",
  completed: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
  archived: "Archived",
};

export default function SongPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;
  const { settings, notify, trackJob, refreshJobs, jobs, onJobSettled } = useStore();
  const audio = useAudio();
  const caps = settings?.capabilities;

  const [project, setProject] = React.useState<ProjectDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>("Overview");
  const [selectedVersion, setSelectedVersion] = React.useState<number | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [generating, setGenerating] = React.useState<"plan" | "audio" | null>(null);
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

  // The browser tab should say which song this is.
  React.useEffect(() => {
    if (!project) return;
    const previous = document.title;
    document.title = `${title || project.title} · SongForge`;
    return () => {
      document.title = previous;
    };
  }, [project, title]);

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

  // The one that is running, if any; otherwise the next one waiting. With two
  // takes queued, picking simply "the first unfinished job" showed "Waiting in
  // the queue" above a song that was in fact being rendered.
  const activeJob: Job | undefined = React.useMemo(() => {
    const mine = jobs.filter((job) => job.project_id === projectId);
    return (
      mine.find((job) => job.status === "running") ??
      mine
        .filter((job) => job.status === "queued")
        .sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0))[0]
    );
  }, [jobs, projectId]);

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
    setGenerating(stage);
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
        // "Takes" is about audio: several performances to choose between. A
        // plan is one score to read and edit, and two of them only doubled
        // the wait and left a second score-only version to tidy away.
        ...(stage === "plan" ? { candidates: undefined } : {}),
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
      setGenerating(null);
    }
  };

  /** A project-level action from the header menu, with its failure reported. */
  const act = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
      await load();
    } catch (cause) {
      notify({
        tone: "danger",
        title: label,
        body: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex items-center gap-4">
          <Skeleton className="h-20 w-20 rounded-2xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-8 w-72 max-w-full" />
            <Skeleton className="h-4 w-48" />
          </div>
        </div>
        <Skeleton className="h-48 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  if (loadError || !project) {
    return (
      <div className="mx-auto max-w-2xl">
        <Banner tone="danger" title="Could not open this song">
          <p>{loadError ?? "It may have been deleted."}</p>
        </Banner>
        <Link href="/" className={buttonClasses("secondary", "md", "mt-4")}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to the library
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
  const busy = generating !== null || Boolean(activeJob);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-lg py-1 pr-2 text-[13px] font-medium text-ink-muted transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Library
        </Link>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="subtle"
            size="icon"
            className="h-10 w-10"
            onClick={() =>
              act("Could not update favourite", () =>
                api.updateProject(projectId, { favourite: !project.favourite }),
              )
            }
            aria-pressed={project.favourite}
            aria-label={project.favourite ? "Remove from favourites" : "Add to favourites"}
            title={project.favourite ? "Remove from favourites" : "Add to favourites"}
          >
            <Heart
              className={cn("h-4 w-4", project.favourite && "fill-accent text-accent")}
              aria-hidden="true"
            />
          </Button>
          <Menu
            label="Song actions"
            trigger={(props) => (
              <Button {...props} variant="subtle" size="icon" className="h-10 w-10" aria-label="More actions">
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          >
            {(close) => (
              <div className="w-60">
                <MenuItem
                  icon={<Download className="h-4 w-4" aria-hidden="true" />}
                  href={api.exportZipUrl(project.id)}
                  onClick={close}
                  description="Every version, input and log"
                >
                  Export everything (.zip)
                </MenuItem>
                <MenuItem
                  icon={<Copy className="h-4 w-4" aria-hidden="true" />}
                  description="A new song with the same lyrics and style"
                  onClick={() => {
                    close();
                    void (async () => {
                      try {
                        const copy = await api.duplicateProject(project.id);
                        notify({
                          tone: "success",
                          title: "Duplicated",
                          body: `“${copy.title}” is ready to edit.`,
                          href: `/song/${copy.id}`,
                        });
                        router.push(`/song/${copy.id}`);
                      } catch (cause) {
                        notify({
                          tone: "danger",
                          title: "Could not duplicate",
                          body: cause instanceof Error ? cause.message : String(cause),
                        });
                      }
                    })();
                  }}
                >
                  Duplicate
                </MenuItem>
                <MenuItem
                  icon={
                    project.archived ? (
                      <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Archive className="h-4 w-4" aria-hidden="true" />
                    )
                  }
                  onClick={() => {
                    close();
                    void act("Could not archive", () =>
                      api.archiveProject(project.id, !project.archived),
                    );
                  }}
                >
                  {project.archived ? "Restore from the archive" : "Archive"}
                </MenuItem>
                <div className="my-1 h-px bg-edge" role="separator" />
                <MenuItem
                  danger
                  icon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                  onClick={() => {
                    close();
                    setConfirmDelete(true);
                  }}
                >
                  Delete…
                </MenuItem>
              </div>
            )}
          </Menu>
        </div>
      </div>

      {/* --- Header --- */}
      <header className="mb-6 flex items-start gap-4 sm:gap-5">
        <div className="h-[4.5rem] w-[4.5rem] shrink-0 sm:h-24 sm:w-24">
          <Artwork seed={project.id} bars={14} rounded="rounded-2xl" />
        </div>

        <div className="min-w-0 flex-1">
          <input
            value={title}
            onChange={(event) => edit({ title: event.target.value })}
            aria-label="Song title"
            placeholder="Untitled"
            maxLength={200}
            className={cn(
              "sf-display -ml-2 w-[calc(100%+0.5rem)] truncate rounded-lg border border-transparent bg-transparent px-2 py-0.5",
              "text-[1.4rem] font-semibold leading-tight text-ink placeholder:text-ink-faint sm:text-[1.9rem]",
              "transition-colors hover:border-edge focus:border-accent focus:bg-sunken focus:outline-none",
            )}
          />
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-ink-faint">
            <Badge
              tone={STATUS_TONE[project.status]}
              dot={project.status === "generating" || project.status === "queued" ? "live" : undefined}
            >
              {STATUS_LABEL[project.status]}
            </Badge>
            <span>Created {formatDate(project.created_at)}</span>
            {project.version_count > 0 && (
              <span>
                {project.version_count} {project.version_count === 1 ? "version" : "versions"}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5" aria-live="polite">
              {saving ? (
                <>
                  <Spinner className="h-3 w-3" /> Saving…
                </>
              ) : dirty ? (
                "Unsaved changes"
              ) : savedAt ? (
                <>
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" /> Draft saved
                </>
              ) : null}
            </span>
          </div>
        </div>

      </header>

      {project.archived && (
        <Banner tone="info" title="This song is archived" className="mb-5">
          It is hidden from the library but nothing has been deleted.
        </Banner>
      )}

      {/* --- Active job --- */}
      {activeJob && (
        <Card className="sf-rise mb-5 border-accent/35 p-5">
          <StageRail job={activeJob} stages={caps?.stages} />
        </Card>
      )}

      {/* --- Player --- */}
      <Card className="mb-6 p-5 sm:p-6">
        {project.versions.length > 0 && (
          <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3">
            <VersionPicker
              versions={project.versions}
              selected={version?.number ?? null}
              onSelect={setSelectedVersion}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {version?.is_plan_only && <Badge tone="info">Score only</Badge>}
              {version?.duration_seconds != null && (
                <Badge tone="neutral">{formatDuration(version.duration_seconds)}</Badge>
              )}
              {version?.seed != null && <Badge tone="neutral">seed {version.seed}</Badge>}
              {isTruncated(version) && <Badge tone="warning">Cut short</Badge>}
            </div>
          </div>
        )}

        <TruncationNotice version={version} />

        {playable ? (
          <Player
            projectId={projectId}
            version={version.number}
            title={title || project.title}
            duration={version.duration_seconds}
          />
        ) : (
          <div className="flex items-center gap-4 rounded-xl border border-dashed border-edge-strong/70 px-5 py-6">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-overlay text-ink-faint">
              <ListMusic className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="text-sm leading-relaxed text-ink-muted">
              {!version
                ? "No audio yet. Generate a version to hear this song."
                : version.status === "queued" || version.status === "running"
                  ? `Version ${version.number} is ${version.status === "queued" ? "waiting in the queue" : "being generated"}. It will play here when it finishes.`
                  : version.status === "failed" || version.status === "interrupted"
                    ? `Version ${version.number} did not finish, so it has no audio. The Logs tab shows why.`
                    : version.status === "cancelled"
                      ? `Version ${version.number} was cancelled before it produced audio.`
                      : version.is_plan_only
                        ? "This version is a score. Review it in the Score tab, then render the audio."
                        : "This version has no audio file on disk."}
            </p>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-edge pt-5">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              loading={generating === "audio"}
              disabled={busy}
              onClick={() => void generate("audio")}
            >
              {generating !== "audio" && <Sparkles className="h-4 w-4" aria-hidden="true" />}
              {version?.is_plan_only ? "Render audio" : project.versions.length === 0 ? "Generate song" : "Generate new version"}
            </Button>
            {caps?.supports_plan_stage && (
              <Button
                loading={generating === "plan"}
                disabled={busy}
                onClick={() => void generate("plan")}
                title="Write only the score, so you can edit it before rendering"
              >
                {generating !== "plan" && <ListMusic className="h-4 w-4" aria-hidden="true" />}
                Plan only
              </Button>
            )}
          </div>

          {/* What the buttons above will actually use, so nobody has to open
              the Style tab to find out. */}
          {gen && (
            <button
              type="button"
              onClick={() => {
                setTab("Style");
                requestAnimationFrame(() =>
                  document
                    .getElementById("next-version-settings")
                    ?.scrollIntoView({ block: "start", behavior: "smooth" }),
                );
              }}
              className="group ml-auto flex items-center gap-2 rounded-lg py-1 text-left"
              title="Change the settings for the next version"
            >
              <GenerationSummary value={gen} takes={advanced.candidates} />
              <SlidersHorizontal
                className="h-4 w-4 shrink-0 text-ink-faint transition-colors group-hover:text-accent"
                aria-hidden="true"
              />
            </button>
          )}
        </div>
        {activeJob && (
          <p className="mt-3 text-xs text-ink-faint">
            A version of this song is already in progress; another can start when it
            finishes.
          </p>
        )}
      </Card>

      {/* --- Tabs --- */}
      <Tabs
        className="mb-5"
        label="Song sections"
        idPrefix="tab"
        panelId="song-tabpanel"
        value={tab}
        onChange={setTab}
        tabs={TABS.map((name) => ({
          value: name,
          label: name === "Style" ? "Style & settings" : name,
          // Finished takes only, the same number the header gives. A cancelled
          // or failed attempt is listed in the tab but is not a version to keep.
          count: name === "Versions" ? project.version_count : null,
        }))}
      />

      <div
        id="song-tabpanel"
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        tabIndex={-1}
        className="focus:outline-none"
      >
        {tab === "Overview" && (
          <OverviewTab
            project={project}
            version={version}
            notes={notes}
            onNotesChange={(value) => edit({ notes: value })}
          />
        )}

        {tab === "Lyrics" && (
          <Card className="p-5 sm:p-6">
            <SectionTitle
              className="mb-5"
              description="Edits are a draft until you generate a new version — finished versions never change."
            >
              Lyrics
            </SectionTitle>
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
                  <span className="text-warning">Differs from version {version.number}</span>
                ) : undefined
              }
            />
            {version && version.lyrics !== lyrics && (
              <details className="sf-disclosure mt-4 rounded-xl border border-edge bg-sunken/50 p-4">
                <summary className="text-[13px] font-medium text-ink">
                  Changes since version {version.number}
                </summary>
                <LineDiff
                  className="mt-3"
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
          <div className="space-y-5">
            <Card className="p-5 sm:p-6">
              <SectionTitle className="mb-5" description="Genre, instruments, mood and vocal character. This is the only style channel YuE2 has.">
                Style
              </SectionTitle>
              <Field label="Style prompt" htmlFor="style">
                <Textarea
                  id="style"
                  value={style}
                  rows={4}
                  onChange={(event) => edit({ style: event.target.value })}
                  placeholder="indie folk, fingerpicked acoustic guitar, close-mic'd, rainy afternoon"
                />
              </Field>
              {version && version.style_prompt !== style && (
                <p className="mt-2 text-[13px] text-warning">
                  This differs from what version {version.number} was generated with.
                </p>
              )}
              {project.tags.length > 0 && (
                <div className="mt-5">
                  <p className="mb-2 text-[13px] font-medium text-ink">Tags</p>
                  <div className="flex flex-wrap gap-1.5">
                    {project.tags.map((value) => (
                      <Badge key={value} tone="neutral">
                        {value}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            {gen && (
              <Card id="next-version-settings" className="scroll-mt-20 p-5 sm:p-6">
                <SectionTitle
                  className="mb-5"
                  description="These apply to the next Generate. Completed versions keep the settings they were made with."
                >
                  Settings for the next version
                </SectionTitle>
                <GenerationSettingsPanel
                  value={gen}
                  onChange={editGen}
                  caps={caps}
                  ffmpeg={Boolean(settings?.ffmpeg_available)}
                />
                <div className="mt-6 border-t border-edge pt-6">
                  <AdvancedGenerationPanel
                    value={advanced}
                    onChange={setAdvanced}
                    caps={caps}
                  />
                </div>
              </Card>
            )}
          </div>
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
            busy={busy}
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

        {/* The log of the take on screen, not merely the most recent one: with
            two versions, "Logs" under version 1 used to show version 2's run. */}
        {tab === "Logs" && (
          <LogsTab
            job={activeJob ?? jobForVersion(jobs, projectId, version) ?? lastJob}
            version={version}
            onRetry={load}
          />
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
                  if (audio.track?.projectId === projectId) audio.close();
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

/**
 * Which take the page is showing.
 *
 * A handful of versions are pills you can see at once; past that the row
 * scrolls sideways rather than wrapping the player down the page.
 */
function VersionPicker({
  versions,
  selected,
  onSelect,
}: {
  versions: Version[];
  selected: number | null;
  onSelect: (number: number) => void;
}) {
  if (versions.length === 1) {
    return (
      <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-edge bg-sunken px-3 text-[13px] font-medium text-ink">
        Version {versions[0].number}
      </span>
    );
  }
  return (
    <div
      role="radiogroup"
      aria-label="Version"
      className="sf-scroll-x flex max-w-full gap-1 rounded-full border border-edge bg-sunken p-1"
    >
      {versions.map((entry) => {
        const active = entry.number === selected;
        const usable = entry.status === "completed";
        return (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`Version ${entry.number}${entry.is_primary ? ", primary" : ""}${entry.is_plan_only ? ", score only" : ""}${usable ? "" : `, ${entry.status}`}`}
            title={entry.is_primary ? "Primary version" : entry.is_plan_only ? "Score only" : undefined}
            onClick={() => onSelect(entry.number)}
            className={cn(
              "sf-focus-inset inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-3 text-[13px] font-medium tabular-nums transition-colors",
              active
                ? "bg-elevated text-ink shadow-[var(--sf-highlight),var(--sf-shadow-sm)]"
                : "text-ink-muted hover:text-ink",
              !usable && !active && "opacity-60",
            )}
          >
            {entry.is_primary && <Crown className="h-3 w-3 text-accent" aria-hidden="true" />}
            v{entry.number}
          </button>
        );
      })}
    </div>
  );
}

/** The newest job that produced (or tried to produce) this version. */
function jobForVersion(
  jobs: Job[],
  projectId: string,
  version: Version | undefined,
): Job | undefined {
  if (!version) return undefined;
  return jobs
    .filter((job) => job.project_id === projectId && job.version_number === version.number)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
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
    <Banner
      tone="warning"
      className="mb-5"
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
          className="font-medium text-accent underline-offset-2 hover:underline"
        >
          Why songs get cut short
        </Link>
      </p>
    </Banner>
  );
}

function OverviewTab({
  project,
  version,
  notes,
  onNotesChange,
}: {
  project: ProjectDetail;
  version: Version | undefined;
  notes: string;
  onNotesChange: (value: string) => void;
}) {
  const timing = version?.result?.timing as Record<string, unknown> | undefined;
  const identity = version?.result?.identity as string | undefined;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="p-5 sm:p-6">
        <SectionTitle className="mb-2">Details</SectionTitle>
        <dl className="divide-y divide-edge">
          <KeyValue label="Status" value={STATUS_LABEL[project.status]} />
          <KeyValue label="Versions" value={String(project.version_count)} />
          <KeyValue label="Created" value={formatDate(project.created_at)} />
          <KeyValue label="Plays" value={String(project.play_count)} />
          {project.language && <KeyValue label="Language" value={project.language} />}
          {project.vocal_preference && (
            <KeyValue label="Vocal" value={project.vocal_preference} />
          )}
          {project.instrumental && <KeyValue label="Vocals" value="Instrumental" />}
          {version?.sample_rate && (
            <KeyValue
              label="Audio"
              value={`24-bit / ${(version.sample_rate / 1000).toFixed(0)} kHz FLAC`}
            />
          )}
          {version?.seed != null && <KeyValue label="Seed" value={String(version.seed)} mono />}
        </dl>
      </Card>

      <div className="space-y-5">
        {/* Provenance is genuinely unusual for this class of app: the model and
            VAE checksums plus an identity hash make a run reproducible. */}
        {(identity || timing) && (
          <Card className="p-5 sm:p-6">
            <SectionTitle
              className="mb-2"
              description={`Reported by the engine for version ${version?.number}. With the same seed and settings, this identity reproduces the same song.`}
            >
              Provenance
            </SectionTitle>
            <dl className="divide-y divide-edge">
              {identity && (
                <KeyValue
                  label="Identity"
                  value={<span title={identity}>{identity.slice(0, 20) + "…"}</span>}
                  mono
                />
              )}
              {typeof timing?.e2e_seconds === "number" && (
                <KeyValue
                  label="Generated in"
                  value={formatDuration(timing.e2e_seconds as number) + " min"}
                />
              )}
              {typeof timing?.output_tps === "number" && (
                <KeyValue
                  label="Throughput"
                  value={`${(timing.output_tps as number).toFixed(1)} tokens/s`}
                />
              )}
              {typeof timing?.attention === "string" && (
                <KeyValue label="Attention" value={timing.attention as string} />
              )}
              {typeof timing?.execution === "string" && (
                <KeyValue label="Execution" value={timing.execution as string} />
              )}
            </dl>
          </Card>
        )}

        <Card className="p-5 sm:p-6">
          <Field label="Notes" htmlFor="notes" hint="Private to you; never sent to the model.">
            <Textarea
              id="notes"
              value={notes}
              rows={5}
              onChange={(event) => onNotesChange(event.target.value)}
              placeholder="What worked, what to try next…"
            />
          </Field>
        </Card>
      </div>
    </div>
  );
}
