// Vercel Edge Function: the AI Director for OmniaCut.
// Works with a FREE Gemini key (default) or with an Anthropic key.
// Vercel project > Settings > Environment Variables:
//   GEMINI_API_KEY         free key from Google AI Studio (aistudio.google.com/app/apikey)
//   ANTHROPIC_API_KEY      optional, if you prefer Claude (paid)
//   DIRECTOR_PROVIDER      optional: "gemini" or "anthropic" (default: gemini if its key exists)
//   DIRECTOR_ACCESS_CODE   optional password so strangers cannot use your key
//   GEMINI_MODEL / GEMINI_MODEL_QUICK / GEMINI_MODEL_COMPLEX   optional model overrides
// To see exactly what is wrong, open  /api/director?test=1  in your browser.
export const config = { runtime: 'edge' };

const J = { 'content-type': 'application/json' };
const TXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
const err = (status, msg, extra) => new Response(JSON.stringify({ error: msg, status, ...extra }), { status, headers: J });
const retryOf = (t) => { const m = String(t).match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/); return m ? Math.ceil(+m[1]) : 0; };

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
const gurl = (model, method) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}`;

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
  // Free-tier limits are per model, so if one model is busy we try the next one.
  const chain = [...new Set([GEM()[body.tier] || GEM().default, 'gemini-flash-latest', 'gemini-flash-lite-latest'])];
  let last = null;
  for (const model of chain) {
    const r = await fetch(gurl(model, 'streamGenerateContent') + '?alt=sse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.9, maxOutputTokens: 16384 } }),
    });
    if (r.ok) {
      return new Response(sseText(r, (j) => (((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).filter((p) => !p.thought && p.text).map((p) => p.text).join(''))), { headers: TXT });
    }
    const text = await r.text();
    last = err(r.status, `Gemini (${model}) returned ${r.status}`, { detail: text.slice(0, 400), retry: retryOf(text) });
    if (r.status === 401 || r.status === 403 || (r.status === 400 && /API key|API_KEY/i.test(text))) return last; // key problem: other models will not help
  }
  return last || err(502, 'Gemini API error');
}

async function anthropic(body, key) {
  const content = (body.images || []).slice(0, 12).map((d) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: d } }));
  content.push({ type: 'text', text: String(body.prompt || '').slice(0, 60000) });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: ANT()[body.tier] || ANT().default, max_tokens: 8000, stream: true, messages: [{ role: 'user', content }] }),
  });
  if (!r.ok) return err(r.status === 429 ? 429 : 502, 'Anthropic API returned ' + r.status, { detail: (await r.text()).slice(0, 400) });
  return new Response(sseText(r, (j) => (j.type === 'content_block_delta' && j.delta && j.delta.text) || ''), { headers: TXT });
}

// /api/director?test=1 : a tiny call that shows the real error in plain JSON.
async function selfTest(p) {
  if (!p) return err(500, 'No key found. Add GEMINI_API_KEY (or ANTHROPIC_API_KEY) in Vercel, then redeploy.');
  const out = [];
  try {
    if (p === 'gemini') {
      for (const model of [...new Set([GEM().default, 'gemini-flash-lite-latest'])]) {
        const r = await fetch(gurl(model, 'generateContent'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK' }] }] }),
        });
        const t = await r.text();
        let reply = '';
        try { reply = (JSON.parse(t).candidates[0].content.parts[0].text || '').slice(0, 40); } catch {}
        out.push({ model, status: r.status, ok: r.ok, reply: r.ok ? reply : undefined, detail: r.ok ? undefined : t.slice(0, 300) });
      }
    } else {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: ANT().default, max_tokens: 20, messages: [{ role: 'user', content: 'Reply with the single word OK' }] }),
      });
      const t = await r.text();
      out.push({ model: ANT().default, status: r.status, ok: r.ok, detail: r.ok ? undefined : t.slice(0, 300) });
    }
  } catch (e) { out.push({ error: String(e) }); }
  return new Response(JSON.stringify({ provider: p, results: out }, null, 1), { headers: J });
}

export default async function handler(req) {
  const p = provider(), code = process.env.DIRECTOR_ACCESS_CODE;
  if (req.method === 'GET') {
    if (new URL(req.url).searchParams.get('test')) return selfTest(p);
    return new Response(JSON.stringify({ ready: !!p, provider: p === 'gemini' ? 'Gemini' : p === 'anthropic' ? 'Claude' : '', locked: !!code }), { headers: J });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!p) return err(500, 'Set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY in Vercel');
  if (code && req.headers.get('x-access-code') !== code) return err(401, 'access code required');
  let body;
  try { body = await req.json(); } catch { return err(400, 'bad json'); }
  try {
    return p === 'gemini' ? await gemini(body, process.env.GEMINI_API_KEY) : await anthropic(body, process.env.ANTHROPIC_API_KEY);
  } catch (e) { return err(502, 'Server error: ' + String(e).slice(0, 200)); }
}
