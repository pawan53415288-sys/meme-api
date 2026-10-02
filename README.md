# meme-api

Backend for the **AI Meme Generator**. Runs as a standalone Express service —
it is intentionally a *separate repository* from the React frontend so each side
can be deployed and scaled on its own.

The one thing this service must never leak is the OpenRouter key. That key lives
here, in a server-side environment variable, and the frontend only ever sees
generated memes.

> Frontend repo: [`meme-web`](../meme-web) · Original combined repo: [`server1`](https://github.com/pawan53415288-sys/server1)

---

## Endpoints

### `GET /api/health`

```jsonc
{ "ok": true, "keyConfigured": true }
```

Useful as a deploy smoke-test and to confirm env vars loaded.

### `POST /api/memes`

**Request**

```json
{ "category": "bollywood" }
```

`category` must be one of: `bollywood`, `cartoon`, `viral-songs`, `sports`.

**Response `200`**

```jsonc
{
  "memes": [
    {
      "id": "bollywood-0-1730000000000",
      "imageUrl": "https://api.memegen.link/images/drake/....png",
      "caption": "Gym ka membership lena · Ek din jaake sirf photo daalna"
    }
  ]
}
```

**Errors** — always `{ "error": "<human readable reason>" }`

| Status | When |
| ------ | ---- |
| `400`  | `category` missing or not recognised |
| `502`  | Upstream (OpenRouter / memegen) failed |
| `504`  | Ran out of the time budget — worth retrying |

---

## Local setup

```bash
git clone https://github.com/<you>/meme-api.git
cd meme-api
npm install
cp .env.example .env    # then paste your OpenRouter key in
npm run dev
```

Verify it:

```bash
curl http://localhost:8787/api/health

curl -X POST http://localhost:8787/api/memes \
  -H "Content-Type: application/json" \
  -d '{"category":"bollywood"}'
```

The first real request takes **30–60s**. Free OpenRouter models are slow
reasoning models and the service walks a fallback list before it gives up; that
is expected, not a hang.

### Connecting the frontend

With `meme-web` running on Vite, add this to **`meme-web/.env`**:

```
VITE_API_URL=http://localhost:8787
```

Vite's dev proxy in `meme-web/vite.config.ts` already handles this if you leave
`VITE_API_URL` unset.

---

## Environment variables

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `OPEN_ROUTER_API_KEY` | **yes** | — | From <https://openrouter.ai/keys>. Without it every request fails with `OPEN_ROUTER_API_KEY is missing from .env`. |
| `OPENROUTER_MODEL` | no | — | Pin one `vendor/model:free` id to try it first, ahead of the built-in fallback list. |
| `PORT` | no | `8787` | Set automatically by most PaaS providers. |
| `ALLOWED_ORIGINS` | no | *(any origin)* | Comma-separated allowed browser origins, e.g. `https://meme-web.vercel.app`. **Set this in production** so the API isn't usable as an open relay from any site. |

---

## Deployment

Any Node host works — the service only needs `npm start` and Node 20+.

- **Vercel / Render / Railway / Fly.io** — build `npm install`, start `npm start`.
- **Docker** — `node:20-alpine` base, `CMD ["npm","start"]`.

Remember to set `OPEN_ROUTER_API_KEY` and `ALLOWED_ORIGINS` in the host's
dashboard — not in the repo.

Then set `VITE_API_URL` on the **frontend** to the deployed API URL and rebuild
the frontend. `VITE_*` values are baked in at build time, so changing one needs
a redeploy.

### Two things to know before going live

1. **Free OpenRouter models are rate-limited and slow.** A 30–60s response
   exceeds the default timeout on many hosts (Vercel Functions cap around 10–60s
   depending on plan). If you deploy to Vercel, either use a plan with a longer
   function timeout or lower `TOTAL_BUDGET_MS` in `src/openrouter.js`.
2. **There is no rate limiting.** The endpoint is unauthenticated and every call
   spends key quota. Put a rate limiter (e.g. `express-rate-limit`) in front of
   it before exposing it publicly.

---

## Project layout

```
src/
  index.js       Express app: CORS, routes, error mapping
  memes-core.js  Framework-agnostic orchestration + category themes
  openrouter.js  AI text generation, model fallback, JSON parsing
  memegen.js     Template catalog + memegen.link image rendering
```

`memes-core.js` has no Express dependency, so the same logic can be dropped into
a different serverless entry point (e.g. a Vercel Function) without changing it.