import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type {
  InstagramAccountKey,
  InstagramAccountPickValues,
  InstagramAccountProfileRefreshValues,
  InstagramAccountRepository,
  InstagramAccountRow,
} from './instagram-account.repository.js';
import type { InstagramMessageAccessState } from '@/shared/constants/instagram.constants.js';

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
 * - The webhook store records messaging items and the subscription check flags missing ones
 *   through {@link recordMessagesWebhookSeen} / {@link recordMessagesWebhookMissing} (P358).
 * - The connection's token check refreshes the profile through {@link recordProfileRefresh} (P17,
 *   ROUTE row R51). The account jobs (set-up, subscription check, starter-question sync, ROUTE row
 *   R40) write the webhook stamp and the starter-question stamp through this service in their job
 *   scope (the launch daily check that also stamped is retired).
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
   * The token check's profile refresh (P17, MC10): the profile fields and `profile_synced_at`,
   * only while the channel account is not revoked and the row is still this Instagram account.
   *
   * @remarks
   * Algorithm: one guarded update in the caller's unit. Failure modes: none. Side effects: at most
   * one row written; returns whether it was. Notes: a username or count Meta left out keeps its
   * stored value; Meta's profile read carries no `account_type` / `is_private` (P120), so they stay.
   */
  async recordProfileRefresh({
    scope,
    instagramAccount,
    instagramUserId,
    profile,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    instagramAccount: InstagramAccountKey;
    instagramUserId: string;
    profile: InstagramAccountProfileRefreshValues;
  }): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.accountRepository.recordProfileRefresh({
          ...instagramAccount,
          instagramUserId,
          profile,
        }),
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

  /**
   * The webhook subscription check found a field off (WC-25): the stamp emptied, so the account shows
   * as not subscribed until the set-up succeeds again. Returns whether a stamp was cleared.
   *
   * @remarks
   * Algorithm: the same guarded stamp clear as a revoke (`clearOnRevoke` — one write path, reuse
   * rule). Failure modes: none. Side effects: at most one row written.
   */
  async recordWebhookSubscriptionLost(input: {
    scope: OrganizationPrincipalDatabaseScope;
    instagramAccount: InstagramAccountKey;
  }): Promise<boolean> {
    return this.clearOnRevoke(input);
  }

  /**
   * A messaging webhook item arrived (P358): `messages_webhook_seen_at` now and the
   * missing-messages flag emptied. Returns whether a row was written.
   *
   * @remarks
   * Algorithm: one guarded update in the caller's unit (the webhook store's). Failure modes: none.
   * Side effects: at most one row written. Notes: the caller writes at most hourly
   * (`shouldRecordInstagramMessagesWebhookSeen`), or at once to clear the flag.
   */
  async recordMessagesWebhookSeen({
    scope,
    instagramAccount,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    instagramAccount: InstagramAccountKey;
  }): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.accountRepository.recordMessagesWebhookSeen(instagramAccount),
    });
  }

  /**
   * Stores the last "Allow access to messages" answer (feat-meta-connect-flow IG1) — the set-up
   * probe's, route 154's, or a send's own `access_off` (`off`). One writer per answer (3.10).
   *
   * @remarks
   * Algorithm: one guarded update by the channel account (not revoked) in the caller's scope,
   * joining the caller's unit when one is open. Failure modes: none — `null` when the account is
   * gone or revoked. Side effects: at most one row written.
   */
  async recordMessageAccess({
    scope,
    channelAccount,
    status,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccount: { organizationId: number; channelAccountId: number };
    status: InstagramMessageAccessState;
  }): Promise<{ status: InstagramMessageAccessState; checkedAt: Date } | null> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.accountRepository.recordMessageAccess({ ...channelAccount, status }),
    });
  }

  /**
   * The subscription check's flag (P358): messages happen at Meta but none reaches the webhook.
   * Returns whether the flag was newly set — the caller then tells the owners once.
   *
   * @remarks
   * Algorithm: one guarded update (not set yet, still subscribed, not revoked). Failure modes: none.
   * Side effects: at most one row written.
   */
  async recordMessagesWebhookMissing({
    scope,
    instagramAccount,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    instagramAccount: InstagramAccountKey;
  }): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.accountRepository.recordMessagesWebhookMissing(instagramAccount),
    });
  }

  /**
   * The starter-question sync's stamp (WC-31, IA8): `starter_questions_set_at` now after Meta took a
   * non-empty list, empty after the list was removed. Returns whether a row was written (`false`
   * when the channel account was revoked in between).
   *
   * @remarks
   * Algorithm: one guarded update. Failure modes: none. Side effects: at most one row written.
   */
  async recordStarterQuestionsSet({
    scope,
    instagramAccount,
    isSet,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    instagramAccount: InstagramAccountKey;
    isSet: boolean;
  }): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.accountRepository.recordStarterQuestionsSet({ ...instagramAccount, isSet }),
    });
  }
}
