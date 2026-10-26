import type { onRequestAsyncHookHandler } from 'fastify';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** `127.0.0.1:<port>` and `localhost:<port>`, plus the Vite dev server in dev. */
export function allowedHosts(port: number, dev: boolean): Set<string> {
  const ports = dev ? [port, 5173] : [port];
  return new Set(ports.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]));
}

/**
 * DNS rebinding: a foreign Host is refused. CSRF: a state-changing request needs an allowed Origin
 * and `X-AOS: 1`, a header a cross-origin page can't send without a CORS preflight we never grant.
 */
export function guards(hosts: Set<string>): onRequestAsyncHookHandler {
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  return async (req, reply) => {
    if (!hosts.has(req.headers.host?.toLowerCase() ?? '')) return reply.code(403).send({ error: 'forbidden host' });
    if (SAFE_METHODS.has(req.method)) return;
    if (!origins.has(req.headers.origin?.toLowerCase() ?? '')) return reply.code(403).send({ error: 'forbidden origin' });
    if (req.headers['x-aos'] !== '1') return reply.code(403).send({ error: 'missing X-AOS header' });
  };
}
