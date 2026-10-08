import { handleRequest } from './router.js';

export { GameRoom } from './room.js';

export default {
  async fetch(request, env) {
    return (await handleRequest(request, env)) ?? new Response('Avalon rooms: not found', { status: 404 });
  },
};
