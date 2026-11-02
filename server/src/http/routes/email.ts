import type { FastifyPluginAsync } from 'fastify';
import { createGmail } from '../../mail/gmail.ts';
import { credentialManagerTokens } from '../../mail/tokens.ts';
import type { TokenStore } from '../../mail/tokens.ts';
import { googleClient, revoke, startConsent } from '../../mail/oauth.ts';
import type { ConsentFlow, OAuthClient } from '../../mail/oauth.ts';
import { consentOn, enqueueAnalyses, mailProviderOk, paragraphOf } from '../../mail/analyse.ts';
import { saveIdea } from '../../mail/ideas.ts';
import { setSenderRule, sortMail } from '../../mail/sorting.ts';
import { CALIBRATION_MAILS, calibrationDone, enqueueTriage, isCalibrating } from '../../mail/triage.ts';
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
        `SELECT id, email, status, backfill_done, last_synced_at, last_error, triage_error, estimate,
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

  // Sorting. Sender and subject are mail text: the page renders them as text only, and no log or error carries them.
  const ID = { type: 'object', properties: { id: { type: 'string', pattern: '^\\d+$' } }, required: ['id'] } as const;
  const NAME = { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' } as const;

  // Opening the page (or Home) is the "first open each day" that queues paragraphs (D11).
  api.get('/email/overview', async () => {
    enqueueAnalyses(db, api.config);
    return overview();
  });
  const overview = () => ({
    calibration: { done: calibrationDone(db), total: CALIBRATION_MAILS, calibrating: isCalibrating(db) },
    consent: consentOn(db),
    provider_ok: mailProviderOk(api.config, 'work'),
    // D18: the same mail in two accounts counts once.
    categories: (
      db
        .prepare(
          `SELECT c.id, c.name, c.system, (SELECT count(DISTINCT COALESCE(m.rfc_message_id, m.account_id || ':' || m.gmail_id)) FROM mail_messages m WHERE m.category_id = c.id AND m.state = 'filed') AS count,
             EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'mail_analyse' AND j.status IN ('queued', 'running') AND json_extract(j.payload, '$.categoryId') = c.id) AS refreshing
           FROM mail_categories c ORDER BY c.id`,
        )
        .all() as { id: number; system: string | null }[]
    ).map((c) => ({ ...c, paragraph: c.system === null ? paragraphOf(db, c.id) : null })),
    needs_sorting: db.prepare(`SELECT count(*) FROM mail_messages WHERE state IN ('needs_sorting', 'failed')`).pluck().get(),
    rules: db.prepare('SELECT sender, category_id FROM mail_sender_rules ORDER BY sender').all(),
  });

  api.put<{ Body: { consent: boolean } }>('/email/settings', { schema: { body: { type: 'object', properties: { consent: { type: 'boolean' } }, required: ['consent'], additionalProperties: false } } }, async (req) => {
    db.prepare(`INSERT INTO mail_settings (key, value) VALUES ('consent', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(String(req.body.consent));
    // Off stops calls at once: queued paragraph jobs check consent before calling, and new ones aren't queued.
    if (!req.body.consent) db.prepare(`DELETE FROM jobs WHERE kind = 'mail_analyse' AND status = 'queued'`).run();
    return overview();
  });

  /** The Refresh button: reruns today; a second click while a job is queued or running is a no-op. */
  api.post('/email/analyses/refresh', async () => ({ queued: enqueueAnalyses(db, api.config, { force: true }) }));

  api.post<{ Params: { id: string } }>('/email/categories/:id/ideas', { schema: { params: ID } }, async (req, reply) => {
    const out = await saveIdea(db, api.config.vaultDir, Number(req.params.id));
    return out ?? reply.code(404).send({ error: 'no_paragraph' });
  });

  api.delete('/email/analyses', async () => {
    db.prepare('DELETE FROM mail_analyses').run();
    return { ok: true };
  });

  api.get('/email/needs-sorting', async () => {
    const rows = db
      .prepare(
        `SELECT m.id, m.gmail_id, m.state, m.sender, m.subject, m.internal_date, m.suggestion_id, a.email AS account FROM mail_messages m JOIN mail_accounts a ON a.id = m.account_id
         WHERE m.state IN ('needs_sorting', 'failed') ORDER BY m.sender IS NULL, m.sender, m.internal_date DESC LIMIT 500`,
      )
      .all() as { sender: string | null; suggestion_id: number | null }[];
    const groups = new Map<string | null, typeof rows>();
    for (const r of rows) groups.set(r.sender, [...(groups.get(r.sender) ?? []), r]);
    return { groups: [...groups].map(([sender, mails]) => ({ sender, suggestion_id: mails[0]!.suggestion_id, mails })) };
  });

  api.get<{ Params: { id: string } }>('/email/categories/:id/mails', { schema: { params: ID } }, async (req) => ({
    mails: db
      .prepare(`SELECT m.id, m.gmail_id, m.sender, m.subject, m.internal_date, a.email AS account FROM mail_messages m JOIN mail_accounts a ON a.id = m.account_id WHERE m.category_id = ? AND m.state = 'filed' ORDER BY m.internal_date DESC LIMIT 100`)
      .all(Number(req.params.id)),
  }));

  api.post<{ Params: { id: string }; Body: { category_id: number; always?: boolean; apply_stored?: boolean } }>(
    '/email/mails/:id/sort',
    { schema: { params: ID, body: { type: 'object', properties: { category_id: { type: 'integer' }, always: { type: 'boolean' }, apply_stored: { type: 'boolean' } }, required: ['category_id'], additionalProperties: false } } },
    async (req, reply) => {
      const id = Number(req.params.id);
      const { category_id: category, always, apply_stored: applyStored } = req.body;
      const sender = db.prepare('SELECT sender FROM mail_messages WHERE id = ?').pluck().get(id) as string | null | undefined;
      if (always && !sender) return reply.code(400).send({ error: sender === undefined ? 'not_found' : 'no_sender' });
      const result = sortMail(db, id, category);
      if (result === 'not_found') return reply.code(404).send({ error: 'not_found' });
      if (result === 'bad_category') return reply.code(400).send({ error: 'bad_category' });
      // The mail the owner clicked counts as checked; the others the rule moves don't (D12).
      const moved = always ? setSenderRule(db, sender!, category, !!applyStored) : 0;
      if (always && applyStored) sortMail(db, id, category);
      for (const a of db.prepare(`SELECT id FROM mail_accounts WHERE status = 'connected'`).pluck().all() as number[]) enqueueTriage(db, a);
      return { moved };
    },
  );

  api.delete<{ Querystring: { sender: string } }>('/email/rules', { schema: { querystring: { type: 'object', properties: { sender: { type: 'string', minLength: 1 } }, required: ['sender'] } } }, async (req, reply) => {
    const { changes } = db.prepare('DELETE FROM mail_sender_rules WHERE sender = ?').run(req.query.sender);
    return changes ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  api.post<{ Body: { name: string } }>('/email/categories', { schema: { body: { type: 'object', properties: { name: NAME }, required: ['name'], additionalProperties: false } } }, async (req, reply) => {
    const name = req.body.name.trim();
    if (db.prepare('SELECT 1 FROM mail_categories WHERE name = ?').get(name)) return reply.code(409).send({ error: 'name_taken' });
    return { id: db.prepare('INSERT INTO mail_categories (name) VALUES (?) RETURNING id').pluck().get(name) };
  });

  api.patch<{ Params: { id: string }; Body: { name: string } }>('/email/categories/:id', { schema: { params: ID, body: { type: 'object', properties: { name: NAME }, required: ['name'], additionalProperties: false } } }, async (req, reply) => {
    const name = req.body.name.trim();
    const id = Number(req.params.id);
    if (db.prepare('SELECT 1 FROM mail_categories WHERE name = ? AND id <> ?').get(name, id)) return reply.code(409).send({ error: 'name_taken' });
    const { changes } = db.prepare('UPDATE mail_categories SET name = ? WHERE id = ?').run(name, id);
    return changes ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  api.delete<{ Params: { id: string } }>('/email/categories/:id', { schema: { params: ID } }, async (req, reply) => {
    const category = db.prepare('SELECT system FROM mail_categories WHERE id = ?').get(Number(req.params.id)) as { system: string | null } | undefined;
    if (!category) return reply.code(404).send({ error: 'not_found' });
    if (category.system) return reply.code(409).send({ error: 'system_category' });
    db.prepare('DELETE FROM mail_categories WHERE id = ?').run(Number(req.params.id)); // its mail moves to Needs sorting (trigger, 0012)
    return { ok: true };
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
