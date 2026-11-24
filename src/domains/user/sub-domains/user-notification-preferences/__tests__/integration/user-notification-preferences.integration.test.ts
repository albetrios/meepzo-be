import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

describe('User Notification Preferences Sub-Domain — Integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  /** One kind × channel of a preferences response. */
  function channelOf(body: unknown, kind: string, channel: string) {
    const data = (
      body as { data: { kinds: Array<{ kind: string; channels: Array<{ channel: string }> }> } }
    ).data;
    const channels = data.kinds.find((entry) => entry.kind === kind)?.channels ?? [];
    return channels.find((entry) => entry.channel === channel);
  }

  describe('PUT /api/v1/users/me/notification-preferences (route 136)', () => {
    it('returns 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'PUT',
        url: testApiPath('/users/me/notification-preferences'),
        payload: { kinds: [] },
      });
      expect(response.statusCode).toBe(401);
    });

    it.each([
      ['an unknown field', { unknown_field: true }],
      ['an empty list', { kinds: [] }],
      ['the SMS channel', { kinds: [{ kind: 'billing', channel: 'SMS', is_enabled: true }] }],
      ['an unknown kind', { kinds: [{ kind: 'security', channel: 'EMAIL', is_enabled: false }] }],
      [
        'a repeated kind × channel',
        {
          kinds: [
            { kind: 'team_change', channel: 'EMAIL', is_enabled: true },
            { kind: 'team_change', channel: 'EMAIL', is_enabled: false },
          ],
        },
      ],
    ])('returns 400 (never 500) for %s', async (_label, payload) => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'PUT',
        url: testApiPath('/users/me/notification-preferences'),
        token,
        payload,
      });
      expect(response.statusCode, response.body).toBe(400);
    });

    it('returns 422 notification_preference_locked for billing email off (AC-14.6)', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'PUT',
        url: testApiPath('/users/me/notification-preferences'),
        token,
        payload: { kinds: [{ kind: 'billing', channel: 'EMAIL', is_enabled: false }] },
      });
      expect(response.statusCode, response.body).toBe(422);
      expect((response.json() as { error: { reason: string } }).error.reason).toBe(
        'notification_preference_locked',
      );
    });

    it('saves one kind × channel for every type of the kind and answers the whole object', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'PUT',
        url: testApiPath('/users/me/notification-preferences'),
        token,
        payload: {
          kinds: [{ kind: 'broadcast_or_past_comments_done', channel: 'EMAIL', is_enabled: true }],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(channelOf(response.json(), 'broadcast_or_past_comments_done', 'EMAIL')).toEqual({
        channel: 'EMAIL',
        is_enabled: true,
        is_default: false,
        is_locked: false,
      });
      // The others keep their defaults (only the items sent change).
      expect(channelOf(response.json(), 'contact_details_left', 'EMAIL')).toMatchObject({
        is_enabled: false,
        is_default: true,
      });
    });
  });

  describe('GET /api/v1/users/me/notification-preferences (route 135)', () => {
    it('returns 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath('/users/me/notification-preferences'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('answers the seven kinds with their defaults before any choice (AC-14.5)', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/users/me/notification-preferences'),
        token,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { data: { kinds: unknown[] } };
      expect(body.data.kinds).toHaveLength(7);
      expect(channelOf(body, 'contact_details_left', 'EMAIL')).toMatchObject({ is_enabled: false });
      expect(channelOf(body, 'broadcast_or_past_comments_done', 'EMAIL')).toMatchObject({
        is_enabled: false,
      });
      expect(channelOf(body, 'weekly_summary', 'IN_APP')).toMatchObject({ is_enabled: false });
      expect(channelOf(body, 'billing', 'EMAIL')).toMatchObject({
        is_enabled: true,
        is_locked: true,
      });
    });

    it('reads back the choice written by PUT', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });

      const put = await injectAuthenticated(app, {
        method: 'PUT',
        url: testApiPath('/users/me/notification-preferences'),
        token,
        payload: {
          kinds: [{ kind: 'direct_message_limit', channel: 'IN_APP', is_enabled: false }],
        },
      });
      expect(put.statusCode, put.body).toBe(200);

      const read = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/users/me/notification-preferences'),
        token,
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(channelOf(read.json(), 'direct_message_limit', 'IN_APP')).toMatchObject({
        is_enabled: false,
        is_default: false,
      });
    });
  });
});
