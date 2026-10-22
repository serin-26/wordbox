// word box API — Cloudflare Pages Functions (one catch-all route for /api/*)
// Bindings / variables (set in the Cloudflare dashboard, see SETUP.md):
//   DB (D1 database), GOOGLE_CLIENT_ID, SESSION_SECRET, GEMINI_API_KEY, [GEMINI_MODEL]

const DAY_MS = 864e5;
const SESSION_DAYS = 30;
const OCR_PER_DAY = 40;
const SCORES_PER_DAY = 120;
const MAX_WORDS = 4000;
const MAX_STATE_BYTES = 1_800_000;
const enc = new TextEncoder();

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
const fail = (code, status = 400) => json({ error: code }, status);

/* ---------- base64url / HMAC session ---------- */
const b64u = {
  enc(bytes) {
    let s = '';
    new Uint8Array(bytes).forEach((b) => (s += String.fromCharCode(b)));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signSession(env, sub) {
  const payload = b64u.enc(enc.encode(JSON.stringify({ sub, exp: Date.now() + SESSION_DAYS * DAY_MS })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_SECRET), enc.encode(payload));
  return payload + '.' + b64u.enc(sig);
}
async function readSession(env, request) {
  if (!env.SESSION_SECRET) return null;
  const m = /^Bearer\s+(\S+)$/.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.SESSION_SECRET), b64u.dec(sig), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64u.dec(payload)));
    if (!data.sub || !(data.exp > Date.now())) return null;
    return String(data.sub);
  } catch {
    return null;
  }
}

/* ---------- Google ID token verification (RS256 via Google's JWKS) ---------- */
let certCache = { at: 0, keys: null };
async function googleKeys() {
  if (certCache.keys && Date.now() - certCache.at < 3600e3) return certCache.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) throw new Error('certs');
  const data = await res.json();
  certCache = { at: Date.now(), keys: data.keys || [] };
  return certCache.keys;
}
async function verifyGoogle(idToken, clientId) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('format');
  const header = JSON.parse(new TextDecoder().decode(b64u.dec(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(b64u.dec(parts[1])));
  if (header.alg !== 'RS256') throw new Error('alg');
  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('kid');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u.dec(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('sig');
  if (claims.aud !== clientId) throw new Error('aud');
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') throw new Error('iss');
  if (!(claims.exp * 1000 > Date.now())) throw new Error('exp');
  if (!claims.sub) throw new Error('sub');
  return claims;
}

/* ---------- helpers ---------- */
function cleanName(s, fallback = '학습자') {
  const v = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return v || fallback;
}
function cleanPicture(s) {
  s = String(s || '');
  return /^https:\/\/[\w.\-]+\/[\w\-./=%?&+~:]*$/.test(s) && s.length < 400 ? s : '';
}
const dayNum = () => Math.floor(Date.now() / DAY_MS);
async function readBody(request, limit) {
  const text = await request.text();
  if (text.length > limit) throw Object.assign(new Error('too_large'), { code: 'too_large' });
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw Object.assign(new Error('bad_json'), { code: 'bad_json' });
  }
}
async function bump(env, uid, kind, limit) {
  const day = dayNum();
  await env.DB.prepare(
    'INSERT INTO usage (user_id, day, kind, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT(user_id, day, kind) DO UPDATE SET n = n + 1'
  ).bind(uid, day, kind).run();
  const row = await env.DB.prepare('SELECT n FROM usage WHERE user_id = ?1 AND day = ?2 AND kind = ?3').bind(uid, day, kind).first();
  return !row || row.n <= limit;
}

/* ---------- routes ---------- */
async function login(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.SESSION_SECRET) return fail('not_configured', 500);
  const body = await readBody(request, 20_000);
  let claims;
  try {
    claims = await verifyGoogle(body.credential, env.GOOGLE_CLIENT_ID);
  } catch {
    return fail('invalid_credential', 401);
  }
  const id = 'g_' + claims.sub;
  let user = await env.DB.prepare('SELECT id, name, picture FROM users WHERE id = ?1').bind(id).first();
  if (!user) {
    const name = cleanName(claims.name || String(claims.email || '').split('@')[0]);
    const picture = cleanPicture(claims.picture);
    await env.DB.prepare('INSERT INTO users (id, name, picture, created) VALUES (?1, ?2, ?3, ?4)').bind(id, name, picture, Date.now()).run();
    user = { id, name, picture };
  }
  return json({ token: await signSession(env, id), user: { name: user.name, picture: user.picture } });
}

