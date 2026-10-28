/**
 * Frontend smoke test.
 *
 * Serves a stub API, starts the production build against it, and asks for every
 * route. The point is not to test behaviour - that is what the backend suite and
 * the browser are for - but to catch the class of failure a typecheck cannot:
 * a page that throws while rendering on the server, a bad import, or a broken
 * /api rewrite. Any of those return 500 instead of HTML.
 *
 * No test framework and no network access: run `npm run build` first, then
 * `npm run smoke`.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const STARTUP_TIMEOUT_MS = 90_000;

/** Minimal, valid-shaped responses - enough for the pages to render. */
const CAPABILITIES = {
  kind: "mock",
  display_name: "Mock runner",
  supports_lyrics: true,
  supports_instrumental: true,
  supports_score_abc: true,
  supports_planning: true,
  supports_seed: true,
  supports_cfg_scale: true,
  supports_duration_target: false,
  supports_cancel: true,
  supports_plan_stage: true,
  supports_progress_percent: true,
  emits_score: true,
  stages: ["queued", "loading_model", "planning", "generating", "decoding", "exporting", "completed"],
  notes: "Smoke-test stub.",
};

const STUB_ROUTES = {
  "/api/health": {
    status: "ok",
    version: "smoke",
    database: true,
    runner_kind: "mock",
    runner_ready: true,
    ffmpeg: false,
    active_job_id: null,
    queued_jobs: 0,
    projects: 0,
  },
  "/api/settings": {
    runner_kind: "mock",
    python_executable: "",
    yue2_executable: "",
    model_path: "",
    vae_path: "standard",
    gpu_index: 0,
    memory_budget_gib: 11,
    offload_ar: false,
    backend_mode: "torch-eager",
    quantization: "none",
    offline_mode: false,
    command_template: "generate --model={model}",
    default_cot: "full",
    default_cfg_scale: 1,
    export_mp3: false,
    export_wav: false,
    mp3_bitrate: 320,
    theme: "dark",
    default_style_prompt: "",
    default_language: "English",
    wizard_completed: true,
    capabilities: CAPABILITIES,
    command_preview: ["yue2", "generate"],
    configuration_issues: [],
    default_command_template: "generate --model={model}",
    projects_dir: "C:\\smoke\\projects",
    models_dir: "C:\\smoke\\models",
    ffmpeg_available: false,
  },
  "/api/lyrics/status": {
    enabled: true, ollama_running: false, ollama_version: null, model: "gemma4:12b",
    model_installed: false, installed_models: [], loaded: false, loaded_vram_bytes: 0,
    gpu_busy: false, writing: false,
  },
  "/api/projects": [],
  "/api/jobs": [],
  // The Create page asks for this as soon as it has a draft; the budget meter
  // renders from whatever comes back.
  "/api/estimate": {
    seconds: 180,
    max_seconds: 360,
    music_tokens: 4500,
    music_cap: 9000,
    prompt_tokens: 320,
    plan_tokens: 4096,
    context_tokens: 13416,
    context_total: 24576,
    verdict: "ok",
    headline: "About 3:00 of song",
    detail: "Comfortably inside YuE2's 6:00 ceiling.",
    advice: "",
  },
};

/**
 * Where this build proxies /api.
 *
 * Turbopack bakes the rewrite destination into routes-manifest.json at build
 * time, so SONGFORGE_API_URL cannot be redirected by `next start`. Rather than
 * pretend otherwise, the stub binds to whatever port the build actually points
 * at - which also means this test exercises the real rewrite.
 */
function proxyTargetPort() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ROOT, ".next", "routes-manifest.json"), "utf8"),
    );
    const rewrites = manifest.rewrites?.afterFiles ?? manifest.rewrites ?? [];
    const entry = (Array.isArray(rewrites) ? rewrites : []).find((row) =>
      String(row.source).startsWith("/api"),
    );
    if (!entry) return null;
    return Number(new URL(String(entry.destination)).port) || null;
  } catch {
    return null;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** True if something already accepts connections on the port. */
function portAnswers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

async function startStubApi(requestedPort) {
  // Windows lets a second listener bind a port another process already holds,
  // so a successful bind proves nothing. Ask whether anyone answers instead.
  const preferredPort =
    requestedPort != null && !(await portAnswers(requestedPort)) ? requestedPort : null;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const body = STUB_ROUTES[url.pathname];
    if (body === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "Not found in the smoke stub." }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.once("error", () => {
      // The port the build points at is already taken - most likely by the
      // real backend. Fall back to a free one and skip the proxy assertion.
      server.listen(0, "127.0.0.1", () =>
        resolve({ server, port: server.address().port, onProxyPort: false }),
      );
    });
    server.listen(preferredPort ?? 0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port, onProxyPort: preferredPort != null }),
    );
  });
}

