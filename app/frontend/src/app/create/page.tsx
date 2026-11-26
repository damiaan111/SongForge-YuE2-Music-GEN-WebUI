"use client";

/**
 * Create - Quick, Custom and Cover modes.
 *
 * Controls are driven by the active runner's declared capabilities, so nothing
 * is offered that the model cannot honour, and anything it does support that
 * Suno-style apps lack (planning mode, own score, plan-first) is surfaced.
 *
 * Layout: the form on the left, and on wide screens a summary rail on the
 * right that keeps the length estimate and the Generate button in view while
 * you scroll. On narrow screens the rail folds under the form and the buttons
 * move to a bar pinned above the player.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { ListMusic, Music2, Sparkles } from "lucide-react";

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
  Banner,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Segmented,
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
const CREATE_MODES = [
  {
    value: "quick",
    label: "Quick",
    blurb: "Just the essentials: a sound, the words, and go.",
  },
  {
    value: "custom",
    label: "Custom",
    blurb: "Everything in Quick, plus voice, planning, seed and sampling controls.",
  },
  {
    value: "cover",
    label: "Cover",
    blurb: "Bring a melody as ABC notation and dress it in a new style.",
  },
] as const;
type CreateMode = (typeof CREATE_MODES)[number]["value"];

/** What a submission uses; the one-click lyrics flow passes fresh values in. */
interface SubmitValues {
  lyrics: string;
  style: string;
  title: string;
}

