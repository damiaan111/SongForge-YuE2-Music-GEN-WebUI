"""Yue2CliRunner - drives the official ``yue2`` CLI from the yue2_infer package.

Every flag used here was read from the installed package's own argument parser,
not invented. The command is assembled as an argv list and executed without a
shell; the template only controls arguments, never the executable.

Template placeholders (documented in the Settings UI):

    {model} {vae} {device} {budget} {backend} {quantization}
    {offload_ar} {offline} {output} {id} {style} {lyrics_file}
    {abc_file} {cot} {stage} {seed} {cfg_scale}

A token whose placeholders all resolve to empty is dropped, so optional
arguments must be written as a single ``--name={placeholder}`` token.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

from ..enums import CotMode, JobStage, RunnerKind
from ..paths import safe_filename
from .base import (
    BaseRunner,
    DiagnosticResult,
    GenerationRequest,
    RunnerCapabilities,
    RunnerError,
    RunnerEvent,
    RunnerResult,
)

DEFAULT_COMMAND_TEMPLATE = (
    "generate "
    "--model={model} --vae={vae} --device={device} --budget={budget} "
    "--backend={backend} --quantization={quantization} {offload_ar} {offline} "
    "--output={output} --id={id} --style={style} --lyrics-file={lyrics_file} "
    "--abc-file={abc_file} --cot={cot} --stage={stage} --seed={seed} "
    "--cfg-scale={cfg_scale} --request={request_file} --config={config_file} {resume}"
)

# Written beside the lyrics when a request carries overrides. yue2 merges the
# --request JSON under its explicit flags, and GenerationConfig.from_dict merges
# a partial --config over its defaults, so both files hold overrides only.
SAMPLING_FILE = "sampling.json"
GENERATION_CONFIG_FILE = "generation-config.json"


# yue2 writes artifacts under <output>/<id>/ - see yue2.storage.save_artifacts.
ARTIFACT_AUDIO = "audio.flac"
ARTIFACT_SCORE = "score.abc"
ARTIFACT_RESULT = "result.json"
ARTIFACT_FAILURE = "failure.json"

# Progress arrives on stdout/stderr as free-form ASCII. Observed from a real
# run rather than guessed:
#   [YuE2] Starting Resolving model files: elapsed 0.0s
#   [YuE2] Running Verifying model files: elapsed 5.0s
#   [YuE2] Running Planning score: 498 tokens | 16.6 tokens/s | elapsed 30.0s
#   [YuE2] Running Generating song: 777 tokens | 17.2 tokens/s | elapsed 45.1s
#   [YuE2] Running Synthesizing audio: 18/32 steps (56%) | elapsed 35.1s
#   [YuE2] Starting Loading audio decoder: elapsed 0.0s
#   [YuE2] Completed Decoding audio: 4/4 chunks (100%) | elapsed 2.6s
#
# Order matters: "Planning score: 498 tokens" must reach PLANNING before the
# GENERATING pattern claims it on the word "tokens". Unmatched lines are logged
# without changing the stage.
_STAGE_PATTERNS: tuple[tuple[re.Pattern[str], JobStage], ...] = (
    (re.compile(r"(resolv|verif)\w*\s+model|weights", re.I), JobStage.LOADING_MODEL),
    (re.compile(r"\b(abc|score|plan\w*|symbolic)\b", re.I), JobStage.PLANNING),
    (re.compile(r"synthes\w*|latent|\bvae\b|decod\w*", re.I), JobStage.DECODING),
    (re.compile(r"semantic|token|generating", re.I), JobStage.GENERATING),
    (re.compile(r"writing|saving|export\w*", re.I), JobStage.EXPORTING),
)

_PROGRESS_PREFIX = "[YuE2]"

LAUNCHER = Path(__file__).with_name("yue2_launch.py")

# Pipeline order, for keeping reported progress monotonic.
_STAGE_ORDER: tuple[JobStage, ...] = (
    JobStage.QUEUED,
    JobStage.LOADING_MODEL,
    JobStage.PLANNING,
    JobStage.GENERATING,
    JobStage.DECODING,
    JobStage.EXPORTING,
    JobStage.COMPLETED,
)

# Several stages report their own completion, e.g. "18/32 steps (56%)". That is
# a per-stage figure and never an overall one, so it is surfaced as text in the
# message and deliberately not used to drive an overall progress bar.
_STAGE_PERCENT_RE = re.compile(r"\((\d{1,3})%\)")

_TOKEN_RE = re.compile(r"\{(\w+)\}")

# Settings are reachable by anyone who can reach the API, so the runner is
# constrained to the yue2 CLI. Without this the executable field plus a free-form
# template would amount to a "run any program with any arguments" endpoint.
_ALLOWED_CLI_STEMS = frozenset({"yue2", "yue2.cli"})
_ALLOWED_SUBCOMMANDS = frozenset({"generate", "doctor", "batch"})

# Every flag the installed yue2 CLI accepts, read from its own argument parser.
_ALLOWED_FLAGS = frozenset({
    "--model", "--vae", "--revision", "--vae-revision", "--device", "--budget",
    "--backend", "--quantization", "--offload-ar", "--offline", "--config",
    "--output", "--verify-hashes", "--cot", "--resume", "--quiet",
    "--no-progress", "--input", "--concurrency", "--request", "--id", "--style",
    "--lyrics", "--lyrics-file", "--abc-file", "--seed", "--cfg-scale", "--stage",
})

# Placeholders that expand to a whole flag rather than to a value.
_FLAG_PLACEHOLDERS = frozenset({"offload_ar", "offline", "resume"})

_PLACEHOLDER_NAMES = frozenset({
    "model", "vae", "device", "budget", "backend", "quantization",
    "offload_ar", "offline", "output", "id", "style", "lyrics_file",
    "abc_file", "cot", "seed", "cfg_scale", "stage", "request_file", "config_file",
    "resume",
})


# YuE2's request carries only style, lyrics, cot, seed, abc and cfg_scale
# (yue2/protocol.py SongRequest). There is no instrumental flag, no language
# field and no vocal field, so those intents have to travel inside the style
# text. Composing them here keeps the user's own style_prompt unmodified in the
# project, while runner-command.txt records exactly what the model was sent.
_INSTRUMENTAL_DIRECTIVE = "instrumental, no vocals, no singing, no lyrics"


def _read_yue2_text(path: Path) -> str:
    """Read a file yue2 wrote, whatever encoding it was written in.

    Runs started by this version use UTF-8 mode, but a run directory from
    before that (or a yue2 started by hand) holds ANSI code-page text. Failing
    to decode it used to replace yue2's real error message with a
    UnicodeDecodeError, so the one file that explains a failure was unreadable.
    """
    raw = path.read_bytes()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


def memory_budget_check(budget: float, card_gib: float) -> dict:
    """Explain the memory limit yue2 will actually apply.

    yue2 (pipeline.py) sets PyTorch's cap to min(budget - 2, card - 2) GiB.
    So a budget equal to the card is the most useful setting, and anything
    above it is harmless: comparing budget <= card failed a 12 GB card set to
    12 because the driver reports 11.99. Only a budget that leaves nothing
    after the 2 GiB reserve is an error.
    """
    cap = min(budget - 2, card_gib - 2)
    if cap <= 0:
        return {"name": "Memory budget", "ok": False,
                "detail": f"budget {budget:g} GiB leaves nothing after YuE2's 2 GiB reserve"}
    detail = f"YuE2 may use up to {cap:.2f} GiB (budget {budget:g} GiB on a {card_gib:.2f} GiB card)"
    if budget < card_gib - 0.5:
        detail += f"; raising the budget to {round(card_gib):g} would allow {card_gib - 2:.2f} GiB"
    return {"name": "Memory budget", "ok": True, "detail": detail}


def _is_network_path(value: str) -> bool:
    """A UNC path (two leading backslashes) or //host/share, which Windows executes."""
    return value.startswith("\\\\") or value.startswith("//")


