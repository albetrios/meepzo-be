import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type {
  AutomationReplyStateKey,
  AutomationReplyStateRepository,
  AutomationReplyStateRow,
} from './automation-reply-state.repository.js';

/**
 * The "Reply like a person" pacing of each automation (feat-instagram-dm-sending routes-final
 * § 4.A, AU19, D32): the one way sub-domain 6's reply lane and result save (later rows) read and
 * write `app.automation_reply_states`, and route 30's box reset.
 *
 * @remarks
 * Algorithm: every call in the caller's organization scope (`withAppDatabaseContext` joins an open
 * unit, so the lane's commit holds it). Failure modes: as the repository. Side effects: one row.
 */
export class AutomationReplyStateService {
  constructor(private readonly repository: AutomationReplyStateRepository) {}

  /**
   * The automation's reply state, locked for the caller's unit; `null` before its first reply.
   *
   * @remarks
   * Algorithm: one read `FOR UPDATE`. Failure modes: none. Side effects: a row lock.
   */
  async lockReplyState({
    scope,
    key,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    key: AutomationReplyStateKey;
  }): Promise<AutomationReplyStateRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.repository.find({ ...key, isLocked: true }),
    });
  }

  /**
   * Writes the reply state after a reply is picked or settled (the lane's commit).
   *
   * @remarks
   * Algorithm: one upsert. Failure modes: as the repository. Side effects: one row.
   */
  async saveReplyState({
    scope,
    key,
    channelAccountId,
    boxStart,
    lastTextNumber,
    waitingCount,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    key: AutomationReplyStateKey;
    channelAccountId: number;
    boxStart: Date | null;
    lastTextNumber: number | null;
    waitingCount: number;
  }): Promise<void> {
    await withAppDatabaseContext({
      scope,
      callback: () =>
        this.repository.save({ ...key, channelAccountId, boxStart, lastTextNumber, waitingCount }),
    });
  }

  /**
   * Empties the box after a reply-step change (route 30, AU12), in the save's unit.
   *
   * @remarks
   * Algorithm: one update. Failure modes: none. Side effects: at most one row.
   */
  async emptyReplyBox({
    scope,
    key,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    key: AutomationReplyStateKey;
  }): Promise<void> {
    await withAppDatabaseContext({ scope, callback: () => this.repository.emptyBox(key) });
  }
}
