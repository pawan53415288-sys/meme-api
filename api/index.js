// Vercel serverless entry point.
//
// Vercel builds one function per file in /api. Without this file it has no
// function to invoke and every route 500s — which is exactly what happened
// before it existed.
//
// The route /api/index.js maps to the URL path /api, so POST /api/memes and
// GET /api/health keep working exactly as they do locally and on Render. No
// rewriting, no separate route table: it's the same Express app either way.
import app from '../src/index.js'

export default app