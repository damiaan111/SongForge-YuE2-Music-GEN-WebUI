"""Database engine and session management."""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import logging

from sqlalchemy import event, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from . import hardware_profile
from .config import get_config
from .enums import JobStatus
from .models import AppSettings, Job

log = logging.getLogger("songforge.db")

_engine: Engine | None = None


def _configure_sqlite(dbapi_conn, _record) -> None:
    cur = dbapi_conn.cursor()
    # WAL keeps the SSE readers from blocking the queue worker's writes.
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.close()


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        cfg = get_config()
        cfg.ensure_dirs()
        _engine = create_engine(
            cfg.database_url,
            echo=False,
            connect_args={"check_same_thread": False},
        )
        event.listen(_engine, "connect", _configure_sqlite)
    return _engine


def create_test_engine() -> Engine:
    """In-memory engine shared across sessions, for tests."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def init_db() -> None:
    engine = get_engine()
    SQLModel.metadata.create_all(engine)
    add_missing_columns(engine)
    drop_removed_columns(engine)
    with Session(engine) as session:
        _ensure_settings_row(session)
        _mark_interrupted(session)
        session.commit()


def _column_default_sql(column) -> str | None:
    """A SQL literal for a new column's default, or None if it has none."""
    default = column.default
    if default is not None and not callable(getattr(default, "arg", None)):
        value = default.arg
        if isinstance(value, bool):
            return "1" if value else "0"
        if isinstance(value, (int, float)):
            return str(value)
        if isinstance(value, str):
            return "'" + value.replace("'", "''") + "'"
        if hasattr(value, "value"):  # enum member
            return "'" + str(value.value).replace("'", "''") + "'"
    # default_factory columns (dict/list JSON, uuids, timestamps): pick the
    # empty value of the storage type so NOT NULL can still be satisfied.
    type_name = column.type.__class__.__name__.upper()
    if "JSON" in type_name:
        return "'{}'"
    if column.nullable:
        return None
    if any(word in type_name for word in ("INT", "BOOL", "FLOAT", "NUMERIC")):
        return "0"
    return "''"


# Columns removed from the models that must also go from existing databases.
# create_all() wrote them as NOT NULL without a SQL default, so leaving one in
# place would fail every INSERT once the model no longer supplies a value.
# SQLite has supported DROP COLUMN since 3.35; this app ships 3.45.
# Table names are the real ones (``Version.__tablename__`` is "versions"), and
# ``test_dropped_columns_name_real_tables`` keeps them honest: a name that
# matches nothing would silently skip the drop and leave the NOT NULL column in
# place, which breaks the next INSERT rather than failing loudly here.
_DROPPED_COLUMNS: tuple[tuple[str, str], ...] = (
    # Generated cover art was removed; the artwork.png files on disk are left
    # alone and simply stop being listed as downloads.
    ("versions", "has_artwork"),
)


def drop_removed_columns(engine: Engine) -> list[str]:
    """Remove columns this version of the app no longer knows about.

    Reflection happens before the transaction is opened, not inside it: the
    engine uses a StaticPool, so an Inspector used while a transaction is open
    shares that one physical connection, and SQLite then refused the following
    DROP with "no such column" even though the column was plainly there.
    """
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    pending: list[tuple[str, str]] = []
    for table, column in _DROPPED_COLUMNS:
        if table not in tables:
            continue
        if column in {col["name"] for col in inspector.get_columns(table)}:
            # The names are ours rather than user input, but an identifier that
            # needed quoting could not be dropped safely: SQLite does not
            # dequote the token in DROP COLUMN.
            if not column.isidentifier():
                raise ValueError(f"Refusing to drop a non-identifier column: {column!r}")
            pending.append((table, column))

    if not pending:
        return []
    with engine.begin() as connection:
        for table, column in pending:
            connection.execute(text(f'ALTER TABLE "{table}" DROP COLUMN {column}'))
    dropped = [f"{table}.{column}" for table, column in pending]
    log.info("database migrated: dropped %s", ", ".join(dropped))
    return dropped


def add_missing_columns(engine: Engine) -> list[str]:
    """Additive migration: add columns the models have and the database lacks.

    create_all() creates missing tables but never alters existing ones, so a
    column added to a model would otherwise break every query on an older
    database. This only ever ADDs columns - it never drops, renames or rewrites
    data - which is the only kind of change SongForge's schema makes.
    """
    added: list[str] = []
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    with engine.begin() as connection:
        for table in SQLModel.metadata.sorted_tables:
            if table.name not in existing_tables:
                continue
            present = {col["name"] for col in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in present:
                    continue
                column_type = column.type.compile(dialect=engine.dialect)
                default = _column_default_sql(column)
                clause = f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {column_type}'
                if default is not None:
                    clause += f" NOT NULL DEFAULT {default}" if not column.nullable else f" DEFAULT {default}"
                connection.execute(text(clause))
                added.append(f"{table.name}.{column.name}")
    if added:
        log.info("database migrated: added %s", ", ".join(added))
    return added


def _ensure_settings_row(session: Session) -> AppSettings:
    """The single settings row, created from the hardware profile if it is new.

    Seeding only ever happens on creation. Once the row exists it is the user's,
    and a later setup run must not quietly overwrite choices they made in
    Settings.
    """
    settings = session.get(AppSettings, 1)
    if settings is not None:
        return settings

    settings = AppSettings(id=1)
    profile = hardware_profile.load(get_config().runtime_dir)
    if profile is not None:
        applied = []
        for field, value in hardware_profile.seed_values(profile).items():
            if hasattr(settings, field):
                setattr(settings, field, value)
                applied.append(field)
        log.info("seeded settings from the hardware profile (%s): %s",
                 profile.describe(), ", ".join(sorted(applied)))
    session.add(settings)
    session.flush()
    return settings


def _mark_interrupted(session: Session) -> int:
    """Any job still 'running' at startup died with the previous process.

    Logs and partial output on disk are left untouched so the user can inspect
    them; only the database status is corrected.
    """
    stranded = session.exec(select(Job).where(Job.status == JobStatus.RUNNING)).all()
    for job in stranded:
        job.status = JobStatus.INTERRUPTED
        job.error = "Backend stopped while this job was running."
        session.add(job)
    return len(stranded)


@contextmanager
def session_scope() -> Iterator[Session]:
    with Session(get_engine()) as session:
        yield session


def get_session() -> Iterator[Session]:
    """FastAPI dependency."""
    with Session(get_engine()) as session:
        yield session
