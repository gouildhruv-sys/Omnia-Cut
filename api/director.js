// Vercel Edge Function: the AI Director for OmniaCut.
// Works with a FREE Gemini key (default) or with an Anthropic key.
// Vercel project > Settings > Environment Variables:
//   GEMINI_API_KEY         free key from Google AI Studio (aistudio.google.com/app/apikey)
//   ANTHROPIC_API_KEY      optional, if you prefer Claude (paid)
//   DIRECTOR_PROVIDER      optional: "gemini" or "anthropic" (default: gemini if its key exists)
//   DIRECTOR_ACCESS_CODE   optional password so strangers cannot use your key
//   GEMINI_MODEL / GEMINI_MODEL_QUICK / GEMINI_MODEL_COMPLEX   optional model overrides
export const config = { runtime: 'edge' };

const J = { 'content-type': 'application/json' };
const TXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
const err = (status, msg, extra) => new Response(JSON.stringify({ error: msg, ...extra }), { status, headers: J });

const provider = () => {
  const want = (process.env.DIRECTOR_PROVIDER || '').toLowerCase();
  if (want === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (want === 'gemini' && process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return '';
};
const GEM = () => ({
  quick: process.env.GEMINI_MODEL_QUICK || 'gemini-flash-lite-latest',
  default: process.env.GEMINI_MODEL || 'gemini-flash-latest',
  complex: process.env.GEMINI_MODEL_COMPLEX || process.env.GEMINI_MODEL || 'gemini-flash-latest',
});
const ANT = () => ({
  quick: process.env.ANTHROPIC_MODEL_QUICK || 'claude-haiku-5-5',
  default: process.env.ANTHROPIC_MODEL_DEFAULT || 'claude-sonnet-5-5',
  complex: process.env.ANTHROPIC_MODEL_COMPLEX || 'claude-opus-5-5',
});

// Turn a provider's event stream (SSE) into a plain text stream the page can read.
function sseText(res, pick) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  return new ReadableStream({
    async start(ctrl) {
      const reader = res.body.getReader();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            try { const t = pick(JSON.parse(line.slice(5))); if (t) ctrl.enqueue(enc.encode(t)); } catch {}
          }
        }
      } finally { ctrl.close(); }
    },
  });
}

async function gemini(body, key) {
  const parts = (body.images || []).slice(0, 12).map((d) => ({ inlineData: { mimeType: 'image/jpeg', data: d } }));
  parts.push({ text: String(body.prompt || '').slice(0, 60000) });
  const first = GEM()[body.tier] || GEM().default, tried = [];
  for (const model of [first, 'gemini-flash-latest']) {
    if (tried.includes(model)) continue;
    tried.push(model);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.9, maxOutputTokens: 8192 } }),
    });
    if (r.ok) {
      return new Response(sseText(r, (j) => (((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).filter((p) => !p.thought && p.text).map((p) => p.text).join(''))), { headers: TXT });
    }
    if (r.status === 429 || r.status === 401 || r.status === 403) {
      return err(r.status, 'Gemini API error ' + r.status, { detail: (await r.text()).slice(0, 300) });
    }
  }
  return err(502, 'Gemini API error (model not available)');
}

async function anthropic(body, key) {
  const content = (body.images || []).slice(0, 12).map((d) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: d } }));
  content.push({ type: 'text', text: String(body.prompt || '').slice(0, 60000) });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: ANT()[body.tier] || ANT().default, max_tokens: 8000, stream: true, messages: [{ role: 'user', content }] }),
  });
  if (!r.ok) return err(502, 'Anthropic API error ' + r.status, { detail: (await r.text()).slice(0, 300) });
  return new Response(sseText(r, (j) => (j.type === 'content_block_delta' && j.delta && j.delta.text) || ''), { headers: TXT });
}

export default async function handler(req) {
  const p = provider(), code = process.env.DIRECTOR_ACCESS_CODE;
  if (req.method === 'GET') {
    return new Response(JSON.stringify({ ready: !!p, provider: p === 'gemini' ? 'Gemini' : p === 'anthropic' ? 'Claude' : '', locked: !!code }), { headers: J });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!p) return err(500, 'Set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY in Vercel');
  if (code && req.headers.get('x-access-code') !== code) return err(401, 'access code required');
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad json'); }
  return p === 'gemini' ? gemini(body, process.env.GEMINI_API_KEY) : anthropic(body, process.env.ANTHROPIC_API_KEY);
      }
