// ─────────────────────────────────────────────────────────────────────────────
//  meme-api — the backend for the AI Meme Generator.
//
//  Lives in its own repository, separate from the React frontend, so it can be
//  deployed and scaled on its own. Its only job is to keep the secret AI key OFF
//  the browser: the frontend calls POST /api/memes and never sees the key.
//
//  Contract the frontend depends on:
//    POST /api/memes   body: { category }   ->   { memes: [{ id, imageUrl, caption }] }
//    GET  /api/health                        ->   { ok: true }
//
//  Errors come back as { error: "<human readable reason>" } with a meaningful
//  status code: 400 bad input, 502 upstream failure, 504 we ran out of time.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { createMemes } from './memes-core.js'
import { verifyApiKey } from './openrouter.js'

const app = express()
app.disable('x-powered-by')

// Render (and every other reverse-proxy host) terminates TLS in front of us, so
// req.ip is the proxy's address unless we trust one hop of X-Forwarded-For.
// Without this the rate limiter would see every visitor as the same single IP —
// i.e. a global cap rather than a per-user one. `1` trusts exactly one proxy
// hop, which is correct for a single front-end proxy and no deeper.
app.set('trust proxy', 1)

const isProduction = process.env.NODE_ENV === 'production'

// ─── CORS ─────────────────────────────────────────────────────────────────────
// The frontend is a separate app on a separate origin, so the browser blocks
// the call unless we say otherwise.
//
// Unset in development, so `vite`'s proxy works untouched. In production it is
// REQUIRED — see the guard below — and set to the deployed frontend URL.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

// Fail fast instead of shipping an open relay. Every call to this endpoint
// spends OpenRouter quota, so an API with no origin allow-list is a way for
// anyone who finds the URL to drain the key. Refusing to boot is loud and
// obvious; defaulting to "*" quietly isn't.
if (isProduction && allowedOrigins.length === 0) {
  console.error(
    '\n' +
      '✖ ALLOWED_ORIGINS is required in production.\n' +
      '  Set it to your deployed frontend origin, comma-separated for several:\n' +
      '    ALLOWED_ORIGINS=https://meme-web.vercel.app\n' +
      '  See .env.example.\n'
  )
  process.exit(1)
}

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    methods: ['GET', 'POST', 'OPTIONS'],
  })
)

app.use(express.json({ limit: '16kb' }))

// Cheap "is it up?" probe — also the fastest way to confirm a deploy is live.
//
// It genuinely verifies the OpenRouter key rather than just checking the env
// var is present, because those are different things: a revoked key passes a
// presence check and then turns every generate into a 502. The upstream call is
// cached inside verifyApiKey() so a 30s health probe doesn't hammer OpenRouter.
//
// Returns 200 even when the key is bad, on purpose: a dead key isn't a reason to
// tell the platform this instance is unhealthy, and Render would react by
// restarting a perfectly good process in a loop. Pass ?strict=1 to get a 503
// instead, which is what you want when a CI step should fail on it.
app.get('/api/health', async (req, res) => {
  const key = await verifyApiKey()
  const healthy = key.valid !== false

  const body = {
    ok: healthy,
    keyConfigured: key.configured,
    keyValid: key.valid,
    ...(key.detail ? { detail: key.detail } : {}),
    ...(key.credits != null ? { credits: key.credits } : {}),
  }

  res.status(req.query.strict === '1' && !healthy ? 503 : 200).json(body)
})

// A real request costs an OpenRouter call and occupies the process for up to
// ~90s, so the cap is deliberately loose — generous enough that an actual user
// never hits it, tight enough that a script looping the endpoint runs dry.
// The long `windowMs` matters here: a short window over a 60s-long request
// would let more calls be in flight than the limit is meant to permit.
const generateLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Match the rest of the API's error shape so the frontend can surface it
  // through the same code path as every other failure.
  handler: (_req, res) =>
    res.status(429).json({
      error: 'Too many memes requested. Please wait a few minutes and try again.',
    }),
})

app.post('/api/memes', generateLimiter, async (req, res) => {
  try {
    const memes = await createMemes(req.body?.category)
    res.json({ memes })
  } catch (err) {
    // A status on the error means the failure is about the request itself
    // (bad category), not about us — pass it through verbatim.
    if (err.status) {
      res.status(err.status).json({ error: err.message })
      return
    }

    console.error('[/api/memes] failed:', err.message)

    // 504 = we gave up waiting on the model, which is retryable and worth
    // telling apart from a hard failure.
    const timedOut = /within \d+s|out of time/i.test(err.message)
    res.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? 'The meme generator took too long. Please try again.'
        : 'Failed to generate memes',
    })
  }
})

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// Express 5 handles async rejections itself, but an unhandled error here would
// otherwise take the whole process down without a useful log line.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err)
})

const PORT = process.env.PORT || 8787

// This file is BOTH the entry point and the handler, so the same code can run
// as a long-lived process or as a serverless function.
//
// • Render / Docker / `node src/index.js` → we must bind a port and keep
//   listening, because there's a real server sitting behind the hostname.
// • Vercel / Lambda → there is no server to bind. The platform imports this
//   module and invokes the exported `app` once per request, then freezes it.
//   Calling listen() here would open a socket nobody routes to, and the real
//   request would hang until it timed out.
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)

// Required so serverless platforms can treat `app` as a request handler.
export default app

if (!isServerless) {
  app.listen(PORT, () => {
    console.log(`🔥 meme-api listening on http://localhost:${PORT}`)
    if (!process.env.OPEN_ROUTER_API_KEY) {
      console.warn('⚠️  OPEN_ROUTER_API_KEY is missing — requests will fail until .env is set')
    }
  })
}