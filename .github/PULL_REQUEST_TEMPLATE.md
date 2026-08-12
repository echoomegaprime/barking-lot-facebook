## What

<!-- What changed and why -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm audit` shows no new high/critical vulnerabilities
- [ ] If this touches `verifyFacebookSignature`/`isAllowedImageHost`/`timingSafeEqual`, a test
      was added in `tests/security.test.ts` that fails against the old behavior and passes
      against the new one
- [ ] `POST /webhook` still calls `verifyFacebookSignature()` before any other processing
- [ ] `/api/image-proxy` still calls `isAllowedImageHost()` before fetching a caller-supplied URL
