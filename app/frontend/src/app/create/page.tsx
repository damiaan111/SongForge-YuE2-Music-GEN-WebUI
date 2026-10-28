"use client";

/**
 * Create - Quick and Custom modes.
 *
 * Controls are driven by the active runner's declared capabilities, so nothing
 * is offered that the model cannot honour, and anything it does support that
 * Suno-style apps lack (planning mode, own score, plan-first) is surfaced.
 */
import { useRouter } from "next/navigation";
import * as React from "react";
import { Info, ListMusic, Sparkles } from "lucide-react";

import { LyricsEditor } from "@/components/lyrics-editor";
import { BudgetMeter, useBudget } from "@/components/song/budget-meter";
import {
  AdvancedGenerationPanel,
  DEFAULT_ADVANCED,
  TakesField,
  advancedErrors,
  advancedPayload,
  takesPayload,
  type AdvancedGeneration,
} from "@/components/song/generation-settings";
import { StyleBuilder, VocalChips } from "@/components/song/style-builder";
import {
  Badge,
  Banner,
  Button,
  Card,
  Field,
  Input,
  Select,
  Textarea,
  Toggle,
} from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useStore } from "@/lib/store";
import { EMPTY_STYLE, composeStyle, type StyleDraft } from "@/lib/style-tags";
import type { CotMode, Project, SeedMode } from "@/lib/types";
import { cn, debounce } from "@/lib/utils";

/**
 * Cover mode is Custom with the planning decision made for you: YuE2's own
 * guidance is that a cover supplies a melody-only score so the accompaniment
 * can adapt to the new style.
 */
const CREATE_MODES = ["quick", "custom", "cover"] as const;
type CreateMode = (typeof CREATE_MODES)[number];

/** What a submission uses; the one-click lyrics flow passes fresh values in. */
interface SubmitValues {
  lyrics: string;
  style: string;
  title: string;
}

