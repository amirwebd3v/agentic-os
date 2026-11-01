import type { FastifyPluginAsync } from 'fastify';
import { createGmail } from '../../mail/gmail.ts';
import { credentialManagerTokens } from '../../mail/tokens.ts';
import type { TokenStore } from '../../mail/tokens.ts';
import { googleClient, startConsent } from '../../mail/oauth.ts';
import type { ConsentFlow, OAuthClient } from '../../mail/oauth.ts';
import { getSecret } from '../../secrets.ts';

export interface EmailDeps {
  /** Null until the owner has saved the Google Cloud client (spec §8). */
  client: () => OAuthClient | null;
  tokens: TokenStore;
  gmailBase?: string;
}

const realDeps: EmailDeps = {
  client: () => {
    const [id, secret] = [getSecret('gmail_client_id'), getSecret('gmail_client_secret')];
    return id && secret ? googleClient(id, secret) : null;
  },
  tokens: credentialManagerTokens,
};

type FlowStatus = 'idle' | 'waiting' | 'connected' | 'cancelled' | 'wrong_scope' | 'failed' | 'timed_out';

export const emailRoutes = (deps: EmailDeps = realDeps): FastifyPluginAsync => async (api) => {
  const { db } = api;
  let flow: ConsentFlow | null = null;
  let status: FlowStatus = 'idle';

  const upsert = db.prepare(
    `INSERT INTO mail_accounts (email) VALUES (?)
     ON CONFLICT (email) DO UPDATE SET status = 'connected' RETURNING id`,
  );

  api.get('/email/accounts', async () => ({
    setup: deps.client() !== null,
    flow: status,
    accounts: db.prepare('SELECT id, email, status, backfill_done, last_synced_at FROM mail_accounts ORDER BY id').all(),
  }));

  api.post('/email/accounts/connect', async (_req, reply) => {
    const client = deps.client();
    if (!client) return reply.code(409).send({ error: 'gmail_not_set_up' });
    flow?.cancel(); // a second click replaces the wait, and frees the old port
    status = 'waiting';
    const started: ConsentFlow = await startConsent(client, (result) => {
      if (flow === started) flow = null;
      else if (flow) return; // an older flow, replaced by a newer one
      if (result.status !== 'granted') {
        status = result.status;
        return;
      }
      void (async () => {
        try {
          const gmail = createGmail(async () => result.accessToken, deps.gmailBase);
          const { emailAddress } = await gmail.getProfile();
          const id = upsert.pluck().get(emailAddress) as number;
          deps.tokens.set(id, result.refreshToken);
          status = 'connected';
        } catch {
          // No account row means nothing to reconnect, so the token must not stay valid at Google.
          await client.revokeToken(result.refreshToken).catch(() => undefined);
          status = 'failed';
        }
      })();
    });
    flow = started;
    return { url: started.url };
  });

  api.delete<{ Params: { id: string }; Querystring: { keep?: string } }>(
    '/email/accounts/:id',
    { schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: '^\\d+$' } } }, querystring: { type: 'object', properties: { keep: { type: 'string', enum: ['0', '1'] } }, required: ['keep'] } } },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!db.prepare('SELECT 1 FROM mail_accounts WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not_found' });
      const token = deps.tokens.get(id);
      let revoked = false;
      if (token) {
        revoked = await Promise.resolve(deps.client()?.revokeToken(token)).then((r) => r !== undefined, () => false);
        deps.tokens.delete(id);
      }
      if (req.query.keep === '1') db.prepare(`UPDATE mail_accounts SET status = 'disconnected', history_id = NULL, backfill_page_token = NULL WHERE id = ?`).run(id);
      else db.prepare('DELETE FROM mail_accounts WHERE id = ?').run(id);
      return { revoked };
    },
  );
};
