"use client";

/**
 * Settings, plus the first-run wizard.
 *
 * The wizard is the same set of sections the full page shows, walked one step
 * at a time, so there is only one implementation of each control. Nothing here
 * executes a command: the runner is configured, previewed and tested through
 * the settings and diagnostics endpoints only.
 */
import * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardCopy,
  FlaskConical,
  FolderOpen,
  Info,
  Monitor,
  Network,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";

import {
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  NumberInput,
  Select,
  Skeleton,
  Textarea,
  Toggle,
} from "@/components/ui/primitives";
import * as api from "@/lib/api";
import { useStore } from "@/lib/store";
import type { Diagnostics, LyricsStatus, Settings, SettingsUpdate } from "@/lib/types";
import { cn, fieldId } from "@/lib/utils";

/** Placeholders the runner substitutes, documented for the template editor. */
const PLACEHOLDERS: [string, string][] = [
  ["{model}", "Model path or Hugging Face id from Settings"],
  ["{vae}", "VAE path, or the word standard / legacy"],
  ["{device}", "cuda:N built from the GPU index"],
  ["{budget}", "VRAM budget in GiB"],
  ["{backend}", "torch / torch-eager / vllm"],
  ["{quantization}", "none / fp8"],
  ["{offload_ar}", "expands to --offload-ar, or to nothing"],
  ["{offline}", "expands to --offline, or to nothing"],
  ["{output}", "the version's run directory"],
  ["{id}", "run id inside that directory"],
  ["{style}", "composed style text (style + language + vocal + instrumental)"],
  ["{lyrics_file}", "path to the lyrics written for this run"],
  ["{abc_file}", "path to score.abc when a score was supplied"],
  ["{cot}", "planning mode: full / melody / off"],
  ["{stage}", "plan (score only) or audio (full render)"],
  ["{seed}", "resolved seed"],
  ["{cfg_scale}", "text guidance scale"],
];

const WIZARD_STEPS = [
  "Storage",
  "Runner",
  "Model & GPU",
  "Command",
  "Test",
  "Access",
] as const;

