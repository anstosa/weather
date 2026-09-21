#!/usr/bin/env python3
"""Verify retained native HTTPS fixture evidence without secrets."""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

import native_https_fixture as fixture

EXPECTED_FILES = {
    "certificates.json",
    "events.jsonl",
    "lifecycle.json",
    "summary.json",
    "weather-test-ca.pem",
}


# require one boolean event matching every supplied field
def matching_event(events: list[dict[str, object]], event: str, **expected: object) -> int:
    """Return the sequence for one matching event."""
    # inspect all sanitized receipts with the requested event name
    for receipt in events:
        # accept only a complete field match
        if receipt.get("event") == event and all(receipt.get(name) == value for name, value in expected.items()):
            sequence = receipt.get("sequence")
            # require a positive ordered sequence
            if isinstance(sequence, int) and sequence > 0:
                return sequence
    raise ValueError(f"missing required sanitized event: {event}")


# verify the complete retained public evidence boundary
def verify_evidence(evidence: Path) -> None:
    """Raise ValueError when one fixture receipt is missing or unsafe."""
    evidence = evidence.resolve()
    # require one real evidence directory
    if not evidence.is_dir() or evidence.is_symlink():
        raise ValueError("fixture evidence directory is missing or unsafe")
    names = {path.name for path in evidence.iterdir()}
    # reject private logs keys and unrecognized outputs
    if names != EXPECTED_FILES:
        raise ValueError(f"unexpected fixture evidence files: {sorted(names)}")

    public_ca = evidence / "weather-test-ca.pem"
    public_ca_text = public_ca.read_text()
    # retain only one public certificate
    if "BEGIN CERTIFICATE" not in public_ca_text or "PRIVATE KEY" in public_ca_text:
        raise ValueError("fixture public CA file is malformed or contains a private key")

    certificates = json.loads((evidence / "certificates.json").read_text())
    expected_certificate_fields = {
        "hosts": ["127.0.0.1", "10.0.2.2"],
        "ports": {"trusted": fixture.TRUSTED_PORT, "untrusted": fixture.UNTRUSTED_PORT},
        "privateKeysMode0600": True,
        "runtimeMode0700": True,
        "untrustedCaExported": False,
    }
    # lock the certificate and private-runtime boundary
    for name, expected in expected_certificate_fields.items():
        # reject one missing or drifted receipt field
        if certificates.get(name) != expected:
            raise ValueError(f"fixture certificate receipt mismatch: {name}")
    # bind the retained CA bytes to the startup receipt
    if certificates.get("trustedCaSha256") != fixture.certificate_sha256(public_ca):
        raise ValueError("retained fixture CA fingerprint mismatch")
    # require every public fingerprint shape
    for name in (
        "trustedCaSha256",
        "trustedLeafSha256",
        "untrustedCaSha256",
        "untrustedLeafSha256",
    ):
        # reject missing or malformed fingerprints
        if not re.fullmatch(r"[0-9a-f]{64}", str(certificates.get(name, ""))):
            raise ValueError(f"fixture fingerprint is malformed: {name}")

    lifecycle = json.loads((evidence / "lifecycle.json").read_text())
    # prove private and negative trust material was removed before retention
    if lifecycle != {
        "privateKeysArchived": False,
        "receiptVersion": 1,
        "runtimeRemoved": True,
        "untrustedCaArchived": False,
    }:
        raise ValueError("fixture cleanup receipt mismatch")

    event_lines = (evidence / "events.jsonl").read_text().splitlines()
    # reject an empty browser journey
    if not event_lines:
        raise ValueError("fixture event receipt is empty")
    events = [json.loads(line) for line in event_lines]
    allowed_event_fields = {
        "authenticated",
        "atUtc",
        "cookieAccepted",
        "cookiePresent",
        "event",
        "method",
        "path",
        "requestSequence",
        "sequence",
        "setting",
        "status",
    }
    pending_admin: dict[int, dict[str, object]] = {}
    # validate every receipt shape and ordering
    for expected_sequence, event in enumerate(events, start=1):
        # reject extra fields that could retain request material
        if not set(event).issubset(allowed_event_fields):
            raise ValueError("fixture event contains an unapproved field")
        # require contiguous server ordering
        if event.get("sequence") != expected_sequence:
            raise ValueError("fixture event sequence is not contiguous")
        event_name = event.get("event")
        # restrict timestamped milestones to the exact admin GET response
        if event_name in {"unauthenticated-admin", "authenticated-admin", "admin-response-written"}:
            at_utc = event.get("atUtc")
            # require one parseable millisecond UTC timestamp
            if not isinstance(at_utc, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", at_utc):
                raise ValueError("fixture admin timestamp is malformed")
            # parse the full calendar date
            try:
                datetime.strptime(at_utc, "%Y-%m-%dT%H:%M:%S.%fZ")
            # reject calendar-invalid timestamps
            except ValueError as error:
                raise ValueError("fixture admin timestamp is invalid") from error
            # require the frozen successful admin route
            if event.get("method") != "GET" or event.get("path") != "/admin" or event.get("status") != 200:
                raise ValueError("fixture admin milestone is not an exact successful GET")
            signature = (event.get("authenticated"), event.get("cookiePresent"), event.get("cookieAccepted"))
            # reject untyped session-state receipts
            if not all(isinstance(value, bool) for value in signature):
                raise ValueError("fixture admin milestone has untyped session state")
            # match each completed write to an already-recorded admin request
            if event_name == "admin-response-written":
                request_sequence = event.get("requestSequence")
                # require one strict earlier positive request identity
                if type(request_sequence) is not int or not 0 < request_sequence < expected_sequence:
                    raise ValueError("fixture admin response write has an invalid request sequence")
                request = pending_admin.pop(request_sequence, None)
                # reject orphan or duplicate completions
                if request is None:
                    raise ValueError("fixture admin response write lacks its request")
                # preserve the exact request session state
                if signature != (request["authenticated"], request["cookiePresent"], request["cookieAccepted"]):
                    raise ValueError("fixture admin response write mismatches its request")
            else:
                # keep request references off prewrite receipts
                if "requestSequence" in event:
                    raise ValueError("fixture admin request has a response reference")
                pending_admin[expected_sequence] = event
        # prevent admin-only fields from leaking into other events
        elif "atUtc" in event or "requestSequence" in event:
            raise ValueError("fixture non-admin event has an admin milestone field")
    # require all successful fixture journeys to finish admin writes
    if any(pending_admin.values()):
        raise ValueError("fixture admin request lacks a completed response write")

    serialized_events = json.dumps(events, sort_keys=True)
    # reject the known secret and raw header vocabulary
    for forbidden in (
        fixture.LOGIN_PASSWORD,
        fixture.COOKIE_NAME,
        "set-cookie",
        "cookie:",
    ):
        # compare case-insensitively for header-shaped text
        if forbidden.lower() in serialized_events.lower():
            raise ValueError("fixture events retain credential or cookie material")

    matching_event(
        events,
        "login-cookie-set",
        authenticated=True,
        method="POST",
        path="/admin/login",
        status=303,
    )
    matching_event(
        events,
        "authenticated-settings",
        authenticated=True,
        cookieAccepted=True,
        cookiePresent=True,
        method="POST",
        path="/admin/settings",
        setting="celsius",
        status=303,
    )
    logout_sequence = matching_event(
        events,
        "logout-cookie-cleared",
        authenticated=True,
        cookieAccepted=True,
        cookiePresent=True,
        method="POST",
        path="/admin/logout",
        status=200,
    )
    unauthenticated_sequence = matching_event(
        events,
        "unauthenticated-admin",
        authenticated=False,
        cookieAccepted=False,
        method="GET",
        path="/admin",
        status=200,
    )
    # require an unauthenticated request after logout, not only before login
    if unauthenticated_sequence <= logout_sequence:
        later_unauthenticated = [
            event
            for event in events
            if event.get("event") == "unauthenticated-admin"
            and isinstance(event.get("sequence"), int)
            and event["sequence"] > logout_sequence
        ]
        # reject a journey that did not prove logout persistence
        if not later_unauthenticated:
            raise ValueError("fixture lacks an unauthenticated request after logout")

    summary = json.loads((evidence / "summary.json").read_text())
    event_counts = Counter(str(event["event"]) for event in events)
    # bind terminal counts and invalidated session state to the event log
    if summary != {
        "eventCounts": dict(sorted(event_counts.items())),
        "receiptVersion": 1,
        "sessionActiveAtShutdown": False,
    }:
        raise ValueError("fixture summary does not match sanitized events")


# verify one explicit evidence directory
def main() -> int:
    """Run the evidence verifier CLI."""
    # require exactly one directory argument
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} EVIDENCE_DIR", file=sys.stderr)
        return 64
    try:
        verify_evidence(Path(sys.argv[1]))
    # report one bounded validation failure
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"native HTTPS fixture evidence invalid: {error}", file=sys.stderr)
        return 1
    print(f"native HTTPS fixture evidence passed: {Path(sys.argv[1]).resolve()}")
    return 0


# execute only as a command
if __name__ == "__main__":
    raise SystemExit(main())