def _program_resolves(program: str) -> bool:
    """True if ``program`` is an existing file, or a bare name found on PATH."""
    path = Path(program)
    if path.parent != Path(".") or path.is_absolute():
        return path.is_file()
    return shutil.which(program) is not None


def _sampling_overrides(request: GenerationRequest) -> dict:
    """The abc_sampling / semantic_sampling keys yue2's request JSON accepts."""
    extra = request.extra or {}
    return {
        key: extra[key]
        for key in ("abc_sampling", "semantic_sampling")
        if isinstance(extra.get(key), dict) and extra[key]
    }


def _config_overrides(request: GenerationRequest) -> dict:
    """Partial GenerationConfig: only ode_steps is tunable (method/context are frozen)."""
    steps = (request.extra or {}).get("ode_steps")
    return {"ode_steps": steps} if isinstance(steps, int) and steps >= 1 else {}


def compose_style(request: GenerationRequest) -> str:
    """Build the style string actually sent to yue2.

    The order is deliberate. YuE2 reads the style as comma-separated tags and
    weights earlier ones more heavily, and the developers' own examples lead
    with the language and the voice - the two choices that change the result
    most. They therefore go ahead of the user's own description rather than
    being appended to it, and the language is written as a plain tag
    ("Portuguese") rather than a sentence fragment ("sung in Portuguese"),
    which is the form the model was trained on.
    """
    parts: list[str] = []
    if request.language and request.language.strip():
        parts.append(request.language.strip())
    if request.vocal_preference and request.vocal_preference.strip():
        parts.append(request.vocal_preference.strip())
    parts.append(request.style_prompt.strip())
    if request.instrumental:
        # Last, so it is the most recent qualifier the model reads, and drop any
        # vocal description that would contradict it.
        parts = [p for p in parts if p and "vocal" not in p.casefold()]
        parts.append(_INSTRUMENTAL_DIRECTIVE)
    return ", ".join(p for p in parts if p)


