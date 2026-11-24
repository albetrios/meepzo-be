import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type {
  InstagramAccountKey,
  InstagramAccountPickValues,
  InstagramAccountRepository,
  InstagramAccountRow,
} from './instagram-account.repository.js';

/**
 * The one writer of the Instagram extension of a channel account (feat-instagram-dm-sending
 * routes-final § 2.A.10, IAC6): creates or brings it back at the pick, records the webhook set-up,
 * clears the webhook stamp on a revoke, erases the profile — and reads it for the channel account.
 *
 * @remarks
 * Algorithm:
 * - Every method runs in `withAppDatabaseContext` with the caller's organization scope; called
 *   inside the caller's open unit of work (the pick, a disconnect, an erasure), it joins it.
 *
 * Failure modes:
 * - None of its own; database failures reach the caller's unit.
 *
 * Side effects:
 * - Writes `app.instagram_accounts` only. The channel account's status, connection and public id are
 *   1B's (`ChannelAccountRepository`); this service never writes them, and 1B never writes the
 *   extension's table.
 *
 * Notes:
 * - The workers' profile refresh and webhook stamp (the daily check, until ROUTE row R51's token
 *   check takes the refresh) write through the worker repository the same columns this service
 *   owns, on the job's handle.
 */
export class InstagramAccountExtensionService {
  constructor(private readonly accountRepository: InstagramAccountRepository) {}

  /**
   * The extension rows of these channel accounts, any status, by channel account id.
   *
   * @remarks
   * Algorithm: one read in the caller's scope. Failure modes: none. Side effects: none.
   */
  async findByChannelAccountIds({
    scope,
    organizationId,
    channelAccountIds,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    channelAccountIds: readonly number[];
  }): Promise<Map<number, InstagramAccountRow>> {
    const rows = await withAppDatabaseContext({
      scope,
      callback: () =>
        this.accountRepository.findByChannelAccountIds({ organizationId, channelAccountIds }),
    });
    return new Map(rows.map((row) => [row.channel_account_id, row]));
  }

  /**
   * The pick's write (MC7, CAC5): the extension created, or this organization's earlier row of the
   * same Instagram account brought back, with the profile read at the pick.
   *
   * @remarks
   * Algorithm: one upsert in the caller's unit (the pick's commit). Failure modes: constraint
   * failures propagate. Side effects: one row written. Notes: the caller writes the channel account
   * first, so `channelAccountId` exists; `instagramUserId` equals its `provider_account_id`.
   */
  async createAtPick({
    scope,
    values,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    values: InstagramAccountPickValues;
  }): Promise<InstagramAccountRow> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.accountRepository.upsertAtPick(values),
    });
  }

  /**
   * The extension's side of a revoke (CA8): the webhook stamp emptied, so the next pick subscribes
   * again.
   *
   * @remarks
   * Algorithm: one guarded update in the caller's unit. Failure modes: none. Side effects: at most
   * one row written; returns whether a stamp was cleared.
   */
  async clearOnRevoke({
    scope,
    instagramAccount,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    instagramAccount: InstagramAccountKey;
  }): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.accountRepository.clearWebhookSubscription(instagramAccount),
    });
  }

  /**
   * Erases a revoked account's profile (IA20, D54); `null` when its channel account is not revoked or
   * the profile is already erased.
   *
   * @remarks
   * Algorithm: one guarded update in the caller's unit. Failure modes: none. Side effects: at most
   * one row written.
   */
  async eraseProfile({
    scope,
    instagramAccount,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    instagramAccount: InstagramAccountKey;
  }): Promise<InstagramAccountRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.accountRepository.eraseProfile(instagramAccount),
    });
  }

  /**
   * Stamps `webhook_subscribed_at` after `subscribed_apps` succeeded and reads the account back;
   * `null` when its channel account was revoked in between.
   *
   * @remarks
   * Algorithm: one unit — the guarded stamp, then the read. Failure modes: none. Side effects: at
   * most one row written.
   */
  async recordWebhookSubscribed({
    scope,
    instagramAccount,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    instagramAccount: InstagramAccountKey;
  }): Promise<InstagramAccountRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const recorded = await this.accountRepository.recordWebhookSubscribed(instagramAccount);
        return recorded ? this.accountRepository.findById(instagramAccount) : null;
      },
    });
  }
}
