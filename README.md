# barking-lot-facebook

A Cloudflare Worker that connects [The Barking Lot Animal Sanctuary](https://barkinglot.org)'s
Facebook Page to their website and to an AI-powered Messenger auto-responder.

## What it does

- **Facebook feed proxy** — caches the Page's recent posts and info in KV so the public website
  can render a live feed without hitting Facebook's rate limits or exposing an access token to
  the browser.
- **Animal listing extraction** — heuristically parses adoptable-animal posts (name, species,
  urgency, photo) out of the raw Facebook feed for the sanctuary's adopt page.
- **Image proxy** — re-serves Facebook CDN images through the Worker so links don't break when
  Facebook's signed CDN URLs expire.
- **Messenger bot** — answers Messenger DMs with a small Workers-AI model grounded in the
  sanctuary's real hours, fees, and contact info, with a keyword-based fallback if the model call
  fails.
- **Daily cron** — refreshes all caches once a day so the first real visitor of the day never eats
  a cold-cache Facebook API call.

## Quickstart

```bash
npm install
npm run typecheck
npm test
npm run dev      # local dev server via wrangler
```

## Configuration

Non-secret values live in `wrangler.toml` under `[vars]`. Secrets are set with `wrangler secret
put` and are never committed:

| Secret | Purpose |
|---|---|
| `FB_PAGE_TOKEN` | Facebook Page access token, used to read posts and send Messenger replies |
| `FB_APP_SECRET` | Facebook App secret, used to verify `X-Hub-Signature-256` on every webhook POST |
| `FB_VERIFY_TOKEN` | The token Facebook challenges the webhook subscription with during setup |

## Endpoints

| Route | Description |
|---|---|
| `GET /api/posts` | Recent Facebook posts (cached 15 min) |
| `GET /api/page` | Page info (cached 1 hr) |
| `GET /api/animals` | Extracted animal listings from posts |
| `GET /api/website-animals` | Full animal records shaped for the adopt page |
| `GET /api/image-proxy?url=` | Re-serves an image from an allowlisted Facebook CDN host only |
| `GET /widget.js` | Embeddable feed widget for the public website |
| `GET /webhook` | Messenger webhook subscription verification |
| `POST /webhook` | Messenger webhook events — **requires a valid `X-Hub-Signature-256`** |
| `GET /health` | Health check |

## Architecture

```
Facebook Page  ──posts──▶  GET /api/posts, /api/animals, /api/website-animals  ──▶  barkinglot.org
                                          │
                                     KV cache (15min-24hr TTLs)

Facebook Messenger ──signed POST──▶  /webhook  ──▶  Workers AI (llama-3.1-8b)  ──▶  Messenger reply
                       (X-Hub-Signature-256                    │
                        verified before                  keyword fallback
                        anything else runs)                if AI call fails
```

## Security

See [SECURITY.md](SECURITY.md) for the incident history and current controls. In short: the
Messenger webhook verifies Facebook's HMAC signature on every request before processing it, and
the image proxy only fetches from Facebook's own CDN hosts.

## License

Proprietary — see [LICENSE](LICENSE).
