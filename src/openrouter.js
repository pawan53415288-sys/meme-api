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
const CREDITS_ENDPOINT = 'https://openrouter.ai/api/v1/credits'

// ─── Key verification ──────────────────────────────────────────────────────────
// `OPEN_ROUTER_API_KEY is set` and `the key works` are different claims, and only
// the second one matters. A revoked or mistyped key still passes a presence
// check, which is how a dead key once made /api/health report green while every
// generate call 502'd. So we actually authenticate.
//
// Cached, because health probes run every ~30s on most hosts and this is a real
// network round-trip to a third party. A stale-true window of a few minutes is
// harmless; hammering OpenRouter to re-confirm it is not.
const KEY_CHECK_TTL_MS = 5 * 60_000
let keyCheckCache = null

export async function verifyApiKey() {
  const apiKey = process.env.OPEN_ROUTER_API_KEY
  if (!apiKey) {
    return { valid: false, configured: false, detail: 'OPEN_ROUTER_API_KEY is not set' }
  }

  const now = Date.now()
  if (keyCheckCache && now - keyCheckCache.at < KEY_CHECK_TTL_MS) {
    return keyCheckCache
  }

  let result
  try {
    const res = await fetch(CREDITS_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })

    if (res.ok) {
      const { data } = await res.json().catch(() => ({ data: null }))
      result = { valid: true, configured: true, detail: null, credits: data?.total_credits ?? null }
    } else {
      result = {
        valid: false,
        configured: true,
        // 401 is the one that bites in practice: a revoked or mistyped key.
        detail: `OpenRouter rejected the key (HTTP ${res.status})`,
      }
    }
  } catch (err) {
    // A network blip must NOT be reported as a bad key — that would send you
    // off rotating a perfectly good key.
    result = { valid: null, configured: true, detail: `Could not reach OpenRouter: ${err.message}` }
  }

  keyCheckCache = { ...result, at: now }
  return keyCheckCache
}

// NOTE: OpenRouter's free catalog changes often. If these all 404, run
// `GET https://openrouter.ai/api/v1/models` and swap in current `:free` ids
// (or set OPENROUTER_MODEL in .env).
//
// Ordered by what we've actually seen answer, fastest viable first.
//
// Verified ids lead. The newer/faster free ids are kept as fallbacks rather than
// promoted: when these were first added, `laguna-xs`, `qwen3.8-27b` and
// `gemma-4-26b` all answered 429 immediately on a free key, so leading with them
// just burned fallback slots before reaching one that works.
//
// Deliberately excluded:
//   • nvidia/nemotron-3.5-content-safety:free — a classifier, it doesn't write
//   • cohere/north-mini-code:free            — code-tuned, poor at humour
//   • nemotron-3-super-120b / ultra-550b      — too large to answer in time
//   • nemotron-3-nano-omni-30b-...-reasoning  — slow and multimodal
//
// Removed ids that no longer exist in the catalog: `ling-3.0-flash-fin` (the
// live one is `ling-3.0-flash-sante`), and a duplicated
// `nemotron-3.5-lightning` that was burning a fallback slot on every request.
const DEFAULT_MODELS = [
  'dots-studio/dots-3-note-preview:free',
  'thinkingmachines/inkling-small:free',
  'liquid/lfm-2.5-2.6b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'inclusionai/ling-3.0-flash-sante:free',
  'poolside/laguna-xs-2.1:free',
  'qwen/qwen3.8-27b:free',
  'google/gemma-4-26b-a4b-it:free',
  'poolside/laguna-s-2.1:free',
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
      const startedAt = Date.now()
      const texts = await callModel(apiKey, model, prompt, deadline)
      if (texts.length >= 1) {
        DEMOTED_UNTIL.delete(model)
        // Log the winner and how long it took. Without this the fallback loop is
        // a black box: you can only infer which model is healthy from how long
        // the request took, which makes tuning the list guesswork.
        console.log(`[openrouter] ${model} answered in ${Date.now() - startedAt}ms`)
        return normalize(texts, templates.length)
      }
      lastError = new Error(`${model} replied without any usable meme text`)
    } catch (err) {
      // A bad key or an empty quota fails identically on every model, so
      // retrying the rest of the list just burns the full request budget to
      // arrive at the same error. Bail out on the first one.
      if (err.auth) {
        DEMOTED_UNTIL.delete(model)
        throw err
      }
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

  // fetch does NOT throw on 4xx/5xx — check res.ok yourself.
  if (!res.ok) {
    // Only 401 genuinely means the key itself is bad, and that's worth
    // aborting on: no model will accept it, so trying the rest of the list just
    // spends the whole request budget to reach the same conclusion.
    if (res.status === 401) {
      throw Object.assign(
        new Error(
          'OpenRouter rejected OPEN_ROUTER_API_KEY. It is probably revoked, mistyped, or belongs to a different account — create a new key at https://openrouter.ai/keys'
        ),
        { auth: true, status: 401 }
      )
    }

    // 403 is NOT an auth failure here. OpenRouter uses it for "this model isn't
    // available on your plan/key" (observed on free-tier ids like
    // thinkingmachines/inkling-small:free), so the correct response is to skip
    // that model exactly like a 404 — aborting would let one restricted model
    // kill every request.
    if (res.status === 402) {
      throw Object.assign(new Error('OpenRouter reports no remaining credit on this key.'), {
        auth: true,
        status: 402,
      })
    }

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
