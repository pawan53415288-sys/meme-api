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
import { createMemes } from './memes-core.js'

const app = express()
app.disable('x-powered-by')

// ─── CORS ─────────────────────────────────────────────────────────────────────
// The frontend is a separate app on a separate origin, so the browser blocks
// the call unless we say otherwise.
//
// ALLOWED_ORIGINS is left unset during development so `vite`'s proxy works
// untouched. In production, set it to the deployed frontend URL — that keeps
// the API from being called as an open relay by any site someone pastes the
// URL into.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    methods: ['GET', 'POST', 'OPTIONS'],
  })
)

app.use(express.json({ limit: '16kb' }))

// Cheap "is it up?" probe — also the fastest way to confirm a deploy is live and
// that its env vars actually loaded.
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    keyConfigured: Boolean(process.env.OPEN_ROUTER_API_KEY),
  })
})

app.post('/api/memes', async (req, res) => {
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

app.listen(PORT, () => {
  console.log(`🔥 meme-api listening on http://localhost:${PORT}`)
  if (!process.env.OPEN_ROUTER_API_KEY) {
    console.warn('⚠️  OPEN_ROUTER_API_KEY is missing — requests will fail until .env is set')
  }
})