async function waitForServer(url, deadline) {
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (response.status < 500) return;
      lastError = `status ${response.status}`;
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Server did not come up in time (last error: ${lastError}).`);
}

function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    // next start spawns a worker; killing only the parent leaves the port held.
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  const mark = ok ? "\u001b[32mPASS\u001b[0m" : "\u001b[31mFAIL\u001b[0m";
  console.log(`  ${mark}  ${name}${detail && !ok ? ` - ${detail}` : ""}`);
}

async function main() {
  console.log("\nSongForge frontend smoke test\n");

  const target = proxyTargetPort();
  const { server: stub, port: apiPort, onProxyPort } = await startStubApi(target);
  if (!onProxyPort) {
    console.log(`  NOTE  port ${target} is in use, so the /api proxy check is skipped.`);
    console.log("        Stop the backend and re-run to include it.");
    console.log("");
  }
  const appPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`;

  let next;
  try {
    next = spawn(
      process.execPath,
      [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(appPort)],
      {
        cwd: ROOT,
        env: { ...process.env, SONGFORGE_API_URL: `http://127.0.0.1:${apiPort}`, NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let serverLog = "";
    next.stdout.on("data", (chunk) => { serverLog += chunk; });
    next.stderr.on("data", (chunk) => { serverLog += chunk; });
    next.on("exit", (code) => {
      if (code) console.error(`\nnext start exited with code ${code}:\n${serverLog}`);
    });

    try {
      await waitForServer(`${base}/`, Date.now() + STARTUP_TIMEOUT_MS);
    } catch (cause) {
      throw new Error(
        `${cause.message}\n\nServer output:\n${serverLog}\n` +
          "Did you run `npm run build` first?",
      );
    }

    // The rewrite is what makes the LAN-only architecture work: the browser
    // never talks to the API directly.
    if (onProxyPort) {
      const proxied = await fetch(`${base}/api/health`);
      const health = await proxied.json();
      check(
        "/api proxies to the backend",
        proxied.status === 200 && health.version === "smoke",
        `status ${proxied.status}`,
      );
    }

    const pages = [
      ["/", "Library"],
      ["/create", "Create"],
      ["/settings", "Settings"],
      ["/lyrics", "Lyrics"],
      ["/learn", "Learn"],
      ["/learn/style", "Learn: style tags"],
      ["/learn/lyrics", "Learn: lyrics"],
      ["/learn/length", "Learn: length"],
      ["/song/00000000-0000-0000-0000-000000000000", "Song workspace"],
    ];

    for (const [route, label] of pages) {
      let status = 0;
      let html = "";
      try {
        const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(30_000) });
        status = response.status;
        html = await response.text();
      } catch (cause) {
        check(`${label} (${route}) renders`, false, cause.message);
        continue;
      }
      check(`${label} (${route}) renders`, status === 200, `status ${status}`);
      check(`${label} (${route}) includes the app shell`,
        html.includes("Skip to content") && html.includes("SongForge"),
        "shell markup missing - the layout did not render");
      check(`${label} (${route}) reports no React error`,
        !html.includes("Application error") && !html.includes("__next_error__"),
        "the page rendered an error boundary");
    }

    const missing = await fetch(`${base}/no-such-route`, { signal: AbortSignal.timeout(15_000) });
    check("unknown route returns 404", missing.status === 404, `status ${missing.status}`);
  } finally {
    stop(next);
    stub.close();
  }

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((cause) => {
  console.error(`\nSmoke test could not run: ${cause.message}\n`);
  process.exit(2);
});
