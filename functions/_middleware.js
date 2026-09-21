import { applyCors, corsPreflight } from './utils/cors.js';

export async function onRequest(context) {
  const preflight = corsPreflight(context.request, context.env);
  if (preflight) return preflight;
  return applyCors(await context.next(), context.request, context.env);
}
