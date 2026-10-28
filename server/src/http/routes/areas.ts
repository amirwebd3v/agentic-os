import type { FastifyPluginAsync } from 'fastify';

/** `GET /api/areas`: active and proposed areas, for the areas listed in the vault's `CLAUDE.md`. */
export const areaRoutes: FastifyPluginAsync = async (api) => {
  const list = api.db.prepare(
    `SELECT id, slug, name, parent_id, status, mode FROM areas WHERE status IN ('active', 'proposed') ORDER BY id`,
  );
  api.get('/areas', async () => list.all());
};
