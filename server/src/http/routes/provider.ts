import type { FastifyPluginAsync } from 'fastify';
import { providerStatus, reloadLlm } from '../../llm/client.ts';

/** `GET /api/provider` and `POST /api/provider/reload`; mounted under `/api` behind auth by `buildApp`. */
export const providerRoutes: FastifyPluginAsync = async (api) => {
  api.get('/provider', async () => providerStatus(api.config));
  api.post('/provider/reload', async () => {
    reloadLlm();
    return providerStatus(api.config);
  });
};
