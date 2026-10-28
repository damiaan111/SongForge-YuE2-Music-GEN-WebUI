"""Process-level configuration.

Values here are set at startup (env / .env) and are NOT user-editable at runtime.
Runtime-editable preferences live in the database - see ``models.AppSettings``.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# .../app/backend/songforge/config.py -> project root is four levels up.
PROJECT_ROOT = Path(__file__).resolve().parents[3]


class Config(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SONGFORGE_",
        env_file=(PROJECT_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- networking -------------------------------------------------------
    host: str = "127.0.0.1"
    port: int = 3334
    frontend_origin: str = "http://localhost:3333"
    # Extra LAN origins permitted by CORS, comma-separated in env.
    allowed_origins: str = ""

    # --- local lyrics model (Ollama) ---------------------------------------
    # Process-level on purpose: Settings is unauthenticated and LAN-reachable,
    # so an editable URL would let anyone point the backend at arbitrary hosts.
    # Only loopback addresses are accepted.
    ollama_url: str = "http://127.0.0.1:11434"

    # --- storage ----------------------------------------------------------
    runtime_dir: Path = PROJECT_ROOT / "runtime"

    # --- behaviour --------------------------------------------------------
    # One GPU cannot serve two renders, so concurrency is not configurable: the
    # queue runs a single job and the setting that said so was never read.
    log_level: str = "info"

    @field_validator("ollama_url", mode="after")
    @classmethod
    def _loopback_only(cls, value: str) -> str:
        from urllib.parse import urlparse

        parsed = urlparse(value)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("SONGFORGE_OLLAMA_URL must be http:// on this computer (127.0.0.1).")
        return value.rstrip("/")

    @field_validator("runtime_dir", mode="after")
    @classmethod
    def _absolute(cls, value: Path) -> Path:
        return value if value.is_absolute() else (PROJECT_ROOT / value).resolve()

    # --- derived paths ----------------------------------------------------
    @property
    def projects_dir(self) -> Path:
        return self.runtime_dir / "projects"

    @property
    def models_dir(self) -> Path:
        return self.runtime_dir / "models"

    @property
    def database_dir(self) -> Path:
        return self.runtime_dir / "database"

    @property
    def logs_dir(self) -> Path:
        return self.runtime_dir / "logs"

    @property
    def database_url(self) -> str:
        return f"sqlite:///{(self.database_dir / 'songforge.db').as_posix()}"

    @property
    def lock_file(self) -> Path:
        return self.runtime_dir / "songforge.lock"

    def cors_origins(self) -> list[str]:
        origins = {self.frontend_origin}
        origins.update(o.strip() for o in self.allowed_origins.split(",") if o.strip())
        return sorted(origins)

    def ensure_dirs(self) -> None:
        for path in (
            self.runtime_dir, self.projects_dir, self.models_dir,
            self.database_dir, self.logs_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_config() -> Config:
    return Config()
