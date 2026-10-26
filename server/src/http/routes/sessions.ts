import { PassThrough } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import { enqueueCategorize, lastMessageId, startIdleTimer } from '../../chat/idle.ts';
import { realLlm, recoverInterrupted, startTurn, streamReply } from '../../chat/stream.ts';
import type { ChatEvent, ChatLlm } from '../../chat/stream.ts';

interface SessionSummary {
  id: number;
  title: string | null;
  mode: 'chat' | 'persona';
  area_id: number | null;
  area_slug: string | null;
  filing_status: 'auto' | 'flagged' | 'inbox' | 'user' | null;
  area_confidence: number | null;
  started_at: string;
  last_message_at: string | null;
}

const SUMMARY = `
  SELECT s.id, s.title, s.mode, s.area_id, a.slug area_slug, s.filing_status, s.area_confidence, s.started_at,
    (SELECT MAX(created_at) FROM messages m WHERE m.session_id = s.id) last_message_at
  FROM sessions s LEFT JOIN areas a ON a.id = s.area_id`;

const idParams = { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] } as const;
type IdParams = { id: number };

const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

/**
 * Sessions REST + `POST /sessions/:id/messages` (SSE). Mounted under `/api` behind auth.
 * Registering it also marks interrupted replies `aborted` and starts the idle-categorization timer.
 */
export const sessionRoutes =
  (llm: ChatLlm = realLlm): FastifyPluginAsync =>
  async (api) => {
    const { db, config } = api;
    recoverInterrupted(db);
    api.addHook('onClose', startIdleTimer(db, config.session.idleMinutes, (err) => api.log.error(err, 'idle categorization failed')));

    const getSummary = db.prepare(`${SUMMARY} WHERE s.id = ?`);
    const summary = (id: number) => getSummary.get(id) as SessionSummary | undefined;

    // ponytail: no pagination, capped at 500; add a cursor when the list outgrows it
    const list = db.prepare(`${SUMMARY}
      WHERE (@area IS NULL OR a.slug = @area)
        AND (@q IS NULL OR s.title LIKE @q ESCAPE '\\'
             OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.content LIKE @q ESCAPE '\\'))
      ORDER BY COALESCE(last_message_at, s.started_at) DESC, s.id DESC LIMIT 500`);
    api.get<{ Querystring: { area?: string; q?: string } }>(
      '/sessions',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: { area: { type: 'string', maxLength: 100 }, q: { type: 'string', maxLength: 200 } },
          },
        },
      },
      async (req) => list.all({ area: req.query.area || null, q: req.query.q ? likePattern(req.query.q) : null }),
    );

    const create = db.prepare('INSERT INTO sessions (mode) VALUES (?) RETURNING id');
    api.post<{ Body: { mode: 'chat' | 'persona' } }>(
      '/sessions',
      {
        schema: {
          body: { type: 'object', properties: { mode: { enum: ['chat', 'persona'] } }, required: ['mode'], additionalProperties: false },
        },
      },
      async (req, reply) => reply.code(201).send(summary((create.get(req.body.mode) as { id: number }).id)),
    );

    const messages = db.prepare(
      `SELECT id, role, content, status, created_at FROM messages WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY id`,
    );
    api.get<{ Params: IdParams }>('/sessions/:id', { schema: { params: idParams } }, async (req, reply) => {
      const session = summary(req.params.id);
      if (!session) return reply.code(404).send({ error: 'not found' });
      return { session, messages: messages.all(session.id) };
    });

    const activeArea = db.prepare(`SELECT slug FROM areas WHERE id = ? AND status IN ('active', 'proposed')`);
    const setTitle = db.prepare('UPDATE sessions SET title = ? WHERE id = ?');
    const setArea = db.prepare(`UPDATE sessions SET area_id = ?, filing_status = 'user' WHERE id = ?`);
    const correction = db.prepare(
      `INSERT INTO decisions (subject_type, subject_id, question, answer, final_answer, backend, corrected_by_user)
       VALUES ('session', ?, 'area', ?, ?, 'user', 1)`,
    );
    api.patch<{ Params: IdParams; Body: { title?: string; area_id?: number } }>(
      '/sessions/:id',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            properties: { title: { type: 'string', maxLength: 200 }, area_id: { type: 'integer', minimum: 1 } },
            additionalProperties: false,
            minProperties: 1,
          },
        },
      },
      async (req, reply) => {
        const before = summary(req.params.id);
        if (!before) return reply.code(404).send({ error: 'not found' });
        const { title, area_id } = req.body;
        const area = area_id === undefined ? undefined : (activeArea.get(area_id) as { slug: string } | undefined);
        if (area_id !== undefined && !area) return reply.code(400).send({ error: 'unknown area' });
        db.transaction(() => {
          if (title !== undefined) setTitle.run(title.trim() || null, before.id);
          if (area_id === undefined) return;
          setArea.run(area_id, before.id);
          // A changed area is a correction of the model's filing: training data for the decider.
          if (area_id !== before.area_id) correction.run(String(before.id), before.area_slug, area!.slug);
        })();
        return summary(before.id);
      },
    );

    const end = db.prepare(`UPDATE sessions SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`);
    api.post<{ Params: IdParams }>('/sessions/:id/end', { schema: { params: idParams } }, async (req, reply) => {
      const id = req.params.id;
      if (!summary(id)) return reply.code(404).send({ error: 'not found' });
      end.run(id);
      const last = lastMessageId(db, id);
      return reply.code(202).send({ queued: last !== null && enqueueCategorize(db, id, last) });
    });

    api.post<{ Params: IdParams; Body: { content: string } }>(
      '/sessions/:id/messages',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            properties: { content: { type: 'string', minLength: 1, maxLength: 20_000 } },
            required: ['content'],
            additionalProperties: false,
          },
        },
      },
      async (req, reply) => {
        const sessionId = req.params.id;
        if (!summary(sessionId)) return reply.code(404).send({ error: 'not found' });
        if (!llm.configured(config)) return reply.code(409).send({ error: 'provider_not_configured' });

        const ids = startTurn(db, sessionId, req.body.content, config.llm.models.work);
        const out = new PassThrough();
        const send = (ev: ChatEvent) => out.destroyed || out.write(`data: ${JSON.stringify(ev)}\n\n`);
        const abort = new AbortController();
        // The client went away before the reply finished: stop the model call, keep the partial text.
        reply.raw.on('close', () => reply.raw.writableFinished || abort.abort());
        send(ids);
        void streamReply({ db, config, llm, sessionId, assistantId: ids.assistant_message_id, signal: abort.signal, send })
          .catch((err) => req.log.error(err, 'chat stream failed'))
          .finally(() => out.end());
        return reply
          .header('content-type', 'text/event-stream; charset=utf-8')
          .header('cache-control', 'no-cache, no-store')
          .header('x-accel-buffering', 'no')
          .send(out);
      },
    );
  };
