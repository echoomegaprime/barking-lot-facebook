# ECHO Repository Health Receipt

Source repository: `echoomegaprime/barking-lot-facebook`

Source commit: `571388add78c97cb3ff371c2b3334655357e9abc`

Updated manually as part of the GitHub Certified Consolidation of the legacy
`ECHO-OMEGA-PRIME/barking-lot-facebook` repository (2026-08-12). The GitHub App Suite that
would post this automatically is affected by build #29466 (`actions/runs` returns
`total_count: 0` for every commit on this account; re-confirmed on this repo before writing
this receipt).

Cert Forge `PRODUCTION_READY` was obtained via `POST /v1/certifications`
(`cert_053abafb206b0ccce3b7f3c4c64c7869140e06f3`), confirmed via the signed ed25519 verdict
payload (`signing_key_id: ed25519:a07f417e23d6ef50e316f046c115b9fc`,
`evidence_merkle_root: f2d930bce4902b84adc191f843f29c96a140374ba50030c02ca332237bbd0560`).

## Showroom floor audit

- [x] `README.md` — architecture diagram, endpoint table, config/secrets table, quickstart
- [x] `LICENSE`
- [x] `SECURITY.md` — full incident writeup for both fixes, including the live-legacy status
- [x] `CONTRIBUTING.md`
- [x] `CODE_OF_CONDUCT.md`
- [x] `CHANGELOG.md`
- [x] `.gitignore` (`node_modules/`, `.wrangler/`, `.dev.vars`, `__pycache__/`, `*.pyc`)
- [x] `.github/workflows/ci.yml` (typecheck + test + audit)
- [x] `.github/PULL_REQUEST_TEMPLATE.md` + `ISSUE_TEMPLATE/`

Result: **9/9 present**.

## GUI fitness gate

This is a backend Cloudflare Worker (API + webhook + cron) with one embeddable `widget.js`
consumed by a separate website repository. It is infrastructure, not a user-facing application
in its own right — the GUI fitness gate does not require this repo to ship a GUI.

## Secret-literal scan

`git grep --untracked -InE 'sk-live|sk_live|AKIA[0-9A-Z]{16}|gho_[A-Za-z0-9]{36}|ecf_live|-----BEGIN'`
across the full tracked tree (excluding `package-lock.json`): **0 matches**.

## CRITICAL security fixes verified in this commit — read before relying on this certification

**Unauthenticated Messenger webhook (live incident).** `POST /webhook` had no
`X-Hub-Signature-256` verification at all, despite `FB_APP_SECRET` being declared in `Env` for
exactly that purpose — the verification code was simply never written. Verified live at
`barking-lot-facebook.bmcii1976.workers.dev` on 2026-08-12: a forged POST with an empty `entry`
array (deliberately chosen so the probe would not itself trigger a real paid AI call or a real
Messenger send) returned `200 EVENT_RECEIVED` with no authentication of any kind. A real forged
event would have triggered a paid Cloudflare Workers AI call plus a real Messenger send from the
sanctuary's own Page access token to an attacker-chosen recipient id. Fixed with
`verifyFacebookSignature()` — HMAC-SHA256 of the raw request body via `crypto.subtle`, keyed
with `FB_APP_SECRET`, compared against the `X-Hub-Signature-256` header with a constant-time
comparison, applied before the body is parsed or any other processing runs, and failing closed
if `FB_APP_SECRET` is unconfigured.

**SSRF via the image proxy.** `GET /api/image-proxy?url=` fetched any caller-supplied URL
server-side with no host restriction. Fixed with `isAllowedImageHost()`, an explicit
Facebook/Meta CDN hostname allowlist enforced in `proxyImage()` before any fetch.

`tests/security.test.ts` (24/24 passing) covers both fixes and was **tamper-tested twice**:
once for the webhook signature gate (removing it correctly failed the auth-gate tests), and once
for the SSRF fix — where the first pass of tests only exercised `isAllowedImageHost()` as a pure
function and did **not** catch the route-level guard being removed; an end-to-end test hitting
the actual `/api/image-proxy` route was added and confirmed to catch that regression.
`scripts/certforge_journey.py` independently re-verifies both fixes via source inspection and
was tamper-tested against the webhook regression.

This is the **fifth** service found live on the `bmcii1976.workers.dev` account pattern during
this consolidation campaign, after `echo-prime-dashboard`, `encore-cloud-scraper`,
`permian-pulse-scraper` (all full auth-bypass, same severity class) and `echo-title-scraper`
(lower severity, single route). Unlike the first three, this account is now confirmed to be the
Commander's own (2026-08-12) rather than an unowned/legacy one.

**This certificate covers the code in this repository only.** The live legacy deployment at
`barking-lot-facebook.bmcii1976.workers.dev` was **not** redeployed with this fix as of this
commit — see `SECURITY.md` for why: that URL is hardcoded into this repo's own `widget.js` and
is presumably the live Messenger webhook URL registered in Meta's App dashboard for this Page,
so redeploying under a different Cloudflare account would mint a new `*.workers.dev` URL and
silently break both the public website embed and the Messenger integration for a real
third-party nonprofit unless the cutover is coordinated. That coordination decision was flagged
for the Commander, not attempted unilaterally. Do not report this incident closed based on a
GitHub certification alone.