/** Field ids in the order they appear, so the first error can be scrolled to. */
const ERROR_TARGETS: Record<string, string> = {
  style: "style",
  lyrics: "lyrics",
  score: "score",
  seed: "seed",
  cfg: "cfg",
  advanced: "create-advanced",
};

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
  const [submitting, setSubmitting] = React.useState<"plan" | "audio" | null>(null);
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
  const [restored, setRestored] = React.useState(false);
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem("songforge.create-draft");
      if (!raw) return;
      const draft = JSON.parse(raw) as Record<string, unknown>;
      let any = false;
      // localStorage cannot be read during render or in a lazy initialiser
      // without breaking hydration, so a stored preference is restored after
      // mount. One extra render, once.
      if (typeof draft.title === "string" && draft.title) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setTitle(draft.title);
        any = true;
      }
      if (typeof draft.lyrics === "string" && draft.lyrics) {
        setLyrics(draft.lyrics);
        any = true;
      }
      if (draft.style && typeof draft.style === "object") {
        const style = { ...EMPTY_STYLE, ...(draft.style as Partial<StyleDraft>) };
        setStyleDraft(style);
        any = any || Boolean(composeStyle(style));
      } else if (typeof draft.style === "string" && draft.style) {
        // A draft saved before the style became a tag set.
        setStyleDraft({ ...EMPTY_STYLE, description: draft.style });
        any = true;
      }
      setRestored(any);
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

  const startOver = () => {
    setTitle("");
    setLyrics("");
    setScoreAbc("");
    setStyleDraft({ ...EMPTY_STYLE, description: settings?.default_style_prompt ?? "" });
    setErrors({});
    setRestored(false);
    try {
      localStorage.removeItem("songforge.create-draft");
    } catch {
      /* ignore */
    }
  };

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
  const canPlan = Boolean(caps?.supports_plan_stage) && effectiveCot !== "off";

  const validate = (values: SubmitValues): boolean => {
    const next: Record<string, string> = {};
    if (!values.style.trim()) {
      next.style = "Describe the song before generating.";
    }
    if (lyricsRequired && !values.lyrics.trim()) {
      next.lyrics =
        "YuE2 needs lyrics to sing. Add some, or switch to Instrumental.";
    }
    if (mode !== "quick") {
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
      if (sampling.length > 0) next.advanced = sampling[0];
    }
    if (mode === "custom" && scoreAbc.trim() && effectiveCot === "off") {
      next.score =
        "A score needs planning switched on. Choose melody or full planning.";
    }
    if (mode === "cover" && !scoreAbc.trim()) {
      next.score = "A cover needs the melody as ABC notation. Paste it here.";
    }
    setErrors(next);
    const first = Object.keys(ERROR_TARGETS).find((key) => key in next);
    if (first) {
      // Bring the first problem into view: on a long form the message can be
      // two screens away from the button that was pressed.
      requestAnimationFrame(() => {
        const target = document.getElementById(ERROR_TARGETS[first]);
        target?.scrollIntoView({ block: "center", behavior: "smooth" });
        if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
          target.focus({ preventScroll: true });
        }
      });
    }
    return Object.keys(next).length === 0;
  };

  const submit = async (stage: "plan" | "audio", override: Partial<SubmitValues> = {}) => {
    const values: SubmitValues = {
      lyrics: override.lyrics ?? lyrics,
      style: override.style ?? composedStyle,
      title: override.title ?? title,
    };
    if (!validate(values)) return;
    setSubmitting(stage);
    try {
      const custom = mode !== "quick";
      // Quick mode shows none of the Custom controls, so it must not send
      // values left over from them: a seed typed in Custom and then hidden
      // would otherwise pin every Quick song to it.
      let projectId = custom ? targetProject : "";

      if (!projectId) {
        const created = await api.createProject({
          title: values.title.trim() || undefined,
          style_prompt: values.style,
          lyrics: values.lyrics,
          instrumental,
          language: language.trim() || null,
          vocal_preference: custom ? vocal.trim() || null : null,
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

      if (custom && scoreAbc.trim()) {
        await api.saveScore(projectId, scoreAbc);
      }

      const job = await api.generate(projectId, {
        stage,
        instrumental,
        language: language.trim() || undefined,
        vocal_preference: custom ? vocal.trim() || undefined : undefined,
        cot: effectiveCot,
        seed_mode: custom ? seedMode : "random",
        seed: custom && seedMode === "manual" ? Number(seed) : undefined,
        cfg_scale:
          custom && cfgScale.trim() ? (parseDecimal(cfgScale) ?? undefined) : undefined,
        export_mp3: exportMp3,
        export_wav: exportWav,
        // Takes are offered in both modes; the sampling knobs are Custom only.
        ...(custom ? advancedPayload(advanced, caps) : takesPayload(advanced)),
        // A plan is one score to read and edit; takes are about the audio.
        ...(stage === "plan" ? { candidates: undefined } : {}),
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
      setSubmitting(null);
    }
  };

  const errorCount = Object.keys(errors).length;
  const activeMode = CREATE_MODES.find((entry) => entry.value === mode) ?? CREATE_MODES[0];

  const actions = (
    <>
      <Button
        variant="primary"
        size="lg"
        loading={submitting === "audio"}
        disabled={submitting !== null}
        onClick={() => void submit("audio")}
        className="min-w-0 flex-1"
      >
        {submitting !== "audio" && <Sparkles className="h-[1.1rem] w-[1.1rem]" aria-hidden="true" />}
        Generate song
      </Button>
      {canPlan && (
        <Button
          size="lg"
          loading={submitting === "plan"}
          disabled={submitting !== null}
          onClick={() => void submit("plan")}
          title="Write the score first, review it, then render audio"
        >
          {submitting !== "plan" && <ListMusic className="h-[1.1rem] w-[1.1rem]" aria-hidden="true" />}
          Plan first
        </Button>
      )}
    </>
  );

  return (
    <div className="mx-auto max-w-[84rem]">
      <PageHeader
        title="Create a song"
        description={
          <>
            Describe the sound, add the words, and let YuE2 perform it.{" "}
            {caps && !health?.runner_ready && settings?.runner_kind === "mock"
              ? "Simulation mode is on, so the result is a placeholder tone."
              : "Everything runs on this machine."}
          </>
        }
        actions={
          restored && (
            <Button variant="ghost" size="sm" onClick={startOver}>
              Start over
            </Button>
          )
        }
      />

      {settings && !runnerReady && (
        <Banner
          tone="warning"
          title="The music engine is not ready yet"
          className="mb-5"
          action={
            <Link href="/settings" className="text-[13px] font-medium text-accent hover:underline">
              Open Settings
            </Link>
          }
        >
          <ul className="list-inside list-disc space-y-0.5">
            {settings.configuration_issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
          <p className="mt-1.5">
            Fix these in Settings, or switch to the simulation runner there to try the app.
          </p>
        </Banner>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_23rem] xl:items-start">
        <div className="min-w-0 space-y-5">
          {/* --- Mode --- */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Segmented
              label="Create mode"
              idPrefix="create-mode"
              value={mode}
              onChange={setMode}
              options={CREATE_MODES.filter(
                (entry) => entry.value !== "cover" || caps?.supports_score_abc !== false,
              ).map((entry) => ({ value: entry.value, label: entry.label, title: entry.blurb }))}
            />
            <p className="text-[13px] text-ink-muted">{activeMode.blurb}</p>
          </div>

          {/* --- 1. Sound --- */}
          <StepCard step={1} title="Sound" description="What should it sound like?">
            <StyleBuilder
              draft={styleDraft}
              onChange={setStyleDraft}
              context={{ language, vocal: mode === "quick" ? "" : vocal, instrumental }}
              rows={3}
              error={errors.style}
              compact={mode === "quick"}
            />
          </StepCard>

          {/* --- 2. Words --- */}
          <StepCard
            step={2}
            title="Words"
            description={
              instrumental
                ? "No vocals: the song is performed without a lyric sheet."
                : "Section tags like [Verse] and [Chorus] give the song its structure."
            }
            action={
              caps?.supports_instrumental && (
                <Segmented
                  size="sm"
                  label="Vocals"
                  value={instrumental ? "instrumental" : "lyrics"}
                  onChange={(next) => setInstrumental(next === "instrumental")}
                  options={[
                    { value: "lyrics", label: "Lyrics" },
                    { value: "instrumental", label: "Instrumental" },
                  ]}
                />
              )
            }
          >
            {instrumental ? (
              <div className="flex items-start gap-3 rounded-xl border border-edge bg-sunken/60 p-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-overlay text-accent">
                  <Music2 className="h-4 w-4" aria-hidden="true" />
                </span>
                <p className="text-[13px] leading-relaxed text-ink-muted">
                  SongForge sends an empty lyric and asks for no vocals in the style.
                  YuE2 has no instrumental switch, so this is strong guidance rather
                  than a guarantee — an occasional take may still hum along.
                </p>
              </div>
            ) : (
              <>
                <LyricsEditor
                  value={lyrics}
                  onChange={setLyrics}
                  rows={mode === "quick" ? 10 : 14}
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
                      Length follows the lyrics — four to six lines per section is about
                      half a minute of music.
                    </span>
                  }
                />
                {errors.lyrics && (
                  <p role="alert" className="mt-2 text-xs text-danger">
                    {errors.lyrics}
                  </p>
                )}
              </>
            )}
          </StepCard>

          {/* --- Cover: the melody comes from outside the app --- */}
          {mode === "cover" && caps?.supports_score_abc && (
            <StepCard
              step={3}
              title="The melody to cover"
              description="Paste the melody as ABC notation. SongForge plans the melody only and lets the accompaniment follow your style tags, which is what YuE2's own guidance recommends for covers."
            >
              <Banner tone="info" title="Transcribing happens outside SongForge">
                There is no audio-to-ABC step here, so the notation has to come from
                sheet music, a MIDI export or a transcription tool. Keep the new lyrics
                close to the original phrasing and syllable count, or the melody will
                not fit the words.
              </Banner>
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
                    spellCheck={false}
                    aria-invalid={Boolean(errors.score)}
                    placeholder={"X:1\nT:Melody\nM:4/4\nL:1/8\nK:C\nC D E F | G A B c |]"}
                    className="font-mono text-[13px]"
                  />
                </Field>
              </div>
            </StepCard>
          )}

          {/* --- Custom and cover --- */}
          {mode !== "quick" && (
            <>
              <StepCard
                step={mode === "cover" ? 4 : 3}
                title="Voice"
                description="Both travel inside the style text; YuE2 has no separate fields for them."
              >
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
                    hint={
                      instrumental
                        ? "Not used for an instrumental."
                        : "Gender and tone. Left blank, the voice varies with the seed."
                    }
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
              </StepCard>

              {mode === "custom" && caps?.supports_planning && (
                <StepCard
                  step={4}
                  title="Planning"
                  description="YuE2 writes a symbolic score before it sings. That score is what gives a song its structure, and it is the part you can read and edit afterwards."
                >
                  <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Planning mode">
                    <PlanOption
                      value="full"
                      current={cot}
                      onSelect={setCot}
                      title="Melody + chords"
                      description="Almost always right for an original song. Produces a full editable score."
                      recommended
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
                    <div className="mt-5">
                      <Field
                        label="Bring your own score (ABC)"
                        htmlFor="score"
                        error={errors.score}
                        hint="Optional. Paste an ABC melody to steer the arrangement."
                      >
                        <Textarea
                          id="score"
                          value={scoreAbc}
                          onChange={(event) => setScoreAbc(event.target.value)}
                          rows={5}
                          spellCheck={false}
                          disabled={cot === "off"}
                          aria-invalid={Boolean(errors.score)}
                          placeholder={"X:1\nT:Melody\nM:4/4\nL:1/8\nK:C\nC D E F | G A B c |]"}
                          className="font-mono text-[13px]"
                        />
                      </Field>
                    </div>
                  )}
                </StepCard>
              )}

              <StepCard
                step={5}
                title="Fine-tuning"
                description="Reproducibility, guidance and the model's sampling settings. The defaults are good; change these when you are chasing something specific."
              >
                <div id="create-advanced" className="grid gap-4 sm:grid-cols-2">
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
                      hint={`Blank uses YuE2's own default (${effectiveCot === "off" ? "1.01" : "1.0"}). Any other value runs a second guidance branch and roughly doubles generation time.`}
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

                <div className="mt-5 border-t border-edge pt-5">
                  <AdvancedGenerationPanel
                    value={advanced}
                    onChange={setAdvanced}
                    caps={caps}
                    showTakes={false}
                  />
                  {errors.advanced && (
                    <p role="alert" className="mt-2 text-xs text-danger">
                      {errors.advanced}
                    </p>
                  )}
                </div>
              </StepCard>

              <StepCard
                step={6}
                title="Output"
                description="A 24-bit / 48 kHz FLAC master is always kept."
              >
                <div className="space-y-4">
                  <Toggle
                    id="mp3"
                    checked={exportMp3}
                    onChange={setExportMp3}
                    label="Also export MP3"
                    description={
                      settings?.ffmpeg_available
                        ? `${settings.mp3_bitrate} kbps, for sharing.`
                        : "Needs FFmpeg, which was not found on this computer."
                    }
                    disabled={!settings?.ffmpeg_available}
                  />
                  <Toggle
                    id="wav"
                    checked={exportWav}
                    onChange={setExportWav}
                    label="Also export WAV"
                    description={
                      settings?.ffmpeg_available
                        ? "Uncompressed, for a DAW."
                        : "Needs FFmpeg, which was not found on this computer."
                    }
                    disabled={!settings?.ffmpeg_available}
                  />
                </div>
                <div className="mt-5 border-t border-edge pt-5">
                  <Field
                    label="Save as"
                    htmlFor="target"
                    hint="A new version keeps an existing song's history and lets you compare takes."
                  >
                    <Select
                      id="target"
                      value={targetProject}
                      onChange={(event) => setTargetProject(event.target.value)}
                    >
                      <option value="">A new song</option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          New version of “{project.title}”
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </StepCard>
            </>
          )}
        </div>

        {/* --- Summary rail --- */}
        <aside className="min-w-0 space-y-4 xl:sticky xl:top-8" aria-label="Song summary">
          <Card className="space-y-5 p-5">
            <Field
              label="Title"
              htmlFor="title"
              hint="Optional — one is taken from your description if you leave it blank."
            >
              <Input
                id="title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Untitled"
                maxLength={200}
              />
            </Field>

            {budget ? (
              <BudgetMeter estimate={budget} />
            ) : (
              <div className="sf-shimmer h-28 rounded-xl" aria-hidden="true" />
            )}

            <TakesField
              value={advanced}
              onChange={setAdvanced}
              songSeconds={budget?.seconds}
              gpuName={settings?.runner_kind === "mock" ? undefined : settings?.hardware?.name}
            />

            <div className="hidden space-y-3 border-t border-edge pt-5 xl:block">
              {errorCount > 0 && (
                <p role="status" className="text-[13px] text-danger">
                  {errorCount === 1 ? "One thing needs" : `${errorCount} things need`} fixing
                  before this can start.
                </p>
              )}
              <div className="flex gap-2">{actions}</div>
              {canPlan && (
                <p className="text-xs leading-relaxed text-ink-faint">
                  <strong className="font-medium text-ink-muted">Plan first</strong> writes
                  only the score — a fraction of a full render. Review and edit it, then
                  render the audio from the song page.
                </p>
              )}
            </div>
          </Card>
        </aside>
      </div>

      {/* --- Pinned actions for screens without room for the rail --- */}
      <div
        className="sticky z-20 mt-6 xl:hidden"
        style={{ bottom: "calc(var(--sf-footer, 0px) + 0.75rem)" }}
      >
        <div className="sf-glass rounded-2xl border border-edge-strong p-2.5 shadow-[var(--sf-shadow-lg)]">
          {errorCount > 0 && (
            <p role="status" className="px-1.5 pb-2 text-[13px] text-danger">
              {errorCount === 1 ? "One thing needs" : `${errorCount} things need`} fixing first.
            </p>
          )}
          <div className="flex gap-2">{actions}</div>
        </div>
      </div>
    </div>
  );
}

/** A numbered section of the form. */
function StepCard({
  step,
  title,
  description,
  action,
  children,
}: {
  step: number;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-5 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent/10 font-mono text-xs font-semibold text-accent"
          >
            {step}
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold leading-tight text-ink">{title}</h2>
            {description && (
              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
                {description}
              </p>
            )}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </Card>
  );
}

function PlanOption({
  value,
  current,
  onSelect,
  title,
  description,
  recommended,
}: {
  value: CotMode;
  current: CotMode;
  onSelect: (value: CotMode) => void;
  title: string;
  description: string;
  recommended?: boolean;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={() => onSelect(value)}
      className={cn(
        "rounded-xl border p-3.5 text-left transition-colors",
        active
          ? "border-accent/60 bg-accent/10"
          : "border-edge bg-raised hover:border-edge-strong hover:bg-overlay",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className={cn("text-sm font-medium", active ? "text-accent" : "text-ink")}>
          {title}
        </span>
        {recommended && (
          <span className="rounded-full bg-overlay px-1.5 py-0.5 text-xs text-ink-faint">
            default
          </span>
        )}
      </span>
      <span className="mt-1 block text-xs leading-relaxed text-ink-faint">{description}</span>
    </button>
  );
}
