"""Who may talk to the API.

SongForge has no accounts: it is meant for one person on their own computer,
or a household on its own network. That is a reasonable design only as long as
"whoever can reach the port" really is that person, and a browser makes that
less true than it looks. Any web page the user visits can ask their browser to
send requests to http://localhost:3333, and two well-known tricks turn that
into access to a local app:

* **DNS rebinding.** A hostile site points its own domain name at 127.0.0.1.
  The browser then treats the local app as part of that site and lets its
  scripts read every response. The tell is the Host header, which carries the
  attacker's name rather than "localhost" or an IP address.
* **Cross-site requests.** Without reading anything, a page can still *send* a
  form post or a fetch. The tell is the Origin header naming another site.

``RequestGuard`` checks both, before any route runs:

1. The host the browser asked for must be ``localhost``, an IP address, or a
   name the owner has listed. A rebinding attack cannot use an IP address -
   it needs a name it controls - so this closes it without getting in the way
   of opening the app by its network address from a phone.
2. A request that changes something (anything but GET, HEAD and OPTIONS) must
   come from the app itself: its Origin, when the browser sends one, has to be
   the very address the page was opened at, a loopback address, or a listed
   origin.

The web app proxies to this API and passes the address the browser used as
``X-Forwarded-Host``. That header cannot be forged by a hostile page: adding a
custom header to a cross-site request needs a CORS preflight, which the policy
in main.py refuses.
"""
from __future__ import annotations

import ipaddress
import json
import logging
from urllib.parse import urlsplit

log = logging.getLogger("songforge.security")

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
LOOPBACK_NAMES = frozenset({"localhost", "127.0.0.1", "::1"})


def split_host(value: str) -> tuple[str, str]:
    """("name", "port") from a Host header value, IPv6 brackets removed."""
    value = value.strip().lower()
    if not value:
        return "", ""
    if value.startswith("["):
        name, _, rest = value[1:].partition("]")
        return name, rest.lstrip(":")
    if value.count(":") > 1:
        # A bare IPv6 address without a port.
        return value, ""
    name, _, port = value.partition(":")
    return name, port


def is_ip_literal(name: str) -> bool:
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return False
    return True


class RequestGuard:
    """ASGI middleware: refuse rebinding and cross-site writes.

    See the module docstring for what each check is for.
    """

    def __init__(self, app, *, allowed_hosts: frozenset[str] = frozenset(),
                 allowed_origins: frozenset[str] = frozenset()) -> None:
        self.app = app
        self.allowed_hosts = frozenset(
            host.strip().lower() for host in allowed_hosts if host.strip())
        self.allowed_origins = frozenset(
            origin.strip().lower().rstrip("/") for origin in allowed_origins if origin.strip())

    def host_allowed(self, host_header: str) -> bool:
        name, _port = split_host(host_header)
        if not name:
            return False
        return name in LOOPBACK_NAMES or is_ip_literal(name) or name in self.allowed_hosts

    def origin_allowed(self, origin: str, host_header: str) -> bool:
        origin = origin.strip().lower().rstrip("/")
        if not origin or origin == "null":
            # "null" is what a sandboxed frame or a local file sends: by
            # definition not the app.
            return False
        if origin in self.allowed_origins:
            return True
        parts = urlsplit(origin)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return False
        if parts.hostname in LOOPBACK_NAMES:
            # Another page on this same computer. The dev server on :3333
            # talking to the API on :3334 is the everyday case.
            return True
        # Same origin as the page itself: the address the browser was pointed
        # at, port included, whatever network address that happens to be.
        return parts.netloc == host_header.strip().lower()

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers: dict[str, str] = {}
        for raw_name, raw_value in scope.get("headers", []):
            # First value wins; a duplicated Host or Origin is itself suspect.
            headers.setdefault(raw_name.decode("latin-1").lower(), raw_value.decode("latin-1"))

        forwarded = headers.get("x-forwarded-host", "").split(",")[0].strip()
        direct = headers.get("host", "")
        if not forwarded and not direct:
            await self._refuse(send, "The request did not say which host it was for.")
            return
        # Both must pass: the forwarded one is the address the browser used,
        # the direct one is what actually arrived at this socket.
        for candidate in filter(None, (forwarded, direct)):
            if not self.host_allowed(candidate):
                log.warning("refused a request for host %r", candidate[:80])
                await self._refuse(
                    send,
                    "This address is not allowed to reach SongForge. "
                    "Open it as http://localhost or by its IP address.",
                )
                return

        if scope.get("method", "GET").upper() not in SAFE_METHODS:
            origin = headers.get("origin")
            if origin is not None and not self.origin_allowed(origin, forwarded or direct):
                log.warning("refused a cross-site %s from origin %r",
                            scope.get("method"), origin[:120])
                await self._refuse(send, "This request came from another website and was refused.")
                return

        await self.app(scope, receive, send)

    @staticmethod
    async def _refuse(send, detail: str) -> None:
        body = json.dumps({"detail": detail}).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 403,
            "headers": [(b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode("ascii"))],
        })
        await send({"type": "http.response.body", "body": body})
