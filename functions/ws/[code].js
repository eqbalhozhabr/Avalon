import { handleRequest } from '../../worker/src/router.js';

export const onRequest = async ({ request, env }) =>
  (await handleRequest(request, env)) ?? new Response('not found', { status: 404 });
