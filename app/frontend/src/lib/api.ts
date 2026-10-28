/**
 * Typed API client.
 *
 * Every call goes through `request`, which turns a non-2xx response into an
 * ApiError carrying the backend's own message, so the UI can show what actually
 * went wrong instead of a generic failure.
 */
import type {
  Diagnostics,
  Estimate,
  EstimateRequest,
  GenerateRequest,
  Health,
  Job,
  JobList,
  JobLog,
  LyricsGenerateRequest,
  LyricsResult,
  LyricsStatus,
  ProjectCreate,
  ProjectDetail,
  ProjectList,
  ProjectUpdate,
  QuickGenerate,
  Settings,
  SettingsUpdate,
  SortKey,
  Version,
  Waveform,
  DownloadKey,
  ProjectStatus,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Extract a human-readable message from FastAPI's several error shapes. */
function messageFrom(status: number, body: unknown): string {
  if (typeof body === "string" && body.trim()) return body;
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      // Pydantic validation errors: surface the field and reason.
      const parts = detail
        .map((item) => {
          if (item && typeof item === "object") {
            const entry = item as { loc?: unknown[]; msg?: string };
            const field = Array.isArray(entry.loc)
              ? entry.loc.filter((p) => p !== "body").join(".")
              : "";
            return field ? `${field}: ${entry.msg ?? ""}` : (entry.msg ?? "");
          }
          return String(item);
        })
        .filter(Boolean);
      if (parts.length) return parts.join("; ");
    }
  }
  return `Request failed with status ${status}.`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (cause) {
    throw new ApiError(
      "Could not reach the SongForge backend. Is it running?",
      0,
      cause,
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      /* leave as text; the message extractor handles both */
    }
  }

  if (!response.ok) {
    throw new ApiError(messageFrom(response.status, body), response.status, body);
  }
  return body as T;
}

function query(params: Record<string, string | number | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

// --------------------------------------------------------------------- health

export const getHealth = () => request<Health>("/api/health");

export const getSettings = () => request<Settings>("/api/settings");

export const updateSettings = (patch: SettingsUpdate) =>
  request<Settings>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });

export const runDiagnostics = () =>
  request<Diagnostics>("/api/diagnostics/runner", { method: "POST" });

// ------------------------------------------------------------------- projects

export interface ProjectQuery {
  search?: string;
  status?: ProjectStatus;
  tag?: string;
  language?: string;
  vocal?: string;
  favourite?: boolean;
  archived?: boolean;
  sort?: SortKey;
  limit?: number;
  offset?: number;
}

export const listProjects = (params: ProjectQuery = {}) =>
  request<ProjectList>(`/api/projects${query({ ...params })}`);

export const getProject = (id: string) =>
  request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`);

export const createProject = (payload: ProjectCreate) =>
  request<ProjectDetail>("/api/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const updateProject = (id: string, patch: ProjectUpdate) =>
  request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });

export const saveDraft = (
  id: string,
  patch: { title?: string; style_prompt?: string; lyrics?: string; notes?: string },
) =>
  request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}/draft`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });

export const saveScore = (id: string, score_abc: string) =>
  request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}/score`, {
    method: "PUT",
    body: JSON.stringify({ score_abc }),
  });

export const duplicateProject = (id: string) =>
  request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}/duplicate`, {
    method: "POST",
  });

export const archiveProject = (id: string, archived: boolean) =>
  request<ProjectDetail>(
    `/api/projects/${encodeURIComponent(id)}/archive${query({ archived })}`,
    { method: "POST" },
  );

/** Permanent. The caller must have confirmed with the user first. */
export const deleteProject = (id: string) =>
  request<void>(`/api/projects/${encodeURIComponent(id)}?confirm=true`, {
    method: "DELETE",
  });

export const listVersions = (id: string) =>
  request<Version[]>(`/api/projects/${encodeURIComponent(id)}/versions`);

/** Permanent, and refused for the primary version. Confirm with the user first. */
export const deleteVersion = (id: string, number: number) =>
  request<void>(
    `/api/projects/${encodeURIComponent(id)}/versions/${number}?confirm=true`,
    { method: "DELETE" },
  );

