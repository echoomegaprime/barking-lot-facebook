# Security Policy

## Reporting a Vulnerability

Report suspected vulnerabilities to **security@echo-op.com**. Do not open a public issue for
undisclosed security problems. We aim to acknowledge reports within 3 business days.

## 2026-08-12 incident: unauthenticated Messenger webhook, live

Discovered during GitHub Certified Consolidation. `POST /webhook` (the Facebook Messenger
webhook handler) had **no signature verification at all**, despite `FB_APP_SECRET` being
declared in `Env` for exactly that purpose and set as a real Worker secret — the verification
code to actually use it was never written.

**Impact**: anyone who knew (or found) the webhook URL could POST a forged Messenger event and
the Worker would process it unconditionally:

- It would call Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct`) with attacker-supplied
  text — an unauthenticated, uncapped trigger for a metered/paid model call, the same incident
  class CLAUDE.md documents from the 2026-07-25 Copilot $1,000.20 overage ("unbounded automated
  trigger, no spend cap"), here reachable from the open internet with a single POST.
- It would then send the AI's response as a real Messenger message **from the sanctuary's own
  Facebook Page, using the Page's live access token**, to whatever `sender.id` the attacker put
  in the forged payload — effectively an open relay letting a third party make the sanctuary's
  Page say arbitrary AI-generated things to Facebook users, bypassing the actual human-initiated
  conversations Facebook's real webhook delivery is supposed to gate.

**Verified live** at `barking-lot-facebook.bmcii1976.workers.dev` on 2026-08-12: a forged
`POST /webhook` with an empty `entry: []` array (chosen specifically so the test would not incur
a real AI call or send a real message) returned `200 EVENT_RECEIVED` with no authentication of
any kind, confirming the Worker processes unsigned webhook bodies in production.

**Fix**: `verifyFacebookSignature()` computes the expected `X-Hub-Signature-256` (HMAC-SHA256 of
the raw request body, keyed with `FB_APP_SECRET`, via `crypto.subtle`) and compares it against
the header Facebook sends, using a constant-time comparison (`timingSafeEqualHex`). This runs
**before** the body is parsed or any other code executes, and fails closed (rejects) if
`FB_APP_SECRET` is unconfigured, if the header is missing or malformed, or if the computed
signature doesn't match. See `tests/security.test.ts` for the full regression suite (24 tests,
tamper-tested twice: once by removing the signature check and confirming the auth-gate tests
fail, once by removing the image-proxy host check and confirming those tests fail).

**Outstanding**: this fix has landed in `echoomegaprime/barking-lot-facebook`, but the *live*
deployment at `barking-lot-facebook.bmcii1976.workers.dev` has not yet been redeployed with it.
That account is the Commander's own (confirmed 2026-08-12), but per standing direction on this
same account (see the `echo-prime-dashboard` / `encore-cloud-scraper` / `permian-pulse-scraper`
incidents earlier in this campaign), new deployments go to the current paid account rather than
that one. Unlike those three, this Worker's URL is hardcoded into a live third-party website's
embedded widget script (`getWidgetScript()` in `src/index.ts` references
`barking-lot-facebook.bmcii1976.workers.dev` directly) and is presumably the live Messenger
webhook URL configured in Meta's App dashboard for this Page — redeploying under a new account
would mint a new `*.workers.dev` URL and silently break both integrations unless the cutover is
coordinated (updating the website's widget reference and Meta's webhook subscription URL at the
same time). That coordination is a Commander-level decision given it touches a real nonprofit's
live production integration outside our own properties, so it was **not** attempted
unilaterally as part of this consolidation pass. **Do not consider this incident closed until
the live deployment is confirmed patched or a coordinated cutover is completed.**

## 2026-08-12: SSRF fix on the image proxy

`GET /api/image-proxy?url=` fetched **any URL the caller supplied**, server-side, with no
restriction on the target host — a classic SSRF vector letting the Worker be used to probe or
fetch arbitrary internal/external addresses through Cloudflare's edge, laundered through this
sanctuary's own domain and KV cache. Fixed with `isAllowedImageHost()`, an explicit allowlist of
Facebook/Meta CDN hostname patterns (`fbcdn.net`, `facebook.com`, `cdninstagram.com`) plus an
HTTPS-only check, enforced in `proxyImage()` before any fetch happens. Regression-tested both as
a pure function and end-to-end through the actual `/api/image-proxy` route (the first version of
this test suite only covered the pure function and would NOT have caught the route-level guard
being removed — see the two-part test in `tests/security.test.ts`).

## Also fixed in this pass (hygiene, not a live incident)

- `.wrangler/cache/wrangler-account.json` was tracked in git despite `.wrangler/` being in
  `.gitignore` — a file gets ignored going forward but `.gitignore` does not retroactively
  untrack something already committed. It contained only a Cloudflare account id (not a secret),
  but shouldn't have been committed. Removed with `git rm --cached`.
- Hardened `verifyMessengerWebhook()` (the `GET /webhook` subscription-verify challenge) to use
  the same constant-time comparison as the POST path, and to fail closed with `503` if
  `FB_VERIFY_TOKEN` is unconfigured rather than silently falling through to a `403`.

## Secrets

`FB_PAGE_TOKEN`, `FB_APP_SECRET`, and `FB_VERIFY_TOKEN` are set via `npx wrangler secret put
<NAME>` and are never committed.
