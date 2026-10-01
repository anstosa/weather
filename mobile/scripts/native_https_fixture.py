#!/usr/bin/env python3
"""Serve the bounded native WebView HTTPS fixture."""

from __future__ import annotations

import argparse
import hashlib
import html
import http.client
import json
import os
import secrets
import shlex
import shutil
import signal
import socket
import ssl
import stat
import subprocess
import threading
from collections import Counter
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

TRUSTED_PORT = 18443
UNTRUSTED_PORT = 18444
COOKIE_NAME = "weather_admin_session"
LOGIN_USERNAME = "fixture-admin"
LOGIN_PASSWORD = "fixture-password"
LOGIN_MAX_AGE = 1800
ALLOWED_HOSTS = {"127.0.0.1", "10.0.2.2"}
MAX_FORM_BYTES = 8192
PAGE_ROUTES = {
    "/": "home",
    "/forecast": "forecast",
    "/logs": "logs",
    "/map": "map",
    "/policy": "policy",
    "/settings": "settings",
    "/trends": "trends",
}


# build the exact production-shaped login header
def login_cookie_header(token: str) -> str:
    """Return the fixture session cookie contract."""
    # reject header delimiters in the opaque token
    if not token or any(character in token for character in ";\r\n"):
        raise ValueError("invalid fixture session token")
    return (
        f"{COOKIE_NAME}={token}; Path=/; HttpOnly; Max-Age={LOGIN_MAX_AGE}; "
        "SameSite=None; Secure; Partitioned"
    )


# build the exact production-shaped logout header
def logout_cookie_header() -> str:
    """Return the fixture session deletion contract."""
    return (
        f"{COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0; "
        "SameSite=None; Secure; Partitioned"
    )


# hash one public certificate without retaining private material
def certificate_sha256(path: Path) -> str:
    """Return the SHA-256 fingerprint of one PEM certificate."""
    der = ssl.PEM_cert_to_DER_cert(path.read_text())
    return hashlib.sha256(der).hexdigest()


# write a private runtime file under the restrictive process umask
def write_runtime_file(path: Path, content: str) -> None:
    """Write one mode-0600 runtime file."""
    path.write_text(content)
    path.chmod(0o600)


