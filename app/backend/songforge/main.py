"""SongForge FastAPI application.

Binds to localhost by default. The frontend is what listens on the LAN; expose
this service directly only if you understand the consequences.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api import estimate, files, health, jobs, lyrics, projects, settings
from .api.deps import set_queue
from .config import get_config
from .db import init_db
from .lock import InstanceLock, InstanceLockError
from .paths import PathTraversalError
from .queue import GenerationQueue
from .runners.registry import current_runner
from .version import __version__

log = logging.getLogger("songforge")

DESCRIPTION = """
Local, LAN-only music studio for YuE2.

Generation runs through a configurable runner abstraction. The MockRunner is a
complete simulation for development; Yue2CliRunner drives the official `yue2`
command-line interface.
"""


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = get_config()
    cfg.ensure_dirs()

    lock = InstanceLock(cfg.lock_file)
    try:
        lock.acquire()
    except InstanceLockError as exc:
        log.error("%s", exc)
        raise

    init_db()
    queue = GenerationQueue(current_runner)
    set_queue(queue)
    await queue.start()
    app.state.queue = queue
    log.info("SongForge %s ready on http://%s:%s", __version__, cfg.host, cfg.port)
    try:
        yield
    finally:
        await queue.stop()
        lock.release()


def create_app() -> FastAPI:
    cfg = get_config()
    # SONGFORGE_LOG_LEVEL was documented but never applied, so "debug" did
    # nothing. Only the app's own loggers are touched: uvicorn is configured by
    # whoever starts it, and overriding the root logger would also re-level it.
    logging.getLogger("songforge").setLevel(cfg.log_level.upper())
    app = FastAPI(
        title="SongForge",
        version=__version__,
        description=DESCRIPTION,
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.cors_origins(),
        allow_origin_regex=r"http://(localhost|127\.0\.0\.1|10\.10\.5\.\d{1,3})(:\d+)?",
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    for router in (health.router, settings.router, projects.router,
                   jobs.router, files.router, lyrics.router, estimate.router):
        app.include_router(router, prefix="/api")

    @app.exception_handler(PathTraversalError)
    async def _traversal_handler(_: Request, exc: PathTraversalError) -> JSONResponse:
        # Never echo the attempted path back to the client.
        log.warning("rejected path traversal attempt: %s", exc)
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"detail": "Invalid path."},
        )

    # No blanket ValueError handler: bad input is rejected by Pydantic (422) or
    # by explicit HTTPExceptions. A ValueError reaching this far is a server
    # bug, and reporting it as a 400 with its message echoed would both hide it
    # from monitoring and leak internals such as absolute paths.

    return app


app = create_app()
