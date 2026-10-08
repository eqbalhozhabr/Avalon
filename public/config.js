// Where the game server lives.
//  ''  -> relative to this page (works at the site root and under /avalon/): Pages Functions
//        (functions/) forward api/ and ws/ to the Durable Object.
//  'https://avalon-rooms.<your-subdomain>.workers.dev' -> talk to the Worker directly
//        (use this if you prefer not to bind the Durable Object to Pages).
window.AVALON = { apiBase: '' };
