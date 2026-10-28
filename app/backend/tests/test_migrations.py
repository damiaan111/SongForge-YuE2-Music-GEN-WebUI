"""Schema migrations against databases written by an older SongForge.

The additive half is covered elsewhere; this is the destructive half, which is
riskier: ``create_all`` wrote ``has_artwork`` as NOT NULL with no SQL default,
so a database that still has that column rejects every new version row once the
model stops supplying a value.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import text
from sqlmodel import SQLModel


def test_dropped_columns_name_real_tables() -> None:
    """A wrong table name would skip the drop silently.

    This is not hypothetical: the first version of the list said "version",
    while the table is "versions", so the column survived the migration.
    """
    from songforge import models  # noqa: F401  (registers the tables)
    from songforge.db import _DROPPED_COLUMNS

    tables = set(SQLModel.metadata.tables)
    for table, column in _DROPPED_COLUMNS:
        assert table in tables, f"{table} is not a table; known: {sorted(tables)}"
        assert column not in SQLModel.metadata.tables[table].columns, (
            f"{table}.{column} is still in the model, so it must not be dropped"
        )


def test_a_legacy_artwork_column_is_dropped(runtime_dir: Path) -> None:
    from songforge.db import drop_removed_columns, get_engine, init_db

    init_db()
    engine = get_engine()

    # Put the old column back, as an older database would have it.
    with engine.begin() as connection:
        connection.execute(
            text('ALTER TABLE "versions" ADD COLUMN "has_artwork" BOOLEAN NOT NULL DEFAULT 0')
        )

    assert drop_removed_columns(engine) == ["versions.has_artwork"]
    with engine.begin() as connection:
        columns = {row[1] for row in connection.execute(text('PRAGMA table_info("versions")'))}
    assert "has_artwork" not in columns

    # Idempotent: a database already migrated reports nothing to do.
    assert drop_removed_columns(engine) == []


def test_a_version_can_still_be_written_after_the_migration(runtime_dir: Path) -> None:
    """The point of the drop: inserts must keep working."""
    from sqlmodel import Session

    from songforge.db import get_engine, init_db
    from songforge.models import Project, Version

    init_db()
    with Session(get_engine()) as session:
        project = Project(title="Migrated", slug="migrated", style_prompt="folk", lyrics="[Verse]\nx")
        session.add(project)
        session.flush()
        session.add(Version(project_id=project.id, number=1, title="Migrated",
                            style_prompt="folk", lyrics="[Verse]\nx"))
        session.commit()
        stored = session.get(Version, session.exec(
            __import__("sqlmodel").select(Version.id)
        ).first())
        assert stored is not None
        assert not hasattr(stored, "has_artwork")


@pytest.mark.parametrize("name", ["has_artwork"])
def test_the_model_no_longer_carries_the_column(name: str) -> None:
    from songforge.models import Version
    from songforge.schemas import VersionOut

    assert name not in Version.model_fields
    assert name not in VersionOut.model_fields
