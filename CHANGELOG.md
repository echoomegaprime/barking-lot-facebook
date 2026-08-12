# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Security

- **CRITICAL**: `POST /webhook` (the Facebook Messenger webhook) had **no signature
  verification** — anyone who found the URL could POST a forged event and trigger a paid
  Workers AI call plus a real Messenger send from the sanctuary's own Page token to an
  arbitrary recipient. Verified live and unauthenticated on `bmcii1976.workers.dev` before the
  fix. Added `verifyFacebookSignature()` (HMAC-SHA256 of the raw body via `crypto.subtle`,
  constant-time compared, fails closed if `FB_APP_SECRET` is unconfigured). See
  [SECURITY.md](SECURITY.md) for the full incident writeup and the status of the live legacy
  deployment.
- **HIGH**: `GET /api/image-proxy?url=` fetched any caller-supplied URL server-side with no host
  restriction (SSRF). Added `isAllowedImageHost()`, an explicit Facebook/Meta CDN allowlist
  enforced before every proxy fetch.
- Hardened `GET /webhook` (`verifyMessengerWebhook`) to use a constant-time comparison and to
  fail closed `503` if `FB_VERIFY_TOKEN` is unconfigured, instead of falling through to a bare
  `403`.
- Untracked `.wrangler/cache/wrangler-account.json`, which was committed despite `.wrangler/`
  being in `.gitignore` (gitignore doesn't retroactively untrack already-committed files).
- Added `tests/security.test.ts` (24 tests), tamper-tested twice: removing the webhook signature
  check fails the auth-gate tests, and removing the image-proxy host check fails the SSRF tests
  — including one iteration where the SSRF unit tests alone did NOT catch the regression and an
  end-to-end route test had to be added to actually exercise the fix.

### Added

- `tsconfig.json`, `@cloudflare/workers-types`, `vitest`, `npm run typecheck` / `npm test`.
- `README.md`, `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, this file, CI
  workflow, PR/issue templates.

## Prior history

See `git log` for the pre-consolidation commit history.
