// HTTP routing shared by the stand-alone Worker and the Pages Functions, so the
// two deployment shapes behave identically.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O: easy to read out loud

export function randomCode(len = 4) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const stubFor = (env, code) => env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));

// Returns a Response for the routes we own, or null so the caller can fall through.
export async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/api/rooms') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    for (let i = 0; i < 8; i++) {
      const code = randomCode();
      const res = await stubFor(env, code).fetch(`https://room/init?code=${code}`, { method: 'POST' });
      if (res.status === 200) return json({ code });
    }
    return json({ error: 'busy' }, 503);
  }

  const m = url.pathname.match(/^\/ws\/([A-Za-z]{4})$/);
  if (m) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    return stubFor(env, m[1].toUpperCase()).fetch(request);
  }
  return null;
}
