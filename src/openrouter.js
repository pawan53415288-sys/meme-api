// ─────────────────────────────────────────────────────────────────────────────
//  OpenRouter meme-text generation (server-side only).
//
//  Uses the OpenAI-compatible Chat Completions endpoint OpenRouter exposes.
//  We try a list of FREE models in order, so the demo keeps working even if one
//  is rate-limited or retired. Browse current free models at:
//    https://openrouter.ai/models?max_price=0
//
//  The key idea for GOOD memes: we don't ask for generic captions. We tell the
//  model exactly which meme template each line is for, and its joke structure,
//  so the text actually fits the format (that's what viral memes do).
// ─────────────────────────────────────────────────────────────────────────────
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

// NOTE: OpenRouter's free catalog changes often. If these all 404, run
// `GET https://openrouter.ai/api/v1/models` and swap in current `:free` ids
// (or set OPENROUTER_MODEL in .env).
//
// Only ids verified to actually answer are listed. Retired-from-free ids
// (gpt-oss-20b, nemotron-3-nano, ling-3.0-flash) were removed: they answer 404
// instantly and just burn a slot in the fallback loop.
const DEFAULT_MODELS = [
  'dots-studio/dots-3-note-preview:free',
  'liquid/lfm-2.5-2.6b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'inclusionai/ling-3.0-flash-fin:free',
  'nvidia/nemotron-3.5-lightning:free',
  'thinkingmachines/inkling-small:free'
]

// Resolved per call rather than at import time, and de-duplicated: an override
// that names a model already in the list would otherwise be tried twice and
// burn its timeout slot for nothing.
function configuredModels() {
  return [...new Set([process.env.OPENROUTER_MODEL, ...DEFAULT_MODELS].filter(Boolean))]
}

// Free models are unreliable in two very different ways: some fail fast with a
// 404/429, others accept the request and then never send a body back. Without a
// deadline the second kind hangs the whole HTTP response forever, which is why
// the UI used to spin with no error. So every attempt is capped.
//
// The cap has to clear the slowest *working* model with headroom: these are
// reasoning models and a real 5-meme completion measures 25-35s, so anything
// under ~45s starts killing requests that were about to succeed.
const PER_MODEL_TIMEOUT_MS = 60_000
const TOTAL_BUDGET_MS = 90_000

// A model that fails gets pushed to the back of the queue for a while, so one
// bad afternoon on a free provider doesn't tax every request.
const DEMOTED_UNTIL = new Map()

function modelOrder() {
  const now = Date.now()
  for (const [model, until] of DEMOTED_UNTIL) {
    if (until <= now) DEMOTED_UNTIL.delete(model)
  }
  return configuredModels().sort(
    (a, b) => Number(DEMOTED_UNTIL.has(a)) - Number(DEMOTED_UNTIL.has(b))
  )
}

// templates: [{ id, lines, brief }]  ->  [{ top, bottom }] (one per template)
export async function generateMemeTexts(theme, templates) {
  const apiKey = process.env.OPEN_ROUTER_API_KEY
  if (!apiKey) {
    throw new Error('OPEN_ROUTER_API_KEY is missing from .env')
  }

  const prompt = buildPrompt(theme, templates)
  const deadline = Date.now() + TOTAL_BUDGET_MS

  let lastError
  for (const model of modelOrder()) {
    if (Date.now() >= deadline) break

    try {
      const texts = await callModel(apiKey, model, prompt, deadline)
      if (texts.length >= 1) {
        DEMOTED_UNTIL.delete(model)
        return normalize(texts, templates.length)
      }
      lastError = new Error(`${model} replied without any usable meme text`)
    } catch (err) {
      lastError = err
    }

    DEMOTED_UNTIL.set(model, Date.now() + 10 * 60_000)
    console.warn(`[openrouter] skipping ${model}: ${lastError.message}`)
  }

  throw lastError ?? new Error('No meme text returned by any model')
}