class ExecutableNotAllowed(RunnerError):
    """The configured program is not the yue2 CLI."""


class TemplateNotAllowed(RunnerError):
    """The command template contains something outside the allowed grammar."""


def _validate_template(template: str) -> list[str]:
    """Return human-readable problems with a command template.

    The grammar is deliberately narrow: a subcommand, then flags. Anything else
    - bare words, bare value placeholders, redirections - is rejected, because a
    token that is not attached to a flag becomes its own argv element and can
    impersonate one.
    """
    try:
        tokens = shlex.split(template)
    except ValueError as exc:
        return [f"Command template cannot be parsed: {exc}"]
    if not tokens:
        return ["Command template is empty."]

    problems: list[str] = []
    if tokens[0] not in _ALLOWED_SUBCOMMANDS:
        problems.append(
            f"Template must start with one of: {', '.join(sorted(_ALLOWED_SUBCOMMANDS))}."
        )

    for token in tokens[1:]:
        names = _TOKEN_RE.findall(token)
        unknown = set(names) - _PLACEHOLDER_NAMES
        if unknown:
            problems.append(f"Unknown placeholder(s): {', '.join(sorted(unknown))}.")
            continue

        # A token that is exactly one flag-valued placeholder, e.g. {offline}.
        if _TOKEN_RE.fullmatch(token):
            if names[0] not in _FLAG_PLACEHOLDERS:
                problems.append(
                    f"{token} supplies a value, so it must be written as "
                    f"--flag={token} rather than on its own."
                )
            continue

        if not token.startswith("--"):
            problems.append(f"Unexpected token {token!r}; only flags are allowed.")
            continue

        flag = token.split("=", 1)[0]
        if flag not in _ALLOWED_FLAGS:
            problems.append(f"Unknown yue2 flag: {flag}")

    return problems

# Terminating the launcher alone can orphan the CUDA worker, so on Windows the
# whole process group is signalled.
_CREATE_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)


@dataclass(slots=True)
class Yue2Config:
    """Resolved runner settings. Mirrors the editable fields in AppSettings."""
    executable: str = ""
    python_executable: str = ""
    model_path: str = ""
    vae_path: str = ""
    gpu_index: int = 0
    memory_budget_gib: float = 11.0
    offload_ar: bool = True
    backend_mode: str = "torch-eager"
    quantization: str = "none"
    offline_mode: bool = True
    command_template: str = DEFAULT_COMMAND_TEMPLATE
    # Launch through yue2_launch.py so long songs use the memory-efficient
    # attention kernel. See that module for the measurements.
    memory_efficient_attention: bool = True

    @property
    def device(self) -> str:
        return f"cuda:{self.gpu_index}"


