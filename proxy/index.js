// Serves the game under https://luckylion.games/avalon/ by forwarding to the Pages project.
//   /avalon          -> redirect to /avalon/ (relative asset URLs need the trailing slash)
//   /avalon/<path>   -> <ORIGIN>/<path>  (static files, /api/rooms, /ws/CODE incl. WebSocket upgrades)
// It also stamps X-Robots-Tag so the game stays out of search results no matter what Pages sends.

const PREFIX = '/avalon';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === PREFIX) return Response.redirect(`${url.origin}${PREFIX}/${url.search}`, 301);
    if (!url.pathname.startsWith(`${PREFIX}/`)) return fetch(request); // not ours: pass through untouched

    const origin = new URL(env.ORIGIN);
    const target = new URL(url.pathname.slice(PREFIX.length) + url.search, origin);
    const upstream = await fetch(new Request(target, request), { redirect: 'manual' });

    // WebSocket upgrade responses must be returned as-is.
    if (upstream.status === 101) return upstream;

    const headers = new Headers(upstream.headers);
    headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    const loc = headers.get('Location');
    if (loc) {
      const l = new URL(loc, origin);
      if (l.origin === origin.origin) headers.set('Location', `${url.origin}${PREFIX}${l.pathname}${l.search}`);
    }
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  },
};
