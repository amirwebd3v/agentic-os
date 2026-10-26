import type { onSendAsyncHookHandler } from 'fastify';

// img-src without remote hosts: rendered markdown can't exfiltrate data through image URLs.
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

export const securityHeaders: onSendAsyncHookHandler = async (_req, reply, payload) => {
  reply.headers(SECURITY_HEADERS);
  return payload;
};
