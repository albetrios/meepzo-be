import {
  type RequestScopedPostgresDatabase,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { instagram_webhook_event_keys } from './instagram-webhook-event-key.schema.js';

/** One key the store function claims: the event key and the UTC day of Meta's time (`YYYY-MM-DD`). */
export interface InstagramWebhookEventKeyDay {
  /** WH9's key, at most 512 characters. */
  eventKey: string;
  /** The UTC day of Meta's own time for the item — the partition key (WH20). */
  eventDay: string;
}

/**
 * Drizzle access to `app.instagram_webhook_event_keys` (routes-final § 5.B.3, WH20, WHC12): the one
 * write — claim a delivery's keys, so only the new ones get an event row. No routes, no reads by
 * id, no updates; the keys go with their day part (the shared upkeep, ROUTE R49).
 *
 * @remarks
 * - **Algorithm:** one `INSERT … ON CONFLICT DO NOTHING RETURNING` on the primary key
 *   `(organization_id, channel_account_id, event_key, event_day)`: a key already seen on that Meta
 *   day returns nothing.
 * - **Failure modes:** a database error propagates — the store unit then fails as a whole and Meta
 *   delivers again.
 * - **Side effects:** inserts key rows only.
 * - **Notes:** runs inside the caller's `withAppDatabaseContext` (the store function's unit, in the
 *   organization's `VERIFIED` scope or the job's) — the repository never mints a scope.
 */
export class InstagramWebhookEventKeyRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /**
   * Inserts the keys of one account `ON CONFLICT DO NOTHING` and returns the ones this statement
   * inserted — the keys never seen before on their Meta day (WH9 step 6).
   */
  async insertNewKeys({
    organizationId,
    channelAccountId,
    keys,
  }: {
    /** `tenancy.organizations.id`. */
    organizationId: number;
    /** `app.channel_accounts.id`. */
    channelAccountId: number;
    keys: readonly InstagramWebhookEventKeyDay[];
  }): Promise<InstagramWebhookEventKeyDay[]> {
    if (keys.length === 0) return [];
    const rows = await this.db()
      .insert(instagram_webhook_event_keys)
      .values(
        keys.map((key) => ({
          organization_id: organizationId,
          channel_account_id: channelAccountId,
          event_key: key.eventKey,
          event_day: key.eventDay,
        })),
      )
      .onConflictDoNothing()
      .returning({
        eventKey: instagram_webhook_event_keys.event_key,
        eventDay: instagram_webhook_event_keys.event_day,
      });
    return rows;
  }
}
