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
| `429`  | Rate limit hit — more than 10 requests in 10 minutes from one IP |
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
| `ALLOWED_ORIGINS` | in production | Comma-separated allowed browser origins, e.g. `https://meme-web.vercel.app`. **Required in production** — the service exits at boot if it's missing, rather than serving as an open relay. |

---

## Abuse protection

This endpoint is unauthenticated and every call spends OpenRouter quota, so two
guards are on by default:

1. **Rate limit** — 10 requests per 10 minutes per IP on `POST /api/memes`,
   returning `429` with a readable message. Loose enough that a real user never
   hits it, tight enough that a script looping the endpoint runs dry.
2. **CORS allow-list** — in production the service refuses to start without
   `ALLOWED_ORIGINS`, so it can't be driven from an arbitrary page.

Both are best-effort, not exact: the limiter keeps counts in memory, so they
reset when the instance sleeps, and each instance counts separately. Behind more
than one instance, swap in a shared store (Redis) via `express-rate-limit`.

`app.set('trust proxy', 1)` is what makes the per-IP limit correct behind
Render's proxy — without it every visitor would share one address and the limit
would apply globally.

---

## Deployment

`render.yaml` is included, so deploying to Render is: **New → Blueprint → point
at this repo**. Render builds with `npm install`, runs `npm start`, and health
checks `/api/health`.

**The first deploy is expected to fail.** `NODE_ENV=production` is set by the
blueprint, and the service exits without `ALLOWED_ORIGINS`. In the Render
dashboard add these as **Secret** env vars, then redeploy:

| Key | Value |
| --- | ----- |
| `OPEN_ROUTER_API_KEY` | your key from <https://openrouter.ai/keys> |
| `ALLOWED_ORIGINS` | your frontend URL, e.g. `https://meme-web.vercel.app` |

Other hosts work fine too — they just need `npm install` + `npm start` on Node 20+,
with the same two env vars set.

### Why Render and not Vercel

A real request takes **30–60s**, because the free OpenRouter models that actually
answer are slow reasoning models. Vercel (10–60s) and Netlify (10s) kill requests
under that, so the app would return `504` in production while working perfectly
on localhost. Render has no hard request timeout, which is what this workload
needs.

Set `VITE_API_URL` on the **frontend** to the deployed API URL and rebuild it.
`VITE_*` values are baked in at build time, so changing one needs a redeploy.

### Free-tier behaviour to expect

- Instances sleep after 15 min idle and take ~30s to wake. The client timeout is
  120s, so it still succeeds — it just feels slow on the first request.
- The in-memory rate limit resets when an instance wakes.

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