"""Critical journey for the ECHO Certification Forge.

The Forge runs this argv (declared in ``.echo/certification.json``) inside its
isolated ``python:3.12-alpine`` sandbox, against the exact acquired commit,
with no network and no project dependencies installed. Node/TypeScript is not
present in that sandbox, so the Worker cannot actually boot or be typechecked
here -- this journey proves the artifact the Forge acquired is the intact,
complete, fixed application via source-integrity and critical-surface checks,
not that it currently runs or compiles. The full behavioural suite
(``npm run typecheck``, ``npm test``, real fetch() calls through the exported
default worker) runs in CI on this same commit.

Checks:
  1. Critical surfaces exist: the Worker entrypoint, its test file, config,
     and every governance file the showroom-quality bar requires.
  2. ``src/index.ts`` bracket counts are balanced (corruption/truncation
     proxy) over a string/regex/comment-stripped copy of the file.
  3. No install-lifecycle scripts have crept into ``package.json``.
  4. No hardcoded secret-shaped literals in ``src/index.ts``.
  5. ``verifyFacebookSignature`` still exists, still checks the
     ``X-Hub-Signature-256`` header, and is still called from
     ``handleMessengerWebhook`` BEFORE the body is parsed -- the exact
     "signature added but placed after processing" trap that would silently
     reopen the live incident this commit closed (this repo previously had
     ZERO signature verification on POST /webhook).
  6. ``isAllowedImageHost`` still exists and is still called from
     ``proxyImage`` before any fetch of a caller-supplied URL -- guards
     against the SSRF regression reopening.
  7. ``timingSafeEqual``/``timingSafeEqualHex`` still guard on
     length-mismatch before comparing.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys
from typing import NoReturn

CRITICAL_SURFACES = (
    "src/index.ts",
    "tests/security.test.ts",
    "package.json",
    "tsconfig.json",
    "wrangler.toml",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    ".github/workflows/ci.yml",
)

INSTALL_LIFECYCLE_HOOKS = ("preinstall", "install", "postinstall", "prepare")

SECRET_LITERAL_PATTERN = re.compile(
    r'(?:api_key|secret|password|token)["\']?\s*[:=]\s*["\'][a-zA-Z0-9_\-]{16,}["\']',
    re.IGNORECASE,
)

BALANCE_PAIRS = {"(": ")", "{": "}", "[": "]"}


def _fail(message: str) -> NoReturn:
    print(f"BARKING_LOT_FACEBOOK_CRITICAL_JOURNEY_FAILED: {message}", file=sys.stderr)
    raise SystemExit(1)


def _source_text() -> str:
    return pathlib.Path("src/index.ts").read_text(encoding="utf-8")


def check_critical_surfaces() -> None:
    for surface in CRITICAL_SURFACES:
        if not pathlib.Path(surface).exists():
            _fail(f"missing critical surface: {surface}")


def _strip_strings_regexes_and_comments(text: str) -> str:
    """Best-effort removal of string/regex/comment bodies before bracket counting."""
    out = []
    i, n = 0, len(text)
    prev_significant = ""
    while i < n:
        ch = text[i]
        if ch in "'\"`":
            quote = ch
            j = i + 1
            while j < n and text[j] != quote:
                if text[j] == "\\":
                    j += 2
                    continue
                j += 1
            i = j + 1
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            i = n if j == -1 else j
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue
        if ch == "/" and prev_significant in ("", "(", ",", "=", ":", "!", "&", "|", "return", "[", "\n"):
            j = i + 1
            in_class = False
            while j < n and (in_class or text[j] != "/"):
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == "[":
                    in_class = True
                elif text[j] == "]":
                    in_class = False
                elif text[j] == "\n":
                    break
                j += 1
            if j < n and text[j] == "/":
                i = j + 1
                continue
        out.append(ch)
        if not ch.isspace():
            prev_significant = ch
        i += 1
    return "".join(out)


def check_source_balanced() -> None:
    text = _strip_strings_regexes_and_comments(_source_text())
    for open_ch, close_ch in BALANCE_PAIRS.items():
        opens, closes = text.count(open_ch), text.count(close_ch)
        if opens != closes:
            _fail(
                f"src/index.ts has mismatched '{open_ch}'/'{close_ch}' counts "
                f"({opens} vs {closes}) -- possible truncation or corruption"
            )


def check_no_install_hooks() -> None:
    manifest = pathlib.Path("package.json")
    try:
        scripts = json.loads(manifest.read_text(encoding="utf-8")).get("scripts", {})
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        _fail(f"package.json is not valid JSON: {exc}")
    present = sorted(hook for hook in INSTALL_LIFECYCLE_HOOKS if hook in scripts)
    if present:
        _fail(f"package.json reintroduced install-lifecycle script(s): {', '.join(present)}")


def check_no_hardcoded_secrets() -> None:
    text = _source_text()
    match = SECRET_LITERAL_PATTERN.search(text)
    if match:
        _fail(f"src/index.ts contains a hardcoded secret-shaped literal: {match.group(0)[:40]}...")


def check_webhook_signature_gate_intact() -> None:
    text = _source_text()
    fn_match = re.search(
        r"export async function handleMessengerWebhook\([^)]*\)[^{]*\{(.*?)\n\}",
        text,
        re.DOTALL,
    )
    if not fn_match:
        _fail("could not locate handleMessengerWebhook() in src/index.ts")
    body = fn_match.group(1)

    verify_idx = body.find("verifyFacebookSignature(request, rawBody, env)")
    if verify_idx == -1:
        _fail(
            "handleMessengerWebhook no longer calls verifyFacebookSignature() -- the exact "
            "regression this fix closed (this repo previously had ZERO webhook auth)"
        )

    parse_idx = body.find("JSON.parse(rawBody)")
    if parse_idx != -1 and parse_idx < verify_idx:
        _fail("the webhook body is parsed BEFORE the signature is verified")

    if "if (!verifyFacebookSignature" not in body.replace("await ", "") and \
       "if (!(await verifyFacebookSignature" not in body:
        _fail("verifyFacebookSignature() result is not gated with an if-check")


def check_verify_facebook_signature_uses_header() -> None:
    text = _source_text()
    fn_match = re.search(
        r"export async function verifyFacebookSignature\([^)]*\)[^{]*\{(.*?)\n\}",
        text,
        re.DOTALL,
    )
    if not fn_match:
        _fail("could not locate verifyFacebookSignature() in src/index.ts")
    body = fn_match.group(1)
    if "X-Hub-Signature-256" not in body:
        _fail("verifyFacebookSignature() no longer reads the X-Hub-Signature-256 header")
    if "FB_APP_SECRET" not in body:
        _fail("verifyFacebookSignature() no longer uses env.FB_APP_SECRET")
    if "timingSafeEqualHex" not in body:
        _fail("verifyFacebookSignature() no longer uses a constant-time comparison")


def check_ssrf_gate_intact() -> None:
    text = _source_text()
    fn_match = re.search(
        r"async function proxyImage\([^)]*\)[^{]*\{(.*?)\n\}",
        text,
        re.DOTALL,
    )
    if not fn_match:
        _fail("could not locate proxyImage() in src/index.ts")
    body = fn_match.group(1)
    if "isAllowedImageHost(imageUrl)" not in body:
        _fail(
            "proxyImage no longer calls isAllowedImageHost() -- the exact regression this fix "
            "closed (this repo previously fetched ANY caller-supplied url, an SSRF vector)"
        )


def check_timing_safe_equal_guards() -> None:
    text = _source_text()
    for fn_name in ("timingSafeEqual", "timingSafeEqualHex"):
        fn_match = re.search(
            rf"export function {fn_name}\([^)]*\)[^{{]*\{{(.*?)\n\}}",
            text,
            re.DOTALL,
        )
        if not fn_match:
            _fail(f"could not locate {fn_name}() in src/index.ts")
        if "length" not in fn_match.group(1):
            _fail(f"{fn_name}() no longer checks length before comparing")


def main() -> None:
    check_critical_surfaces()
    check_source_balanced()
    check_no_install_hooks()
    check_no_hardcoded_secrets()
    check_webhook_signature_gate_intact()
    check_verify_facebook_signature_uses_header()
    check_ssrf_gate_intact()
    check_timing_safe_equal_guards()
    print(
        "BARKING_LOT_FACEBOOK_CRITICAL_JOURNEY_OK "
        "critical_surfaces=12 install_hooks=0 hardcoded_secrets=0 "
        "webhook_signature_gate_intact=1 ssrf_gate_intact=1 timing_safe_equal_guards=1"
    )


if __name__ == "__main__":
    main()