# execute the host OpenSSL without exposing generated keys
def run_openssl(runtime: Path, *arguments: str) -> None:
    """Run one certificate-generation command."""
    subprocess.run(
        ["openssl", *arguments],
        cwd=runtime,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


# generate one private CA and matched-host server certificate
def generate_authority(runtime: Path, prefix: str, common_name: str) -> dict[str, Path]:
    """Generate one root and leaf pair inside the private runtime."""
    ca_key = runtime / f"{prefix}-ca-key.pem"
    ca_cert = runtime / f"{prefix}-ca.pem"
    leaf_key = runtime / f"{prefix}-leaf-key.pem"
    leaf_csr = runtime / f"{prefix}-leaf.csr"
    leaf_cert = runtime / f"{prefix}-leaf.pem"
    ca_config = runtime / f"{prefix}-ca.cnf"
    leaf_config = runtime / f"{prefix}-leaf.cnf"
    write_runtime_file(
        ca_config,
        "\n".join(
            [
                "[req]",
                "distinguished_name = distinguished_name",
                "x509_extensions = root_extensions",
                "prompt = no",
                "[distinguished_name]",
                f"CN = {common_name}",
                "[root_extensions]",
                "basicConstraints = critical, CA:true, pathlen:0",
                "keyUsage = critical, keyCertSign, cRLSign",
                "subjectKeyIdentifier = hash",
                "authorityKeyIdentifier = keyid:always",
                "",
            ]
        ),
    )
    write_runtime_file(
        leaf_config,
        "\n".join(
            [
                "[req]",
                "distinguished_name = distinguished_name",
                "req_extensions = leaf_extensions",
                "prompt = no",
                "[distinguished_name]",
                "CN = Weather Native HTTPS Fixture",
                "[leaf_extensions]",
                "basicConstraints = critical, CA:false",
                "keyUsage = critical, digitalSignature, keyEncipherment",
                "extendedKeyUsage = serverAuth",
                "subjectAltName = @subject_alt_names",
                "subjectKeyIdentifier = hash",
                "[subject_alt_names]",
                "IP.1 = 127.0.0.1",
                "IP.2 = 10.0.2.2",
                "",
            ]
        ),
    )
    run_openssl(
        runtime,
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "2",
        "-set_serial",
        f"0x{secrets.token_hex(16)}",
        "-keyout",
        ca_key.name,
        "-out",
        ca_cert.name,
        "-config",
        ca_config.name,
    )
    run_openssl(
        runtime,
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-keyout",
        leaf_key.name,
        "-out",
        leaf_csr.name,
        "-config",
        leaf_config.name,
    )
    run_openssl(
        runtime,
        "x509",
        "-req",
        "-sha256",
        "-days",
        "2",
        "-set_serial",
        f"0x{secrets.token_hex(16)}",
        "-in",
        leaf_csr.name,
        "-CA",
        ca_cert.name,
        "-CAkey",
        ca_key.name,
        "-out",
        leaf_cert.name,
        "-extfile",
        leaf_config.name,
        "-extensions",
        "leaf_extensions",
    )
    # retain restrictive permissions for every generated private key
    for private_key in (ca_key, leaf_key):
        private_key.chmod(0o600)
    return {
        "ca_cert": ca_cert,
        "ca_key": ca_key,
        "leaf_cert": leaf_cert,
        "leaf_key": leaf_key,
    }


# retain one fake server state boundary
class FixtureState:
    """Hold bounded fake session state and sanitized event receipts."""

    # initialize one isolated fixture run
    def __init__(self, events_path: Path) -> None:
        self.events_path = events_path
        self.lock = threading.Lock()
        self.sequence = 0
        self.session_token: str | None = None
        self.server_unit = "fahrenheit"
        self.event_counts: Counter[str] = Counter()
        self.events_path.write_text("")
        self.events_path.chmod(0o644)

    # inspect a request cookie without retaining its value
    def session_status(self, raw_cookie: str) -> tuple[bool, bool]:
        """Return cookie-present and cookie-accepted booleans."""
        cookie = SimpleCookie()
        # parse without retaining the supplied value
        try:
            cookie.load(raw_cookie)
        # reject malformed request cookie syntax
        except Exception:
            return COOKIE_NAME in raw_cookie, False
        present = COOKIE_NAME in cookie
        supplied = cookie[COOKIE_NAME].value if present else ""
        with self.lock:
            accepted = bool(
                present
                and self.session_token
                and secrets.compare_digest(supplied, self.session_token)
            )
        return present, accepted

    # create one opaque fake session
    def start_session(self) -> str:
        """Replace and return the fixture session token."""
        with self.lock:
            self.session_token = secrets.token_urlsafe(32)
            self.server_unit = "fahrenheit"
            return self.session_token

    # update authenticated server preference state
    def set_server_unit(self, unit: str) -> None:
        """Persist one authenticated fake setting."""
        with self.lock:
            self.server_unit = unit

    # read authenticated server preference state
    def get_server_unit(self) -> str:
        """Return the current fake setting."""
        with self.lock:
            return self.server_unit

    # clear the current fake session
    def end_session(self) -> None:
        """Invalidate the fixture session."""
        with self.lock:
            self.session_token = None

    # append one allowlisted event without headers or credentials
    def record(
        self,
        event: str,
        *,
        method: str,
        path: str,
        status_code: int,
        cookie_present: bool = False,
        cookie_accepted: bool = False,
        authenticated: bool = False,
        setting: str | None = None,
        timestamped: bool = False,
        request_sequence: int | None = None,
    ) -> int:
        """Append one sanitized JSON receipt and return its sequence."""
        with self.lock:
            self.sequence += 1
            self.event_counts[event] += 1
            receipt: dict[str, object] = {
                "authenticated": authenticated,
                "cookieAccepted": cookie_accepted,
                "cookiePresent": cookie_present,
                "event": event,
                "method": method,
                "path": path,
                "sequence": self.sequence,
                "status": status_code,
            }
            # timestamp only the bounded admin request and response milestones
            if timestamped:
                receipt["atUtc"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            # bind only a completed admin write to its request
            if request_sequence is not None:
                receipt["requestSequence"] = request_sequence
            # retain only the two allowlisted unit values
            if setting in {"fahrenheit", "celsius"}:
                receipt["setting"] = setting
            with self.events_path.open("a") as output:
                output.write(json.dumps(receipt, sort_keys=True) + "\n")
            return self.sequence

    # write aggregate event counts after clean server shutdown
    def write_summary(self, path: Path) -> None:
        """Write the sanitized terminal fixture receipt."""
        with self.lock:
            payload = {
                "eventCounts": dict(sorted(self.event_counts.items())),
                "receiptVersion": 1,
                "sessionActiveAtShutdown": self.session_token is not None,
            }
        path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
        path.chmod(0o644)


# select the platform-visible host while preserving exact fixed ports
def fixture_host(host_header: str) -> str:
    """Return an allowlisted certificate host for generated links."""
    host = host_header.rsplit(":", 1)[0]
    # reject unexpected Host values from generated destinations
    if host not in ALLOWED_HOSTS:
        return "127.0.0.1"
    return host


# render one accessible deterministic HTML document
def document(title: str, page: str, content: str, host: str) -> bytes:
    """Return one complete fixture page."""
    escaped_title = html.escape(title)
    untrusted_origin = f"https://{host}:{UNTRUSTED_PORT}"
    navigation = "".join(
        [
            '<a href="/" aria-label="Fixture home navigation">Home</a>',
            '<a href="/forecast" aria-label="Fixture forecast navigation">Forecast</a>',
            '<a href="/map" aria-label="Fixture map navigation">Map</a>',
            '<a href="/logs" aria-label="Fixture logs navigation">Logs</a>',
            '<a href="/trends" aria-label="Fixture trends navigation">Trends</a>',
            '<a href="/settings" aria-label="Fixture settings navigation">Settings</a>',
            '<a href="/admin" aria-label="Fixture administration navigation">Admin</a>',
        ]
    )
    return (
        "<!doctype html>"
        '<html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{escaped_title}</title>"
        "<style>body{font-family:system-ui;margin:1rem;max-width:48rem}"
        "nav{display:flex;flex-wrap:wrap;gap:.75rem}"
        "form{display:grid;gap:.75rem;max-width:24rem;margin-block:1rem}"
        "button,input,select{font:inherit;padding:.5rem}"
        "[role=status]{font-weight:600}</style></head><body>"
        f'<nav aria-label="Fixture navigation">{navigation}</nav>'
        f'<main data-testid="fixture-page" data-page="{html.escape(page)}">'
        f"{content}</main>"
        f'<a id="untrusted-tls-link" href="{untrusted_origin}/tls-negative" '
        'aria-label="Open untrusted TLS fixture">Open untrusted TLS fixture</a>'
        "</body></html>"
    ).encode()


# render one ordinary same-origin page
def public_page(page: str, host: str) -> bytes:
    """Return one fake public route."""
    title = f"Fixture {page}"
    content = f"<h1>{html.escape(title)}</h1>"
    # expose history, popup, and policy targets from the home route
    if page == "home":
        content += (
            '<p><a id="open-forecast" href="/forecast" '
            'aria-label="Open fixture forecast">Open fixture forecast</a></p>'
            '<p><a id="target-blank-map" href="/map" target="_blank" '
            'aria-label="Open fixture map in new window">Open fixture map in new window</a></p>'
            '<p><a id="open-policy" href="/policy" '
            'aria-label="Open fixture policy links">Open fixture policy links</a></p>'
        )
    # expose only cancellable policy targets without requesting them here
    if page == "policy":
        content += (
            f'<p><a id="unsafe-http-link" href="http://{host}:{TRUSTED_PORT}/unsafe" '
            'aria-label="Unsafe HTTP fixture">Unsafe HTTP fixture</a></p>'
            '<p><a id="lookalike-link" '
            'href="https://weather.ballydidean.farm.example.invalid/forecast" '
            'aria-label="Lookalike Weather origin">Lookalike Weather origin</a></p>'
            '<p><a id="external-link" href="https://external.example.invalid/fixture" '
            'aria-label="External fixture policy">External fixture policy</a></p>'
        )
    # expose public localStorage preference controls
    if page == "settings":
        content += """
<section aria-labelledby="public-unit-heading">
  <h2 id="public-unit-heading">Public unit preference</h2>
  <p id="public-unit-state" role="status">Public unit preference: Fahrenheit</p>
  <button id="use-fahrenheit" type="button" aria-label="Use Fahrenheit">Use Fahrenheit</button>
  <button id="use-celsius" type="button" aria-label="Use Celsius">Use Celsius</button>
</section>
<script>
(() => {
  const key = "weather_fixture_temperature_unit";
  const output = document.getElementById("public-unit-state");
  const render = () => {
    const unit = localStorage.getItem(key) === "celsius" ? "Celsius" : "Fahrenheit";
    output.textContent = `Public unit preference: ${unit}`;
  };
  document.getElementById("use-fahrenheit").addEventListener("click", () => {
    localStorage.setItem(key, "fahrenheit");
    render();
  });
  document.getElementById("use-celsius").addEventListener("click", () => {
    localStorage.setItem(key, "celsius");
    render();
  });
  render();
})();
</script>
"""
    return document(title, page, content, host)


# render the unauthenticated administration page
def login_page(host: str, message: str = "") -> bytes:
    """Return the fake login form."""
    status = f'<p role="status">{html.escape(message)}</p>' if message else ""
    content = f"""
<h1>Fixture sign in</h1>
{status}
<form method="post" action="/admin/login">
  <label for="fixture-username">Fixture username</label>
  <input id="fixture-username" name="username" autocomplete="username" required>
  <label for="fixture-password">Fixture password</label>
  <input id="fixture-password" name="password" type="password" autocomplete="current-password" required>
  <button id="fixture-login" type="submit" aria-label="Sign in to fixture">Sign in to fixture</button>
</form>
"""
    return document("Fixture sign in", "admin-sign-in", content, host)


# render authenticated administration controls
def administration_page(host: str, server_unit: str) -> bytes:
    """Return the authenticated fake administration page."""
    selected_fahrenheit = " selected" if server_unit == "fahrenheit" else ""
    selected_celsius = " selected" if server_unit == "celsius" else ""
    content = f"""
<h1>Fixture administration</h1>
<p data-testid="auth-state">Authenticated fixture session</p>
<p id="server-unit-state" role="status">Server unit: {html.escape(server_unit.title())}</p>
<p id="http-only-state" role="status">Checking HttpOnly session</p>
<form method="post" action="/admin/settings">
  <label for="fixture-server-unit">Fixture server unit</label>
  <select id="fixture-server-unit" name="unit">
    <option value="fahrenheit"{selected_fahrenheit}>Fahrenheit</option>
    <option value="celsius"{selected_celsius}>Celsius</option>
  </select>
  <button id="save-fixture-settings" type="submit" aria-label="Save fixture settings">Save fixture settings</button>
</form>
<form method="post" action="/admin/logout">
  <button id="fixture-logout" type="submit" aria-label="Sign out of fixture">Sign out of fixture</button>
</form>
<script>
(() => {{
  const exposed = document.cookie.split(";").some((part) => part.trim().startsWith("{COOKIE_NAME}="));
  document.getElementById("http-only-state").textContent = exposed
    ? "HttpOnly session exposed"
    : "HttpOnly session hidden";
}})();
</script>
"""
    return document("Fixture administration", "admin", content, host)


# serve only the frozen local fixture surface
class FixtureRequestHandler(BaseHTTPRequestHandler):
    """Handle trusted and negative HTTPS fixture requests."""

    protocol_version = "HTTP/1.1"
    server_version = "WeatherNativeFixture/1"

    # suppress default raw request logging
    def log_message(self, _format: str, *_arguments: object) -> None:
        """Disable request-header logging."""

    # expose the typed fixture state from the server instance
    @property
    def fixture_state(self) -> FixtureState:
        """Return shared in-memory fixture state."""
        return self.server.fixture_state  # type: ignore[attr-defined]

    # expose the listener trust class
    @property
    def listener_name(self) -> str:
        """Return trusted or untrusted."""
        return self.server.listener_name  # type: ignore[attr-defined]

    # write a complete bounded response
    def respond(
        self,
        status_code: int,
        body: bytes = b"",
        *,
        content_type: str = "text/html; charset=utf-8",
        headers: tuple[tuple[str, str], ...] = (),
    ) -> None:
        """Send one no-store security-hardened fixture response."""
        self.send_response(status_code)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        # add only caller-selected safe headers
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        # omit bodies only for HEAD
        if self.command != "HEAD":
            self.wfile.write(body)

    # parse one bounded URL-encoded form body
    def form(self) -> dict[str, list[str]] | None:
        """Return a bounded form or None after an error response."""
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip()
        # accept only deterministic HTML form submissions
        if content_type != "application/x-www-form-urlencoded":
            self.respond(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, b"unsupported form encoding\n", content_type="text/plain; charset=utf-8")
            return None
        # parse a numeric bounded body length
        try:
            length = int(self.headers.get("Content-Length", "0"))
        # reject ambiguous transfer lengths
        except ValueError:
            self.respond(HTTPStatus.BAD_REQUEST, b"invalid content length\n", content_type="text/plain; charset=utf-8")
            return None
        # reject oversized or absent request bodies
        if length <= 0 or length > MAX_FORM_BYTES:
            self.respond(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, b"invalid form size\n", content_type="text/plain; charset=utf-8")
            return None
        # decode one exact form payload
        try:
            return parse_qs(
                self.rfile.read(length).decode("utf-8"),
                keep_blank_values=True,
                strict_parsing=True,
            )
        # reject malformed UTF-8 or fields
        except (UnicodeDecodeError, ValueError):
            self.respond(HTTPStatus.BAD_REQUEST, b"invalid form body\n", content_type="text/plain; charset=utf-8")
            return None

    # inspect the session without exposing its value
    def session(self) -> tuple[bool, bool]:
        """Return request cookie-present and accepted state."""
        return self.fixture_state.session_status(self.headers.get("Cookie", ""))

    # route trusted and negative GET requests
    def do_GET(self) -> None:
        """Serve one fixture page."""
        parsed = urlsplit(self.path)
        host = fixture_host(self.headers.get("Host", ""))
        # keep query input outside the deterministic fixture contract
        if parsed.query:
            self.respond(HTTPStatus.BAD_REQUEST, b"query input is not supported\n", content_type="text/plain; charset=utf-8")
            return
        # restrict the negative listener to matched-host certificate testing
        if self.listener_name == "untrusted":
            # keep an independently verified readiness route
            if parsed.path == "/__fixture/health":
                self.respond(HTTPStatus.OK, b"untrusted fixture ready\n", content_type="text/plain; charset=utf-8")
                return
            # expose one normal certificate-negative document
            if parsed.path == "/tls-negative":
                self.fixture_state.record(
                    "untrusted-route-served",
                    method="GET",
                    path=parsed.path,
                    status_code=HTTPStatus.OK,
                )
                self.respond(HTTPStatus.OK, document("Untrusted TLS fixture", "tls-negative", "<h1>Untrusted TLS fixture</h1>", host))
                return
            self.respond(HTTPStatus.NOT_FOUND, b"not found\n", content_type="text/plain; charset=utf-8")
            return
        # expose one trusted health endpoint for CA-verified readiness
        if parsed.path == "/__fixture/health":
            self.respond(HTTPStatus.OK, b"trusted fixture ready\n", content_type="text/plain; charset=utf-8")
            return
        # serve one ordinary fake application route
        if parsed.path in PAGE_ROUTES:
            page = PAGE_ROUTES[parsed.path]
            self.fixture_state.record(
                "public-page",
                method="GET",
                path=parsed.path,
                status_code=HTTPStatus.OK,
            )
            self.respond(HTTPStatus.OK, public_page(page, host))
            return
        # serve authenticated or unauthenticated administration state
        if parsed.path == "/admin":
            present, accepted = self.session()
            event = "authenticated-admin" if accepted else "unauthenticated-admin"
            body = administration_page(host, self.fixture_state.get_server_unit()) if accepted else login_page(host)
            request_sequence = self.fixture_state.record(
                event,
                method="GET",
                path=parsed.path,
                status_code=HTTPStatus.OK,
                cookie_present=present,
                cookie_accepted=accepted,
                authenticated=accepted,
                timestamped=True,
            )
            self.respond(HTTPStatus.OK, body)
            # record only a completed server-side write, not client receipt
            self.fixture_state.record(
                "admin-response-written",
                method="GET",
                path="/admin",
                status_code=HTTPStatus.OK,
                cookie_present=present,
                cookie_accepted=accepted,
                authenticated=accepted,
                timestamped=True,
                request_sequence=request_sequence,
            )
            return
        # expose a protected machine-readable setting for integration assertions
        if parsed.path == "/admin/settings-state":
            present, accepted = self.session()
            status_code = HTTPStatus.OK if accepted else HTTPStatus.UNAUTHORIZED
            payload = {
                "authenticated": accepted,
                "unit": self.fixture_state.get_server_unit() if accepted else None,
            }
            self.fixture_state.record(
                "authenticated-settings-state" if accepted else "settings-state-rejected",
                method="GET",
                path=parsed.path,
                status_code=status_code,
                cookie_present=present,
                cookie_accepted=accepted,
                authenticated=accepted,
                setting=payload["unit"],
            )
            self.respond(
                status_code,
                (json.dumps(payload, sort_keys=True) + "\n").encode(),
                content_type="application/json; charset=utf-8",
            )
            return
        self.respond(HTTPStatus.NOT_FOUND, b"not found\n", content_type="text/plain; charset=utf-8")

    # route deterministic login, settings, and logout forms
    def do_POST(self) -> None:
        """Apply one fixture administration action."""
        parsed = urlsplit(self.path)
        host = fixture_host(self.headers.get("Host", ""))
        # keep query input outside the deterministic fixture contract
        if parsed.query:
            self.respond(HTTPStatus.BAD_REQUEST, b"query input is not supported\n", content_type="text/plain; charset=utf-8")
            return
        # never accept administration actions on the negative listener
        if self.listener_name != "trusted":
            self.respond(HTTPStatus.NOT_FOUND, b"not found\n", content_type="text/plain; charset=utf-8")
            return
        # clear the fake session without requiring form fields
        if parsed.path == "/admin/logout":
            present, accepted = self.session()
            self.fixture_state.end_session()
            self.fixture_state.record(
                "logout-cookie-cleared",
                method="POST",
                path=parsed.path,
                status_code=HTTPStatus.OK,
                cookie_present=present,
                cookie_accepted=accepted,
                authenticated=accepted,
            )
            self.respond(
                HTTPStatus.OK,
                login_page(host, "Fixture session signed out"),
                headers=(("Set-Cookie", logout_cookie_header()),),
            )
            return
        form = self.form()
        # stop after the bounded form parser writes an error
        if form is None:
            return
        # establish a fake session and exact cookie contract
        if parsed.path == "/admin/login":
            username = form.get("username", [""])[0]
            password = form.get("password", [""])[0]
            # reject every non-fixture credential
            if username != LOGIN_USERNAME or password != LOGIN_PASSWORD:
                self.fixture_state.record(
                    "login-rejected",
                    method="POST",
                    path=parsed.path,
                    status_code=HTTPStatus.UNAUTHORIZED,
                )
                self.respond(HTTPStatus.UNAUTHORIZED, login_page(host, "Fixture credentials rejected"))
                return
            token = self.fixture_state.start_session()
            self.fixture_state.record(
                "login-cookie-set",
                method="POST",
                path=parsed.path,
                status_code=HTTPStatus.SEE_OTHER,
                authenticated=True,
            )
            self.respond(
                HTTPStatus.SEE_OTHER,
                headers=(("Location", "/admin"), ("Set-Cookie", login_cookie_header(token))),
            )
            return
        # require the returned HttpOnly cookie for a protected mutation
        if parsed.path == "/admin/settings":
            present, accepted = self.session()
            unit = form.get("unit", [""])[0]
            if not accepted or unit not in {"fahrenheit", "celsius"}:
                self.fixture_state.record(
                    "settings-rejected",
                    method="POST",
                    path=parsed.path,
                    status_code=HTTPStatus.UNAUTHORIZED,
                    cookie_present=present,
                    cookie_accepted=accepted,
                    authenticated=False,
                )
                self.respond(HTTPStatus.UNAUTHORIZED, login_page(host, "Fixture authentication required"))
                return
            self.fixture_state.set_server_unit(unit)
            self.fixture_state.record(
                "authenticated-settings",
                method="POST",
                path=parsed.path,
                status_code=HTTPStatus.SEE_OTHER,
                cookie_present=present,
                cookie_accepted=True,
                authenticated=True,
                setting=unit,
            )
            self.respond(HTTPStatus.SEE_OTHER, headers=(("Location", "/admin"),))
            return
        self.respond(HTTPStatus.NOT_FOUND, b"not found\n", content_type="text/plain; charset=utf-8")


# create one loopback-only TLS listener
class FixtureHTTPSServer(ThreadingHTTPServer):
    """Dispatch raw TCP before a bounded worker performs TLS."""

    daemon_threads = True
    request_queue_size = 16

    # retain one bounded TLS context and worker allowance
    def __init__(self, address: tuple[str, int], context: ssl.SSLContext) -> None:
        self.tls_context = context
        self.connection_slots = threading.BoundedSemaphore(16)
        super().__init__(address, FixtureRequestHandler)

    # reject excess idle peers before allocating another worker
    def process_request(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        # keep concurrent handshakes and HTTP connections bounded
        if not self.connection_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        # release the slot if thread creation fails
        except BaseException:
            self.connection_slots.release()
            raise

    # release one worker allowance after its socket closes
    def process_request_thread(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connection_slots.release()

    # perform TLS only after the accepted connection has a worker
    def finish_request(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        try:
            request.settimeout(5)
            secured = self.tls_context.wrap_socket(request, server_side=True)
        # close only failed handshakes without logging raw input
        except OSError:
            request.close()
            return
        # preserve normal HTTP handler failure diagnostics
        with secured:
            super().finish_request(secured, client_address)


# create one loopback-only TLS listener
def create_server(
    state: FixtureState,
    listener_name: str,
    port: int,
    certificate: Path,
    private_key: Path,
) -> FixtureHTTPSServer:
    """Create a TLS 1.2+ loopback listener."""
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(certificate, private_key)
    server = FixtureHTTPSServer(("127.0.0.1", port), context)
    server.fixture_state = state  # type: ignore[attr-defined]
    server.listener_name = listener_name  # type: ignore[attr-defined]
    return server


# request one listener with ordinary hostname and CA verification
def verified_health(port: int, ca_path: Path) -> bytes:
    """Return one CA-verified health body."""
    context = ssl.create_default_context(cafile=str(ca_path))
    connection = http.client.HTTPSConnection("127.0.0.1", port, context=context, timeout=3)
    # always release the bounded readiness socket
    try:
        connection.request("GET", "/__fixture/health")
        response = connection.getresponse()
        payload = response.read()
        # reject a listener that is reachable but unhealthy
        if response.status != HTTPStatus.OK:
            raise RuntimeError(f"fixture health returned HTTP {response.status}")
        return payload
    # close after either success or TLS failure
    finally:
        connection.close()


# prove both valid chains and the trusted/untrusted separation
def verify_listener_readiness(trusted_ca: Path, untrusted_ca: Path) -> None:
    """Verify listeners without disabling certificate checks."""
    trusted_body = verified_health(TRUSTED_PORT, trusted_ca)
    untrusted_body = verified_health(UNTRUSTED_PORT, untrusted_ca)
    # require each verified listener identity
    if trusted_body != b"trusted fixture ready\n" or untrusted_body != b"untrusted fixture ready\n":
        raise RuntimeError("fixture listener identity mismatch")
    # require ordinary chain validation to reject the negative listener
    try:
        verified_health(UNTRUSTED_PORT, trusted_ca)
    # accept only an actual certificate verification failure
    except ssl.SSLCertVerificationError:
        return
    raise RuntimeError("untrusted listener chained to the trusted fixture CA")


# retain only public certificate metadata and the trusted public root
def write_certificate_receipts(
    runtime: Path,
    evidence: Path,
    trusted: dict[str, Path],
    untrusted: dict[str, Path],
) -> Path:
    """Write the public CA and sanitized certificate receipt."""
    public_ca = evidence / "weather-test-ca.pem"
    shutil.copyfile(trusted["ca_cert"], public_ca)
    public_ca.chmod(0o644)
    private_keys = [
        trusted["ca_key"],
        trusted["leaf_key"],
        untrusted["ca_key"],
        untrusted["leaf_key"],
    ]
    receipt = {
        "hosts": ["127.0.0.1", "10.0.2.2"],
        "opensslVersion": subprocess.run(
            ["openssl", "version"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip(),
        "ports": {"trusted": TRUSTED_PORT, "untrusted": UNTRUSTED_PORT},
        "privateKeysMode0600": all(
            stat.S_IMODE(path.stat().st_mode) == 0o600 for path in private_keys
        ),
        "runtimeMode0700": stat.S_IMODE(runtime.stat().st_mode) == 0o700,
        "trustedCaSha256": certificate_sha256(trusted["ca_cert"]),
        "trustedLeafSha256": certificate_sha256(trusted["leaf_cert"]),
        "untrustedCaExported": False,
        "untrustedCaSha256": certificate_sha256(untrusted["ca_cert"]),
        "untrustedLeafSha256": certificate_sha256(untrusted["leaf_cert"]),
    }
    # fail before startup if private boundary modes drift
    if not receipt["privateKeysMode0600"] or not receipt["runtimeMode0700"]:
        raise RuntimeError("fixture private runtime permissions are not restrictive")
    receipt_path = evidence / "certificates.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    receipt_path.chmod(0o644)
    return public_ca


# write the bounded child-process environment after verified readiness
def write_ready_files(runtime: Path, evidence: Path, public_ca: Path) -> None:
    """Write JSON and shell environment contracts."""
    environment = {
        "WEATHER_HTTPS_FIXTURE_ANDROID_ORIGIN": f"https://10.0.2.2:{TRUSTED_PORT}",
        "WEATHER_HTTPS_FIXTURE_ANDROID_UNTRUSTED_ORIGIN": f"https://10.0.2.2:{UNTRUSTED_PORT}",
        "WEATHER_HTTPS_FIXTURE_CA_PEM": str(public_ca.resolve()),
        "WEATHER_HTTPS_FIXTURE_EVIDENCE_DIR": str(evidence.resolve()),
        "WEATHER_HTTPS_FIXTURE_IOS_ORIGIN": f"https://127.0.0.1:{TRUSTED_PORT}",
        "WEATHER_HTTPS_FIXTURE_IOS_UNTRUSTED_ORIGIN": f"https://127.0.0.1:{UNTRUSTED_PORT}",
        "WEATHER_HTTPS_FIXTURE_PASSWORD": LOGIN_PASSWORD,
        "WEATHER_HTTPS_FIXTURE_USERNAME": LOGIN_USERNAME,
    }
    ready = runtime / "ready.json"
    ready.write_text(json.dumps(environment, indent=2, sort_keys=True) + "\n")
    ready.chmod(0o600)
    shell_environment = runtime / "environment.sh"
    shell_environment.write_text(
        "".join(f"export {name}={shlex.quote(value)}\n" for name, value in environment.items())
    )
    shell_environment.chmod(0o600)


# start both listeners and own their bounded shutdown
def serve(runtime: Path, evidence: Path) -> None:
    """Run the fixture until SIGTERM or SIGINT."""
    # require caller-created private and public output boundaries
    if stat.S_IMODE(runtime.stat().st_mode) != 0o700:
        raise RuntimeError("fixture runtime directory must be mode 0700")
    # reject mixed or reused public evidence
    if any(evidence.iterdir()):
        raise RuntimeError("fixture evidence directory must start empty")
    trusted = generate_authority(runtime, "trusted", "Weather Native Fixture Trusted Root")
    untrusted = generate_authority(runtime, "untrusted", "Weather Native Fixture Untrusted Root")
    public_ca = write_certificate_receipts(runtime, evidence, trusted, untrusted)
    state = FixtureState(evidence / "events.jsonl")
    servers = [
        create_server(state, "trusted", TRUSTED_PORT, trusted["leaf_cert"], trusted["leaf_key"]),
        create_server(state, "untrusted", UNTRUSTED_PORT, untrusted["leaf_cert"], untrusted["leaf_key"]),
    ]
    threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
    # start both listeners before publishing readiness
    for thread in threads:
        thread.start()
    stop = threading.Event()

    # translate process signals into one orderly shutdown
    def request_stop(_signum: int, _frame: object) -> None:
        stop.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    verify_listener_readiness(trusted["ca_cert"], untrusted["ca_cert"])
    write_ready_files(runtime, evidence, public_ca)
    stop.wait()
    # stop and close every listener before final receipts
    for server in servers:
        server.shutdown()
        server.server_close()
    # join every bounded listener thread
    for thread in threads:
        thread.join(timeout=5)
    state.write_summary(evidence / "summary.json")


# parse one explicit server invocation
def parse_arguments() -> argparse.Namespace:
    """Parse fixture runtime and evidence directories."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-dir", required=True, type=Path)
    parser.add_argument("--evidence-dir", required=True, type=Path)
    return parser.parse_args()


# validate caller paths and start the server
def main() -> int:
    """Run the fixture CLI."""
    arguments = parse_arguments()
    runtime = arguments.runtime_dir.resolve()
    evidence = arguments.evidence_dir.resolve()
    # reject absent or symlinked output boundaries
    if not runtime.is_dir() or runtime.is_symlink():
        raise RuntimeError("fixture runtime directory is missing or unsafe")
    # require one real caller-created evidence directory
    if not evidence.is_dir() or evidence.is_symlink():
        raise RuntimeError("fixture evidence directory is missing or unsafe")
    os.umask(0o077)
    serve(runtime, evidence)
    return 0


# execute only as a command
if __name__ == "__main__":
    raise SystemExit(main())