function buildPrompt(theme, templates) {
  const list = templates
    .map((t, i) => {
      const eg = (t.example || []).filter(Boolean).join('  ->  ') || 'setup -> punchline'
      const slots = t.lines === 2 ? 'top + bottom' : 'one line'
      return `${i + 1}. ${t.name} (${slots}). Its format looks like:  ${eg}`
    })
    .join('\n')

  return [
    `Write ${templates.length} genuinely funny, RELATABLE memes about ${theme}.`,
    '',
    'WHAT MAKES A GOOD MEME (read carefully):',
    '- Each meme = ONE specific everyday situation with a clear setup and a punchline.',
    '- Every line must be a COMPLETE, natural Hinglish sentence, like texting a friend.',
    '- The two lines must connect into ONE joke. NEVER write disconnected keywords.',
    '- Be specific + relatable: padhai, salary, shaadi, cricket, reels, mummy ki daant, EMI.',
    '- Hinglish = Hindi + English in Roman/English letters. Casual spoken tone.',
    '- Keep each line under ~10 words. No emojis, no hashtags, no quotes, no gaali.',
    '',
    'BAD (never do this): "Hero dialogue yaad, public ne mazak udaya"  <- random fragments, no joke.',
    'GOOD (match this coherence + relatability):',
    '  Drake        -> top: "Gym ka membership lena"       bottom: "Ek din jaake sirf photo daalna"',
    '  Futurama Fry -> top: "Not sure if sach me bhookh hai" bottom: "ya bas bore ho raha hoon"',
    '  Wonka        -> top: "Oh, tumne ek match dekha?"      bottom: "Ab toh tum coach ban gaye"',
    '  This Is Fine (one line): "Exam kal hai aur main abhi bhi reels dekh raha hoon"',
    '',
    'Now write for these templates, IN ORDER. Fit YOUR situation into each format:',
    list,
    '',
    'Reply with ONLY this JSON (bottom = "" for one-line templates):',
    '{"memes":[{"top":"...","bottom":"..."}]}',
  ].join('\n')
}

async function callModel(apiKey, model, prompt, deadline) {
  const budget = Math.min(PER_MODEL_TIMEOUT_MS, deadline - Date.now())
  if (budget <= 0) throw new Error('out of time before trying this model')

  let res
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You are a savage desi meme writer who thinks in Hinglish and knows ' +
              'every classic meme template by heart. You always reply with valid JSON.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.9,
      }),
      signal: AbortSignal.timeout(budget),
    })
  } catch (err) {
    // A free model that accepts the request but never answers lands here.
    throw new Error(`no answer within ${Math.round(budget / 1000)}s`)
  }

  // fetch does NOT throw on 4xx/5xx — check res.ok yourself (Week 1, Slide 22).
  if (!res.ok) {
    throw new Error(`OpenRouter responded ${res.status}`)
  }

  const data = await res.json()

  // Upstream provider failures (429 rate limit, 503 overloaded) come back as
  // HTTP 200 with the failure in the body. Treating those as a normal reply
  // silently loses the reason, so surface it.
  if (data?.error) {
    throw new Error(data.error.message || `OpenRouter error ${data.error.code}`)
  }

  const text = data?.choices?.[0]?.message?.content ?? ''
  return parseMemes(text)
}

// Models wrap the JSON in ``` fences, or emit a draft, a "oops let me fix
// that" note, and then the real JSON. A single greedy /\{[\s\S]*\}/ spans from
// the first { to the last }, swallowing both objects plus the prose between
// them — JSON.parse then throws and we fall through to the line-based fallback,
// which turns the whole reply into junk one-line "memes". So walk the balanced
// {...} blocks individually and take the first one that actually parses.
function parseMemes(text) {
  for (const block of jsonBlocks(text)) {
    const list = toMemeList(block)
    if (list) return list
  }

  // No JSON anywhere. Returning [] (rather than treating every line as a meme)
  // lets the caller fall through to the next model — showing the user lines of
  // prose dressed up as captions is worse than one more retry.
  return []
}

// Yields each balanced top-level {...} or [...] block, ignoring brackets that
// appear inside string literals.
function* jsonBlocks(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue

    const stack = []
    let inString = false

    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (inString) {
        if (ch === '\\') j++
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{' || ch === '[') stack.push(ch)
      else if (ch === '}' || ch === ']') {
        stack.pop()
        if (stack.length === 0) {
          yield text.slice(i, j + 1)
          i = j
          break
        }
      }
    }
  }
}

function toMemeList(block) {
  try {
    const obj = JSON.parse(block)
    const list = Array.isArray(obj?.memes) ? obj.memes : Array.isArray(obj) ? obj : null
    return list ? list.map(toMeme).filter((m) => m.top || m.bottom) : null
  } catch {
    return null
  }
}

// Accept a few shapes the model might use and normalise to { top, bottom }.
function toMeme(item) {
  if (typeof item === 'string') return { top: item.trim(), bottom: '' }
  const top = item.top ?? item.line1 ?? item.text ?? ''
  const bottom = item.bottom ?? item.line2 ?? ''
  return { top: String(top).trim(), bottom: String(bottom).trim() }
}

function normalize(texts, count) {
  return texts.slice(0, count).filter((t) => t.top || t.bottom)
}
