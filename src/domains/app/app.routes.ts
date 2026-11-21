import type { FastifyPluginAsync } from 'fastify';
import { instagramAccountRoutes } from './sub-domains/instagram-account/instagram-account.routes.js';

/**
 * Top-level app domain plugin, mounted by `src/routes.ts` under `/api/v1/app`. It registers the
 * sub-domain route trees, each reading its services from `app.appDomain`: the Instagram account
 * today (`/social/instagram/connect`, `/social/instagram/account`); contacts, automations and the
 * Instagram webhook join as each one is built.
 */
export const appRoutesPlugin: FastifyPluginAsync = async (app) => {
  const { appDomain } = app;
  await app.register(instagramAccountRoutes(appDomain.instagramAccountService));
};