async function me(request, env, uid) {
  const user = await env.DB.prepare('SELECT name, picture FROM users WHERE id = ?1').bind(uid).first();
  if (!user) return fail('unauthorized', 401);
  if (request.method === 'PUT') {
    const body = await readBody(request, 2000);
    const name = cleanName(body.name, user.name);
    await env.DB.prepare('UPDATE users SET name = ?1 WHERE id = ?2').bind(name, uid).run();
    return json({ user: { name, picture: user.picture } });
  }
  return json({ user: { name: user.name, picture: user.picture } });
}

async function state(request, env, uid) {
  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT data, updated FROM states WHERE user_id = ?1').bind(uid).first();
    if (!row) return json({ data: null, updated: 0 });
    let data = null;
    try {
      data = JSON.parse(row.data);
    } catch {}
    return json({ data, updated: row.updated });
  }
  const body = await readBody(request, MAX_STATE_BYTES + 5000);
  const d = body && body.data;
  if (!d || typeof d !== 'object' || !Array.isArray(d.words) || d.words.length > MAX_WORDS) return fail('invalid_state');
  const clean = {
    v: 1,
    words: d.words,
    folders: Array.isArray(d.folders) ? d.folders.slice(0, 500) : [],
    langs: Array.isArray(d.langs) ? d.langs.slice(0, 50) : [],
    hist: d.hist && typeof d.hist === 'object' && !Array.isArray(d.hist) ? d.hist : {},
    mine: Array.isArray(d.mine) ? d.mine.slice(0, 400) : [],
  };
  const text = JSON.stringify(clean);
  if (text.length > MAX_STATE_BYTES) return fail('too_large', 413);
  await env.DB.prepare(
    'INSERT INTO states (user_id, data, updated) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO UPDATE SET data = ?2, updated = ?3'
  ).bind(uid, text, Date.now()).run();
  return json({ ok: true });
}

function int(v, lo, hi) {
  v = Number(v);
  return Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : null;
}
async function score(request, env, uid) {
  const b = await readBody(request, 2000);
  let value, detail;
  if (b.game === 'typing') {
    const chars = int(b.chars, 10, 3000), jamo = int(b.jamo, 10, 9000), ms = int(b.ms, 2000, 3_600_000), errors = int(b.errors, 0, 3000);
    if (chars == null || jamo == null || ms == null || errors == null || errors > chars) return fail('invalid_score');
    const cpm = jamo / (ms / 60000);
    if (cpm > 1100) return fail('too_fast');
    const acc = 1 - errors / chars;
    value = Math.round(cpm * acc);
    detail = JSON.stringify({ cpm: Math.round(cpm), acc: Math.round(acc * 1000) / 10, chars });
  } else if (b.game === 'quiz') {
    const total = int(b.total, 5, 50), correct = int(b.correct, 0, 50);
    if (total == null || correct == null || correct > total) return fail('invalid_score');
    value = correct * 10;
    detail = JSON.stringify({ correct, total });
  } else return fail('invalid_game');
  if (!(await bump(env, uid, 'score', SCORES_PER_DAY))) return fail('rate_limited', 429);
  await env.DB.prepare('INSERT INTO scores (user_id, game, score, detail, created) VALUES (?1, ?2, ?3, ?4, ?5)').bind(uid, b.game, value, detail, Date.now()).run();
  return json({ score: value });
}

async function leaderboard(request, env) {
  const url = new URL(request.url);
  const game = url.searchParams.get('game') === 'quiz' ? 'quiz' : 'typing';
  const period = url.searchParams.get('period') === 'all' ? 'all' : 'week';
  const since = period === 'all' ? 0 : Date.now() - 7 * DAY_MS;
  const agg = game === 'quiz' ? 'SUM(s.score)' : 'MAX(s.score)';
  const res = await env.DB.prepare(
    `SELECT s.user_id AS uid, u.name AS name, ${agg} AS score FROM scores s JOIN users u ON u.id = s.user_id
     WHERE s.game = ?1 AND s.created >= ?2 GROUP BY s.user_id ORDER BY score DESC, MIN(s.created) ASC LIMIT 200`
  ).bind(game, since).all();
  const myId = await readSession(env, request);
  const all = (res.results || []).map((r, i) => ({ rank: i + 1, name: r.name, score: r.score, me: r.uid === myId }));
  const top = all.slice(0, 30);
  const mine = all.find((r) => r.me);
  if (mine && !top.includes(mine)) top.push(mine);
  return json({ game, period, rows: top, total: all.length });
}