export default function SettingsPage() {
  const { settings, refreshSettings, refreshHealth, notify } = useStore();
  const [edits, setEdits] = React.useState<SettingsUpdate>({});
  const [saving, setSaving] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [wizardStep, setWizardStep] = React.useState(0);
  // null = follow the server's wizard_completed flag; true/false = the user
  // opened or dismissed it in this session. Derived rather than seeded in an
  // effect, so the full page never flashes before the wizard takes over.
  const [wizardChoice, setWizardChoice] = React.useState<boolean | null>(null);
  const [diagnostics, setDiagnostics] = React.useState<Diagnostics | null>(null);
  const [testing, setTesting] = React.useState(false);

  if (!settings) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  // Setup already did the wizard's job when it detected the hardware, wrote
  // the paths and left no configuration issues. Opening a six-step "point
  // SongForge at your model" flow at someone who just watched an installer do
  // exactly that reads as though the install failed.
  const configuredBySetup =
    settings.hardware !== null &&
    settings.runner_kind !== "mock" &&
    settings.configuration_issues.length === 0;
  const wizardOpen = wizardChoice ?? (!settings.wizard_completed && !configuredBySetup);
  const value: Settings = { ...settings, ...edits };
  const dirty = Object.keys(edits).length > 0;

  const set = <K extends keyof SettingsUpdate>(key: K, next: SettingsUpdate[K]) => {
    setEdits((current) => ({ ...current, [key]: next }));
    setErrors((current) => {
      if (!(key in current)) return current;
      const rest = { ...current };
      delete rest[key as string];
      return rest;
    });
  };

  const validate = (candidate: Settings): Record<string, string> => {
    const found: Record<string, string> = {};
    if (candidate.gpu_index < 0 || candidate.gpu_index > 15) {
      found.gpu_index = "Must be between 0 and 15.";
    }
    if (!(candidate.memory_budget_gib > 0) || candidate.memory_budget_gib > 512) {
      found.memory_budget_gib = "Must be greater than 0 and at most 512 GiB.";
    }
    if (candidate.default_cfg_scale < 0 || candidate.default_cfg_scale > 20) {
      found.default_cfg_scale = "YuE2 accepts 0 to 20.";
    }
    if (candidate.runner_kind === "yue2_cli") {
      if (!candidate.yue2_executable.trim() && !candidate.python_executable.trim()) {
        found.yue2_executable = "Set the yue2 command, or clear it and set the Python interpreter.";
      }
      if (!candidate.model_path.trim()) {
        found.model_path = "Required for the YuE2 runner.";
      }
      if (!candidate.command_template.trim()) {
        found.command_template = "The template cannot be empty.";
      }
    }
    return found;
  };

  const save = async (extra: SettingsUpdate = {}): Promise<boolean> => {
    const patch = { ...edits, ...extra };
    if (Object.keys(patch).length === 0) return true;
    const found = validate({ ...settings, ...patch });
    if (Object.keys(found).length > 0) {
      setErrors(found);
      notify({
        tone: "warning",
        title: "Check the highlighted fields",
        body: Object.values(found)[0],
      });
      return false;
    }
    setSaving(true);
    try {
      await api.updateSettings(patch);
      await Promise.all([refreshSettings(), refreshHealth()]);
      setEdits({});
      setErrors({});
      notify({ tone: "success", title: "Settings saved" });
      return true;
    } catch (cause) {
      notify({
        tone: "danger",
        title: "Could not save settings",
        body: cause instanceof Error ? cause.message : String(cause),
      });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const runDiagnostics = async () => {
    setTesting(true);
    setDiagnostics(null);
    try {
      const result = await api.runDiagnostics();
      setDiagnostics(result);
      notify({
        tone: result.ok ? "success" : "warning",
        title: result.ok ? "Runner test passed" : "Runner test found problems",
        body: result.summary,
      });
    } catch (cause) {
      notify({
        tone: "danger",
        title: "Diagnostics failed to run",
        body: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setTesting(false);
    }
  };

  const sectionProps = { value, set, errors, settings };

  // ------------------------------------------------------------------ wizard
  if (wizardOpen) {
    const last = wizardStep === WIZARD_STEPS.length - 1;
    const finish = async () => {
      const ok = await save({ wizard_completed: true });
      if (ok) setWizardChoice(false);
    };

    return (
      <div className="mx-auto max-w-3xl">
        <header className="mb-6">
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--sf-accent)]">
            First-run setup
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">
            Point SongForge at your model
          </h1>
          <p className="mt-1 text-sm text-[var(--sf-text-muted)]">
            Six short steps. Nothing runs on your GPU until you press Test, and
            you can leave at any point — everything here is editable later.
          </p>
        </header>

        <ol className="mb-6 flex flex-wrap gap-2" aria-label="Setup progress">
          {WIZARD_STEPS.map((label, index) => (
            <li key={label}>
              <button
                type="button"
                onClick={() => setWizardStep(index)}
                aria-current={index === wizardStep ? "step" : undefined}
                className={cn(
                  "rounded-full px-3 py-1 text-xs transition-colors",
                  index === wizardStep
                    ? "bg-[var(--sf-accent)] text-[var(--sf-accent-ink)]"
                    : index < wizardStep
                      ? "bg-[var(--sf-bg-overlay)] text-[var(--sf-text)]"
                      : "bg-[var(--sf-bg-overlay)] text-[var(--sf-text-faint)]",
                )}
              >
                {index + 1}. {label}
              </button>
            </li>
          ))}
        </ol>

        <div className="space-y-5">
          {wizardStep === 0 && <StorageSection settings={settings} />}
          {wizardStep === 1 && <RunnerSection {...sectionProps} />}
          {wizardStep === 2 && <HardwareSection {...sectionProps} />}
          {wizardStep === 3 && <CommandSection {...sectionProps} />}
          {wizardStep === 4 && (
            <DiagnosticsSection
              diagnostics={diagnostics}
              testing={testing}
              onRun={runDiagnostics}
              dirty={dirty}
              onSave={() => save()}
            />
          )}
          {wizardStep === 5 && <AccessSection />}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => setWizardStep((step) => Math.max(0, step - 1))}
            disabled={wizardStep === 0}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back
          </Button>
          {last ? (
            <Button variant="primary" loading={saving} onClick={finish}>
              <Check className="h-4 w-4" aria-hidden="true" />
              Finish setup
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={saving}
              onClick={async () => {
                if (dirty && !(await save())) return;
                setWizardStep((step) => step + 1);
              }}
            >
              Next
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
          <Button
            variant="ghost"
            className="ml-auto"
            onClick={() => setWizardChoice(false)}
          >
            Skip to full settings
          </Button>
        </div>
      </div>
    );
  }

  // ----------------------------------------------------------- full settings
  return (
    <div className="mx-auto max-w-3xl pb-24">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-[var(--sf-text-muted)]">
            Runner configuration, generation defaults and diagnostics.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => { setWizardStep(0); setWizardChoice(true); }}>
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          Re-run setup wizard
        </Button>
      </header>

      {settings.configuration_issues.length > 0 && (
        <div className="mb-5">
          <Banner tone="warning" title="The runner is not fully configured">
            <ul className="list-disc space-y-0.5 pl-4">
              {settings.configuration_issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </Banner>
        </div>
      )}

      <div className="space-y-5">
        <RunnerSection {...sectionProps} />
        <HardwareSection {...sectionProps} />
        <CommandSection {...sectionProps} />
        <DiagnosticsSection
          diagnostics={diagnostics}
          testing={testing}
          onRun={runDiagnostics}
          dirty={dirty}
          onSave={() => save()}
        />
        <DefaultsSection {...sectionProps} />
        <LyricsSection {...sectionProps} />
        <AppearanceSection {...sectionProps} />
        <StorageSection settings={settings} />
        <AccessSection />
      </div>

      {/* Save bar - fixed so it stays reachable on a long page. */}
      <div
        className={cn(
          "fixed inset-x-0 bottom-14 z-30 border-t border-[var(--sf-border)]",
          "bg-[var(--sf-bg-raised)]/95 px-4 py-3 backdrop-blur lg:bottom-0 lg:left-60",
          dirty ? "" : "hidden",
        )}
      >
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <p className="min-w-0 flex-1 truncate text-xs text-[var(--sf-text-muted)]">
            {Object.keys(edits).length} unsaved change
            {Object.keys(edits).length === 1 ? "" : "s"}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEdits({});
              setErrors({});
            }}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            Discard
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={() => save()}>
            <Save className="h-4 w-4" aria-hidden="true" />
            Save changes
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sections

interface SectionProps {
  value: Settings;
  set: <K extends keyof SettingsUpdate>(key: K, next: SettingsUpdate[K]) => void;
  errors: Record<string, string>;
  settings: Settings;
}

function RunnerSection({ value, set, errors, settings }: SectionProps) {
  const isMock = value.runner_kind === "mock";
  return (
    <Card>
      <CardHeader
        title="Runner"
        description="Which engine generates audio. The mock runner produces a placeholder tone and needs no GPU — useful for exercising the interface."
        action={
          <Badge tone={isMock ? "warning" : "accent"}>
            {settings.capabilities.display_name}
          </Badge>
        }
      />
      <div className="space-y-4 p-5 pt-0">
        <Field
          label="Engine"
          htmlFor={fieldId("settings", "runner_kind")}
          hint={settings.capabilities.notes}
        >
          <Select
            id={fieldId("settings", "runner_kind")}
            value={value.runner_kind}
            onChange={(event) =>
              set("runner_kind", event.target.value as Settings["runner_kind"])
            }
          >
            <option value="yue2_cli">YuE2 (real generation)</option>
            <option value="mock">Mock (simulation, no GPU)</option>
          </Select>
        </Field>

        {!isMock && (
          <>
            <p className="text-xs leading-relaxed text-[var(--sf-text-muted)]">
              {value.memory_efficient_attention
                ? "With memory-efficient attention on, SongForge starts yue2 through its launcher using the yue2 environment's Python: the interpreter below, or the python.exe next to the yue2 command when that is blank."
                : "SongForge starts yue2 in one of two ways. The yue2 command is used whenever it is filled in; leave it blank to run yue2 through the Python interpreter instead."}
            </p>

            <Field
              label="yue2 command"
              htmlFor={fieldId("settings", "yue2_executable")}
              error={errors.yue2_executable}
              hint={
                value.memory_efficient_attention
                  ? "Used to locate the environment's python.exe when the interpreter below is blank. Only the yue2 CLI is accepted, and only a path on this computer."
                  : value.yue2_executable.trim()
                    ? "In use. Give the full path unless yue2 is on PATH. Only the yue2 CLI is accepted: settings are reachable from the LAN, so an arbitrary program here would be a remote-code-execution hole."
                    : "Blank, so the Python interpreter below is used."
              }
            >
              <Input
                id={fieldId("settings", "yue2_executable")}
                value={value.yue2_executable}
                spellCheck={false}
                placeholder={String.raw`<checkout>\runtime\venv-yue2\Scripts\yue2.exe`}
                onChange={(event) => set("yue2_executable", event.target.value)}
              />
            </Field>

            <Field
              label="Python interpreter"
              htmlFor={fieldId("settings", "python_executable")}
              error={errors.python_executable}
              hint={
                value.memory_efficient_attention
                  ? "In use: runs SongForge's launcher, which then runs yue2. Must be the interpreter of the environment yue2 is installed into."
                  : value.yue2_executable.trim()
                    ? "Not used while the yue2 command above is filled in."
                    : "In use: runs python -m yue2.cli. Must be the interpreter of the environment yue2 is installed into."
              }
            >
              <Input
                id={fieldId("settings", "python_executable")}
                value={value.python_executable}
                spellCheck={false}
                disabled={!value.memory_efficient_attention && Boolean(value.yue2_executable.trim())}
                placeholder={String.raw`<checkout>\runtime\venv-yue2\Scripts\python.exe`}
                onChange={(event) => set("python_executable", event.target.value)}
              />
            </Field>
          </>
        )}
      </div>
    </Card>
  );
}

function HardwareSection({ value, set, errors }: SectionProps) {
  if (value.runner_kind === "mock") return null;
  return (
    <Card>
      <CardHeader
        title="Model and GPU"
        description="Weights, decoder and the limits generation runs under."
      />
      <div className="space-y-4 p-5 pt-0">
        <Field
          label="Model"
          htmlFor={fieldId("settings", "model_path")}
          error={errors.model_path}
          required
          hint="A local directory or a Hugging Face repo id."
        >
          <Input
            id={fieldId("settings", "model_path")}
            value={value.model_path}
            spellCheck={false}
            aria-invalid={Boolean(errors.model_path)}
            placeholder="m-a-p/YuE2-3B"
            onChange={(event) => set("model_path", event.target.value)}
          />
        </Field>

        <DecoderChoice value={value.vae_path} onChange={(next) => set("vae_path", next)} />

        {value.hardware && (
          /* What setup detected. Shown because every number below is derived
             from it, and because "why is my budget 11?" should have a visible
             answer rather than being folklore about one developer's card. */
          <Banner tone="info" title="Detected by setup">
            <p>{value.hardware.description}</p>
            <p className="mt-1 text-xs opacity-80">
              The budget, offload and quantization below were chosen from this.
              Re-run setup after changing graphics card to refresh it.
            </p>
          </Banner>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="GPU index"
            htmlFor={fieldId("settings", "gpu_index")}
            error={errors.gpu_index}
            hint="0 is the first CUDA device."
          >
            <NumberInput
              id={fieldId("settings", "gpu_index")}
              min={0}
              max={15}
              value={value.gpu_index}
              onValueChange={(next) => set("gpu_index", next ?? 0)}
            />
          </Field>

          <Field
            label="VRAM budget (GiB)"
            htmlFor={fieldId("settings", "memory_budget_gib")}
            error={errors.memory_budget_gib}
            hint="Set this to your card's size, less a gigabyte for the desktop: 11 on a 12 GB card, 23 on a 24 GB one. YuE2 keeps 2 GiB in reserve and caps itself at budget minus 2, so a lower number only makes out-of-memory errors more likely. Setup fills this in from the card it detects."
          >
            <NumberInput
              id={fieldId("settings", "memory_budget_gib")}
              min={1}
              max={512}
              step={0.5}
              value={value.memory_budget_gib}
              onValueChange={(next) => set("memory_budget_gib", next ?? 0)}
            />
          </Field>

          <Field
            label="Attention backend"
            htmlFor={fieldId("settings", "backend_mode")}
            hint="torch-eager is the working default on Windows: plain torch needs FlashAttention, which has no Windows build."
          >
            <Select
              id={fieldId("settings", "backend_mode")}
              value={value.backend_mode}
              onChange={(event) =>
                set("backend_mode", event.target.value as Settings["backend_mode"])
              }
            >
              <option value="torch-eager">torch-eager (Windows)</option>
              <option value="torch">torch</option>
              <option value="vllm">vllm</option>
            </Select>
          </Field>

          <Field
            label="Quantization"
            htmlFor={fieldId("settings", "quantization")}
            hint="fp8 needs compute capability 8.9 or newer — Ada, Hopper and later. On an older card leave this at none; it will not run faster, it will not run at all."
          >
            <Select
              id={fieldId("settings", "quantization")}
              value={value.quantization}
              onChange={(event) =>
                set("quantization", event.target.value as Settings["quantization"])
              }
            >
              <option value="none">none</option>
              <option value="fp8">fp8</option>
            </Select>
          </Field>
        </div>

        <div className="space-y-3 border-t border-[var(--sf-border)] pt-4">
          <Toggle
            id={fieldId("settings", "offload_ar")}
            checked={value.offload_ar}
            onChange={(next) => set("offload_ar", next)}
            label="Offload the language model between stages"
            description="Frees VRAM before synthesis at the cost of some time. Turn on if you run out of memory."
          />
          <Toggle
            id={fieldId("settings", "memory_efficient_attention")}
            checked={value.memory_efficient_attention}
            onChange={(next) => set("memory_efficient_attention", next)}
            label="Memory-efficient attention (needed for long songs)"
            description="On this setup YuE2's attention otherwise needs memory that grows with the square of the song's length, so songs past about two minutes run out of GPU memory. SongForge starts yue2 through a small launcher that switches to PyTorch's memory-efficient kernel; output differs only by rounding. Uses the Python interpreter of the yue2 environment."
          />
          <Toggle
            id={fieldId("settings", "offline_mode")}
            checked={value.offline_mode}
            onChange={(next) => set("offline_mode", next)}
            label="Offline mode"
            description="Never contact Hugging Face. Requires the weights to be present locally already."
          />
        </div>
      </div>
    </Card>
  );
}

function CommandSection({ value, set, errors, settings }: SectionProps) {
  const [copied, setCopied] = React.useState(false);
  if (value.runner_kind === "mock") return null;

  const preview = settings.command_preview;
  const changed = value.command_template !== settings.command_template;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(preview.join(" "));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard is unavailable over plain HTTP in some browsers */
    }
  };

  return (
    <Card>
      <CardHeader
        title="Command template"
        description="How the yue2 command line is assembled. Every argument is passed as a separate element — there is no shell involved, so quoting is never your problem."
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => set("command_template", settings.default_command_template)}
            disabled={value.command_template === settings.default_command_template}
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Reset
          </Button>
        }
      />
      <div className="space-y-4 p-5 pt-0">
        <Field
          label="Template"
          htmlFor={fieldId("settings", "command_template")}
          error={errors.command_template}
          hint="Flags are checked against the yue2 CLI's own argument list; unknown flags are rejected on save."
        >
          <Textarea
            id={fieldId("settings", "command_template")}
            value={value.command_template}
            rows={6}
            spellCheck={false}
            aria-invalid={Boolean(errors.command_template)}
            className="font-mono text-xs"
            onChange={(event) => set("command_template", event.target.value)}
          />
        </Field>

        <details className="rounded-lg border border-[var(--sf-border)] p-3">
          <summary className="cursor-pointer text-xs font-medium text-[var(--sf-text-muted)]">
            Placeholders ({PLACEHOLDERS.length})
          </summary>
          <dl className="mt-3 space-y-1.5">
            {PLACEHOLDERS.map(([token, meaning]) => (
              <div key={token} className="flex gap-3 text-xs">
                <dt className="w-32 shrink-0 font-mono text-[var(--sf-accent)]">
                  {token}
                </dt>
                <dd className="text-[var(--sf-text-muted)]">{meaning}</dd>
              </div>
            ))}
          </dl>
        </details>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-[var(--sf-text-muted)]">
              <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
              Command preview
            </p>
            <Button size="sm" variant="ghost" onClick={copy} disabled={preview.length === 0}>
              <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          {preview.length > 0 ? (
            <pre className="overflow-x-auto rounded-lg border border-[var(--sf-border)] bg-[var(--sf-bg)] p-3 text-[11px] leading-relaxed text-[var(--sf-text-muted)]">
              {preview.map((part, index) => (
                <span key={`${part}-${index}`} className="mr-1.5 inline-block">
                  {part}
                </span>
              ))}
            </pre>
          ) : (
            <p className="rounded-lg border border-dashed border-[var(--sf-border)] p-3 text-xs text-[var(--sf-text-faint)]">
              No preview — the template could not be expanded. See the warnings above.
            </p>
          )}
          {changed && (
            <p className="mt-1.5 text-xs text-[var(--sf-warning)]">
              This preview is of the saved template. Save to rebuild it.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function DiagnosticsSection({
  diagnostics,
  testing,
  onRun,
  dirty,
  onSave,
}: {
  diagnostics: Diagnostics | null;
  testing: boolean;
  onRun: () => void;
  dirty: boolean;
  onSave: () => void;
}) {
  return (
    <Card>
      <CardHeader
        title="Test the runner"
        description="Runs yue2 doctor: checks the interpreter, the CUDA device, the VRAM budget and the weight checksums. It generates nothing and writes nothing."
        action={
          <Button size="sm" variant="primary" loading={testing} onClick={onRun}>
            <FlaskConical className="h-4 w-4" aria-hidden="true" />
            Run test
          </Button>
        }
      />
      <div className="space-y-3 p-5 pt-0">
        {dirty && (
          <Banner tone="warning" title="You have unsaved changes">
            <p>The test uses the saved settings.</p>
            <Button size="sm" className="mt-2" onClick={onSave}>
              Save first
            </Button>
          </Banner>
        )}

        {!diagnostics && !testing && (
          <p className="text-xs text-[var(--sf-text-faint)]">
            No test run yet in this session.
          </p>
        )}

        {diagnostics && (
          <>
            <Banner tone={diagnostics.ok ? "success" : "danger"} title={diagnostics.summary}>
              {diagnostics.exit_code !== null && (
                <p>Exit code {diagnostics.exit_code}.</p>
              )}
            </Banner>

            <ul className="space-y-1.5">
              {diagnostics.checks.map((check) => (
                <li key={check.name} className="flex items-start gap-2 text-xs">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                      check.ok
                        ? "bg-[var(--sf-success)]/20 text-[var(--sf-success)]"
                        : "bg-[var(--sf-danger)]/20 text-[var(--sf-danger)]",
                    )}
                  >
                    {check.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0">
                    <span className="font-medium text-[var(--sf-text)]">{check.name}</span>
                    {check.detail && (
                      <span className="text-[var(--sf-text-muted)]"> — {check.detail}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>

            {(diagnostics.stdout || diagnostics.stderr) && (
              <details className="rounded-lg border border-[var(--sf-border)] p-3">
                <summary className="cursor-pointer text-xs font-medium text-[var(--sf-text-muted)]">
                  Raw output
                </summary>
                {diagnostics.command && (
                  <p className="mt-2 break-all font-mono text-[11px] text-[var(--sf-text-faint)]">
                    {diagnostics.command}
                  </p>
                )}
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--sf-text-muted)]">
                  {diagnostics.stdout}
                  {diagnostics.stderr}
                </pre>
              </details>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function DefaultsSection({ value, set, errors, settings }: SectionProps) {
  return (
    <Card>
      <CardHeader
        title="Generation defaults"
        description="What the Create page starts with. Every one of these can be changed per song."
      />
      <div className="space-y-4 p-5 pt-0">
        <Field
          label="Default style prompt"
          htmlFor={fieldId("settings", "default_style_prompt")}
          hint="Prefilled in Create. Leave blank for an empty box."
        >
          <Textarea
            id={fieldId("settings", "default_style_prompt")}
            value={value.default_style_prompt}
            rows={2}
            onChange={(event) => set("default_style_prompt", event.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Default language"
            htmlFor={fieldId("settings", "default_language")}
            hint="Travels to the model inside the style text; also used as a Library filter."
          >
            <Input
              id={fieldId("settings", "default_language")}
              value={value.default_language}
              placeholder="English"
              onChange={(event) => set("default_language", event.target.value)}
            />
          </Field>

          <Field
            label="Default planning mode"
            htmlFor={fieldId("settings", "default_cot")}
            hint="off skips the score entirely — faster, but nothing to edit afterwards."
          >
            <Select
              id={fieldId("settings", "default_cot")}
              value={value.default_cot}
              disabled={!settings.capabilities.supports_planning}
              onChange={(event) => set("default_cot", event.target.value as Settings["default_cot"])}
            >
              <option value="full">Full — melody and chords</option>
              <option value="melody">Melody only</option>
              <option value="off">Off — no score</option>
            </Select>
          </Field>

          <Field
            label="Default guidance (CFG scale)"
            htmlFor={fieldId("settings", "default_cfg_scale")}
            error={errors.default_cfg_scale}
            hint="1.0 is the model's own default. Anything else doubles generation time, because it runs two guidance branches."
          >
            <NumberInput
              id={fieldId("settings", "default_cfg_scale")}
              min={0}
              max={20}
              step={0.1}
              value={value.default_cfg_scale}
              disabled={!settings.capabilities.supports_cfg_scale}
              onValueChange={(next) => set("default_cfg_scale", next ?? 0)}
            />
          </Field>

          <Field
            label="MP3 bitrate"
            htmlFor={fieldId("settings", "mp3_bitrate")}
            hint="Only used when an MP3 export is requested."
          >
            <Select
              id={fieldId("settings", "mp3_bitrate")}
              value={String(value.mp3_bitrate)}
              disabled={!settings.ffmpeg_available}
              onChange={(event) => set("mp3_bitrate", Number(event.target.value))}
            >
              <option value="128">128 kbps</option>
              <option value="192">192 kbps</option>
              <option value="256">256 kbps</option>
              <option value="320">320 kbps</option>
            </Select>
          </Field>
        </div>

        <div className="space-y-3 border-t border-[var(--sf-border)] pt-4">
          {!settings.ffmpeg_available && (
            <Banner tone="info" title="FFmpeg was not found">
              <p>
                The 24-bit/48 kHz FLAC master is always written by the model itself.
                MP3 and WAV are optional conversions and need FFmpeg on PATH.
              </p>
            </Banner>
          )}
          <Toggle
            id={fieldId("settings", "export_mp3")}
            checked={value.export_mp3}
            disabled={!settings.ffmpeg_available}
            onChange={(next) => set("export_mp3", next)}
            label="Also export MP3"
            description="Convenient for phones and messaging. Lossy."
          />
          <Toggle
            id={fieldId("settings", "export_wav")}
            checked={value.export_wav}
            disabled={!settings.ffmpeg_available}
            onChange={(next) => set("export_wav", next)}
            label="Also export WAV"
            description="Uncompressed, for editing in a DAW."
          />
        </div>
      </div>
    </Card>
  );
}

function LyricsSection({ value, set }: SectionProps) {
  const [status, setStatus] = React.useState<LyricsStatus | null>(null);
  const [unloading, setUnloading] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await api.getLyricsStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  React.useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  const models = status?.installed_models ?? [];
  const options = models.includes(value.lyrics_model) ? models : [value.lyrics_model, ...models];

  return (
    <Card>
      <CardHeader
        title="Lyrics writer"
        description="Optional. A local language model (Ollama) that writes and revises lyrics; without it you write your own. It shares the graphics card with YuE2, so it is unloaded automatically before every render."
        action={
          <Badge tone={!status?.ollama_running ? "warning" : status.loaded ? "success" : "neutral"}>
            {!status ? "checking" : !status.ollama_running ? "not running" : status.loaded ? "loaded" : "idle"}
          </Badge>
        }
      />
      <div className="space-y-4 p-5 pt-0">
        <Toggle
          id={fieldId("settings", "lyrics_enabled")}
          checked={value.lyrics_enabled}
          onChange={(next) => set("lyrics_enabled", next)}
          label="Offer lyrics writing"
          description="Shows Generate lyrics on every lyrics box and the Lyrics page."
        />
        <Field
          label="Model"
          htmlFor={fieldId("settings", "lyrics_model")}
          hint={
            status?.ollama_running
              ? `Installed with Ollama ${status.ollama_version ?? ""}. Bigger models write better lyrics and load more slowly.`
              : "Ollama is not running, so installed models cannot be listed. The start script launches it when it is installed."
          }
        >
          <Select
            id={fieldId("settings", "lyrics_model")}
            value={value.lyrics_model}
            onChange={(event) => set("lyrics_model", event.target.value)}
          >
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
                {models.includes(name) ? "" : " (not installed)"}
              </option>
            ))}
          </Select>
        </Field>
        {status?.ollama_running && !status.model_installed && (
          <Banner tone="info" title={`${status.model} is not installed`}>
            <p>
              The lyrics writer is optional; you can always write your own. To add
              this model, run <code>ollama pull {status.model}</code> in a terminal.
            </p>
          </Banner>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            loading={unloading}
            disabled={!status?.loaded}
            onClick={async () => {
              setUnloading(true);
              try {
                await api.unloadLyrics();
              } finally {
                setUnloading(false);
                void refresh();
              }
            }}
          >
            Unload now
          </Button>
          <span className="text-xs text-[var(--sf-text-faint)]">
            {status?.loaded
              ? `Using ${(status.loaded_vram_bytes / 2 ** 30).toFixed(1)} GB of GPU memory.`
              : "Not using GPU memory."}
          </span>
        </div>
      </div>
    </Card>
  );
}

function AppearanceSection({ value, set }: SectionProps) {
  const options: [Settings["theme"], string, string][] = [
    ["dark", "Dark", "The studio default."],
    ["light", "Light", "Higher contrast in a bright room."],
    ["system", "System", "Follow the operating system."],
  ];
  return (
    <Card>
      <CardHeader title="Appearance" description="Applies immediately, on every device that loads the app." />
      <div className="grid gap-2 p-5 pt-0 sm:grid-cols-3">
        {options.map(([theme, label, description]) => (
          <button
            key={theme}
            type="button"
            aria-pressed={value.theme === theme}
            onClick={() => set("theme", theme)}
            className={cn(
              "rounded-lg border p-3 text-left transition-colors",
              value.theme === theme
                ? "border-[var(--sf-accent)] bg-[var(--sf-accent)]/10"
                : "border-[var(--sf-border)] hover:bg-[var(--sf-bg-overlay)]",
            )}
          >
            <span className="flex items-center gap-2 text-sm text-[var(--sf-text)]">
              <Monitor className="h-4 w-4" aria-hidden="true" />
              {label}
            </span>
            <span className="mt-1 block text-xs text-[var(--sf-text-faint)]">
              {description}
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function StorageSection({ settings }: { settings: Settings }) {
  return (
    <Card>
      <CardHeader
        title="Storage and backups"
        description="Where songs live on the Windows machine. These paths come from the .env file and change with a restart, not from this page."
      />
      <div className="space-y-4 p-5 pt-0">
        <dl className="space-y-2 text-xs">
          {[
            ["Projects", settings.projects_dir, "One folder per song: lyrics, style, score, every version's audio and logs."],
            ["Models", settings.models_dir, "Weights and decoders, when kept locally rather than in the Hugging Face cache."],
          ].map(([label, path, meaning]) => (
            <div key={label} className="rounded-lg border border-[var(--sf-border)] p-3">
              <dt className="flex items-center gap-1.5 font-medium text-[var(--sf-text)]">
                <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                {label}
              </dt>
              <dd className="mt-1 break-all font-mono text-[11px] text-[var(--sf-accent)]">
                {path || "—"}
              </dd>
              <dd className="mt-1 text-[var(--sf-text-muted)]">{meaning}</dd>
            </div>
          ))}
        </dl>

        <Banner tone="info" title="Backing up">
          <p>
            Stop the app, then copy the <code>projects</code> and <code>database</code>{" "}
            folders inside the runtime directory. Those two together are the whole
            library — restoring is copying them back.
          </p>
          <p className="mt-1">
            A single song can be exported at any time from its Files tab as a ZIP
            containing the audio, score, request and logs.
          </p>
        </Banner>

        <p className="flex items-start gap-1.5 text-xs text-[var(--sf-text-faint)]">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          To move the library to another drive, set
          <code className="mx-1">SONGFORGE_RUNTIME_DIR</code> in the project&rsquo;s
          .env file and restart.
        </p>
      </div>
    </Card>
  );
}

function AccessSection() {
  // Read after hydration without a state-setting effect: on the server there is
  // no location, and the two snapshots must differ or React will not re-render.
  const origin = React.useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );

  return (
    <Card>
      <CardHeader
        title="Access from other devices"
        description="SongForge is a LAN application. It is not exposed to the internet and has no accounts."
      />
      <div className="space-y-4 p-5 pt-0">
        <div className="rounded-lg border border-[var(--sf-border)] p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-[var(--sf-text-muted)]">
            <Network className="h-3.5 w-3.5" aria-hidden="true" />
            This page&rsquo;s address
          </p>
          <p className="mt-1 break-all font-mono text-sm text-[var(--sf-accent)]">
            {origin || "…"}
          </p>
          <p className="mt-1 text-xs text-[var(--sf-text-muted)]">
            Open that on the other device. If it reads localhost, use this
            machine&rsquo;s LAN address instead — Start-SongForge.ps1 prints it.
          </p>
        </div>

        <Banner tone="info" title="Firewall">
          <p>Allow port 3333 from your own LAN subnet only (the example below is not yours):</p>
          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap text-[11px]">
{`New-NetFirewallRule -DisplayName "SongForge" -Direction Inbound \`
  -Action Allow -Protocol TCP -LocalPort 3333 \`
  -RemoteAddress 192.168.1.0/24`}
          </pre>
        </Banner>

        <p className="flex items-start gap-1.5 text-xs text-[var(--sf-text-faint)]">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          The API binds to 127.0.0.1; only the frontend listens on the network and
          proxies to it. Do not port-forward either one.
        </p>
      </div>
    </Card>
  );
}

/**
 * Standard or legacy decoder, as a labelled choice rather than a free-text box
 * with a datalist: the two options are a real trade-off worth stating, and the
 * typed path stays available for a decoder kept somewhere else.
 */
function DecoderChoice({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const known = value === "standard" || value === "legacy" || value === "";
  const [custom, setCustom] = React.useState(!known);
  const current = value === "" ? "standard" : value;

  const OPTIONS = [
    {
      key: "standard",
      title: "Standard",
      description: "Favours perceptual quality. The YuE2 default.",
    },
    {
      key: "legacy",
      title: "Legacy",
      description: "Scores higher on musicality benchmarks; reproduces the paper.",
    },
  ] as const;

  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-[var(--sf-text)]">Audio decoder (VAE)</p>
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Audio decoder">
        {OPTIONS.map((option) => {
          const active = !custom && current === option.key;
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                setCustom(false);
                onChange(option.key);
              }}
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
                {option.title}
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--sf-text-faint)]">
                {option.description}
              </span>
            </button>
          );
        })}
      </div>

      {custom ? (
        <div className="mt-2">
          <Field
            label="Decoder path"
            htmlFor={fieldId("settings", "vae_path")}
            hint="A local directory or a Hugging Face repository id."
          >
            <Input
              id={fieldId("settings", "vae_path")}
              value={known ? "" : value}
              spellCheck={false}
              placeholder="<checkout>\runtime\models\YuE2-Vae"
              onChange={(event) => onChange(event.target.value)}
            />
          </Field>
          <button
            type="button"
            className="mt-1 text-[11px] text-[var(--sf-accent)] underline-offset-2 hover:underline"
            onClick={() => {
              setCustom(false);
              onChange("standard");
            }}
          >
            Use a bundled decoder instead
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="mt-2 text-[11px] text-[var(--sf-text-muted)] underline-offset-2 hover:text-[var(--sf-text)] hover:underline"
          onClick={() => {
            setCustom(true);
            onChange("");
          }}
        >
          Use a decoder from another path
        </button>
      )}
    </div>
  );
}