/** Accepts "1.5" and the "1,5" a European keyboard produces; null if not a number. */
function parseDecimal(text: string): number | null {
  const value = Number(text.trim().replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

export default function CreatePage() {
  const router = useRouter();
  const { settings, notify, trackJob, refreshJobs, health } = useStore();
  const caps = settings?.capabilities;

  const [mode, setMode] = React.useState<CreateMode>("quick");
  const [submitting, setSubmitting] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // Shared fields.
  const [title, setTitle] = React.useState("");
  const [styleDraft, setStyleDraft] = React.useState<StyleDraft>(EMPTY_STYLE);
  const [lyrics, setLyrics] = React.useState("");
  const [instrumental, setInstrumental] = React.useState(false);

  // Custom-only fields.
  const [language, setLanguage] = React.useState("");
  const [vocal, setVocal] = React.useState("");
  const [cot, setCot] = React.useState<CotMode>("full");
  const [seedMode, setSeedMode] = React.useState<SeedMode>("random");
  const [seed, setSeed] = React.useState("");
  const [cfgScale, setCfgScale] = React.useState("");
  const [advanced, setAdvanced] = React.useState<AdvancedGeneration>(DEFAULT_ADVANCED);
  const [scoreAbc, setScoreAbc] = React.useState("");
  const [exportMp3, setExportMp3] = React.useState(true);
  const [exportWav, setExportWav] = React.useState(false);
  const [targetProject, setTargetProject] = React.useState<string>("");
  const [projects, setProjects] = React.useState<Project[]>([]);

  // Apply server defaults once, the first render on which settings exist.
  // The previous effect re-ran whenever settings changed and reset the user's
  // planning mode and export choices behind their back.
  const [defaultsApplied, setDefaultsApplied] = React.useState(false);
  if (settings && !defaultsApplied) {
    setDefaultsApplied(true);
    setCot(settings.default_cot);
    setExportMp3(settings.export_mp3);
    setExportWav(settings.export_wav);
    setLanguage((current) => current || settings.default_language);
    setStyleDraft((current) =>
      current.description
        ? current
        : { ...current, description: settings.default_style_prompt },
    );
  }

  React.useEffect(() => {
    void api
      .listProjects({ limit: 100, sort: "newest" })
      .then((list) => setProjects(list.items))
      .catch(() => setProjects([]));
  }, []);

  // Restore a local draft so a refresh does not lose typing.
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem("songforge.create-draft");
      if (!raw) return;
      const draft = JSON.parse(raw) as Record<string, unknown>;
      // localStorage cannot be read during render or in a lazy initialiser
      // without breaking hydration, so a stored preference is restored after
      // mount. One extra render, once.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (typeof draft.title === "string") setTitle(draft.title);
      if (typeof draft.lyrics === "string") setLyrics(draft.lyrics);
      if (draft.style && typeof draft.style === "object") {
        setStyleDraft({ ...EMPTY_STYLE, ...(draft.style as Partial<StyleDraft>) });
      } else if (typeof draft.style === "string") {
        // A draft saved before the style became a tag set.
        setStyleDraft({ ...EMPTY_STYLE, description: draft.style });
      }
    } catch {
      /* a corrupt or unavailable draft is not worth surfacing */
    }
  }, []);

  const persistDraft = React.useMemo(
    () =>
      debounce((draft: Record<string, unknown>) => {
        try {
          localStorage.setItem("songforge.create-draft", JSON.stringify(draft));
        } catch {
          /* ignore */
        }
      }, 500),
    [],
  );

  React.useEffect(() => {
    persistDraft({ title, style: styleDraft, lyrics });
  }, [title, styleDraft, lyrics, persistDraft]);

  // Chips compose into the style text: yue2 has one style channel, and `style`
  // and `tags` are strict aliases that must not disagree. The language and
  // vocal tags are prefixed by the backend, not here.
  const composedStyle = React.useMemo(() => composeStyle(styleDraft), [styleDraft]);

  // Cover mode decides planning for you; everywhere else the user chooses.
  const effectiveCot: CotMode = mode === "cover" ? "melody" : cot;

  // The ceilings live on the backend, so the meter and the runner cannot
  // disagree about what will fit.
  const budget = useBudget({
    style: composedStyle,
    lyrics,
    scoreAbc,
    cot: effectiveCot,
    instrumental,
  });
  const lyricsRequired = !instrumental;
  const runnerReady = settings ? settings.configuration_issues.length === 0 : false;

  const validate = (values: SubmitValues): boolean => {
    const next: Record<string, string> = {};
    if (!values.style.trim()) {
      next.style = "Describe the song before generating.";
    }
    if (lyricsRequired && !values.lyrics.trim()) {
      next.lyrics =
        "YuE2 needs lyrics to sing. Add some, or switch on Instrumental.";
    }
    if (seedMode === "manual" && !seed.trim()) {
      next.seed = "Enter a seed, or switch to random.";
    } else if (seedMode === "manual" && !Number.isSafeInteger(Number(seed))) {
      // A JavaScript number silently rounds above 2^53, which would submit a
      // different seed than the one typed - the opposite of reproducible.
      next.seed = `Seeds above ${Number.MAX_SAFE_INTEGER} cannot be sent exactly from a browser.`;
    }
    if (cfgScale.trim()) {
      const parsed = parseDecimal(cfgScale);
      if (parsed === null || parsed < 0 || parsed > 20) {
        next.cfg = "Guidance must be a number from 0 to 20.";
      }
    }
    const sampling = advancedErrors(advanced);
    if (mode !== "quick" && sampling.length > 0) {
      next.advanced = sampling[0];
    }
    if (scoreAbc.trim() && effectiveCot === "off") {
      next.score =
        "A score needs planning switched on. Choose melody or full planning.";
    }
    if (mode === "cover" && !scoreAbc.trim()) {
      next.score = "A cover needs the melody as ABC notation. Paste it here.";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (stage: "plan" | "audio", override: Partial<SubmitValues> = {}) => {
    const values: SubmitValues = {
      lyrics: override.lyrics ?? lyrics,
      style: override.style ?? composedStyle,
      title: override.title ?? title,
    };
    if (!validate(values)) return;
    setSubmitting(true);
    try {
      let projectId = targetProject;

      if (!projectId) {
        const created = await api.createProject({
          title: values.title.trim() || undefined,
          style_prompt: values.style,
          lyrics: values.lyrics,
          instrumental,
          language: language.trim() || null,
          vocal_preference: vocal.trim() || null,
          tags: [...styleDraft.genres, ...styleDraft.moods],
        });
        projectId = created.id;
      } else {
        // Generating a new version of an existing project: update its draft
        // first, so the version records exactly what was submitted.
        await api.saveDraft(projectId, {
          title: values.title.trim() || undefined,
          style_prompt: values.style,
          lyrics: values.lyrics,
        });
      }

      if (scoreAbc.trim()) {
        await api.saveScore(projectId, scoreAbc);
      }

      const job = await api.generate(projectId, {
        stage,
        instrumental,
        language: language.trim() || undefined,
        vocal_preference: vocal.trim() || undefined,
        cot: effectiveCot,
        seed_mode: seedMode,
        seed: seedMode === "manual" ? Number(seed) : undefined,
        cfg_scale: cfgScale.trim() ? (parseDecimal(cfgScale) ?? undefined) : undefined,
        export_mp3: exportMp3,
        export_wav: exportWav,
        // Takes are offered in both modes; the sampling knobs are Custom only.
        ...(mode !== "quick" ? advancedPayload(advanced, caps) : takesPayload(advanced)),
      });
      const takes = 1 + (job.sibling_job_ids?.length ?? 0);

      trackJob(job);
      try {
        localStorage.removeItem("songforge.create-draft");
      } catch {
        /* ignore */
      }
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
      router.push(`/song/${projectId}`);
    } catch (cause) {
      notify({
        tone: "danger",
        title: "Could not start generation",
        body: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Create</h1>
        <p className="mt-0.5 text-sm text-[var(--sf-text-muted)]">
          Everything runs on this machine.{" "}
          {caps ? `Using ${caps.display_name}.` : ""}
        </p>
      </header>

      {settings && !runnerReady && (
        <div className="mb-4">
          <Banner tone="warning" title="The runner is not ready">
            <ul className="list-inside list-disc space-y-0.5">
              {settings.configuration_issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
            <p className="mt-1.5">
              Fix these in Settings, or switch to the mock runner to try the app.
            </p>
          </Banner>
        </div>
      )}

      {health && !health.runner_ready && runnerReady && (
        <div className="mb-4">
          <Banner tone="info" title="Using the simulation runner">
            Output is synthesised locally and is not a real YuE2 generation.
          </Banner>
        </div>
      )}

      {/* --- Mode switch --- */}
      <div
        className="mb-5 inline-flex rounded-lg border border-[var(--sf-border)] p-1"
        role="tablist"
        aria-label="Create mode"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const step = event.key === "ArrowRight" ? 1 : CREATE_MODES.length - 1;
          const next =
            CREATE_MODES[(CREATE_MODES.indexOf(mode) + step) % CREATE_MODES.length];
          setMode(next);
          document.getElementById(`create-mode-${next}`)?.focus();
        }}
      >
        {CREATE_MODES.map((value) => (
          <button
            key={value}
            id={`create-mode-${value}`}
            role="tab"
            type="button"
            aria-selected={mode === value}
            tabIndex={mode === value ? 0 : -1}
            onClick={() => setMode(value)}
            className={cn(
              "rounded-md px-4 py-1.5 text-sm capitalize transition-colors",
              mode === value
                ? "bg-[var(--sf-accent)] text-[var(--sf-accent-ink)]"
                : "text-[var(--sf-text-muted)] hover:text-[var(--sf-text)]",
            )}
          >
            {value}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {/* --- Describe --- */}
        <Card className="p-5">
          <StyleBuilder
            draft={styleDraft}
            onChange={setStyleDraft}
            context={{ language, vocal, instrumental }}
            rows={mode === "quick" ? 4 : 3}
            error={errors.style}
            compact={mode === "quick"}
          />

          <div className="mt-4">
            <Field label="Title" htmlFor="title" hint="Optional. One is derived from your description if you leave it blank.">
              <Input
                id="title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Untitled"
                maxLength={200}
              />
            </Field>
          </div>

          {caps?.supports_instrumental && (
            <div className="mt-4 border-t border-[var(--sf-border)] pt-4">
              <Toggle
                id="instrumental"
                checked={instrumental}
                onChange={setInstrumental}
                label="Instrumental"
                description="Sends an empty lyric and asks for no vocals in the style. YuE2 has no instrumental switch, so this is guidance rather than a guarantee."
              />
            </div>
          )}
        </Card>

        {/* --- Lyrics --- */}
        {!instrumental && (
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Lyrics</h2>
              <Badge tone={lyricsRequired ? "accent" : "neutral"}>
                {lyricsRequired ? "Required" : "Optional"}
              </Badge>
            </div>
            <LyricsEditor
              value={lyrics}
              onChange={setLyrics}
              rows={mode === "quick" ? 8 : 14}
              writer={{
                storageKey: "songforge.lyrics-writer.create",
                defaults: { styleHint: composedStyle, language: language || undefined },
                openInitially: !lyrics.trim(),
                onResult: (result, { applyStyle, applyTitle }) => {
                  if (applyStyle && result.style) {
                    // The model's suggestion replaces the tag set outright.
                    setStyleDraft({ ...EMPTY_STYLE, description: result.style });
                  }
                  if (applyTitle && result.title) setTitle(result.title);
                },
                onWriteAndRender: async (result) => {
                  // The render keeps the style already chosen, or the model's
                  // suggestion when none was given.
                  const style = composedStyle.trim() || result.style;
                  const nextTitle = title.trim() || result.title;
                  if (!composedStyle.trim()) {
                    setStyleDraft({ ...EMPTY_STYLE, description: result.style });
                  }
                  if (!title.trim()) setTitle(result.title);
                  await submit("audio", { lyrics: result.lyrics, style, title: nextTitle });
                },
              }}
              hint={
                <span>
                  Length follows the lyrics; there is no duration control. Four to six
                  lines per section is about half a minute of music.
                </span>
              }
            />
            <BudgetMeter estimate={budget} className="mt-3" />
            {errors.lyrics && (
              <p role="alert" className="mt-1.5 text-xs text-[var(--sf-danger)]">
                {errors.lyrics}
              </p>
            )}
          </Card>
        )}

        {/* Takes sit in both modes: it is the highest-impact choice on the page,
            and under "Advanced" it went unused. */}
        <Card className="p-5">
          <TakesField
            value={advanced}
            onChange={setAdvanced}
            songSeconds={budget?.seconds}
            gpuName={settings?.hardware?.name}
          />
        </Card>

        {/* --- Cover: the melody comes from outside the app --- */}
        {mode === "cover" && caps?.supports_score_abc && (
          <Card className="p-5">
            <h2 className="text-sm font-semibold">The melody to cover</h2>
            <p className="mt-1 text-xs text-[var(--sf-text-muted)]">
              Paste the melody as ABC notation. SongForge plans the melody only and
              lets the accompaniment follow your style tags, which is what YuE2&apos;s
              own guidance recommends for covers.
            </p>
            <div className="mt-3">
              <Banner tone="info" title="Transcribing happens outside SongForge">
                There is no audio-to-ABC step here, so the notation has to come from
                sheet music, a MIDI export or a transcription tool. Keep the new lyrics
                close to the original phrasing and syllable count, or the melody will
                not fit the words.
              </Banner>
            </div>
            <div className="mt-4">
              <Field
                label="Melody (ABC)"
                htmlFor="score"
                required
                error={errors.score}
                hint="Only the melody line; chord symbols are not removed for you."
              >
                <Textarea
                  id="score"
                  value={scoreAbc}
                  onChange={(event) => setScoreAbc(event.target.value)}
                  rows={8}
                  aria-invalid={Boolean(errors.score)}
                  placeholder={"X:1\nT:Melody\nM:4/4\nL:1/8\nK:C\nC D E F | G A B c |]"}
                  className="font-mono text-[12px]"
                />
              </Field>
            </div>
          </Card>
        )}

        {/* --- Custom and cover --- */}
        {mode !== "quick" && (
          <>
            <Card className="p-5">
              <h2 className="mb-4 text-sm font-semibold">Performance</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Language"
                  htmlFor="language"
                  hint="Becomes the first style tag. Worth setting even for English."
                >
                  <Input
                    id="language"
                    value={language}
                    onChange={(event) => setLanguage(event.target.value)}
                    placeholder="English"
                    maxLength={40}
                  />
                </Field>
                <Field
                  label="Vocal preference"
                  htmlFor="vocal"
                  hint="Gender and tone. Left blank, the voice varies with the seed."
                >
                  <Input
                    id="vocal"
                    value={vocal}
                    onChange={(event) => setVocal(event.target.value)}
                    placeholder="Soft female vocal"
                    maxLength={80}
                    disabled={instrumental}
                  />
                </Field>
              </div>
              <VocalChips value={vocal} onChange={setVocal} disabled={instrumental} />
            </Card>

            {mode === "custom" && caps?.supports_planning && (
              <Card className="p-5">
                <h2 className="text-sm font-semibold">Planning</h2>
                <p className="mt-1 text-xs text-[var(--sf-text-muted)]">
                  YuE2 writes a symbolic score before it sings, and that score is
                  what gives a song its structure - it is also the part you can read
                  and edit. If it runs out of room, later sections have no plan and
                  can go missing, which is why fewer, shorter sections render more
                  reliably.
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <PlanOption
                    value="full"
                    current={cot}
                    onSelect={setCot}
                    title="Melody + chords"
                    description="Almost always right for an original song. Produces a full editable score."
                  />
                  <PlanOption
                    value="melody"
                    current={cot}
                    onSelect={setCot}
                    title="Melody only"
                    description="For covers: the accompaniment is free to follow your style tags."
                  />
                  <PlanOption
                    value="off"
                    current={cot}
                    onSelect={setCot}
                    title="Direct"
                    description="No score at all. Faster, but structure becomes a lottery."
                  />
                </div>

                {caps.supports_score_abc && (
                  <div className="mt-4">
                    <Field
                      label="Bring your own score (ABC)"
                      htmlFor="score"
                      error={errors.score}
                      hint="Optional. Paste an ABC melody to steer the arrangement - the basis of the cover workflow."
                    >
                      <Textarea
                        id="score"
                        value={scoreAbc}
                        onChange={(event) => setScoreAbc(event.target.value)}
                        rows={5}
                        disabled={cot === "off"}
                        aria-invalid={Boolean(errors.score)}
                        placeholder={"X:1\nT:Melody\nM:4/4\nL:1/8\nK:C\nC D E F | G A B c |]"}
                        className="font-mono text-[12px]"
                      />
                    </Field>
                  </div>
                )}
              </Card>
            )}

            <Card className="p-5">
              <h2 className="mb-4 text-sm font-semibold">Advanced</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {caps?.supports_seed && (
                  <>
                    <Field
                      label="Seed"
                      htmlFor="seed-mode"
                      hint="The same seed and settings reproduce a song exactly. Keep one seed while you compare prompt changes, so you hear the prompt rather than the dice."
                    >
                      <Select
                        id="seed-mode"
                        value={seedMode}
                        onChange={(event) => setSeedMode(event.target.value as SeedMode)}
                      >
                        <option value="random">Random each time</option>
                        <option value="locked">Reuse the last seed</option>
                        <option value="manual">Enter a seed</option>
                      </Select>
                    </Field>
                    {seedMode === "manual" && (
                      <Field label="Seed value" htmlFor="seed" error={errors.seed}>
                        <Input
                          id="seed"
                          value={seed}
                          inputMode="numeric"
                          onChange={(event) =>
                            setSeed(event.target.value.replace(/[^0-9]/g, ""))
                          }
                          aria-invalid={Boolean(errors.seed)}
                          placeholder="831001"
                        />
                      </Field>
                    )}
                  </>
                )}

                {caps?.supports_cfg_scale && (
                  <Field
                    label="Text guidance (CFG)"
                    htmlFor="cfg"
                    error={errors.cfg}
                    hint={`Blank uses yue2's own default (${effectiveCot === "off" ? "1.01" : "1.0"}). Any other value runs a second guidance branch and roughly doubles generation time.`}
                  >
                    <Input
                      id="cfg"
                      value={cfgScale}
                      inputMode="decimal"
                      onChange={(event) => setCfgScale(event.target.value)}
                      placeholder="1.0"
                    />
                  </Field>
                )}
              </div>

              <div className="mt-4 space-y-3 border-t border-[var(--sf-border)] pt-4">
                <p className="text-xs text-[var(--sf-text-muted)]">
                  A 24-bit / 48 kHz FLAC master is always kept.
                </p>
                <Toggle
                  id="mp3"
                  checked={exportMp3}
                  onChange={setExportMp3}
                  label="Also export MP3"
                  description={
                    settings?.ffmpeg_available
                      ? `${settings.mp3_bitrate} kbps`
                      : "Needs FFmpeg, which was not found."
                  }
                  disabled={!settings?.ffmpeg_available}
                />
                <Toggle
                  id="wav"
                  checked={exportWav}
                  onChange={setExportWav}
                  label="Also export WAV"
                  disabled={!settings?.ffmpeg_available}
                />
              </div>

              <div className="mt-4 border-t border-[var(--sf-border)] pt-4">
                <AdvancedGenerationPanel
                  value={advanced}
                  onChange={setAdvanced}
                  caps={caps}
                  showTakes={false}
                />
                {errors.advanced && (
                  <p role="alert" className="mt-2 text-xs text-[var(--sf-danger)]">
                    {errors.advanced}
                  </p>
                )}
              </div>
            </Card>

            <Card className="p-5">
              <Field
                label="Generate as"
                htmlFor="target"
                hint="A new version keeps the existing project's history and lets you compare takes."
              >
                <Select
                  id="target"
                  value={targetProject}
                  onChange={(event) => setTargetProject(event.target.value)}
                >
                  <option value="">A new project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      New version of “{project.title}”
                    </option>
                  ))}
                </Select>
              </Field>
            </Card>
          </>
        )}

        {/* --- Submit --- */}
        <div className="sticky bottom-16 z-20 flex flex-wrap gap-2 rounded-xl border border-[var(--sf-border)] bg-[var(--sf-bg-raised)]/95 p-3 backdrop-blur lg:bottom-4">
          <Button
            variant="primary"
            size="lg"
            loading={submitting}
            onClick={() => void submit("audio")}
            className="flex-1"
          >
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            Generate song
          </Button>

          {caps?.supports_plan_stage && effectiveCot !== "off" && (
            <Button
              size="lg"
              loading={submitting}
              onClick={() => void submit("plan")}
              title="Write the score first, review it, then render audio"
            >
              <ListMusic className="h-4 w-4" aria-hidden="true" />
              Plan first
            </Button>
          )}
        </div>

        {caps?.supports_plan_stage && effectiveCot !== "off" && (
          <p className="flex items-start gap-1.5 text-xs text-[var(--sf-text-faint)]">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              <strong className="text-[var(--sf-text-muted)]">Plan first</strong> writes
              only the score, which takes a fraction of a full render. Review and edit
              it, then render the audio from the song page.
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

function PlanOption({
  value,
  current,
  onSelect,
  title,
  description,
}: {
  value: CotMode;
  current: CotMode;
  onSelect: (value: CotMode) => void;
  title: string;
  description: string;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      aria-pressed={active}
      className={cn(
        "rounded-lg border p-3 text-left transition-colors",
        active
          ? "border-[var(--sf-accent)] bg-[var(--sf-accent)]/10"
          : "border-[var(--sf-border)] hover:border-[var(--sf-border-strong)]",
      )}
    >
      <span
        className={cn(
          "block text-xs font-medium",
          active ? "text-[var(--sf-accent)]" : "text-[var(--sf-text)]",
        )}
      >
        {title}
      </span>
      <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--sf-text-faint)]">
        {description}
      </span>
    </button>
  );
}
