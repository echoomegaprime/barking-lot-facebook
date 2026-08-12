# Contributing

## Setup

```bash
npm install
npm run dev
```

## Before opening a PR

```bash
npm run typecheck
npm test
```

Both must pass.

## Style

- TypeScript, no framework — keep it that way.
- Any change to `verifyFacebookSignature`, `isAllowedImageHost`, or `timingSafeEqual` must ship
  with a test in `tests/security.test.ts` that fails against the old behavior and passes against
  the new one — these three functions are the entire security boundary of this Worker.
- `POST /webhook` must always call `verifyFacebookSignature()` on the raw request body before any
  other processing. See [SECURITY.md](SECURITY.md) for why this is non-negotiable.
- `/api/image-proxy` must always call `isAllowedImageHost()` before fetching a caller-supplied
  URL. Never widen `ALLOWED_IMAGE_HOSTS` without also confirming the new host is genuinely a
  Facebook/Meta CDN domain.
- Never hardcode a secret. `FB_PAGE_TOKEN`, `FB_APP_SECRET`, and `FB_VERIFY_TOKEN` are set with
  `wrangler secret put` and read only from `env`.

## Reporting security issues

See [SECURITY.md](SECURITY.md) — do not open a public issue for undisclosed vulnerabilities.
