import type { FastifyPluginAsync } from 'fastify';
import { createGmail } from '../../mail/gmail.ts';
import { credentialManagerTokens } from '../../mail/tokens.ts';
import type { TokenStore } from '../../mail/tokens.ts';
import { googleClient, revoke, startConsent } from '../../mail/oauth.ts';
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
  let generation = 0;
  let starting = false;

  const upsert = db.prepare(
    `INSERT INTO mail_accounts (email) VALUES (?)
     ON CONFLICT (email) DO UPDATE SET status = 'connected', failures = 0, last_error = NULL RETURNING id`,
  );

  /** Row and token commit together or not at all; a token nobody holds is revoked, including the one a reconnect replaces. */
  async function store(client: OAuthClient, accessToken: string, refreshToken: string): Promise<boolean> {
    try {
      const { emailAddress } = await createGmail(async () => accessToken, deps.gmailBase).getProfile();
      const replaced = db.transaction(() => {
        const id = upsert.pluck().get(emailAddress) as number;
        const old = deps.tokens.get(id);
        deps.tokens.set(id, refreshToken);
        return old;
      })();
      if (replaced && replaced !== refreshToken) void revoke(client, replaced);
      return true;
    } catch {
      await revoke(client, refreshToken);
      return false;
    }
  }

  api.get('/email/accounts', async () => ({
    setup: deps.client() !== null,
    flow: status,
    accounts: db
      .prepare(
        `SELECT id, email, status, backfill_done, last_synced_at, last_error, estimate,
           (SELECT count(*) FROM mail_pending p WHERE p.account_id = a.id) AS pending FROM mail_accounts a ORDER BY id`,
      )
      .all(),
  }));

  api.post('/email/accounts/connect', async (_req, reply) => {
    const client = deps.client();
    if (!client) return reply.code(409).send({ error: 'gmail_not_set_up' });
    if (starting) return reply.code(409).send({ error: 'connect_busy' });
    flow?.cancel(); // a second click replaces the wait, and frees the old port
    const mine = ++generation;
    status = 'waiting';
    starting = true;
    try {
      const started = await startConsent(client, (result) => {
        if (mine !== generation) {
          if (result.status === 'granted') void revoke(client, result.refreshToken);
          return; // a flow a newer click replaced
        }
        flow = null;
        if (result.status !== 'granted') {
          status = result.status;
          return;
        }
        void store(client, result.accessToken, result.refreshToken).then((ok) => {
          if (mine === generation) status = ok ? 'connected' : 'failed';
        });
      });
      flow = started;
      return { url: started.url };
    } catch (err) {
      status = 'failed';
      throw err;
    } finally {
      starting = false;
    }
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
        const client = deps.client();
        revoked = client ? await revoke(client, token) : false;
        deps.tokens.delete(id);
      }
      if (req.query.keep === '1') db.prepare(`UPDATE mail_accounts SET status = 'disconnected', history_id = NULL, backfill_page_token = NULL, list_after = NULL, next_history_id = NULL, history_page_token = NULL, failures = 0, last_error = NULL WHERE id = ?`).run(id);
      else db.prepare('DELETE FROM mail_accounts WHERE id = ?').run(id);
      return { revoked };
    },
  );
};
