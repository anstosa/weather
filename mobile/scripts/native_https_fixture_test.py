#!/usr/bin/env python3
"""Verify the native WebView HTTPS fixture boundary."""

from __future__ import annotations

import http.client
import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.parse import urlencode

import native_https_fixture as fixture
from verify_native_https_fixture_evidence import verify_evidence

SCRIPT_DIR = Path(__file__).resolve().parent
REPOSITORY_ROOT = SCRIPT_DIR.parent.parent
WRAPPER = SCRIPT_DIR / "with-native-https-fixture.sh"


# issue one ordinary CA-verified fixture request
def request(
    method: str,
    path: str,
    *,
    body: bytes | None = None,
    cookie: str | None = None,
) -> tuple[int, bytes, dict[str, str]]:
    """Return status body and normalized headers."""
    context = ssl.create_default_context(cafile=os.environ["WEATHER_HTTPS_FIXTURE_CA_PEM"])
    connection = http.client.HTTPSConnection("127.0.0.1", fixture.TRUSTED_PORT, context=context, timeout=5)
    headers: dict[str, str] = {}
    # declare deterministic HTML form encoding
    if body is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    # return the fake HttpOnly cookie when requested
    if cookie is not None:
        headers["Cookie"] = cookie
    # always close the client socket
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        payload = response.read()
        response_headers = {name.lower(): value for name, value in response.getheaders()}
        return response.status, payload, response_headers
    # release the connection after every response
    finally:
        connection.close()


# encode one deterministic fixture form
def form(**values: str) -> bytes:
    """Return an ASCII URL-encoded form."""
    return urlencode(values).encode("ascii")


# exercise TLS cookies authentication navigation and settings as a child
def exercise_client() -> int:
    """Run the live fixture assertions inside its exported environment."""
    public_markers = {
        "/": [b"<h1>Fixture home</h1>", b"Open fixture forecast", b"Open fixture map in new window", b"Open untrusted TLS fixture"],
        "/forecast": [b"<h1>Fixture forecast</h1>"],
        "/logs": [b"<h1>Fixture logs</h1>"],
        "/map": [b"<h1>Fixture map</h1>"],
        "/policy": [b"Unsafe HTTP fixture", b"Lookalike Weather origin", b"External fixture policy"],
        "/settings": [b"Use Fahrenheit", b"Use Celsius", b"Public unit preference: Fahrenheit", b"localStorage"],
        "/trends": [b"<h1>Fixture trends</h1>"],
    }
    # prove every deterministic public route and DOM contract
    for path, markers in public_markers.items():
        status, body, headers = request("GET", path)
        # require one successful no-store response
        if status != 200 or headers.get("cache-control") != "no-store":
            raise AssertionError(f"public fixture route failed: {path}")
        # require every stable visible or selector marker
        for marker in markers:
            # reject one missing accessible contract marker
            if marker not in body:
                raise AssertionError(f"public fixture marker missing: {path}")

    status, body, _headers = request("GET", "/admin")
    # require the complete unauthenticated form contract
    if status != 200 or not all(
        marker in body
        for marker in (
            b"Fixture sign in",
            b"Fixture username",
            b"Fixture password",
            b"Sign in to fixture",
        )
    ):
        raise AssertionError("unauthenticated administration DOM mismatch")

    status, _body, headers = request(
        "POST",
        "/admin/login",
        body=form(username="wrong", password="wrong"),
    )
    # reject accidental session creation
    if status != 401 or "set-cookie" in headers:
        raise AssertionError("invalid fixture login did not fail closed")

    status, _body, headers = request(
        "POST",
        "/admin/login",
        body=form(
            username=os.environ["WEATHER_HTTPS_FIXTURE_USERNAME"],
            password=os.environ["WEATHER_HTTPS_FIXTURE_PASSWORD"],
        ),
    )
    set_cookie = headers.get("set-cookie", "")
    # require a redirect and one opaque session
    if status != 303 or not set_cookie.startswith(f"{fixture.COOKIE_NAME}="):
        raise AssertionError("valid fixture login did not set the session")
    token = set_cookie.split(";", 1)[0].split("=", 1)[1]
    # lock every session cookie attribute
    if set_cookie != fixture.login_cookie_header(token):
        raise AssertionError("fixture login cookie contract drifted")
    cookie = f"{fixture.COOKIE_NAME}={token}"

    status, body, _headers = request("GET", "/admin", cookie=cookie)
    # require the complete authenticated control surface
    if status != 200 or not all(
        marker in body
        for marker in (
            b"Fixture administration",
            b"Authenticated fixture session",
            b"Fixture server unit",
            b"Save fixture settings",
            b"HttpOnly session hidden",
            b"Sign out of fixture",
        )
    ):
        raise AssertionError("authenticated administration DOM mismatch")

    status, _body, headers = request(
        "POST",
        "/admin/settings",
        body=form(unit="celsius"),
        cookie=cookie,
    )
    # require the protected mutation redirect
    if status != 303 or headers.get("location") != "/admin":
        raise AssertionError("authenticated fixture setting did not persist")
    status, body, _headers = request("GET", "/admin/settings-state", cookie=cookie)
    # require server-side authenticated persistence
    if status != 200 or json.loads(body) != {"authenticated": True, "unit": "celsius"}:
        raise AssertionError("fixture setting receipt mismatch")

    status, body, headers = request(
        "POST",
        "/admin/logout",
        cookie=cookie,
    )
    # lock every deletion cookie attribute
    if status != 200 or headers.get("set-cookie") != fixture.logout_cookie_header():
        raise AssertionError("fixture logout cookie contract drifted")
    # require one visible logout marker
    if b"Fixture session signed out" not in body:
        raise AssertionError("fixture logout marker missing")
    status, body, _headers = request("GET", "/admin", cookie=cookie)
    # reject reuse of an invalidated cookie
    if status != 200 or b"Fixture sign in" not in body or b"Authenticated fixture session" in body:
        raise AssertionError("fixture logout did not invalidate the session")

    status, _body, _headers = request("GET", "/forecast?days=1")
    # reject input outside the frozen route contract
    if status != 400:
        raise AssertionError("fixture query input was accepted")

    untrusted_context = ssl.create_default_context(cafile=os.environ["WEATHER_HTTPS_FIXTURE_CA_PEM"])
    untrusted = http.client.HTTPSConnection(
        "127.0.0.1",
        fixture.UNTRUSTED_PORT,
        context=untrusted_context,
        timeout=5,
    )
    # always close the deliberately failing TLS connection
    try:
        # require normal TLS verification to reject the second CA
        try:
            untrusted.request("GET", "/tls-negative")
            untrusted.getresponse()
        # accept only an SSL-layer rejection
        except ssl.SSLError:
            pass
        # reject an unexpectedly trusted negative listener
        else:
            raise AssertionError("untrusted fixture unexpectedly chained to the trusted CA")
    # release the negative-test socket
    finally:
        untrusted.close()
    return 0


