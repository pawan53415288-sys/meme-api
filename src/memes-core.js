// ─────────────────────────────────────────────────────────────────────────────
//  Shared meme-generation logic — framework agnostic on purpose.
//
//  Two entry points call into this, so the behaviour is identical in both:
//    • server/index.js  → Express, used locally by `npm run dev`
//    • api/memes.js     → Vercel Function, used in production
//
//  Contract both entry points expose:
//    POST /api/memes   body: { category }   ->   { memes: [{ id, imageUrl, caption }] }
// ─────────────────────────────────────────────────────────────────────────────
import { generateMemeTexts } from './openrouter.js'
import { pickTemplates, buildMemeImages } from './memegen.js'

// A short human description per category. We keep this on the server so the
// prompt (and any tweaks to it) stay out of the frontend.
export const CATEGORY_THEMES = {
  bollywood: 'Bollywood movies, iconic actors, dramatic dialogues and filmy songs',
  cartoon: 'classic cartoons and childhood animated TV shows',
  'viral-songs': 'viral songs and internet music trends everyone has stuck in their head',
  sports: 'sports fandom — cricket, football and big tournament moments',
}

// Thrown for problems we want to report back with a specific status code.
export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// category -> [{ id, imageUrl, caption }]
export async function createMemes(category) {
  const theme = CATEGORY_THEMES[category]
  if (!theme) {
    throw new HttpError(400, 'Unknown category')
  }

  // 1. Pick meme templates (each with its joke format).
  // 2. Ask the AI for text written to each template's structure.
  // 3. Paint the text onto the templates via memegen.link.
  const templates = await pickTemplates(5)
  const texts = await generateMemeTexts(theme, templates)
  return buildMemeImages(category, templates, texts)
}