class Yue2CliRunner(BaseRunner):
    """Runs ``yue2 generate`` as a subprocess and streams its output."""

    def __init__(self, config: Yue2Config) -> None:
        self.config = config

    # --------------------------------------------------------------- caps

    @property
    def capabilities(self) -> RunnerCapabilities:
        return RunnerCapabilities(
            kind=RunnerKind.YUE2_CLI,
            display_name="YuE2-3B (yue2 CLI)",
            supports_lyrics=True,
            # Honoured by sending an empty lyric plus an instrumental directive
            # in the style text. yue2 has no instrumental flag, so this is a
            # prompt-level instruction the model usually but not always follows.
            supports_instrumental=True,
            supports_score_abc=True,
            supports_planning=True,
            supports_seed=True,
            supports_cfg_scale=True,
            # No duration argument exists; length follows the lyrics.
            supports_duration_target=False,
            supports_cancel=True,
            supports_plan_stage=True,
            # Only honoured when the template forwards both override files; a
            # hand-edited template without them would silently drop the values.
            supports_sampling_overrides=self._template_forwards_overrides(),
            # The package documents totals as often unknown, so a percentage
            # would be fabricated. Stages are real; a percentage is not.
            supports_progress_percent=False,
            emits_score=True,
            stages=(
                JobStage.LOADING_MODEL,
                JobStage.PLANNING,
                JobStage.GENERATING,
                JobStage.DECODING,
                JobStage.EXPORTING,
                JobStage.COMPLETED,
            ),
            notes=(
                "Song length is determined by the lyrics; there is no duration "
                "control. Progress is reported by stage, not percentage. "
                "Instrumental, language and vocal preference are written into "
                "the style prompt, not set as model flags, so the model follows "
                "them as guidance rather than as a guarantee."
            ),
        )

    # ------------------------------------------------------------ command

    def _interpreter_for_launcher(self) -> str | None:
        """The yue2 environment's Python: the configured interpreter, or the
        python.exe beside the configured yue2 executable (a venv's Scripts dir)."""
        python = (self.config.python_executable or "").strip()
        if python:
            return python
        exe = (self.config.executable or "").strip()
        if exe and Path(exe).parent != Path("."):
            for name in ("python.exe", "python"):
                sibling = Path(exe).with_name(name)
                if sibling.is_file():
                    return str(sibling)
        return None

    def _executable(self) -> list[str]:
        """Return the argv prefix that invokes the CLI.

        The program is constrained to the yue2 CLI itself, or a Python
        interpreter running ``-m yue2.cli``. Settings are reachable by anyone on
        the LAN, so an unconstrained executable field would turn this into a
        general "run any program" API. Raises ExecutableNotAllowed otherwise.
        """
        exe = (self.config.executable or "").strip()
        python_setting = (self.config.python_executable or "").strip()
        for label, value in (("yue2 command", exe), ("Python interpreter", python_setting)):
            if _is_network_path(value):
                # Settings are unauthenticated and reachable from the LAN; a UNC
                # path named yue2.exe or python.exe would run someone else's
                # program from their share.
                raise ExecutableNotAllowed(
                    f"The {label} must be on this computer, not a network path ({value!r})."
                )
        if exe and Path(exe).stem.casefold() not in _ALLOWED_CLI_STEMS:
            raise ExecutableNotAllowed(
                f"The runner executable must be the yue2 CLI, not {Path(exe).name!r}. "
                "Clear the field to run it through the configured Python interpreter."
            )

        if self.config.memory_efficient_attention:
            # The launcher path is fixed by SongForge, never taken from
            # settings, so this adds no way to run an arbitrary program.
            python = self._interpreter_for_launcher()
            if python is None:
                raise ExecutableNotAllowed(
                    "Memory-efficient attention runs yue2 through its Python "
                    "interpreter. Set the Python interpreter, or give the yue2 "
                    "command as a full path inside its environment."
                )
            if not Path(python).stem.casefold().startswith("python"):
                raise ExecutableNotAllowed(
                    f"The Python interpreter must be a python executable, not {Path(python).name!r}."
                )
            return [python, str(LAUNCHER)]

        exe = (self.config.executable or "").strip()
        if exe:
            stem = Path(exe).stem.casefold()
            if stem not in _ALLOWED_CLI_STEMS:
                raise ExecutableNotAllowed(
                    f"The runner executable must be the yue2 CLI, not {Path(exe).name!r}. "
                    "Clear the field to run it through the configured Python interpreter."
                )
            return [exe]

        python = (self.config.python_executable or "").strip() or sys.executable
        stem = Path(python).stem.casefold()
        if not stem.startswith("python"):
            raise ExecutableNotAllowed(
                f"The Python interpreter must be a python executable, not {Path(python).name!r}."
            )
        return [python, "-m", "yue2.cli"]

    def _placeholders(self, request: GenerationRequest, output_dir: Path) -> dict[str, str]:
        cfg = self.config
        seed = "" if request.seed is None else str(request.seed)
        cfg_scale = "" if request.cfg_scale is None else str(request.cfg_scale)
        return {
            "model": cfg.model_path,
            "vae": cfg.vae_path or "standard",
            "device": cfg.device,
            "budget": f"{cfg.memory_budget_gib:g}",
            "backend": cfg.backend_mode,
            "quantization": cfg.quantization,
            "offload_ar": "--offload-ar" if cfg.offload_ar else "",
            "offline": "--offline" if cfg.offline_mode else "",
            "output": str(output_dir),
            "id": self.run_id(request),
            "style": compose_style(request),
            # An instrumental request deliberately sends an empty lyric file:
            # yue2 accepts "" (only None is refused, protocol.SongRequest only
            # type-checks), and the instrumental intent rides in the style text.
            "lyrics_file": (
                str(output_dir / "lyrics.txt")
                if (request.lyrics.strip() or request.instrumental)
                else ""
            ),
            "abc_file": str(output_dir / "score.abc") if request.score_abc else "",
            "cot": str(request.cot),
            "stage": request.stage,
            "seed": seed,
            "cfg_scale": cfg_scale,
            "request_file": (
                str(output_dir / SAMPLING_FILE) if _sampling_overrides(request) else ""
            ),
            "config_file": (
                str(output_dir / GENERATION_CONFIG_FILE)
                if _config_overrides(request) else ""
            ),
            "resume": "--resume" if (request.extra or {}).get("resume") else "",
        }

    def can_resume(self, request: GenerationRequest, output_dir: Path) -> str | None:
        """Why this run cannot be resumed, or None if it can.

        yue2's --resume only re-verifies a run that already wrote result.json
        (cli.generate): a partially written run directory is refused as
        "Nonempty output". So resume rescues exactly one case - yue2 finished,
        but SongForge stopped before recording it.
        """
        template = self.config.command_template or DEFAULT_COMMAND_TEMPLATE
        if "{resume}" not in template:
            return "The command template has no {resume} placeholder. Reset it in Settings."
        if request.stage == "plan":
            return "A score-only run writes no result.json, so yue2 cannot resume it. Use Retry."
        run_dir = output_dir / "runs" / self.run_id(request)
        if not (run_dir / ARTIFACT_RESULT).is_file():
            return (
                "YuE2 did not finish this run, and it cannot continue a partial one. "
                "Use Retry to render it again."
            )
        if not (run_dir / ARTIFACT_AUDIO).is_file():
            return "The finished run's audio is no longer on disk. Use Retry."
        return None

    def _template_forwards_overrides(self) -> bool:
        template = self.config.command_template or DEFAULT_COMMAND_TEMPLATE
        return "{request_file}" in template and "{config_file}" in template

    @staticmethod
    def run_id(request: GenerationRequest) -> str:
        """Subdirectory name yue2 writes into. Derived, never user text."""
        return safe_filename(f"v{request.version_number}", fallback="version")

    def build_command(self, request: GenerationRequest, output_dir: Path) -> list[str]:
        """Expand the template into argv.

        Each template token must be a yue2 subcommand, a known bare flag, or a
        ``--flag={placeholder}`` pair. Requiring the flag form is what keeps a
        value such as a style prompt reading ``--model=...`` inside its own argv
        element instead of becoming a separate argument.
        """
        template = self.config.command_template or DEFAULT_COMMAND_TEMPLATE
        problems = _validate_template(template)
        if problems:
            raise TemplateNotAllowed("; ".join(problems))

        values = self._placeholders(request, output_dir)
        argv = list(self._executable())
        for token in shlex.split(template):
            names = _TOKEN_RE.findall(token)
            if names and all(not values.get(name, "") for name in names):
                continue  # optional argument with nothing to supply
            argv.append(_TOKEN_RE.sub(lambda m: values.get(m.group(1), ""), token))
        return argv

    def template_issues(self) -> list[str]:
        """Human-readable problems with the current configuration.

        Surfaced in Settings so an incomplete template is flagged before use.
        """
        issues: list[str] = []
        cfg = self.config
        if not cfg.model_path:
            issues.append("No model path is configured.")
        elif not Path(cfg.model_path).exists():
            issues.append(f"Model path does not exist: {cfg.model_path}")
        if cfg.vae_path and cfg.vae_path not in ("standard", "legacy") and not Path(cfg.vae_path).exists():
            issues.append(f"VAE path does not exist: {cfg.vae_path}")
        if not cfg.executable and not cfg.python_executable:
            issues.append("No yue2 executable or Python interpreter is configured.")

        # The program must be the yue2 CLI; report it here rather than only
        # failing at generation time.
        try:
            program = self._executable()[0]
        except ExecutableNotAllowed as exc:
            issues.append(str(exc))
        else:
            # A name the backend cannot start is not "ready", however valid the
            # text looks. The yue2 field wins whenever it is filled in, so a bare
            # "yue2" that is not on PATH silently shadowed a working interpreter.
            if not _program_resolves(program):
                field = "yue2 command" if (cfg.executable or "").strip() else "Python interpreter"
                issues.append(
                    f"The {field} {program!r} cannot be found. Use its full path"
                    + (
                        ", or clear the yue2 command to run through the Python interpreter."
                        if field == "yue2 command" else "."
                    )
                )

        template = cfg.command_template or DEFAULT_COMMAND_TEMPLATE
        issues.extend(_validate_template(template))
        for required in ("{model}", "{output}"):
            if required not in template:
                issues.append(f"Template is missing the {required} placeholder.")

        if cfg.quantization == "fp8":
            issues.append(
                "fp8 quantization requires compute capability 8.9 or newer "
                "(Ada, Hopper and later). Older cards cannot use it."
            )
        return issues

    # ---------------------------------------------------------- diagnose

    async def diagnose(self) -> DiagnosticResult:
        """Run ``yue2 doctor`` - it loads no weights and generates no audio."""
        checks: list[dict] = [
            {"name": "Configuration", "ok": not self.template_issues(),
             "detail": "; ".join(self.template_issues()) or "complete"}
        ]
        # Diagnostics are exactly where a bad configuration should be explained,
        # so a disallowed executable must produce a report, never a 500.
        try:
            prefix = self._executable()
        except ExecutableNotAllowed as exc:
            checks.append({"name": "Executable", "ok": False, "detail": str(exc)})
            return DiagnosticResult(
                ok=False, summary=str(exc), command="", checks=checks,
            )

        argv = [
            *prefix, "doctor",
            f"--model={self.config.model_path}",
            f"--vae={self.config.vae_path or 'standard'}",
            # Reads the weight checksums, which the report below surfaces.
            "--verify-hashes",
        ]
        if self.config.offline_mode:
            argv.append("--offline")
        command = shlex.join(argv)

        if not self.config.model_path:
            return DiagnosticResult(
                ok=False,
                summary="Cannot run diagnostics: no model path is configured.",
                command=command, checks=checks,
            )

        try:
            proc = await asyncio.create_subprocess_exec(
                *argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=self._environment(),
            )
            raw_out, raw_err = await asyncio.wait_for(proc.communicate(), timeout=300)
        except FileNotFoundError:
            return DiagnosticResult(
                ok=False, summary=f"Executable not found: {argv[0]}",
                command=command, checks=checks,
            )
        except asyncio.TimeoutError:
            return DiagnosticResult(
                ok=False, summary="Diagnostics timed out after 5 minutes.",
                command=command, checks=checks,
            )

        stdout = raw_out.decode("utf-8", "replace")
        stderr = raw_err.decode("utf-8", "replace")
        checks.extend(self._parse_doctor(stdout))
        ok = proc.returncode == 0 and all(c["ok"] for c in checks)
        summary = (
            "Runner is ready." if ok
            else "Diagnostics reported problems; see the checks below."
        )
        return DiagnosticResult(
            ok=ok, summary=summary, command=command, exit_code=proc.returncode,
            stdout=stdout[-8000:], stderr=stderr[-8000:], checks=checks,
        )

    def _parse_doctor(self, stdout: str) -> list[dict]:
        """Turn the doctor JSON report into displayable checks."""
        try:
            report = json.loads(stdout[stdout.index("{"):stdout.rindex("}") + 1])
        except (ValueError, json.JSONDecodeError):
            return [{"name": "Doctor report", "ok": False,
                     "detail": "Could not parse the doctor output as JSON."}]

        checks: list[dict] = []
        versions = report.get("versions") or {}
        missing = [name for name, ver in versions.items() if not ver]
        checks.append({
            "name": "Python dependencies",
            "ok": bool(report.get("dependencies_ready")),
            "detail": f"missing: {', '.join(missing)}" if missing else
                      ", ".join(f"{k} {v}" for k, v in versions.items()),
        })

        devices = report.get("cuda") or []
        if devices:
            index = self.config.gpu_index
            device = next((d for d in devices if d.get("id") == index), devices[0])
            memory = float(device.get("memory_gib") or 0.0)
            cap = device.get("compute_capability") or [0, 0]
            checks.append({
                "name": f"GPU {device.get('id')}",
                "ok": True,
                "detail": f"{device.get('name')} - {memory:.2f} GiB, "
                          f"compute {cap[0]}.{cap[1]}",
            })
            checks.append(memory_budget_check(self.config.memory_budget_gib, memory))
        else:
            checks.append({"name": "GPU", "ok": False,
                           "detail": "No CUDA device was reported by torch."})

        weights = report.get("weights")
        if weights:
            checks.append({"name": "Weight hashes", "ok": True,
                           "detail": "model and VAE checksums read successfully"})
        return checks

    # ---------------------------------------------------------- generate

    def _environment(self) -> dict[str, str]:
        env = dict(os.environ)
        # CUDA_VISIBLE_DEVICES is deliberately NOT set: masking renumbers the
        # chosen GPU to ordinal 0 inside the child, which would contradict the
        # --device=cuda:<index> argument and break every non-zero gpu_index.
        env.pop("CUDA_VISIBLE_DEVICES", None)
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        # UTF-8 mode, not just UTF-8 stdio. yue2 writes its JSON with a bare
        # Path.write_text(), which on Windows uses the ANSI code page (cp1252):
        # a curly apostrophe in the lyrics became byte 0x92, and any character
        # cp1252 lacks - Chinese, Japanese, emoji - made yue2 crash while saving
        # a song it had already generated. Verified against yue2 0.1.5.
        env["PYTHONUTF8"] = "1"
        # Progress prints one line per five seconds when not a TTY, which is
        # what we want from a pipe.
        env.pop("COLUMNS", None)
        if self.config.offline_mode:
            env["HF_HUB_OFFLINE"] = "1"
        return env

    async def generate(
        self, request: GenerationRequest, output_dir: Path
    ) -> AsyncIterator[RunnerEvent | RunnerResult]:
        issues = self.template_issues()
        if issues:
            raise RunnerError("Runner is not configured: " + "; ".join(issues))

        output_dir.mkdir(parents=True, exist_ok=True)
        # yue2 takes --output as a parent and writes into <output>/<id>, which it
        # requires to be absent or empty. So the CLI gets its own subdirectory and
        # the input files sit beside it, in the same directory that
        # ``_placeholders`` derives {lyrics_file} and {abc_file} from.
        run_root = output_dir / "runs"
        run_root.mkdir(parents=True, exist_ok=True)
        if request.lyrics.strip() or request.instrumental:
            # Empty is deliberate for an instrumental request; yue2 accepts "".
            (run_root / "lyrics.txt").write_text(request.lyrics, encoding="utf-8")
        if request.score_abc:
            (run_root / "score.abc").write_text(request.score_abc, encoding="utf-8")
        if sampling := _sampling_overrides(request):
            (run_root / SAMPLING_FILE).write_text(json.dumps(sampling, indent=2), encoding="utf-8")
        if config := _config_overrides(request):
            (run_root / GENERATION_CONFIG_FILE).write_text(
                json.dumps(config, indent=2), encoding="utf-8"
            )

        argv = self.build_command(request, run_root)
        command = shlex.join(argv)

        yield RunnerEvent(
            stage=JobStage.LOADING_MODEL,
            message="Starting YuE2",
            log_line=f"$ {command}",
        )

        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=self._environment(),
                creationflags=_CREATE_GROUP,
            )
        except FileNotFoundError as exc:
            raise RunnerError(f"Executable not found: {argv[0]}") from exc

        stage = JobStage.LOADING_MODEL
        tail: list[str] = []
        try:
            assert proc.stdout is not None
            async for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if not line.strip():
                    continue
                tail.append(line)
                del tail[:-400]
                stage = self.advance_stage(stage, line)
                yield RunnerEvent(stage=stage, message=line[:200], log_line=line)
            code = await proc.wait()
        except asyncio.CancelledError:
            await self._terminate(proc)
            raise
        except BaseException:
            await self._terminate(proc)
            raise

        run_dir = run_root / self.run_id(request)
        if code != 0:
            raise RunnerError(
                self._failure_reason(run_dir, tail, code), exit_code=code
            )

        plan_only = request.stage == "plan"
        audio = run_dir / ARTIFACT_AUDIO
        if not plan_only and not audio.is_file():
            raise RunnerError(
                f"yue2 exited cleanly but no {ARTIFACT_AUDIO} was produced in {run_dir}.",
                exit_code=code,
            )
        if plan_only and not (run_dir / ARTIFACT_SCORE).is_file():
            raise RunnerError(
                f"yue2 exited cleanly but no {ARTIFACT_SCORE} was produced in {run_dir}.",
                exit_code=code,
            )

        score_path = run_dir / ARTIFACT_SCORE
        score = _read_yue2_text(score_path) if score_path.is_file() else None
        receipt = self._read_result(run_dir)

        yield RunnerEvent(stage=JobStage.COMPLETED, message="Generation complete",
                          log_line=f"[completed] exit code {code}")
        yield RunnerResult(
            flac_path=None if plan_only else audio,
            plan_only=plan_only,
            score_abc=score,
            duration_seconds=receipt["duration"],
            sample_rate=receipt["sample_rate"],
            seed=request.seed,
            exit_code=code,
            command=command,
            truncated=receipt["truncated"],
            identity=receipt["identity"],
            weights=receipt["weights"],
            timing=receipt["timing"],
            artifacts={
                key: run_dir / f"{key}.json"
                for key in ("request", "result", "config", "plan")
                if (run_dir / f"{key}.json").is_file()
            },
        )

    @classmethod
    def advance_stage(cls, current: JobStage, line: str) -> JobStage:
        """The stage after reading ``line``. Progress only ever moves forward.

        yue2's final summary is a JSON line ('{"status": "complete", ...,
        "truncated": {"abc": ...}}') whose "abc" once dragged a finished run
        back to Planning in the UI.
        """
        matched = cls._match_stage(line)
        if matched is not None and _STAGE_ORDER.index(matched) > _STAGE_ORDER.index(current):
            return matched
        return current

    @staticmethod
    def _match_stage(line: str) -> JobStage | None:
        # Only yue2's own progress lines name a stage. Anything else - the JSON
        # summary, a Python warning, a traceback - is logged but never parsed.
        if not line.lstrip().startswith(_PROGRESS_PREFIX):
            return None
        for pattern, stage in _STAGE_PATTERNS:
            if pattern.search(line):
                return stage
        return None

    @staticmethod
    def _read_result(run_dir: Path) -> dict:
        """Parse yue2's result.json.

        Key names verified against a real run: the file carries audio_seconds,
        sample_rate, truncated, identity, weights and timing at the top level.
        """
        empty: dict = {
            "duration": None, "sample_rate": None,
            "truncated": None, "identity": None, "weights": None, "timing": None,
        }
        path = run_dir / ARTIFACT_RESULT
        if not path.is_file():
            return Yue2CliRunner._read_plan_receipt(run_dir, empty)
        try:
            data = json.loads(_read_yue2_text(path))
        except (OSError, json.JSONDecodeError):
            return empty

        duration = data.get("audio_seconds")
        rate = data.get("sample_rate")
        return {
            "duration": float(duration) if isinstance(duration, (int, float)) else None,
            "sample_rate": int(rate) if isinstance(rate, int) else None,
            "truncated": data.get("truncated") if isinstance(data.get("truncated"), dict) else None,
            "identity": data.get("identity") if isinstance(data.get("identity"), str) else None,
            "weights": data.get("weights") if isinstance(data.get("weights"), dict) else None,
            "timing": data.get("timing") if isinstance(data.get("timing"), dict) else None,
        }

    @staticmethod
    def _read_plan_receipt(run_dir: Path, empty: dict) -> dict:
        """A plan-stage run writes no result.json, only plan.json.

        Verified against a real run: plan.json carries ``truncated`` as a bare
        bool (it only covers the score stage) and a ``timing`` dict. It is
        normalised to the result.json shape so a plan that hit the ABC token
        ceiling is reported like any other truncation.
        """
        path = run_dir / "plan.json"
        if not path.is_file():
            return empty
        try:
            data = json.loads(_read_yue2_text(path))
        except (OSError, json.JSONDecodeError):
            return empty
        truncated = data.get("truncated")
        timing = data.get("timing")
        return {
            **empty,
            "truncated": {"abc": truncated} if isinstance(truncated, bool) else None,
            "timing": timing if isinstance(timing, dict) else None,
        }

    @staticmethod
    def _failure_reason(run_dir: Path, tail: list[str], code: int) -> str:
        """Prefer the CLI's own failure.json over guessing from the log tail."""
        path = run_dir / ARTIFACT_FAILURE
        if path.is_file():
            try:
                data = json.loads(_read_yue2_text(path))
                kind = data.get("type", "Error")
                reason = data.get("reason", "")
                if "OutOfMemory" in kind or "out of memory" in reason.lower():
                    # yue2 caps PyTorch at (budget - 2 GiB), bounded by the card
                    # (pipeline.py set_per_process_memory_fraction). So a larger
                    # budget is what helps; a smaller one only lowers the cap.
                    return (
                        f"{kind}: the song needed more GPU memory than YuE2 allows. "
                        "YuE2 caps itself at the memory budget minus 2 GiB, so raise the "
                        "budget in Settings up to your card's size, leaving a gigabyte spare. "
                        "Longer scores need more memory: an instrumental with no lyrics "
                        "tends to plan a very long piece, so lowering Score sampling max "
                        f"tokens also helps. ({reason})"
                    )
                lowered = reason.lower()
                if "exceeds" in lowered and any(
                    word in lowered for word in ("context", "24576", "kv capacity", "budget")
                ):
                    return (
                        f"{kind}: this song is too long for YuE2's 24,576-token context. "
                        "The lyrics, any supplied score and the audio token limit must "
                        "fit together: shorten the lyrics, or lower the audio max tokens "
                        f"under Sampling and synthesis. ({reason})"
                    )
                return f"{kind}: {reason}"
            except Exception:  # noqa: BLE001
                # Whatever is wrong with the report, fall back to the log tail
                # rather than replacing the real failure with a parsing error.
                pass
        snippet = "\n".join(tail[-15:]) or "no output captured"
        return f"yue2 exited with code {code}.\n{snippet}"

    @staticmethod
    async def _terminate(proc: asyncio.subprocess.Process) -> None:
        """Stop the process group, escalating to kill if it does not exit."""
        if proc.returncode is not None:
            return
        try:
            if _CREATE_GROUP:
                proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                proc.terminate()
        except (ProcessLookupError, OSError, ValueError):
            pass
        # This runs from an `except CancelledError` handler, where any bare await
        # is cancelled immediately. Shielding gives the process a real chance to
        # exit on its own before it is killed.
        try:
            await asyncio.wait_for(asyncio.shield(_reap(proc)), timeout=15)
            return
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
        try:
            proc.kill()
        except (ProcessLookupError, OSError):
            pass
        # Reap so the child does not linger as a zombie.
        with contextlib.suppress(Exception):
            await asyncio.wait_for(asyncio.shield(_reap(proc)), timeout=5)


async def _reap(proc: asyncio.subprocess.Process) -> int:
    """Await a process's exit as its own task, so a shield can protect it."""
    return await proc.wait()
