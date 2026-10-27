"""Bounded, product-neutral network metadata capture for the egress Guardian.

By default only capture hosts are forwarded. With TAE_EGRESS_INTERCEPT_ALL=1
(the controller-host Guardian) every host is forwarded: capture hosts keep the
full policy, while other hosts are streamed and journaled as metadata rows
within a separate, non-truncating budget.
"""

from __future__ import annotations

import datetime
import gzip
import hashlib
import io
import ipaddress
import json
import os
import re
import shutil
import socket
import sys
import threading
import time
from urllib.parse import urlsplit

from mitmproxy import http


LOG_PATH = os.environ["TAE_EGRESS_LOG"]
CONTROL_TOKEN = os.environ["TAE_EGRESS_CONTROL_TOKEN"]
CONTROL_HOST = "tae-egress-control.invalid"
CONTROL_PREFIX = "/__tae_egress_control__"
# The controller proves the workload -> relay -> Guardian path with a CONNECT
# to this reserved name when a task has no capture hosts; it never resolves.
PREFLIGHT_HOST = "preflight.hurdle.invalid"
MAX_ROWS = min(10_000, max(1, int(os.environ.get("TAE_EGRESS_MAX_ROWS", "10000"))))
MAX_JOURNAL_BYTES = min(
    15 * 1024 * 1024,
    max(1, int(os.environ.get("TAE_EGRESS_MAX_BYTES", str(15 * 1024 * 1024)))),
)
MAX_PATH_BYTES = 4096
INTERCEPT_ALL = os.environ.get("TAE_EGRESS_INTERCEPT_ALL") == "1"
MAX_OBSERVED_ROWS = min(
    MAX_ROWS // 2,
    max(0, int(os.environ.get("TAE_EGRESS_OBSERVED_MAX_ROWS", str(MAX_ROWS // 2)))),
)
MAX_OBSERVED_BYTES = min(
    MAX_JOURNAL_BYTES // 3,
    max(0, int(os.environ.get("TAE_EGRESS_OBSERVED_MAX_BYTES", str(MAX_JOURNAL_BYTES // 3)))),
)
MAX_SAFE_COUNTER = 9_007_199_254_740_991
MAX_BODY_BYTES = 1024 * 1024
MAX_JSON_DEPTH = 32
MAX_JSON_NODES = 100_000
MAX_FACT_MATCHES_PER_EXCHANGE = 128
MAX_FACT_BYTES_PER_EXCHANGE = 64 * 1024
MAX_FACT_EXCHANGES = 256
PATH_SEGMENT_TEMPLATE = "{segment}"
MAX_FACT_BYTES_PER_RUN = 1024 * 1024
SENSITIVE_POINTER_TERMS = (
    "prompt",
    "content",
    "answer",
    "text",
    "reasoning",
    "output",
    "secret",
    "password",
    "authorization",
    "cookie",
    "token",
    "input",
    "embedding",
)
CAPTURE_HOSTS = frozenset(
    str(host).lower().rstrip(".")
    for host in json.loads(os.environ["TAE_EGRESS_CAPTURE_HOSTS"])
)
# Pass-through hosts carry the Agent's own model traffic. The Guardian swaps in
# the real Agent credential and streams the exchange, but never journals it or
# applies request policy: it is not evaluation evidence.
PASSTHROUGH_HOSTS = frozenset(
    str(host).lower().rstrip(".")
    for host in json.loads(os.environ.get("TAE_EGRESS_PASSTHROUGH_HOSTS", "[]"))
)
if CAPTURE_HOSTS & PASSTHROUGH_HOSTS:
    raise RuntimeError("capture and pass-through hosts overlap")
# Without intercept-all, these are the only destinations the Guardian dials.
ROUTED_HOSTS = CAPTURE_HOSTS | PASSTHROUGH_HOSTS
SUBSTITUTIONS = tuple(json.loads(os.environ.get("TAE_EGRESS_SUBSTITUTIONS", "[]")))
# Hosts a real credential may be sent to. A request whose Host header names one
# must also be tunnelled to it, or the Guardian refuses it.
CREDENTIAL_HOSTS = frozenset(
    str(host).lower().rstrip(".")
    for binding in SUBSTITUTIONS
    for host in binding.get("hosts", [])
)
SELECTED_RESPONSE_HEADERS = {
    str(host).lower().rstrip("."): tuple(str(name).lower() for name in names)
    for host, names in json.loads(
        os.environ.get("TAE_EGRESS_SELECTED_RESPONSE_HEADERS", "{}")
    ).items()
}


def _load_blocked_requests() -> tuple[tuple[str, str], ...]:
    try:
        rules = json.loads(os.environ.get("TAE_EGRESS_BLOCKED_REQUESTS", "[]"))
    except (TypeError, ValueError) as error:
        raise RuntimeError("invalid blocked request policy") from error
    if not isinstance(rules, list) or len(rules) > 128:
        raise RuntimeError("invalid blocked request policy")
    ids: set[str] = set()
    pairs: set[tuple[str, str]] = set()
    for rule in rules:
        if not _closed_object(rule, frozenset(("id", "method", "path"))):
            raise RuntimeError("invalid blocked request policy")
        rule_id = rule.get("id")
        method = rule.get("method")
        path = rule.get("path")
        if (
            not _valid_id(rule_id)
            or not isinstance(method, str)
            or re.fullmatch(r"[A-Z]{1,16}", method) is None
            or not _valid_path(path)
            or rule_id in ids
            or (method, path) in pairs
        ):
            raise RuntimeError("invalid blocked request policy")
        ids.add(rule_id)
        pairs.add((method, path))
    return tuple(sorted(pairs))


class FactCaptureError(Exception):
    """Closed exchange-fact failure whose message is never persisted."""


class DuplicateJsonKey(FactCaptureError):
    pass


def _closed_object(value: object, fields: frozenset[str]) -> bool:
    return isinstance(value, dict) and frozenset(value) == fields


def _valid_id(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,127}", value) is not None


def _valid_pointer(pointer: object) -> bool:
    if not isinstance(pointer, str) or not pointer.startswith("/"):
        return False
    if len(pointer.encode("utf-8")) > 256:
        return False
    segments = pointer[1:].split("/")
    if len(segments) > 16 or sum(segment == "*" for segment in segments) > 2:
        return False
    for segment in segments:
        index = 0
        while index < len(segment):
            if segment[index] == "~":
                if index + 1 >= len(segment) or segment[index + 1] not in ("0", "1"):
                    return False
                index += 2
            else:
                index += 1
    return True


def _valid_selector(selector: object) -> bool:
    if not isinstance(selector, dict) or frozenset(selector) not in (
        frozenset(("id", "pointer", "projection")),
        frozenset(("id", "pointer", "maxMatches", "projection")),
    ):
        return False
    if not _valid_id(selector.get("id")) or not _valid_pointer(selector.get("pointer")):
        return False
    wildcard_count = selector["pointer"].split("/").count("*")
    if wildcard_count:
        if type(selector.get("maxMatches")) is not int or not (
            1 <= selector["maxMatches"] <= 32
        ):
            return False
    elif "maxMatches" in selector:
        return False
    decoded_segments = [
        segment.replace("~1", "/").replace("~0", "~")
        for segment in selector["pointer"][1:].split("/")
    ]
    if any(
        term in re.sub(r"[^a-z0-9]", "", segment.lower())
        for segment in decoded_segments
        if segment != "*"
        for term in SENSITIVE_POINTER_TERMS
    ):
        return False
    projection = selector.get("projection")
    if projection == {"kind": "present"}:
        return True
    if _closed_object(projection, frozenset(("kind", "maxItems"))):
        return projection["kind"] == "count" and type(projection["maxItems"]) is int and (
            0 <= projection["maxItems"] <= 4096
        )
    if _closed_object(projection, frozenset(("kind", "maxInputBytes"))):
        return projection["kind"] == "sha256-string" and type(
            projection["maxInputBytes"]
        ) is int and 1 <= projection["maxInputBytes"] <= 64 * 1024
    return False


def _valid_path(path: object) -> bool:
    return isinstance(path, str) and path.startswith("/") and "?" not in path and "#" not in path and (
        len(path.encode("utf-8")) <= MAX_PATH_BYTES
    )


BLOCKED_REQUESTS = frozenset(_load_blocked_requests())


def _template_segments(template: object) -> list[str] | None:
    if not _valid_path(template):
        return None
    assert isinstance(template, str)
    segments = template.split("/")[1:]
    placeholders = sum(segment == PATH_SEGMENT_TEMPLATE for segment in segments)
    if not 1 <= placeholders <= 4 or any(
        not segment or (("{" in segment or "}" in segment) and segment != PATH_SEGMENT_TEMPLATE)
        for segment in segments
    ):
        return None
    return segments


def _path_shapes_overlap(left: str, right: str) -> bool:
    left_segments = left.split("/")[1:]
    right_segments = right.split("/")[1:]
    return len(left_segments) == len(right_segments) and all(
        left_segment == PATH_SEGMENT_TEMPLATE
        or right_segment == PATH_SEGMENT_TEMPLATE
        or left_segment == right_segment
        for left_segment, right_segment in zip(left_segments, right_segments)
    )


def _path_matches(shape: str, path: str) -> bool:
    if PATH_SEGMENT_TEMPLATE not in shape:
        return shape == path
    template_segments = _template_segments(shape)
    path_segments = path.split("/")[1:]
    return template_segments is not None and len(template_segments) == len(path_segments) and all(
        (1 <= len(path_segment.encode("utf-8")) <= 512)
        if template_segment == PATH_SEGMENT_TEMPLATE
        else template_segment == path_segment
        for template_segment, path_segment in zip(template_segments, path_segments)
    )


def _load_exchange_facts() -> dict[str, object] | None:
    raw = os.environ.get("TAE_EGRESS_EXCHANGE_FACTS")
    if raw is None or raw == "" or raw == "null":
        return None
    try:
        policy = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise FactCaptureError("invalid-policy") from error
    if not _closed_object(
        policy,
        frozenset(("schemaVersion", "captureProfile", "policyFingerprint", "profiles")),
    ):
        raise FactCaptureError("invalid-policy")
    if policy["schemaVersion"] != 1 or policy["captureProfile"] != "bounded-json-exchange-facts-v1":
        raise FactCaptureError("invalid-policy")
    fingerprint = policy["policyFingerprint"]
    if not isinstance(fingerprint, str) or re.fullmatch(r"sha256:[a-f0-9]{64}", fingerprint) is None:
        raise FactCaptureError("invalid-policy")
    profiles = policy["profiles"]
    if not isinstance(profiles, list) or not (1 <= len(profiles) <= 8):
        raise FactCaptureError("invalid-policy")
    selector_total = 0
    profile_ids: set[str] = set()
    match_keys: list[tuple[str, str, int]] = []
    for profile in profiles:
        if not _closed_object(
            profile,
            frozenset(("id", "match", "requestJson", "responseJson")),
        ) or not _valid_id(profile.get("id")) or profile["id"] in profile_ids:
            raise FactCaptureError("invalid-policy")
        profile_ids.add(profile["id"])
        match = profile["match"]
        if not (
            _closed_object(match, frozenset(("method", "paths", "statusCodes")))
            or _closed_object(match, frozenset(("method", "pathTemplates", "statusCodes")))
        ):
            raise FactCaptureError("invalid-policy")
        if not isinstance(match["method"], str) or re.fullmatch(r"[A-Z]{1,16}", match["method"]) is None:
            raise FactCaptureError("invalid-policy")
        shapes = match.get("paths", match.get("pathTemplates"))
        if not isinstance(shapes, list) or not shapes or len(shapes) > 32:
            raise FactCaptureError("invalid-policy")
        if len(set(shapes)) != len(shapes):
            raise FactCaptureError("invalid-policy")
        if "paths" in match and any(
            not _valid_path(path) or "{" in path or "}" in path for path in shapes
        ):
            raise FactCaptureError("invalid-policy")
        if "pathTemplates" in match and any(_template_segments(path) is None for path in shapes):
            raise FactCaptureError("invalid-policy")
        if not isinstance(match["statusCodes"], list) or not match["statusCodes"] or any(
            type(status) is not int or not 100 <= status <= 599
            for status in match["statusCodes"]
        ):
            raise FactCaptureError("invalid-policy")
        if len(set(match["statusCodes"])) != len(match["statusCodes"]):
            raise FactCaptureError("invalid-policy")
        for path in shapes:
            for status in match["statusCodes"]:
                if any(
                    owner_method == match["method"]
                    and owner_status == status
                    and _path_shapes_overlap(owner_path, path)
                    for owner_method, owner_path, owner_status in match_keys
                ):
                    raise FactCaptureError("invalid-policy")
                match_keys.append((match["method"], path, status))
        if not isinstance(profile["requestJson"], list) or not isinstance(profile["responseJson"], list):
            raise FactCaptureError("invalid-policy")
        selectors = [*profile["requestJson"], *profile["responseJson"]]
        if not 1 <= len(selectors) <= 24 or any(
            not _valid_selector(selector) for selector in selectors
        ):
            raise FactCaptureError("invalid-policy")
        if len({selector["id"] for selector in profile["requestJson"]}) != len(profile["requestJson"]) or len(
            {selector["id"] for selector in profile["responseJson"]}
        ) != len(profile["responseJson"]):
            raise FactCaptureError("invalid-policy")
        selector_total += len(selectors)
    if selector_total > 64:
        raise FactCaptureError("invalid-policy")
    return policy


EXCHANGE_FACTS = _load_exchange_facts()


# Public by every other measure, yet a cloud metadata service.
_NON_GLOBAL_EXCEPTIONS = (ipaddress.ip_network("168.63.129.16/32"),)
# IPv6 addresses that stand for an IPv4 address. A NAT64 gateway or the host
# itself would reach the IPv4 address they carry, so they are judged by it.
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_LOCAL_NAT64 = ipaddress.ip_network("64:ff9b:1::/48")
_IPV4_COMPATIBLE = ipaddress.ip_network("::/96")
_AUTHORITY = re.compile(r"[A-Za-z0-9._:\[\]-]+")


def _resolve(host: str):
    return socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)


def _non_global_address(address: ipaddress._BaseAddress) -> bool:
    if address.version == 6:
        if address in _LOCAL_NAT64:
            return True
        carried = address.ipv4_mapped or address.sixtofour
        if carried is None and (address in _NAT64 or address in _IPV4_COMPATIBLE):
            carried = ipaddress.IPv4Address(int(address) & 0xFFFF_FFFF)
        if carried is not None and _non_global_address(carried):
            return True
    return not address.is_global or any(address in network for network in _NON_GLOBAL_EXCEPTIONS)


def _addresses(host: str) -> list:
    """Every address a destination names, in the resolver's order; raises
    OSError when it does not resolve."""
    host = (host or "").strip().lower().rstrip(".").strip("[]")
    try:
        return [ipaddress.ip_address(host)]
    except ValueError:
        pass
    ordered: list = []
    for family, _, _, _, sockaddr in _resolve(host):
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        address = ipaddress.ip_address(sockaddr[0])
        if address not in ordered:
            ordered.append(address)
    return ordered


def _authority(value: str) -> tuple[str, int | None] | None:
    """The host and port an authority or Host header names; None when malformed."""
    if not _AUTHORITY.fullmatch(value):
        return None
    try:
        parts = urlsplit("//" + value)
        port = parts.port
    except ValueError:
        return None
    if parts.username is not None or parts.path or not parts.hostname:
        return None
    return parts.hostname.rstrip("."), port


def _non_global_destination(host: str) -> bool:
    """True when the host names a non-public address.

    With every host intercepted, the Guardian dials upstream from the
    controller machine, so an agent must not reach that machine's loopback,
    its network or a cloud metadata service through it. A name that does not
    resolve is left to fail on its own; that keeps reserved control and
    preflight names working. This is an early refusal only: server_connect
    checks and pins the address that is actually dialled.
    """
    if not (host or "").strip():
        return False
    try:
        addresses = _addresses(host)
    except (OSError, UnicodeError):
        return False
    return any(_non_global_address(address) for address in addresses)


def _swapped_header(current: str, surrogate: str, value: str) -> str | None:
    """The header value with the real credential in place of an exact stand-in.

    Only a whole value is swapped: the bare stand-in, or one Bearer credential.
    A stand-in anywhere else would let the Agent choose where the real value
    lands, for example inside text a server quotes back in an error.
    """
    if current == surrogate:
        return value
    scheme, separator, credential = current.partition(" ")
    if separator and scheme.lower() == "bearer" and credential == surrogate:
        return f"{scheme} {value}"
    return None


class _ResponseScrubber:
    """Puts the stand-ins back wherever a response repeats a real credential.

    As a mitmproxy stream callable it sees the body chunk by chunk. A real
    value split across chunks is caught by holding back only the end of each
    chunk that could still grow into one; the empty final chunk flushes it.
    """

    def __init__(self, replacements: dict[bytes, bytes]) -> None:
        self.replacements = sorted(replacements.items(), key=lambda pair: -len(pair[0]))
        self.held = b""

    def scrub(self, data: bytes) -> bytes:
        for real, surrogate in self.replacements:
            data = data.replace(real, surrogate)
        return data

    def _partial_end(self, data: bytes) -> int:
        longest = 0
        for real, _ in self.replacements:
            for size in range(min(len(real) - 1, len(data)), longest, -1):
                if real.startswith(data[-size:]):
                    longest = size
                    break
        return longest

    def __call__(self, chunk: bytes) -> bytes:
        if not chunk:
            rest, self.held = self.scrub(self.held), b""
            return rest
        data = self.scrub(self.held + chunk)
        keep = self._partial_end(data)
        self.held = data[len(data) - keep:] if keep else b""
        return data[: len(data) - keep]


class GenericGuardian:
    def __init__(self) -> None:
        self.active = 0
        self.sealed = False
        self.sequence = 0
        self.journal_bytes = 0
        self.truncated = False
        self.fact_bytes = 0
        self.fact_exchanges = 0
        self.observed_rows = 0
        self.observed_bytes = 0
        self.observed_dropped = 0
        self._started: dict[str, float] = {}
        self._observed: dict[str, float] = {}
        self._observed_websockets: dict[str, dict[str, int]] = {}
        self._websockets: dict[str, dict[str, int]] = {}
        self._passthrough: set[str] = set()
        # Flow id -> {real value: stand-in} for every credential swapped into
        # that flow's request; its response gets the stand-ins back.
        self._scrub: dict[str, dict[bytes, bytes]] = {}
        # Server connection id -> (the name server_connect checked and pinned,
        # the client connection it serves). A tunnel's requests keep naming its
        # first server connection after a reconnect, so a pin lasts as long as
        # the client connection, not the server connection.
        self._pinned: dict[str, tuple[str, object]] = {}
        self._client_pins: dict[object, set[str]] = {}
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "xb"):
            pass

    def _digest(self) -> str | None:
        if self.active != 0:
            return None
        with open(LOG_PATH, "rb") as handle:
            return "sha256:" + hashlib.sha256(handle.read()).hexdigest()

    def _state(self) -> dict[str, object]:
        return {
            "sealed": self.sealed,
            "activeFlows": self.active,
            "rowCount": self.sequence,
            "journalBytes": self.journal_bytes,
            "maxRows": MAX_ROWS,
            "maxJournalBytes": MAX_JOURNAL_BYTES,
            "maxPathBytes": MAX_PATH_BYTES,
            "truncated": self.truncated,
            "journalDigest": self._digest(),
            "policyFingerprint": EXCHANGE_FACTS["policyFingerprint"] if EXCHANGE_FACTS else None,
            **({
                "observedRowCount": self.observed_rows,
                "observedDropped": self.observed_dropped,
            } if INTERCEPT_ALL else {}),
        }

    def _control(self, flow: http.HTTPFlow) -> bool:
        request = flow.request
        host = (request.pretty_host or "").lower().rstrip(".")
        path = urlsplit(request.path).path
        if host != CONTROL_HOST or not path.startswith(CONTROL_PREFIX):
            return False
        if request.headers.get("x-tae-egress-control", "") != CONTROL_TOKEN:
            flow.response = http.Response.make(403, b"forbidden")
            return True
        action = path[len(CONTROL_PREFIX):]
        if action == "/seal":
            self.sealed = True
        elif action != "/status":
            flow.response = http.Response.make(404, b"not found")
            return True
        body = json.dumps(self._state(), separators=(",", ":")).encode("utf-8")
        flow.response = http.Response.make(200, body, {"content-type": "application/json"})
        return True

    def _routes_to_host(self, flow: http.HTTPFlow, host: str) -> bool:
        # Inside a CONNECT tunnel, request.host is the tunnel destination while
        # pretty_host prefers the Host header. Swapping in a credential when
        # they differ would send it to a different upstream than its route.
        return self._destination(flow) == host

    def _may_substitute(self, flow: http.HTTPFlow, host: str) -> bool:
        # Every credential swap needs HTTPS to the default port and a Host
        # header that names the tunnel destination.
        return (
            (flow.request.scheme or "").lower() == "https"
            and getattr(flow.request, "port", 443) == 443
            and self._routes_to_host(flow, host)
        )

    def _substitute(self, flow: http.HTTPFlow, host: str) -> None:
        # The single place a surrogate becomes a real value; every route
        # passes through the same guard.
        if not self._may_substitute(flow, host):
            return
        for binding in SUBSTITUTIONS:
            if host not in binding.get("hosts", []):
                continue
            surrogate = str(binding.get("surrogate", ""))
            value = str(binding.get("value", ""))
            if not surrogate or not value:
                continue
            for header_name in binding.get("headerNames", []):
                current = flow.request.headers.get(header_name)
                swapped = None if current is None else _swapped_header(current, surrogate, value)
                if swapped is not None:
                    flow.request.headers[header_name] = swapped
                    self._scrub.setdefault(flow.id, {})[value.encode("utf-8")] = surrogate.encode("utf-8")
        if flow.id in self._scrub:
            # Plain bodies only, so a repeated credential can be found in them.
            flow.request.headers["accept-encoding"] = "identity"

    def _scrub_headers(self, headers, replacements: dict[bytes, bytes]) -> None:
        scrubber = _ResponseScrubber(replacements)
        fields = getattr(headers, "fields", None)
        if fields is not None:
            # Raw fields keep repeated headers, such as Set-Cookie, intact.
            cleaned = tuple((name, scrubber.scrub(value)) for name, value in fields)
            if cleaned != tuple(fields):
                headers.fields = cleaned
            return
        for name in list(headers):
            value = headers[name]
            if isinstance(value, str):
                cleaned = scrubber.scrub(value.encode("utf-8")).decode("utf-8", "replace")
                if cleaned != value:
                    headers[name] = cleaned

    def _scrub_body(self, response, replacements: dict[bytes, bytes]) -> None:
        try:
            # Decoded content; setting it re-encodes with the same encoding.
            content = response.content
        except ValueError:
            return
        if content:
            cleaned = _ResponseScrubber(replacements).scrub(content)
            if cleaned != content:
                response.content = cleaned

    def _destination(self, flow: http.HTTPFlow) -> str:
        # Where mitmproxy actually connects: the CONNECT target or the URL's
        # host. pretty_host prefers the Host header, which the client controls.
        # Inside a tunnel whose connection server_connect pinned to an address,
        # mitmproxy reports that address; map it back to the name it checked.
        request = flow.request
        destination = str(getattr(request, "host", None) or request.pretty_host or "").lower().rstrip(".")
        server = getattr(flow, "server_conn", None)
        pinned = self._pinned.get(getattr(server, "id", None)) if server is not None else None
        address = getattr(server, "address", None) if server is not None else None
        if pinned and address and destination == str(address[0]).lower():
            return pinned[0]
        return destination

    def _names_destination(self, flow: http.HTTPFlow, destination: str) -> bool:
        # Policy, evidence and swaps key on the host a request names, so every
        # name it carries must be the host it is actually sent to: the Host
        # header mitmproxy prefers, every Host header an upstream might read,
        # and an absolute-form or HTTP/2 authority, which an upstream that
        # routes by it (a CDN, say) would follow instead of the Host header.
        request = flow.request
        if (request.pretty_host or "").lower().rstrip(".") != destination:
            return False
        headers = request.headers
        get_all = getattr(headers, "get_all", None)
        names = list(get_all("host")) if get_all else [value for value in [headers.get("host")] if value is not None]
        authority = getattr(request, "authority", "") or ""
        if authority:
            names.append(authority)
        port = getattr(request, "port", 443)
        for value in names:
            named = _authority(str(value))
            if named is None or named[0] != destination or named[1] not in (None, port):
                return False
        return True

    def _refuse_on_failure(self, flow: http.HTTPFlow) -> None:
        # A check that fails unexpectedly must refuse the request; mitmproxy
        # would otherwise log the error and send the request on unchecked.
        self._passthrough.discard(flow.id)
        self._observed.pop(flow.id, None)
        self._scrub.pop(flow.id, None)
        if self._started.pop(flow.id, None) is not None:
            self.active = max(0, self.active - 1)
        flow.request.stream = False
        flow.response = http.Response.make(403, b"guardian check failed")

    def http_connect(self, flow: http.HTTPFlow) -> None:
        try:
            self._check_connect(flow)
        except Exception:
            self._refuse_on_failure(flow)

    def _check_connect(self, flow: http.HTTPFlow) -> None:
        destination = self._destination(flow)
        # A CONNECT names its destination before any upstream connection or
        # TLS handshake; refusing here keeps the proxy from dialing at all.
        if not self._names_destination(flow, destination):
            flow.response = http.Response.make(403, b"host does not match destination")
        # Answer the transport preflight here instead of dialing upstream.
        elif destination == PREFLIGHT_HOST:
            flow.response = http.Response.make(200)
        elif getattr(flow.request, "port", 443) != 443:
            flow.response = http.Response.make(403, b"only port 443 may be tunnelled")
        elif INTERCEPT_ALL:
            if _non_global_destination(destination):
                flow.response = http.Response.make(403, b"destination is not a public address")
        elif destination not in ROUTED_HOSTS:
            flow.response = http.Response.make(403, b"destination is not routed")

    def requestheaders(self, flow: http.HTTPFlow) -> None:
        try:
            self._check_request(flow)
        except Exception:
            self._refuse_on_failure(flow)

    def _check_request(self, flow: http.HTTPFlow) -> None:
        if self._control(flow):
            return
        destination = self._destination(flow)
        if not self._names_destination(flow, destination):
            flow.response = http.Response.make(403, b"host does not match destination")
            return
        host = destination
        if INTERCEPT_ALL and _non_global_destination(destination):
            # Absolute-form plaintext requests never pass through http_connect.
            flow.response = http.Response.make(403, b"destination is not a public address")
            return
        if host in PASSTHROUGH_HOSTS:
            if not self._may_substitute(flow, host):
                flow.response = http.Response.make(403, b"pass-through route rejected")
                return
            if self.sealed:
                flow.response = http.Response.make(503, b"capture sealed")
                return
            self._substitute(flow, host)
            self._passthrough.add(flow.id)
            flow.request.stream = True
            return
        if host not in CAPTURE_HOSTS:
            if not INTERCEPT_ALL:
                flow.response = http.Response.make(403, b"capture route rejected")
                return
            if self.sealed:
                flow.response = http.Response.make(503, b"capture sealed")
                return
            # A Host header naming a credential host must also be the tunnel
            # destination; otherwise the real key could go to another server.
            if host in CREDENTIAL_HOSTS and not self._routes_to_host(flow, host):
                flow.response = http.Response.make(403, b"credential route rejected")
                return
            # Agent credentials are substituted here too, under the same guard.
            self._substitute(flow, host)
            # Never buffer agent model streams or package downloads.
            flow.request.stream = True
            self._observed[flow.id] = time.monotonic()
            return
        if self.sealed:
            flow.response = http.Response.make(503, b"capture sealed")
            return
        if (
            (flow.request.scheme or "").lower() != "https"
            or getattr(flow.request, "port", 443) != 443
        ):
            # Real credentials are substituted for capture hosts; never send
            # them over plaintext or to an unexpected port, in any mode.
            flow.response = http.Response.make(403, b"capture route requires https")
            return
        method = flow.request.method.upper()
        path = urlsplit(flow.request.path).path or "/"
        if (method, path) in BLOCKED_REQUESTS:
            self._append({
                "kind": "http-request",
                "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
                "method": method,
                "scheme": flow.request.scheme.lower() if flow.request.scheme else None,
                "host": host,
                "path": path,
                "statusCode": 403,
                "durationMs": 0,
                "selectedFields": {},
                "disposition": "blocked",
            })
            flow.response = http.Response.make(
                403,
                b"request blocked by evaluation policy",
                {"content-type": "text/plain; charset=utf-8"},
            )
            return
        self._substitute(flow, host)
        self.active += 1
        self._started[flow.id] = time.monotonic()

    def server_connect(self, data) -> None:
        try:
            self._pin(data)
        except Exception:
            # Never let a connection go ahead unchecked.
            self._unpin(data.server)
            data.server.error = "destination check failed"

    def _pin(self, data) -> None:
        # The checks above see names. Resolve the name once here, refuse any
        # non-public answer, and pin the connection to the address that was
        # checked, so a DNS answer that changes in between (rebinding) cannot
        # move the connection. TLS keeps the original name for SNI and for
        # certificate verification. A reconnect inside a pinned tunnel dials
        # the pinned address again and keeps the tunnel's SNI.
        server = data.server
        address = getattr(server, "address", None)
        if not address:
            return
        name, port = str(address[0]), address[1]
        try:
            addresses = _addresses(name)
        except (OSError, UnicodeError):
            server.error = "destination did not resolve"
            return
        if not addresses or any(_non_global_address(value) for value in addresses):
            server.error = "destination is not a public address"
            return
        literal = name.strip("[]")
        try:
            ipaddress.ip_address(literal)
        except ValueError:
            checked = name.lower().rstrip(".")
            # Upstream TLS sends and verifies the checked name, never the
            # client's own SNI.
            server.sni = checked
            client = getattr(getattr(data, "client", None), "id", None)
            self._pinned[server.id] = (checked, client)
            self._client_pins.setdefault(client, set()).add(server.id)
        # The resolver's first answer, as an unpinned connection would dial.
        server.address = (str(addresses[0]), port)

    def _unpin(self, server) -> None:
        server_id = getattr(server, "id", None)
        pinned = self._pinned.pop(server_id, None)
        if pinned is None:
            return
        pins = self._client_pins.get(pinned[1])
        if pins is not None:
            pins.discard(server_id)
            if not pins:
                del self._client_pins[pinned[1]]

    def server_connect_error(self, data) -> None:
        self._unpin(data.server)

    def client_disconnected(self, client) -> None:
        for server_id in self._client_pins.pop(getattr(client, "id", None), ()):
            self._pinned.pop(server_id, None)

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        # Model responses are long server-sent event streams, and observed
        # downloads can be large; forward both as they arrive instead of
        # buffering the whole body in the Guardian.
        if flow.response is None:
            return
        streamed = flow.id in self._passthrough or flow.id in self._observed
        replacements = self._scrub.get(flow.id)
        if replacements:
            self._scrub_headers(flow.response.headers, replacements)
            encoding = (flow.response.headers.get("content-encoding") or "identity").strip().lower()
            if streamed and encoding == "identity":
                flow.response.stream = _ResponseScrubber(replacements)
            # A compressed body cannot be scrubbed chunk by chunk, so it is
            # buffered and scrubbed whole in response().
            return
        if streamed:
            flow.response.stream = True

    def _append(self, observed: dict[str, object]) -> None:
        if self.sequence >= MAX_ROWS:
            self.truncated = True
            return
        observed["sequence"] = self.sequence
        line = (json.dumps(observed, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")
        if self.journal_bytes + len(line) > MAX_JOURNAL_BYTES:
            self.truncated = True
            return
        with open(LOG_PATH, "a", encoding="ascii") as handle:
            handle.write(line.decode("ascii"))
            handle.flush()
            os.fsync(handle.fileno())
        self.sequence += 1
        self.journal_bytes += len(line)

    def _append_observed(self, observed: dict[str, object]) -> None:
        # Observed rows are diagnostic: exhausting their budget drops rows
        # without truncating the capture journal or failing the seal.
        if self.sealed:
            self.observed_dropped += 1
            return
        line_bytes = len(
            json.dumps({**observed, "sequence": self.sequence}, separators=(",", ":"), ensure_ascii=True)
        ) + 1
        if (
            self.observed_rows >= MAX_OBSERVED_ROWS
            or self.observed_bytes + line_bytes > MAX_OBSERVED_BYTES
            or self.sequence >= MAX_ROWS
            or self.journal_bytes + line_bytes > MAX_JOURNAL_BYTES
        ):
            self.observed_dropped += 1
            return
        self._append(observed)
        self.observed_rows += 1
        self.observed_bytes += line_bytes

    def _finish_observed_http(self, flow: http.HTTPFlow, status_code: int | None) -> None:
        started = self._observed.pop(flow.id, None)
        if started is None:
            return
        request = flow.request
        method = request.method.upper()
        scheme = request.scheme.lower() if request.scheme else None
        path = urlsplit(request.path).path or "/"
        host = (request.pretty_host or "").lower().rstrip(".")
        if (
            not method
            or len(method) > 16
            or not method.isascii()
            or not method.isalpha()
            or (scheme is not None and scheme not in ("http", "https"))
            or not path.startswith("/")
            or len(path.encode("utf-8")) > MAX_PATH_BYTES
            or not host
            or len(host.encode("utf-8")) > 253
        ):
            self.observed_dropped += 1
            return
        self._append_observed({
            "kind": "http-request",
            "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "method": method,
            "scheme": scheme,
            "host": host,
            "path": path,
            "statusCode": status_code,
            "durationMs": max(0, int((time.monotonic() - started) * 1000)),
            "selectedFields": {},
        })

    def _finish_observed_websocket(self, flow: http.HTTPFlow) -> None:
        started = self._observed.pop(flow.id, None)
        counters = self._observed_websockets.pop(flow.id, None)
        if started is None or counters is None:
            return
        request = flow.request
        path = urlsplit(request.path).path or "/"
        scheme = {"http": "ws", "https": "wss"}.get(request.scheme.lower() if request.scheme else None)
        host = (request.pretty_host or "").lower().rstrip(".")
        if scheme is None or not path.startswith("/") or len(path.encode("utf-8")) > MAX_PATH_BYTES or not host:
            self.observed_dropped += 1
            return
        self._append_observed({
            "kind": "websocket-session",
            "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "scheme": scheme,
            "host": host,
            "path": path,
            "statusCode": 101,
            "durationMs": max(0, int((time.monotonic() - started) * 1000)),
            **counters,
            "selectedFields": {},
        })

    def _selected_fields(self, flow: http.HTTPFlow) -> dict[str, str]:
        host = (flow.request.pretty_host or "").lower().rstrip(".")
        return {
            name: flow.response.headers.get(name)
            for name in SELECTED_RESPONSE_HEADERS.get(host, ())
            if flow.response is not None
            and flow.response.headers.get(name) is not None
            and len(flow.response.headers.get(name).encode("utf-8")) <= 4096
        }

    @staticmethod
    def _profile(flow: http.HTTPFlow, status_code: int | None) -> dict[str, object] | None:
        if EXCHANGE_FACTS is None or status_code is None:
            return None
        path = urlsplit(flow.request.path).path or "/"
        method = flow.request.method.upper()
        matches = [
            profile
            for profile in EXCHANGE_FACTS["profiles"]
            if profile["match"]["method"] == method
            and any(_path_matches(shape, path) for shape in (
                profile["match"].get("paths", profile["match"].get("pathTemplates", []))
            ))
            and status_code in profile["match"]["statusCodes"]
        ]
        if len(matches) > 1:
            raise FactCaptureError("overlapping-profile")
        return matches[0] if matches else None

    @staticmethod
    def _body(message: object) -> object:
        headers = getattr(message, "headers", {}) or {}
        content_type = str(headers.get("content-type", "")).split(";", 1)[0].strip().lower()
        if content_type != "application/json" and not (
            content_type.startswith("application/") and content_type.endswith("+json")
        ):
            raise FactCaptureError("unsupported-media-type")
        encoding = str(headers.get("content-encoding", "identity")).strip().lower() or "identity"
        raw = getattr(message, "raw_content", None)
        if raw is None:
            raw = getattr(message, "content", None)
        if not isinstance(raw, bytes) or len(raw) > MAX_BODY_BYTES:
            raise FactCaptureError("encoded-body-limit")
        if encoding == "identity":
            decoded = raw
        elif encoding == "gzip":
            try:
                with gzip.GzipFile(fileobj=io.BytesIO(raw), mode="rb") as stream:
                    decoded = stream.read(MAX_BODY_BYTES + 1)
            except (OSError, EOFError) as error:
                raise FactCaptureError("invalid-gzip") from error
        else:
            raise FactCaptureError("unsupported-encoding")
        if len(decoded) > MAX_BODY_BYTES:
            raise FactCaptureError("decoded-body-limit")
        try:
            text = decoded.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise FactCaptureError("invalid-utf8") from error

        def pairs(items: list[tuple[str, object]]) -> dict[str, object]:
            result: dict[str, object] = {}
            for key, value in items:
                if key in result:
                    raise DuplicateJsonKey("duplicate-key")
                result[key] = value
            return result

        try:
            document = json.loads(
                text,
                object_pairs_hook=pairs,
                parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("constant")),
            )
        except (ValueError, TypeError, DuplicateJsonKey, RecursionError) as error:
            raise FactCaptureError("invalid-json") from error
        nodes = 0

        def inspect(value: object, depth: int) -> None:
            nonlocal nodes
            nodes += 1
            if nodes > MAX_JSON_NODES or depth > MAX_JSON_DEPTH:
                raise FactCaptureError("json-structure-limit")
            if isinstance(value, dict):
                for child in value.values():
                    inspect(child, depth + 1)
            elif isinstance(value, list):
                for child in value:
                    inspect(child, depth + 1)

        inspect(document, 1)
        return document

    @staticmethod
    def _pointer_segments(pointer: str) -> list[str]:
        return [segment.replace("~1", "/").replace("~0", "~") for segment in pointer[1:].split("/")]

    @staticmethod
    def _encode_pointer_segment(segment: str) -> str:
        return segment.replace("~", "~0").replace("/", "~1")

    @classmethod
    def _matches(cls, document: object, selector: dict[str, object]) -> list[tuple[str, object]]:
        states: list[tuple[object, list[str]]] = [(document, [])]
        for segment in cls._pointer_segments(selector["pointer"]):
            next_states: list[tuple[object, list[str]]] = []
            for value, path in states:
                if segment == "*":
                    if isinstance(value, list):
                        next_states.extend((child, [*path, str(index)]) for index, child in enumerate(value))
                elif isinstance(value, dict) and segment in value:
                    next_states.append((
                        value[segment],
                        [*path, cls._encode_pointer_segment(segment)],
                    ))
                elif isinstance(value, list) and segment.isdigit() and str(int(segment)) == segment:
                    index = int(segment)
                    if index < len(value):
                        next_states.append((value[index], [*path, segment]))
            states = next_states
        maximum = selector.get("maxMatches", 1)
        if len(states) > maximum:
            raise FactCaptureError("selector-match-limit")
        return [("/" + "/".join(path), value) for value, path in states]

    @classmethod
    def _facts(cls, document: object, selectors: list[dict[str, object]]) -> dict[str, object]:
        facts: dict[str, object] = {}
        match_total = 0
        for selector in selectors:
            matches = cls._matches(document, selector)
            if not matches:
                facts[selector["id"]] = {"state": "absent"}
                continue
            projected = []
            projection = selector["projection"]
            for pointer, value in matches:
                if projection["kind"] == "present":
                    projected_value: object = True
                elif projection["kind"] == "count":
                    if not isinstance(value, list) or len(value) > projection["maxItems"]:
                        raise FactCaptureError("invalid-count")
                    projected_value = len(value)
                elif projection["kind"] == "sha256-string":
                    if not isinstance(value, str):
                        raise FactCaptureError("invalid-string")
                    try:
                        encoded = value.encode("utf-8")
                    except UnicodeEncodeError as error:
                        raise FactCaptureError("invalid-string") from error
                    if len(encoded) > projection["maxInputBytes"]:
                        raise FactCaptureError("string-limit")
                    projected_value = "sha256:" + hashlib.sha256(encoded).hexdigest()
                else:
                    raise FactCaptureError("invalid-projection")
                projected.append({"pointer": pointer, "value": projected_value})
            match_total += len(projected)
            if match_total > MAX_FACT_MATCHES_PER_EXCHANGE:
                raise FactCaptureError("exchange-match-limit")
            facts[selector["id"]] = {"state": "present", "matches": projected}
        return facts

    def _exchange_facts(self, flow: http.HTTPFlow, status_code: int | None) -> dict[str, object] | None:
        profile = self._profile(flow, status_code)
        if profile is None:
            return None
        request = self._facts(self._body(flow.request), profile["requestJson"]) if (
            profile["requestJson"]
        ) else {}
        response = self._facts(self._body(flow.response), profile["responseJson"]) if (
            profile["responseJson"]
        ) else {}
        observed = {
            "schemaVersion": 1,
            "captureProfile": "bounded-json-exchange-facts-v1",
            "policyFingerprint": EXCHANGE_FACTS["policyFingerprint"],
            "profileId": profile["id"],
            "request": request,
            "response": response,
        }
        fact_bytes = len(json.dumps(observed, separators=(",", ":"), ensure_ascii=True).encode("ascii"))
        if fact_bytes > MAX_FACT_BYTES_PER_EXCHANGE:
            raise FactCaptureError("exchange-fact-byte-limit")
        if self.fact_exchanges >= MAX_FACT_EXCHANGES or self.fact_bytes + fact_bytes > MAX_FACT_BYTES_PER_RUN:
            raise FactCaptureError("run-fact-limit")
        self.fact_exchanges += 1
        self.fact_bytes += fact_bytes
        return observed

    def _finish_http(self, flow: http.HTTPFlow, status_code: int | None) -> None:
        started = self._started.pop(flow.id, None)
        if started is None:
            return
        self.active = max(0, self.active - 1)
        request = flow.request
        method = request.method.upper()
        scheme = request.scheme.lower() if request.scheme else None
        path = urlsplit(request.path).path or "/"
        if (
            not method
            or len(method) > 16
            or not method.isascii()
            or not method.isalpha()
            or (scheme is not None and scheme not in ("http", "https"))
            or not path.startswith("/")
            or len(path.encode("utf-8")) > MAX_PATH_BYTES
        ):
            self.truncated = True
            return
        observed = {
            "kind": "http-request",
            "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "method": method,
            "scheme": scheme,
            "host": (request.pretty_host or "").lower().rstrip("."),
            "path": path,
            "statusCode": status_code,
            "durationMs": max(0, int((time.monotonic() - started) * 1000)),
            "selectedFields": self._selected_fields(flow),
        }
        try:
            exchange_facts = self._exchange_facts(flow, status_code)
        except FactCaptureError:
            self.truncated = True
            return
        if exchange_facts is not None:
            observed["exchangeFacts"] = exchange_facts
        self._append(observed)

    def _finish_websocket(self, flow: http.HTTPFlow) -> None:
        started = self._started.pop(flow.id, None)
        counters = self._websockets.pop(flow.id, None)
        if started is None:
            return
        self.active = max(0, self.active - 1)
        if counters is None:
            self.truncated = True
            return
        request = flow.request
        path = urlsplit(request.path).path or "/"
        request_scheme = request.scheme.lower() if request.scheme else None
        scheme = {"http": "ws", "https": "wss"}.get(request_scheme)
        if (
            scheme is None
            or not path.startswith("/")
            or len(path.encode("utf-8")) > MAX_PATH_BYTES
        ):
            self.truncated = True
            return
        self._append({
            "kind": "websocket-session",
            "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "scheme": scheme,
            "host": (request.pretty_host or "").lower().rstrip("."),
            "path": path,
            "statusCode": 101,
            "durationMs": max(0, int((time.monotonic() - started) * 1000)),
            **counters,
            "selectedFields": self._selected_fields(flow),
        })

    def _drop_websocket(self, flow: http.HTTPFlow) -> None:
        started = self._started.pop(flow.id, None)
        self._websockets.pop(flow.id, None)
        if started is not None:
            self.active = max(0, self.active - 1)

    def response(self, flow: http.HTTPFlow) -> None:
        if flow.request.pretty_host == CONTROL_HOST:
            return
        status_code = flow.response.status_code if flow.response else None
        replacements = self._scrub.get(flow.id) if status_code == 101 else self._scrub.pop(flow.id, None)
        if replacements and flow.response is not None and not callable(getattr(flow.response, "stream", False)):
            self._scrub_body(flow.response, replacements)
        if flow.id in self._passthrough:
            if status_code != 101:
                self._passthrough.discard(flow.id)
            return
        if flow.id in self._observed:
            if status_code == 101:
                self._observed_websockets.setdefault(flow.id, {
                    "framesSent": 0,
                    "bytesSent": 0,
                    "framesReceived": 0,
                    "bytesReceived": 0,
                })
            else:
                self._finish_observed_http(flow, status_code)
            return
        if status_code == 101:
            self._websockets.setdefault(flow.id, {
                "framesSent": 0,
                "bytesSent": 0,
                "framesReceived": 0,
                "bytesReceived": 0,
            })
            return
        self._finish_http(flow, status_code)

    def websocket_start(self, flow: http.HTTPFlow) -> None:
        if flow.id in self._passthrough:
            return
        if flow.id in self._observed:
            self._observed_websockets.setdefault(flow.id, {
                "framesSent": 0,
                "bytesSent": 0,
                "framesReceived": 0,
                "bytesReceived": 0,
            })
            return
        self._websockets.setdefault(flow.id, {
            "framesSent": 0,
            "bytesSent": 0,
            "framesReceived": 0,
            "bytesReceived": 0,
        })

    def websocket_message(self, flow: http.HTTPFlow) -> None:
        replacements = self._scrub.get(flow.id)
        messages = getattr(getattr(flow, "websocket", None), "messages", ())
        if replacements and messages and not messages[-1].from_client:
            message = messages[-1]
            scrubber = _ResponseScrubber(replacements)
            if isinstance(message.content, str):
                message.content = scrubber.scrub(message.content.encode("utf-8")).decode("utf-8", "replace")
            elif message.content:
                message.content = scrubber.scrub(message.content)
        if flow.id in self._passthrough:
            return
        observed = flow.id in self._observed
        counters = (self._observed_websockets if observed else self._websockets).get(flow.id)
        messages = getattr(getattr(flow, "websocket", None), "messages", ())
        if counters is None or not messages:
            if observed:
                self.observed_dropped += 1
            else:
                self.truncated = True
            return
        message = messages[-1]
        content = message.content
        if isinstance(content, str):
            content = content.encode("utf-8")
        size = len(content or b"")
        if message.from_client:
            frame_key, byte_key = "framesSent", "bytesSent"
        else:
            frame_key, byte_key = "framesReceived", "bytesReceived"
        if counters[frame_key] >= MAX_SAFE_COUNTER or counters[byte_key] > MAX_SAFE_COUNTER - size:
            if not observed:
                self.truncated = True
            return
        counters[frame_key] += 1
        counters[byte_key] += size

    def websocket_end(self, flow: http.HTTPFlow) -> None:
        self._scrub.pop(flow.id, None)
        if flow.id in self._passthrough:
            self._passthrough.discard(flow.id)
            return
        if flow.id in self._observed:
            self._finish_observed_websocket(flow)
            return
        self._finish_websocket(flow)

    def error(self, flow: http.HTTPFlow) -> None:
        self._scrub.pop(flow.id, None)
        if flow.id in self._passthrough:
            self._passthrough.discard(flow.id)
            return
        if flow.id in self._observed:
            if flow.id in self._observed_websockets:
                self._finish_observed_websocket(flow)
            else:
                self._finish_observed_http(flow, None)
            return
        if flow.id in self._websockets:
            self._drop_websocket(flow)
        else:
            self._finish_http(flow, None)


def _start_lifetime_guards() -> None:
    """Keep this process, and the real credentials it holds, from outliving its run.

    The controller-host Guardian sets both. With TAE_EGRESS_EXIT_WITH_CONTROLLER,
    the controller holds this process's stdin open and never writes to it.
    However the controller ends, even by SIGKILL, the pipe then closes; the
    Guardian removes its own directory (CA key, journal) and exits.
    TAE_EGRESS_MAX_LIFETIME_S is a hard stop for a run that outlives its
    sandbox; the controller, still alive then, cleans up itself.
    """
    if os.environ.get("TAE_EGRESS_EXIT_WITH_CONTROLLER") == "1":
        cleanup = os.environ.get("TAE_EGRESS_CLEANUP_DIR") or None

        def exit_with_controller() -> None:
            try:
                while sys.stdin.buffer.read(4096):
                    pass
            except (OSError, ValueError):
                pass
            if cleanup:
                shutil.rmtree(cleanup, ignore_errors=True)
            os._exit(0)

        threading.Thread(target=exit_with_controller, name="tae-exit-with-controller", daemon=True).start()
    lifetime = os.environ.get("TAE_EGRESS_MAX_LIFETIME_S")
    if lifetime:
        seconds = max(1, int(lifetime))

        def expire() -> None:
            time.sleep(seconds)
            os._exit(3)

        threading.Thread(target=expire, name="tae-max-lifetime", daemon=True).start()


_start_lifetime_guards()
addons = [GenericGuardian()]
