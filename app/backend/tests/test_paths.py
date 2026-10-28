"""Path-safety tests.

These prove the requirement that user input cannot create or read files outside
``runtime/projects``.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from songforge.paths import (
    PathTraversalError,
    is_within,
    safe_filename,
    safe_join,
    slugify,
)

TRAVERSAL_ATTEMPTS = [
    "..",
    "../outside",
    "..\\outside",
    "../../Windows/System32",
    "/etc/passwd",
    "C:\\Windows\\System32",
    "\\\\server\\share",
    "sub/../../escape",
    "sub\\..\\..\\escape",
    "a/b",
    "a\\b",
    ".",
    "",
    "D:relative",
]


@pytest.mark.parametrize("attempt", TRAVERSAL_ATTEMPTS)
def test_safe_join_rejects_traversal(tmp_path: Path, attempt: str) -> None:
    with pytest.raises(PathTraversalError):
        safe_join(tmp_path, attempt)


def test_safe_join_allows_plain_segments(tmp_path: Path) -> None:
    result = safe_join(tmp_path, "project-id", "versions", "v1")
    assert is_within(tmp_path, result)
    assert result == (tmp_path / "project-id" / "versions" / "v1").resolve()


def test_safe_join_rejects_nul(tmp_path: Path) -> None:
    with pytest.raises(PathTraversalError):
        safe_join(tmp_path, "bad\x00name")


def test_is_within_rejects_sibling(tmp_path: Path) -> None:
    base = tmp_path / "base"
    base.mkdir()
    sibling = tmp_path / "base-sibling"
    sibling.mkdir()
    assert is_within(base, base)
    assert not is_within(base, sibling)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Hello World", "hello-world"),
        ("  Multiple   Spaces  ", "multiple-spaces"),
        ("Ünïcödé Tïtlé", "unicode-title"),
        ("../../etc/passwd", "etc-passwd"),
        ("!!!", "untitled"),
        ("", "untitled"),
        ("CON", "untitled"),
    ],
)
def test_slugify(raw: str, expected: str) -> None:
    assert slugify(raw) == expected


def test_slugify_never_contains_separators() -> None:
    for raw in ("a/b", "a\\b", "../..", "C:\\x"):
        slug = slugify(raw)
        assert "/" not in slug and "\\" not in slug and ":" not in slug


@pytest.mark.parametrize(
    ("raw", "banned"),
    [("a/b.txt", "/"), ("a\\b.txt", "\\"), ('a"b.txt', '"'), ("a:b.txt", ":")],
)
def test_safe_filename_strips_separators(raw: str, banned: str) -> None:
    assert banned not in safe_filename(raw)


def test_safe_filename_handles_reserved_and_empty() -> None:
    assert safe_filename("NUL.txt").startswith("_")
    assert safe_filename("") == "file"
    assert safe_filename("   ") == "file"
    assert safe_filename("trailing...") == "trailing"


# --------------------------------------------------------- through the API


def test_project_id_traversal_is_rejected(client) -> None:
    """A crafted project id must not escape the projects directory."""
    for attempt in ("..", "..%2F..", "../../etc", "%2e%2e%2f%2e%2e"):
        response = client.get(f"/api/projects/{attempt}")
        assert response.status_code in (400, 404), (attempt, response.status_code)


def test_download_key_is_allowlisted(client) -> None:
    """Only allowlisted keys reach a file; anything else is a 404.

    A bare ".." is not tested here: HTTP clients collapse it before the request
    is sent, so it never reaches this handler. Traversal through the project id
    is covered by test_project_id_traversal_is_rejected.
    """
    created = client.post("/api/projects", json={"title": "Traversal probe"})
    assert created.status_code == 201
    project_id = created.json()["id"]

    for bad_key in ("../../project.json", "song.flac", "project.json",
                    "unknown", "..%2F..%2Fproject.json"):
        response = client.get(f"/api/projects/{project_id}/download/{bad_key}")
        assert response.status_code == 404, (bad_key, response.status_code)


def test_download_allowlist_covers_only_known_files() -> None:
    """Every allowlisted key maps to a bare filename, never to a path."""
    from songforge import storage

    for key, (filename, media_type) in storage.DOWNLOADABLE.items():
        assert "/" not in filename and "\\" not in filename and ".." not in filename
        assert filename == safe_filename(filename)
        assert media_type


def test_storage_writes_stay_inside_projects_root(client, runtime_dir: Path) -> None:
    """Hostile titles must not place files outside runtime/projects."""
    hostile = "../../../pwned"
    created = client.post("/api/projects", json={"title": hostile})
    assert created.status_code == 201
    project_id = created.json()["id"]

    projects_root = (runtime_dir / "projects").resolve()
    project_path = (projects_root / project_id).resolve()
    assert project_path.is_dir()
    assert is_within(projects_root, project_path)

    # Nothing was created above the runtime directory.
    assert not (runtime_dir.parent / "pwned").exists()
    for path in projects_root.rglob("*"):
        assert is_within(projects_root, path)


def test_version_number_must_be_positive_int(client) -> None:
    from songforge import storage

    created = client.post("/api/projects", json={"title": "Version guard"})
    project_id = created.json()["id"]
    for bad in (0, -1, -99):
        with pytest.raises(ValueError):
            storage.version_paths(project_id, bad)