/* ---------- Gemini (key stays on the server) ---------- */
function ocrPrompt(mode, lang) {
  if (mode === 'text') {
    return (
      'Transcribe all readable text in the attached photo or photos exactly as printed, in reading order. ' +
      'Keep line breaks between paragraphs or lines. Do not translate, summarize or add commentary. ' +
      'Reply with only a JSON object like {"text":"..."}.'
    );
  }
  return (
    'The attached photo shows a vocabulary list or textbook page for a Korean learner of ' + lang + '. ' +
    'Extract every vocabulary entry you can read. Reply with only a JSON array of objects, one per entry, in reading order, like [{"word":"...","meaning":"...","example":"..."}].\n' +
    '- word: the ' + lang + ' word or phrase exactly as printed (keep accents, kana, kanji, hanzi and tone marks). Leave out pronunciation guides such as furigana, pinyin or romanization, part-of-speech tags and numbering.\n' +
    '- meaning: the Korean meaning printed next to the word, copied as printed. Use an empty string if no Korean meaning is printed.\n' +
    '- example: the ' + lang + ' example sentence printed for that word. Use an empty string if there is none. Do not put the Korean translation of the sentence here.\n' +
    'Skip titles, page numbers, headings and anything that is not a vocabulary entry. Do not invent entries and do not fill in text you cannot read.'
  );
}
function parseModelJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.search(/[\[{]/);
    const z = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
    if (a >= 0 && z > a) return JSON.parse(t.slice(a, z + 1));
    throw new Error('json');
  }
}
async function ocr(request, env, uid) {
  if (!env.GEMINI_API_KEY) return fail('ocr_unavailable', 503);
  const b = await readBody(request, 14_000_000);
  const mode = b.mode === 'text' ? 'text' : 'words';
  const lang = String(b.lang || 'English').replace(/[^\p{L}\p{N} ()\-]/gu, '').slice(0, 20) || 'English';
  const imgs = (Array.isArray(b.images) ? b.images : []).slice(0, 3);
  const parts = [{ text: ocrPrompt(mode, lang) }];
  for (const im of imgs) {
    const mime = String((im && im.mime) || '');
    const data = String((im && im.data) || '');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime) || !/^[A-Za-z0-9+/=]+$/.test(data) || data.length > 4_500_000) return fail('invalid_image');
    parts.push({ inline_data: { mime_type: mime, data } });
  }
  if (parts.length < 2) return fail('invalid_image');
  if (!(await bump(env, uid, 'ocr', OCR_PER_DAY))) return fail('rate_limited', 429);
  const model = String(env.GEMINI_MODEL || 'gemini-2.5-flash').replace(/[^\w.\-]/g, '');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 8192 },
    }),
  });
  if (res.status === 429) return fail('rate_limited', 429);
  if (!res.ok) return fail('ocr_failed', 502);
  const out = await res.json();
  const text = (((out.candidates || [])[0] || {}).content || {}).parts;
  const joined = Array.isArray(text) ? text.map((p) => p.text || '').join('') : '';
  let parsed;
  try {
    parsed = parseModelJson(joined);
  } catch {
    return fail('invalid_json', 502);
  }
  if (mode === 'text') return json({ text: String((parsed && parsed.text) || '').slice(0, 20000) });
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.words) ? parsed.words : [];
  const words = list
    .map((x) => ({ word: String((x && x.word) || '').slice(0, 80), meaning: String((x && x.meaning) || '').slice(0, 200), example: String((x && x.example) || '').slice(0, 300) }))
    .filter((x) => x.word)
    .slice(0, 300);
  return json({ words });
}

/* ---------- router ---------- */
export async function onRequest({ request, env }) {
  const route = new URL(request.url).pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const method = request.method;
  try {
    if (route === 'config' && method === 'GET') return json({ clientId: env.GOOGLE_CLIENT_ID || '', ocr: !!env.GEMINI_API_KEY, ready: !!(env.DB && env.SESSION_SECRET) });
    if (!env.DB) return fail('db_missing', 500);
    if (route === 'login' && method === 'POST') return await login(request, env);
    if (route === 'leaderboard' && method === 'GET') return await leaderboard(request, env);
    const uid = await readSession(env, request);
    if (!uid) return fail('unauthorized', 401);
    if (route === 'me' && (method === 'GET' || method === 'PUT')) return await me(request, env, uid);
    if (route === 'state' && (method === 'GET' || method === 'PUT')) return await state(request, env, uid);
    if (route === 'score' && method === 'POST') return await score(request, env, uid);
    if (route === 'ocr' && method === 'POST') return await ocr(request, env, uid);
    return fail('not_found', 404);
  } catch (e) {
    if (e && e.code) return fail(e.code, e.code === 'too_large' ? 413 : 400);
    return fail('server_error', 500);
  }
}
