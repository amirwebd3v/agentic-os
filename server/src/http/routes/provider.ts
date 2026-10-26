import type { FastifyPluginAsync } from 'fastify';
import { providerStatus, reloadLlm, type LlmConfig } from '../../llm/client.ts';

/** `GET /provider` and `POST /provider/reload`; mounted under `/api` behind auth by `buildApp`. */
export const providerRoutes: FastifyPluginAsync<{ config: LlmConfig }> = async (app, { config }) => {
  app.get('/provider', async () => providerStatus(config));
  app.post('/provider/reload', async () => {
    reloadLlm();
    return providerStatus(config);
  });
};