# group shared server and wrapper regressions
class NativeHTTPSFixtureTest(unittest.TestCase):
    """Lock the shared HTTPS fixture contract."""

    # require a post-write receipt only after admin response completion
    def test_admin_response_receipt_requires_successful_write(self) -> None:
        """Separate request arrival from completed server-side response writes."""
        with tempfile.TemporaryDirectory(prefix="weather-fixture-admin-write-") as root:
            events_path = Path(root) / "events.jsonl"
            state = fixture.FixtureState(events_path)
            handler = fixture.FixtureRequestHandler.__new__(fixture.FixtureRequestHandler)
            handler.server = SimpleNamespace(fixture_state=state, listener_name="trusted")
            handler.path = "/admin"
            handler.command = "GET"
            handler.headers = {"Host": "127.0.0.1"}
            handler.send_response = Mock()
            handler.send_header = Mock()
            handler.end_headers = Mock()
            handler.wfile = SimpleNamespace(write=Mock())

            handler.do_GET()
            events = [json.loads(line) for line in events_path.read_text().splitlines()]
            self.assertEqual([event["event"] for event in events], ["unauthenticated-admin", "admin-response-written"])
            self.assertEqual(events[0]["path"], "/admin")
            self.assertEqual(events[1]["status"], 200)
            self.assertEqual(events[1]["requestSequence"], events[0]["sequence"])
            self.assertIn("atUtc", events[0])
            self.assertIn("atUtc", events[1])
            self.assertIn(b"Fixture sign in", handler.wfile.write.call_args.args[0])

            # reset only this in-memory receipt boundary before a failed write
            state = fixture.FixtureState(events_path)
            handler.server = SimpleNamespace(fixture_state=state, listener_name="trusted")
            handler.wfile = SimpleNamespace(write=Mock(side_effect=BrokenPipeError("simulated body write failure")))
            with self.assertRaises(BrokenPipeError):
                handler.do_GET()
            events = [json.loads(line) for line in events_path.read_text().splitlines()]
            self.assertEqual([event["event"] for event in events], ["unauthenticated-admin"])
            handler.wfile.write.assert_called_once()

    # bind interleaved same-session writes to their exact requests
    def test_admin_response_receipts_preserve_interleaved_request_identity(self) -> None:
        """Require per-request sequence references when completion order reverses."""
        with tempfile.TemporaryDirectory(prefix="weather-fixture-admin-interleave-") as root:
            events_path = Path(root) / "events.jsonl"
            state = fixture.FixtureState(events_path)

            # create only the minimal real handler methods for two GETs
            def make_handler() -> fixture.FixtureRequestHandler:
                handler = fixture.FixtureRequestHandler.__new__(fixture.FixtureRequestHandler)
                handler.server = SimpleNamespace(fixture_state=state, listener_name="trusted")
                handler.path = "/admin"
                handler.command = "GET"
                handler.headers = {"Host": "127.0.0.1"}
                handler.send_response = Mock()
                handler.send_header = Mock()
                handler.end_headers = Mock()
                handler.wfile = SimpleNamespace(write=Mock())
                return handler

            first = make_handler()
            second = make_handler()

            # finish the second response while the first body write is active
            def interleave_write(_body: bytes) -> None:
                second.do_GET()

            first.wfile.write = Mock(side_effect=interleave_write)
            first.do_GET()
            events = [json.loads(line) for line in events_path.read_text().splitlines()]
            self.assertEqual(
                [event["event"] for event in events],
                ["unauthenticated-admin", "unauthenticated-admin", "admin-response-written", "admin-response-written"],
            )
            self.assertEqual(events[2]["requestSequence"], events[1]["sequence"])
            self.assertEqual(events[3]["requestSequence"], events[0]["sequence"])

    # verify the production-shaped cookie attributes exactly
    def test_cookie_headers_are_exact(self) -> None:
        """Require exact login and logout cookie contracts."""
        self.assertEqual(
            fixture.login_cookie_header("opaque-token"),
            "weather_admin_session=opaque-token; Path=/; HttpOnly; Max-Age=1800; SameSite=None; Secure; Partitioned",
        )
        self.assertEqual(
            fixture.logout_cookie_header(),
            "weather_admin_session=; Path=/; HttpOnly; Max-Age=0; SameSite=None; Secure; Partitioned",
        )
        # reject values that could add a response header attribute
        for invalid in ("", "value; Domain=example.invalid", "value\r\nInjected: true"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    fixture.login_cookie_header(invalid)

    # keep an idle raw TCP peer from blocking a verified HTTPS request
    def test_idle_tcp_does_not_block_verified_health(self) -> None:
        """Require concurrency before the TLS handshake completes."""
        with tempfile.TemporaryDirectory(prefix="weather-fixture-idle-") as root:
            runtime = Path(root)
            authority = fixture.generate_authority(runtime, "idle", "Weather Fixture Idle Root")
            state = fixture.FixtureState(runtime / "events.jsonl")
            server = fixture.create_server(
                state,
                "trusted",
                0,
                authority["leaf_cert"],
                authority["leaf_key"],
            )
            accepted = threading.Event()
            original_get_request = server.get_request

            # signal only after the real listener has accepted the idle peer
            def observed_get_request() -> tuple[socket.socket, tuple[str, int]]:
                result = original_get_request()
                accepted.set()
                return result

            server.get_request = observed_get_request  # type: ignore[method-assign]
            serving = threading.Thread(target=server.serve_forever, daemon=True)
            serving.start()
            idle = socket.create_connection(server.server_address, timeout=2)
            try:
                self.assertTrue(accepted.wait(timeout=2), "raw TCP peer blocked listener accept")
                self.assertEqual(
                    fixture.verified_health(server.server_address[1], authority["ca_cert"]),
                    b"trusted fixture ready\n",
                )
            # close the idle peer only after verified HTTPS completes
            finally:
                idle.close()
                server.shutdown()
                server.server_close()
                serving.join(timeout=2)
            self.assertFalse(serving.is_alive(), "fixture listener thread did not stop")

    # keep a stalled handshake from delaying listener shutdown
    def test_idle_tcp_does_not_block_listener_shutdown(self) -> None:
        """Close the accept loop while an idle client still owns its socket."""
        with tempfile.TemporaryDirectory(prefix="weather-fixture-shutdown-") as root:
            runtime = Path(root)
            authority = fixture.generate_authority(runtime, "shutdown", "Weather Fixture Shutdown Root")
            state = fixture.FixtureState(runtime / "events.jsonl")
            server = fixture.create_server(
                state,
                "trusted",
                0,
                authority["leaf_cert"],
                authority["leaf_key"],
            )
            accepted = threading.Event()
            original_get_request = server.get_request

            # signal only after the real listener has accepted the idle peer
            def observed_get_request() -> tuple[socket.socket, tuple[str, int]]:
                result = original_get_request()
                accepted.set()
                return result

            server.get_request = observed_get_request  # type: ignore[method-assign]
            serving = threading.Thread(target=server.serve_forever, daemon=True)
            serving.start()
            idle = socket.create_connection(server.server_address, timeout=2)
            accepted_before_shutdown = accepted.wait(timeout=2)
            stopping = threading.Thread(
                target=lambda: (server.shutdown(), server.server_close()),
                daemon=True,
            )
            stopping.start()
            stopping.join(timeout=2)
            # release the idle peer only after observing shutdown progress
            completed_with_idle_open = not stopping.is_alive()
            idle.close()
            stopping.join(timeout=2)
            serving.join(timeout=2)
            self.assertTrue(accepted_before_shutdown, "raw TCP peer blocked listener accept")
            self.assertTrue(completed_with_idle_open, "idle TLS peer blocked listener shutdown")
            self.assertFalse(serving.is_alive(), "fixture listener thread did not stop")

    # verify a live trusted and deliberately untrusted TLS run
    def test_wrapper_exercises_tls_auth_and_sanitized_receipts(self) -> None:
        """Run the real fixture process and inspect retained evidence."""
        with tempfile.TemporaryDirectory(prefix="weather-fixture-test-") as root:
            evidence = Path(root) / "evidence"
            completed = subprocess.run(
                [
                    str(WRAPPER),
                    "--evidence-dir",
                    str(evidence),
                    "--",
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--exercise-client",
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=45,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn("native HTTPS fixture evidence passed:", completed.stdout)

            self.assertEqual(
                {path.name for path in evidence.iterdir()},
                {
                    "certificates.json",
                    "events.jsonl",
                    "lifecycle.json",
                    "summary.json",
                    "weather-test-ca.pem",
                },
            )
            public_ca = (evidence / "weather-test-ca.pem").read_text()
            self.assertIn("BEGIN CERTIFICATE", public_ca)
            self.assertNotIn("PRIVATE KEY", public_ca)
            certificate_receipt = json.loads((evidence / "certificates.json").read_text())
            self.assertEqual(certificate_receipt["hosts"], ["127.0.0.1", "10.0.2.2"])
            self.assertEqual(
                certificate_receipt["ports"],
                {"trusted": fixture.TRUSTED_PORT, "untrusted": fixture.UNTRUSTED_PORT},
            )
            self.assertTrue(certificate_receipt["privateKeysMode0600"])
            self.assertTrue(certificate_receipt["runtimeMode0700"])
            self.assertFalse(certificate_receipt["untrustedCaExported"])
            lifecycle = json.loads((evidence / "lifecycle.json").read_text())
            self.assertEqual(
                lifecycle,
                {
                    "privateKeysArchived": False,
                    "receiptVersion": 1,
                    "runtimeRemoved": True,
                    "untrustedCaArchived": False,
                },
            )

            events = [json.loads(line) for line in (evidence / "events.jsonl").read_text().splitlines()]
            by_name = {event["event"]: event for event in events}
            self.assertEqual(by_name["login-cookie-set"]["status"], 303)
            self.assertTrue(by_name["authenticated-settings"]["cookieAccepted"])
            self.assertEqual(by_name["authenticated-settings"]["setting"], "celsius")
            self.assertTrue(by_name["logout-cookie-cleared"]["cookiePresent"])
            self.assertTrue(by_name["logout-cookie-cleared"]["cookieAccepted"])
            self.assertFalse(by_name["unauthenticated-admin"]["authenticated"])
            self.assertEqual(by_name["admin-response-written"]["path"], "/admin")
            self.assertIn("atUtc", by_name["unauthenticated-admin"])
            self.assertIn("atUtc", by_name["admin-response-written"])
            self.assertGreater(by_name["admin-response-written"]["requestSequence"], 0)
            receipt_text = "\n".join(
                path.read_text()
                for path in evidence.iterdir()
                if path.suffix in {".json", ".jsonl"}
            )
            # reject sensitive fixture material from every receipt
            for forbidden in (
                fixture.LOGIN_PASSWORD,
                fixture.COOKIE_NAME,
                "Set-Cookie",
                "Cookie:",
                "opaque-token",
            ):
                self.assertNotIn(forbidden, receipt_text)
            self.assertFalse(any(path.name.endswith("key.pem") for path in evidence.iterdir()))
            verify_evidence(evidence)

            # rewrite only disposable test receipts for verifier rejection cases
            def write_events(receipts: list[dict[str, object]]) -> None:
                (evidence / "events.jsonl").write_text(
                    "".join(json.dumps(event, sort_keys=True) + "\n" for event in receipts)
                )

            # reject an impossible calendar timestamp
            altered = [dict(event) for event in events]
            admin_write = next(event for event in altered if event["event"] == "admin-response-written")
            admin_write["atUtc"] = "2026-99-21T09:18:01.000Z"
            write_events(altered)
            with self.assertRaisesRegex(ValueError, "fixture admin timestamp is invalid"):
                verify_evidence(evidence)

            # reject a response linked to an absent request
            altered = [dict(event) for event in events]
            admin_write = next(event for event in altered if event["event"] == "admin-response-written")
            admin_write["requestSequence"] = 999_999
            write_events(altered)
            with self.assertRaisesRegex(ValueError, "invalid request sequence"):
                verify_evidence(evidence)

            # reject reuse of an already-consumed request identity
            altered = [dict(event) for event in events]
            admin_writes = [event for event in altered if event["event"] == "admin-response-written"]
            admin_writes[1]["requestSequence"] = admin_writes[0]["requestSequence"]
            write_events(altered)
            with self.assertRaisesRegex(ValueError, "lacks its request"):
                verify_evidence(evidence)

            # reject a write with altered session state for its exact request
            altered = [dict(event) for event in events]
            admin_write = next(event for event in altered if event["event"] == "admin-response-written")
            admin_write["authenticated"] = not admin_write["authenticated"]
            write_events(altered)
            with self.assertRaisesRegex(ValueError, "mismatches its request"):
                verify_evidence(evidence)

    # verify private evidence cannot accidentally land in the checkout
    def test_wrapper_rejects_repository_evidence_path(self) -> None:
        """Reject retained output paths below Git."""
        forbidden = REPOSITORY_ROOT / ".fixture-evidence-must-not-exist"
        self.assertFalse(forbidden.exists())
        completed = subprocess.run(
            [str(WRAPPER), "--evidence-dir", str(forbidden), "--", "true"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(completed.returncode, 64)
        self.assertIn("outside the repository", completed.stderr)
        self.assertFalse(forbidden.exists())

    # clean private keys even when the native child fails
    def test_wrapper_cleans_runtime_after_child_failure(self) -> None:
        """Retain only sanitized evidence on a failing child."""
        with tempfile.TemporaryDirectory(prefix="weather-fixture-failure-") as root:
            evidence = Path(root) / "evidence"
            completed = subprocess.run(
                [
                    str(WRAPPER),
                    "--evidence-dir",
                    str(evidence),
                    "--",
                    sys.executable,
                    "-c",
                    "raise SystemExit(23)",
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=45,
            )
            self.assertEqual(completed.returncode, 23, completed.stderr)
            self.assertEqual(
                json.loads((evidence / "lifecycle.json").read_text()),
                {
                    "privateKeysArchived": False,
                    "receiptVersion": 1,
                    "runtimeRemoved": True,
                    "untrustedCaArchived": False,
                },
            )
            self.assertFalse(any("key" in path.name for path in evidence.iterdir()))
            self.assertFalse(any("untrusted" in path.name for path in evidence.iterdir()))

    # keep native build products outside production Docker contexts
    def test_docker_context_excludes_native_outputs(self) -> None:
        """Require exact generated-output exclusions."""
        ignored = set((REPOSITORY_ROOT / ".dockerignore").read_text().splitlines())
        self.assertTrue(
            {
                "mobile/android/.gradle",
                "mobile/android/.kotlin",
                "mobile/android/app/build",
                "mobile/android/build",
                "mobile/android/host-evidence",
                "mobile/ios/.artifacts",
                "mobile/ios/.derived-data",
                "mobile/ios/.host-evidence",
                "mobile/ios/.results",
            }.issubset(ignored)
        )


# separate the live child command from the unittest runner
if __name__ == "__main__" and sys.argv[1:] == ["--exercise-client"]:
    raise SystemExit(exercise_client())

# run tests only when invoked directly without the child marker
if __name__ == "__main__":
    unittest.main()
