// ─────────────────────────────────────────────────────────────────────────────
//  Meme image builder (server-side only).
//
//  Images come from the free, no-key memegen.link API. For maximum variety we
//  pull memegen's FULL template catalog (~200 templates) and randomly sample a
//  fresh set each run — so you don't see the same 5 images every time.
//
//  Each template ships an `example` that demonstrates its joke format
//  (Drake = "left on unread" / "left on read"). We pass that example to the
//  model so the text fits the template's structure — that's what viral memes do.
// ─────────────────────────────────────────────────────────────────────────────
const BASE = 'https://api.memegen.link/images'
const CATALOG_URL = 'https://api.memegen.link/templates'

// Curated allowlist of WELL-KNOWN templates (1-2 text lines) whose joke format
// the model reliably understands. Random obscure templates produced nonsense,
// so we sample from these ~27 — still tons of variety, but coherent results.
const POPULAR_IDS = new Set([
  'drake', 'blb', 'rollsafe', 'grumpycat', 'fry', 'success', 'mordor',
  'spongebob', 'cmm', 'disastergirl', 'leo', 'wonka', 'aag', 'oprah', 'buzz',
  'yodawg', 'doge', 'stonks', 'both', 'fine', 'interesting', 'afraid',
  'aint-got-time', 'morpheus', 'patrick', 'spiderman', 'philosoraptor',
])

// Offline fallback so the demo still works if the catalog fetch fails.
const FALLBACK_CATALOG = [
  { id: 'drake', name: 'Drake', lines: 2, example: ['left on unread', 'left on read'] },
  { id: 'fry', name: 'Futurama Fry', lines: 2, example: ['not sure if trolling', 'or just stupid'] },
  { id: 'aag', name: 'Ancient Aliens', lines: 2, example: ['', 'aliens'] },
  { id: 'doge', name: 'Doge', lines: 2, example: ['such meme', 'very skill'] },
  { id: 'buzz', name: 'X X Everywhere', lines: 2, example: ['memes', 'memes everywhere'] },
  { id: 'grumpycat', name: 'Grumpy Cat', lines: 2, example: ['everyone said we will meet', 'no one made a plan'] },
  { id: 'mordor', name: 'One Does Not Simply', lines: 2, example: ['one does not simply', 'walk into mordor'] },
  { id: 'fine', name: 'This Is Fine', lines: 2, example: ['', 'this is fine'] },
  { id: 'wonka', name: 'Condescending Wonka', lines: 2, example: ['oh, you just graduated?', 'you must know everything'] },
  { id: 'spiderman', name: 'Spiderman Pointing', lines: 2, example: ['me pointing at you', 'you pointing at me'] },
]

let catalogCache = null

async function getCatalog() {
  if (catalogCache) return catalogCache
  try {
    const res = await fetch(CATALOG_URL)
    if (!res.ok) throw new Error(`catalog responded ${res.status}`)
    const all = await res.json()
    const usable = all
      .filter((t) => POPULAR_IDS.has(t.id) && t.lines >= 1 && t.lines <= 2)
      .map((t) => ({
        id: t.id,
        name: t.name,
        lines: t.lines,
        example: t.example?.text ?? [],
      }))
    catalogCache = usable.length ? usable : FALLBACK_CATALOG
  } catch {
    catalogCache = FALLBACK_CATALOG
  }
  return catalogCache
}

// Randomly sample `count` distinct templates → fresh image variety every run.
export async function pickTemplates(count = 5) {
  const pool = [...(await getCatalog())]
  const picked = []
  while (picked.length < count && pool.length) {
    const i = Math.floor(Math.random() * pool.length)
    picked.push(pool.splice(i, 1)[0])
  }
  return picked
}

// Combines the chosen templates with the model's text into ready-to-show memes.
export function buildMemeImages(category, templates, texts) {
  return templates.map((template, i) => {
    const text = texts[i] ?? { top: '', bottom: '' }
    const top = (text.top || '').trim()
    const bottom = (text.bottom || '').trim()

    // memegen renders top/bottom as two path segments. 1-line templates use one.
    const path =
      template.lines === 2 && bottom
        ? `${encodeMemeText(top)}/${encodeMemeText(bottom)}`
        : encodeMemeText(top || bottom || ' ')

    return {
      id: `${category}-${i}-${Date.now()}`,
      caption: [top, bottom].filter(Boolean).join(' · '),
      imageUrl: `${BASE}/${template.id}/${path}.png`,
    }
  })
}

// memegen.link path-encoding rules (order matters):
//   _ -> __ , - -> -- , space -> _ , then the special ~x escapes.
function encodeMemeText(text) {
  return text
    .trim()
    .replace(/_/g, '__')
    .replace(/-/g, '--')
    .replace(/ /g, '_')
    .replace(/\?/g, '~q')
    .replace(/&/g, '~a')
    .replace(/%/g, '~p')
    .replace(/#/g, '~h')
    .replace(/\//g, '~s')
    .replace(/"/g, "''")
    .replace(/\n/g, '~n')
}