export const generate = (id: string, payload: GenerateRequest = {}) =>
  request<Job>(`/api/projects/${encodeURIComponent(id)}/generate`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const quickGenerate = (payload: QuickGenerate) =>
  request<Job>("/api/projects/quick", {
    method: "POST",
    body: JSON.stringify(payload),
  });

// ----------------------------------------------------------------------- jobs

export const listJobs = (params: { status?: string; project_id?: string; limit?: number } = {}) =>
  request<JobList>(`/api/jobs${query(params)}`);

export const getJob = (id: string) =>
  request<Job>(`/api/jobs/${encodeURIComponent(id)}`);

export const getJobLog = (id: string, maxLines = 2000) =>
  request<JobLog>(`/api/jobs/${encodeURIComponent(id)}/log${query({ max_lines: maxLines })}`);

export const cancelJob = (id: string) =>
  request<Job>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });

export const retryJob = (id: string) =>
  request<Job>(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });

/** Re-record a run yue2 finished but SongForge never finalised. 409 explains why not. */
export const resumeJob = (id: string) =>
  request<Job>(`/api/jobs/${encodeURIComponent(id)}/resume`, { method: "POST" });

// ---------------------------------------------------------------------- files

export function downloadUrl(projectId: string, key: DownloadKey, version?: number) {
  return `/api/projects/${encodeURIComponent(projectId)}/download/${key}${query({ version })}`;
}

export function streamUrl(projectId: string, version?: number) {
  return `/api/projects/${encodeURIComponent(projectId)}/stream${query({ version })}`;
}

export function exportZipUrl(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/export.zip`;
}

/** One archive, a folder per project. */
export function bulkExportZipUrl(projectIds: string[]) {
  const search = new URLSearchParams();
  for (const id of projectIds) search.append("ids", id);
  return `/api/projects/bulk/export.zip?${search.toString()}`;
}

export const getWaveform = (projectId: string, version?: number) =>
  request<Waveform>(downloadUrl(projectId, "waveform", version));

// ------------------------------------------------------------------- streaming

export function jobEventsUrl(jobId: string) {
  return `/api/jobs/${encodeURIComponent(jobId)}/events`;
}

export function allEventsUrl() {
  return "/api/jobs/stream/all";
}

// --------------------------------------------------------------------- lyrics

export const getLyricsStatus = () => request<LyricsStatus>("/api/lyrics/status");

/** Load the model while the user is still typing. Best-effort; never throws. */
export const warmUpLyrics = () =>
  request<{ loaded: boolean; seconds?: number; reason?: string }>("/api/lyrics/warmup", {
    method: "POST",
  }).catch(() => ({ loaded: false }));

export const unloadLyrics = () =>
  request<{ unloaded: boolean }>("/api/lyrics/unload", { method: "POST" });

export interface LyricsStreamHandlers {
  onStatus?: (phase: string, message: string) => void;
  onToken?: (text: string) => void;
}

/**
 * Write lyrics, streaming text as the model produces it.
 *
 * EventSource only does GET, so this reads the POST response body as a stream
 * and splits it into Server-Sent Event frames itself. Resolves with the parsed
 * result; rejects with an ApiError carrying the server's message.
 */
export async function streamLyrics(
  payload: LyricsGenerateRequest,
  handlers: LyricsStreamHandlers = {},
  signal?: AbortSignal,
): Promise<LyricsResult> {
  let response: Response;
  try {
    response = await fetch("/api/lyrics/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw new ApiError("Stopped.", 0, cause);
    throw new ApiError("Could not reach the SongForge backend. Is it running?", 0, cause);
  }
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* plain text */
    }
    throw new ApiError(messageFrom(response.status, body), response.status, body);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: LyricsResult | null = null;

  const handleFrame = (frame: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    const parsed = JSON.parse(data.join("\n")) as Record<string, unknown>;
    if (event === "token") handlers.onToken?.(String(parsed.text ?? ""));
    else if (event === "status") handlers.onStatus?.(String(parsed.phase ?? ""), String(parsed.message ?? ""));
    else if (event === "done") result = parsed as unknown as LyricsResult;
    else if (event === "error") throw new ApiError(String(parsed.message ?? "Lyrics writing failed."), 500, parsed);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        handleFrame(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim()) handleFrame(buffer);
  } catch (cause) {
    if (signal?.aborted) throw new ApiError("Stopped.", 0, cause);
    throw cause;
  } finally {
    reader.releaseLock();
  }
  if (!result) throw new ApiError("The lyrics stream ended without a result.", 500);
  return result;
}

// ------------------------------------------------------------------- estimate

/**
 * Length and context estimate for a draft. Pure arithmetic on the backend - no
 * database, no model - so it is safe to call while the user types.
 */
export const estimate = (payload: EstimateRequest) =>
  request<Estimate>("/api/estimate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
