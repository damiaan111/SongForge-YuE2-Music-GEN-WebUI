/**
 * Types mirroring the backend's Pydantic schemas.
 *
 * Kept hand-written rather than generated so the shapes the UI depends on are
 * explicit. If an endpoint changes, the compiler points at every use.
 */

export type RunnerKind = "mock" | "yue2_cli";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type JobStage =
  | "queued"
  | "loading_model"
  | "planning"
  | "generating"
  | "decoding"
  | "exporting"
  | "completed";

export type ProjectStatus =
  | "draft"
  | "queued"
  | "generating"
  | "completed"
  | "failed"
  | "cancelled"
  | "archived";

export type CotMode = "full" | "melody" | "off";
export type SeedMode = "random" | "locked" | "manual";

export const TERMINAL_STATUSES: readonly JobStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Ordered pipeline stages, used to render a stage rail. */
export const STAGE_ORDER: readonly JobStage[] = [
  "queued",
  "loading_model",
  "planning",
  "generating",
  "decoding",
  "exporting",
  "completed",
];

export const STAGE_LABELS: Record<JobStage, string> = {
  queued: "Queued",
  loading_model: "Loading model",
  planning: "Planning",
  generating: "Generating",
  decoding: "Decoding",
  exporting: "Exporting",
  completed: "Completed",
};

export const STATUS_LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  running: "Generating",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export interface RunnerCapabilities {
  kind: RunnerKind;
  display_name: string;
  supports_lyrics: boolean;
  supports_instrumental: boolean;
  supports_score_abc: boolean;
  supports_planning: boolean;
  supports_seed: boolean;
  supports_cfg_scale: boolean;
  supports_duration_target: boolean;
  supports_cancel: boolean;
  /** Can write the score without rendering audio, for a plan-then-render flow. */
  supports_plan_stage: boolean;
  /** Per-request sampling and synthesis-step overrides (advanced controls). */
  supports_sampling_overrides: boolean;
  supports_progress_percent: boolean;
  emits_score: boolean;
  stages: JobStage[];
  notes: string;
}

export interface Health {
  status: "ok";
  version: string;
  database: boolean;
  runner_kind: RunnerKind;
  runner_ready: boolean;
  ffmpeg: boolean;
  active_job_id: string | null;
  queued_jobs: number;
  projects: number;
}

export interface Settings {
  runner_kind: RunnerKind;
  python_executable: string;
  yue2_executable: string;
  model_path: string;
  vae_path: string;
  gpu_index: number;
  memory_budget_gib: number;
  offload_ar: boolean;
  backend_mode: "torch" | "torch-eager" | "vllm";
  quantization: "none" | "fp8";
  offline_mode: boolean;
  command_template: string;
  /** Run yue2 through SongForge's launcher so long songs fit in memory. */
  memory_efficient_attention: boolean;
  /** Local lyrics writer (Ollama). */
  lyrics_enabled: boolean;
  lyrics_model: string;
  default_cot: CotMode;
  default_cfg_scale: number;
  export_mp3: boolean;
  export_wav: boolean;
  mp3_bitrate: number;
  theme: "dark" | "light" | "system";
  default_style_prompt: string;
  default_language: string;
  wizard_completed: boolean;
  capabilities: RunnerCapabilities;
  command_preview: string[];
  configuration_issues: string[];
  /** The shipped template, for "reset to default" in Settings. */
  default_command_template: string;
  projects_dir: string;
  models_dir: string;
  ffmpeg_available: boolean;
  /** What setup detected. Null when setup has not been run on this machine. */
  hardware: Hardware | null;
}

/** The accelerator setup found, for display only. */
export interface Hardware {
  vendor: string;
  name: string;
  memory_gib: number | null;
  /** NVIDIA compute capability, e.g. "8.9". */
  compute: string | null;
  torch: string;
  description: string;
}

export type SettingsUpdate = Partial<
  Omit<
    Settings,
    | "capabilities"
    | "command_preview"
    | "configuration_issues"
    | "default_command_template"
    | "projects_dir"
    | "models_dir"
    | "ffmpeg_available"
    | "hardware"
  >
>;

export interface DiagnosticCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Diagnostics {
  ok: boolean;
  summary: string;
  command: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  checks: DiagnosticCheck[];
}

export interface Version {
  id: string;
  project_id: string;
  number: number;
  title: string;
  style_prompt: string;
  lyrics: string;
  score_abc: string | null;
  request: Record<string, unknown>;
  /** The runner's own report: truncation, identity, weight hashes, timing. */
  result: Record<string, unknown>;
  is_plan_only: boolean;
  /** Status of the job that produces this version; failed takes stay listed. */
  status: JobStatus;
  /** Shared by takes queued together with candidates > 1. */
  candidate_group: string | null;
  runner_kind: RunnerKind;
  runner_command: string;
  duration_seconds: number | null;
  sample_rate: number | null;
  seed: number | null;
  has_flac: boolean;
  has_mp3: boolean;
  has_wav: boolean;
  has_waveform: boolean;
  is_primary: boolean;
  created_at: string;
}

export interface Project {
  id: string;
  slug: string;
  title: string;
  style_prompt: string;
  lyrics: string;
  score_abc: string | null;
  notes: string;
  instrumental: boolean;
  language: string | null;
  vocal_preference: string | null;
  tags: string[];
  settings: Record<string, unknown>;
  status: ProjectStatus;
  primary_version: number | null;
  favourite: boolean;
  archived: boolean;
  play_count: number;
  last_played_at: string | null;
  created_at: string;
  updated_at: string;
  /** Finished versions only; failed and cancelled attempts are not counted. */
  version_count: number;
  latest_version: number | null;
  active_job_id: string | null;
  /** Length of the primary version's audio. */
  duration_seconds: number | null;
}

