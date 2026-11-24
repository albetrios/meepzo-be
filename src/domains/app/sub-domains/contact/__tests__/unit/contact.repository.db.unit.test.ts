import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '@/infrastructure/database/connection.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import type { ContactRepositoryListQuery } from '@/domains/app/sub-domains/contact/contact.types.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

/** One statement as the driver sent it. */
interface SentStatement {
  query: string;
  parameters: unknown[];
}

/**
 * The contact list's page query against the database (routes-final § 3.A.3, CT2, S5, D56): every sort
 * and direction reads one account's rows in order from an index — the "last message" sort from the
 * activity table's — so a page never sorts the account's contacts. The statement planned is the repository's own, captured as the driver sends it.
 */
describe('ContactRepository.list (database)', () => {
  let organizationId: number;
  let channelAccountId: number;

  beforeEach(async () => {
    await cleanupDatabase();
    const organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    organizationId = organization.id;
    const account = await insertInstagramAccount({ organizationId });
    channelAccountId = account.channel_account_id;
    for (const username of ['avery', null, 'jordan', 'river', null]) {
      await insertContact({ organizationId, instagramAccountId: account.id, username });
    }
  });

  /** The first statement the repository's list sends for `sort` and `order` — its page query. */
  async function capturePageStatement(
    query: Pick<ContactRepositoryListQuery, 'sort' | 'order'>,
  ): Promise<SentStatement> {
    const statements: SentStatement[] = [];
    const capturing = drizzle({
      client: pool,
      logger: {
        logQuery: (text, parameters) => statements.push({ query: text, parameters }),
      },
    });
    await new ContactRepository(capturing as unknown as RequestScopedPostgresDatabase).list({
      organizationId,
      query: {
        limit: 25,
        after: undefined,
        q: undefined,
        tags: [],
        hasEmail: undefined,
        hasPhone: undefined,
        isFollowingAccount: undefined,
        firstSeenFrom: undefined,
        firstSeenTo: undefined,
        channelAccountId,
        automationPublicId: undefined,
        automationId: undefined,
        isOptedOut: undefined,
        isAutomationsPaused: undefined,
        cameInVia: [],
        firstAutomationPublicId: undefined,
        firstAutomationId: undefined,
        ...query,
      },
    });
    const [pageStatement] = statements;
    if (pageStatement === undefined) throw new Error('the list sent no statement');
    return pageStatement;
  }

  /** The statement's plan when the planner may choose an index for the order, and a sort only as the last resort. */
  async function readPlan({ query, parameters }: SentStatement): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The table is tiny, so the planner would scan and sort it: this asks "COULD an index give the
      // order?" — which is what a changed ORDER BY or index would break.
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query('SET LOCAL enable_bitmapscan = off');
      await client.query('SET LOCAL enable_sort = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (FORMAT TEXT) ${query}`,
        parameters,
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it.each([
    ['username', 'desc', 'idx_contacts_account_username_desc_id'],
    ['username', 'asc', 'idx_contacts_account_username_id'],
    ['last_message_received_at', 'desc', 'idx_contact_activities_account_last_message_received_at'],
    ['last_message_received_at', 'asc', 'idx_contact_activities_account_last_message_received_at'],
    ['first_seen_at', 'desc', 'idx_contacts_account_first_seen_at_id'],
    ['first_seen_at', 'asc', 'idx_contacts_account_first_seen_at_id'],
  ] as const)('reads %s %s in order from %s, sorting nothing', async (sort, order, indexName) => {
    const plan = await readPlan(await capturePageStatement({ sort, order }));

    expect(plan).toContain(indexName);
    expect(plan).not.toMatch(/\bSort\b/);
  });
});
