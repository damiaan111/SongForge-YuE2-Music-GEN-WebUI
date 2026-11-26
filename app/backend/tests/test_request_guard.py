"""Who may talk to the API: DNS rebinding and cross-site requests.

SongForge has no accounts, so "can reach the port" is the whole of its access
control. These tests are about the two ways a web page the user merely visits
can reach it through their own browser.
"""
from __future__ import annotations

import pytest

from songforge.security import RequestGuard, split_host


@pytest.mark.parametrize(("header", "expected"), [
    ("localhost:3333", ("localhost", "3333")),
    ("LOCALHOST", ("localhost", "")),
    ("127.0.0.1:3334", ("127.0.0.1", "3334")),
    ("[::1]:3333", ("::1", "3333")),
    ("::1", ("::1", "")),
    ("192.168.1.42:3333", ("192.168.1.42", "3333")),
    ("", ("", "")),
])
def test_host_headers_are_split_including_ipv6(header, expected) -> None:
    assert split_host(header) == expected


@pytest.mark.parametrize("host", [
    "localhost:3333", "127.0.0.1:3334", "[::1]:3333",
    "192.168.1.42:3333", "10.0.0.5", "172.16.4.2:8080",
])
def test_localhost_and_ip_addresses_are_always_reachable(host) -> None:
    assert RequestGuard(None).host_allowed(host)


@pytest.mark.parametrize("host", [
    "evil.example", "evil.example:3333", "localhost.evil.example",
    "127.0.0.1.evil.example", "", "studio.local",
])
def test_any_other_name_is_refused_unless_listed(host) -> None:
    assert not RequestGuard(None).host_allowed(host)
    if host == "studio.local":
        assert RequestGuard(None, allowed_hosts=frozenset({"Studio.Local"})).host_allowed(host)


def test_a_rebound_domain_cannot_read_the_library(client) -> None:
    """evil.example resolving to 127.0.0.1 arrives with its own name as Host."""
    response = client.get("/api/projects", headers={"host": "evil.example:3333"})
    assert response.status_code == 403
    assert "not allowed" in response.json()["detail"]


def test_a_rebound_domain_is_refused_through_the_web_app_too(client) -> None:
    """The proxy rewrites Host to its target and passes the real one along."""
    response = client.get(
        "/api/projects",
        headers={"host": "127.0.0.1:3334", "x-forwarded-host": "evil.example:3333"},
    )
    assert response.status_code == 403


def test_another_website_cannot_change_anything(client) -> None:
    created = client.post("/api/projects", json={"title": "Mine", "style_prompt": "folk", "lyrics": "la"})
    assert created.status_code in (200, 201)
    project_id = created.json()["id"]

    for method, path in (("delete", f"/api/projects/{project_id}"),
                         ("post", "/api/projects"),
                         ("put", "/api/settings")):
        response = getattr(client, method)(
            path,
            **({} if method == "delete" else {"json": {}}),
            headers={"host": "localhost:3333", "origin": "https://evil.example"},
        )
        assert response.status_code == 403, (method, path)
        assert "another website" in response.json()["detail"]

    assert client.get(f"/api/projects/{project_id}").status_code == 200, "the song survived"


def test_a_sandboxed_page_cannot_change_anything(client) -> None:
    response = client.post("/api/projects", json={}, headers={"origin": "null"})
    assert response.status_code == 403


@pytest.mark.parametrize(("host", "forwarded", "origin"), [
    # The app opened on this computer, through the web app's proxy.
    ("127.0.0.1:3334", "localhost:3333", "http://localhost:3333"),
    # The app opened from a phone by the computer's network address.
    ("127.0.0.1:3334", "192.168.1.42:3333", "http://192.168.1.42:3333"),
    # The dev server on one loopback port calling the API on another.
    ("127.0.0.1:3334", "", "http://localhost:3333"),
    # A script on this computer that sends no Origin at all (curl, tests).
    ("127.0.0.1:3334", "", None),
])
def test_the_app_itself_is_never_refused(client, host, forwarded, origin) -> None:
    headers = {"host": host}
    if forwarded:
        headers["x-forwarded-host"] = forwarded
    if origin:
        headers["origin"] = origin
    response = client.post(
        "/api/projects",
        json={"title": "Fine", "style_prompt": "folk", "lyrics": "la"},
        headers=headers,
    )
    assert response.status_code in (200, 201), response.text


def test_a_phone_on_the_network_cannot_be_impersonated_by_another_site(client) -> None:
    """Same address in the bar, different site asking: still refused."""
    response = client.post(
        "/api/projects", json={},
        headers={"host": "127.0.0.1:3334", "x-forwarded-host": "192.168.1.42:3333",
                 "origin": "http://192.168.1.99:3333"},
    )
    assert response.status_code == 403


def test_reading_is_not_blocked_by_an_origin_header(client) -> None:
    """GET changes nothing; whether the page may read the answer is CORS's job."""
    response = client.get("/api/health", headers={"origin": "https://evil.example"})
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers


def test_no_private_network_is_baked_into_the_cors_policy(client) -> None:
    """No address range on somebody's home network is trusted by default."""
    preflight = client.options(
        "/api/projects",
        headers={"origin": "http://192.168.1.20:3333", "access-control-request-method": "POST"},
    )
    assert "access-control-allow-origin" not in preflight.headers
    allowed = client.options(
        "/api/projects",
        headers={"origin": "http://localhost:3333", "access-control-request-method": "POST"},
    )
    assert allowed.headers.get("access-control-allow-origin") == "http://localhost:3333"