export interface ProjectDetail extends Project {
  versions: Version[];
}

export interface ProjectList {
  items: Project[];
  total: number;
  limit: number;
  offset: number;
}

export interface Job {
  id: string;
  project_id: string;
  project_title: string;
  version_number: number;
  status: JobStatus;
  stage: JobStage;
  progress: number;
  message: string;
  error: string | null;
  exit_code: number | null;
  runner_kind: RunnerKind;
  request: Record<string, unknown>;
  retry_of: string | null;
  /** Other jobs queued by the same Generate press (candidates > 1). */
  sibling_job_ids?: string[];
  queue_position: number | null;
  supports_progress_percent: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobList {
  items: Job[];
  active_job_id: string | null;
}

export interface JobLog {
  job_id: string;
  lines: string[];
  truncated: boolean;
}

/** A progress frame delivered over Server-Sent Events. */
export interface JobEvent {
  job_id: string;
  type: "status" | "stage" | "queue" | "completed" | "failed" | "cancelled";
  status?: JobStatus;
  stage?: JobStage;
  progress?: number;
  message?: string;
  log_line?: string;
  queue_position?: number;
  project_id?: string;
  version_number?: number;
  error?: string;
  exit_code?: number;
  at: string;
}

export interface GenerateRequest {
  /** "plan" stops after the symbolic score; "audio" renders the whole song. */
  stage?: "plan" | "audio";
  title?: string;
  style_prompt?: string;
  lyrics?: string;
  score_abc?: string;
  instrumental?: boolean;
  language?: string;
  vocal_preference?: string;
  cot?: CotMode;
  seed_mode?: SeedMode;
  seed?: number | null;
  cfg_scale?: number | null;
  export_mp3?: boolean;
  export_wav?: boolean;
  /** Best-of-N: 1-8 takes, run one after another. */
  candidates?: number;
  abc_sampling?: SamplingOverride;
  semantic_sampling?: SamplingOverride;
  /** Flow-matching synthesis steps; yue2 default 32. */
  ode_steps?: number;
}

/** Partial override of one yue2 sampling stage. Unset keys keep the defaults. */
export interface SamplingOverride {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repetition_penalty?: number;
  penalty_window?: number;
  min_tokens?: number;
  max_tokens?: number;
}

export interface ProjectCreate {
  title?: string;
  style_prompt?: string;
  lyrics?: string;
  instrumental?: boolean;
  language?: string | null;
  vocal_preference?: string | null;
  tags?: string[];
  notes?: string;
}

export interface ProjectUpdate {
  title?: string;
  style_prompt?: string;
  lyrics?: string;
  score_abc?: string;
  notes?: string;
  instrumental?: boolean;
  language?: string | null;
  vocal_preference?: string | null;
  tags?: string[];
  favourite?: boolean;
  archived?: boolean;
  primary_version?: number;
}

export interface QuickGenerate {
  prompt: string;
  lyrics?: string;
  title?: string;
  instrumental?: boolean;
  tags?: string[];
}

export interface Waveform {
  version: number;
  buckets: number;
  duration: number;
  peaks: number[];
  available: boolean;
}

export type SortKey =
  | "newest"
  | "oldest"
  | "alphabetical"
  | "duration"
  | "most_played";

export const DOWNLOAD_KEYS = [
  "flac",
  "mp3",
  "wav",
  "waveform",
  "log",
  "metadata",
  "command",
  "score",
  "request",
  "result",
  "config",
  "plan",
] as const;

export type DownloadKey = (typeof DOWNLOAD_KEYS)[number];

// ---------------------------------------------------------------- lyrics

export interface LyricsStatus {
  enabled: boolean;
  ollama_running: boolean;
  ollama_version: string | null;
  model: string;
  model_installed: boolean;
  installed_models: string[];
  /** Currently in GPU memory. */
  loaded: boolean;
  loaded_vram_bytes: number;
  /** A song is rendering or queued; the lyrics model cannot share the GPU. */
  gpu_busy: boolean;
  writing: boolean;
}

export interface LyricsGenerateRequest {
  idea: string;
  language: string;
  /** Target sung length; the backend turns it into lines and sections. */
  minutes: number;
  style_hint?: string;
  mood?: string;
  /** Revise mode. */
  existing_lyrics?: string;
  instruction?: string;
}

export interface LyricsResult {
  title: string;
  style: string;
  lyrics: string;
  estimated_seconds: number;
  model: string;
  output_tokens: number;
  seconds: number;
  warnings: string[];
}

/**
 * What a draft will cost, from POST /api/estimate.
 *
 * YuE2 has no duration control, so length follows the lyrics, and two ceilings
 * decide whether a song survives: the ~6 minute music budget and the shared
 * 24,576-token context. `verdict` says which one is in danger.
 */
export interface Estimate {
  seconds: number;
  max_seconds: number;
  music_tokens: number;
  music_cap: number;
  prompt_tokens: number;
  plan_tokens: number;
  context_tokens: number;
  context_total: number;
  verdict: "ok" | "tight" | "over_length" | "over_context";
  headline: string;
  detail: string;
  advice: string;
}

export interface EstimateRequest {
  style_prompt?: string;
  lyrics?: string;
  score_abc?: string;
  cot?: CotMode;
  instrumental?: boolean;
}
