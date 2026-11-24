import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  assertTeamOrganization,
  assertTeamOrganizationForRead,
} from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import type { InstagramAccountProfile } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type { ChannelConnectionRepository } from '@/domains/app/sub-domains/channel-connection/channel-connection.repository.js';
import type { ChannelConnectionTokenService } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.service.js';
import type {
  ChannelConnectionAccount,
  ChannelConnectionAccountPort,
  ChannelConnectionAccountScope,
} from '@/domains/app/sub-domains/channel-connection/channel-connection.types.js';
import type {
  InstagramAccountKey,
  InstagramAccountRow,
} from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import type { InstagramAccountExtensionService } from '@/domains/app/sub-domains/instagram-account/instagram-account-extension.service.js';
import { serializeInstagramAccountExtension } from '@/domains/app/sub-domains/instagram-account/instagram-account.serializer.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramAccountSettingsService } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import { serializeInstagramAccountSettings } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.serializer.js';
import type { InstagramAccountSettingsChannelAccountPort } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';
import { CHANNEL_ACCOUNTS_MAX_WITHOUT_PLAN } from '@/domains/app/sub-domains/channel-connection/channel-connection.constants.js';
import { planAccountLimitError } from '@/domains/app/sub-domains/channel-connection/channel-connection-error.util.js';
import {
  CHANNEL_ACCOUNT_CHANNELS,
  CHANNEL_ACCOUNT_PLAN_STOP_REASON,
  CHANNEL_ACCOUNT_STATUS,
  type ChannelAccountChannel,
} from './channel-account.constants.js';
import {
  APP_UNTESTED_META_FEATURES,
  APP_UNTESTED_META_MESSAGE_KINDS,
  APP_UNTESTED_META_TRIGGER_TYPES,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import {
  CHANNEL_CAPABILITIES,
  CHANNEL_FEATURES,
  type ChannelFeature,
} from './channel-account-capabilities.constants.js';
import {
  channelAccountAlreadyActiveError,
  channelAccountNotFoundError,
  stopChannelAccountInvalidError,
} from './channel-account-error.util.js';
import type { ChannelAccountRepository, ChannelAccountRow } from './channel-account.repository.js';
import {
  serializeChannelAccount,
  serializeChannelAccountSummary,
} from './channel-account.serializer.js';
import type {
  AutomationChannelAccount,
  ChannelAutomationPartProblem,
  ChannelAccountChange,
  ChannelAccountLanePort,
  ChannelAccountOutput,
  ChannelAccountPlanStopPort,
  ChannelAccountSummaryOutput,
  ChannelFeatureCheckResult,
  ChannelFeatureProblem,
} from './channel-account.types.js';

/**
 * The plan read route 11 and the feature check take the plan from (sub-domain 8, P83).
 *
 * @remarks
 * Notes: structural, so a test can stub it; billing's `SubscriptionService` satisfies it.
 */
export type ChannelAccountPlanAccessService = Pick<SubscriptionService, 'getPlanAccess'>;

/**
 * The caller of a channel account route: its organization scope and user.
 *
 * @remarks
 * Notes: the scope is the verified `org` claim; the user public id is empty for an API key.
 */
export interface ChannelAccountCaller {
  scope: OrganizationPrincipalDatabaseScope;
  /** `usr_…` of the signed-in user (route 9's `paused_by_user_id`). */
  userPublicId: string;
  /** The request id, sent to Meta as `X-Request-Id` (route 8's unsubscribe). */
  requestId: string;
}

/** The inputs of the one feature check that do not change per feature (one read each, CA11). */
interface ChannelFeatureInputs {
  channel: ChannelAccountChannel;
  connectionScopes: readonly string[];
  planSwitches: Readonly<Record<string, boolean>> | null;
}

/** The account as the channel connection's port names it, from its row and Instagram extension. */
function toConnectionAccount({
  account,
  instagram,
}: {
  account: ChannelAccountRow;
  instagram: InstagramAccountRow | undefined;
}): ChannelConnectionAccount {
  return {
    internalId: account.id,
    publicId: account.public_id,
    channel: account.channel as ChannelAccountChannel,
    providerAccountId: account.provider_account_id,
    displayName: account.display_name,
    profilePictureUrl: instagram?.profile_picture_url ?? null,
    connectionStatus: account.connection_status,
    channelConnectionId: account.channel_connection_id,
    isWebhookSubscribed: instagram?.webhook_subscribed_at != null,
  };
}

/** The one feature check over inputs already read (CA11 (2)): the first failing reason, in order. */
function checkFeature({
  inputs,
  feature,
  untestedMetaFeatures,
}: {
  inputs: ChannelFeatureInputs;
  feature: ChannelFeature;
  untestedMetaFeatures: ReadonlySet<ChannelFeature>;
}): ChannelFeatureCheckResult {
  const capability = CHANNEL_CAPABILITIES[inputs.channel];
  if (capability === undefined || !capability.features.includes(feature)) {
    return { isAllowed: false, reason: 'channel_lacks_feature' };
  }
  const requirement = CHANNEL_FEATURES[feature];
  if (
    requirement.permission !== null &&
    !inputs.connectionScopes.includes(requirement.permission)
  ) {
    return { isAllowed: false, reason: 'permission_not_granted' };
  }
  if (inputs.planSwitches?.[requirement.planSwitch] !== true) {
    return { isAllowed: false, reason: 'plan_lacks_feature' };
  }
  if (requirement.isMetaTestRequired && untestedMetaFeatures.has(feature)) {
    return { isAllowed: false, reason: 'feature_not_offered' };
  }
  return { isAllowed: true };
}

/**
 * The channel account service (feat-instagram-dm-sending routes-final § 1B — routes 6–11): lists and
 * reads the organization's accounts, disconnects one, pauses and resumes its sending, swaps which
 * accounts are active within the plan; the guarded break (CA4); the one feature check (CA11); and
 * the channel connection's account port (MC5–MC8), over `app.channel_accounts` and its Instagram
 * extension.
 *
 * @remarks
 * Algorithm:
 * - Every database step runs in `withAppDatabaseContext` with the caller's organization scope; a
 *   port call joins the caller's open unit of work.
 * - No Meta call inside a unit of work (1B.10): route 8 reads, closes, unsubscribes, then writes.
 * - Route 11 takes the organization's account-limit lock — the pick's (MC7) — before it counts.
 *
 * Failure modes:
 * - `404 channel_account_not_found` (another organization's, a revoked or a missing account);
 *   `404 team_organization_required` on reads and `422` on writes from a personal organization
 *   (CA6); route 11's `409 channel_account_already_active`, `409 plan_account_limit` and
 *   `400 stop_channel_account_id` (CA9).
 *
 * Side effects:
 * - Writes `app.channel_accounts`, and the Instagram extension only through
 *   `InstagramAccountExtensionService` (2.A.10); revokes a connection with its last account (CA8);
 *   Meta's `subscribed_apps` (best effort).
 *
 * Notes:
 * - The lane steps of routes 8–11 and of the break go through {@link ChannelAccountLanePort}
 *   (sub-domain 6's lane service, ROUTE row R18) and the plan stop an activated account takes
 *   through {@link ChannelAccountPlanStopPort} (`plan_limit` from sub-domain 6's month count, R18;
 *   `plan_ended`, R24). Both are optional constructor arguments so a unit test can leave them out.
 * - The audit entries are the controller's, after commit (D36).
 */
export class ChannelAccountService
  implements ChannelConnectionAccountPort, InstagramAccountSettingsChannelAccountPort
{
  constructor(
    private readonly accountRepository: ChannelAccountRepository,
    private readonly instagramExtensionService: InstagramAccountExtensionService,
    private readonly instagramAccountService: InstagramAccountService,
    private readonly instagramSettingsService: InstagramAccountSettingsService,
    private readonly connectionRepository: ChannelConnectionRepository,
    private readonly connectionTokenService: ChannelConnectionTokenService,
    private readonly organizationService: OrganizationService,
    private readonly planAccessService: ChannelAccountPlanAccessService,
    private readonly lanePort?: ChannelAccountLanePort,
    private readonly planStopPort?: ChannelAccountPlanStopPort,
    private readonly untestedMetaFeatures: ReadonlySet<ChannelFeature> = new Set(
      APP_UNTESTED_META_FEATURES,
    ),
  ) {}

  /**
   * Route 6: the organization's not-revoked accounts of these channels, oldest connected first.
   *
   * @remarks
   * Algorithm: one unit — the team check, the accounts, their Instagram extensions and connections.
   * Failure modes: `404 team_organization_required`. Side effects: none — the database only.
   */
  async listAccounts({
    scope,
    channels,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channels: readonly ChannelAccountChannel[];
  }): Promise<ChannelAccountSummaryOutput[]> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organizationId = await this.requireReadableOrganization(scope);
        const accounts = await this.accountRepository.listLive({ organizationId, channels });
        const instagramById = await this.readInstagramRows({ scope, organizationId, accounts });
        const connections = await this.connectionRepository.findByIds({
          organizationId,
          channelConnectionIds: [
            ...new Set(accounts.map((account) => account.channel_connection_id)),
          ],
        });
        const connectionPublicIds = new Map(
          connections.map((connection) => [connection.id, connection.public_id]),
        );
        const summaries: ChannelAccountSummaryOutput[] = [];
        for (const account of accounts) {
          const activeStop = await this.lanePort?.readActiveStop({
            scope,
            organizationId,
            channelAccountId: account.id,
          });
          summaries.push(
            serializeChannelAccountSummary({
              account,
              channel_connection_public_id:
                connectionPublicIds.get(account.channel_connection_id) ?? '',
              profile_picture_url: instagramById.get(account.id)?.profile_picture_url ?? null,
              has_lane_stop: activeStop != null,
            }),
          );
        }
        return summaries;
      },
    });
  }

  /**
   * Route 7: one not-revoked account with its Instagram extension, settings and sending state.
   *
   * @remarks
   * Algorithm: one unit — the team check, the account, its object. Failure modes:
   * `404 channel_account_not_found`, `404 team_organization_required`. Side effects: none — the
   * database only, never Meta.
   */
  async getAccount({
    scope,
    channelAccountPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
  }): Promise<ChannelAccountOutput> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organizationId = await this.requireReadableOrganization(scope);
        const account = await this.requireLiveAccount({ organizationId, channelAccountPublicId });
        return this.toAccountOutput({ scope, organizationId, account });
      },
    });
  }

  /**
   * Route 8 (CA8): disconnects one account.
   *
   * @remarks
   * Algorithm:
   * 1. One unit: the team check (`422`), the account (`404` when revoked), its Instagram row and
   *    its connection's token.
   * 2. Outside any unit: `DELETE subscribed_apps` (best effort, logged — never blocks).
   * 3. One commit: the account `revoked` with its Instagram row, its lanes stopped (sub-domain 6),
   *    and the connection's token deleted — with the connection revoked — only when no other
   *    not-revoked account uses that connection.
   *
   * Failure modes: `404 channel_account_not_found` (a repeat, a race), `422` personal organization.
   * Side effects: the commit; one Meta call. Automations, contacts and history stay; the starter
   * questions' removal is the account set-up's (ROUTE row R40).
   */
  async disconnectAccount({
    scope,
    requestId,
    channelAccountPublicId,
  }: Omit<ChannelAccountCaller, 'userPublicId'> & {
    channelAccountPublicId: string;
  }): Promise<ChannelAccountChange> {
    const snapshot = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organizationId = await this.requireWritableOrganization(scope);
        const account = await this.requireLiveAccount({ organizationId, channelAccountPublicId });
        const instagram = await this.findInstagramRow({ scope, organizationId, account });
        const token = await this.connectionTokenService.findAccessToken({
          scope,
          channelConnection: { organizationId, channelConnectionId: account.channel_connection_id },
        });
        return { organizationId, account, instagram, token };
      },
    });
    if (snapshot.instagram !== null && snapshot.token !== null) {
      await this.instagramAccountService.unsubscribeWebhookFieldsBestEffort({
        scope,
        access: {
          account: snapshot.instagram,
          instagramAccount: instagramKeyOf(snapshot.instagram),
          encryptedAccessToken: snapshot.token.encryptedAccessToken,
        },
        requestId,
      });
    }
    await withAppDatabaseContext({
      scope,
      callback: async () => {
        const { organizationId, account } = snapshot;
        const revoked = await this.revokeAccount({ scope, organizationId, account });
        if (revoked === null) throw channelAccountNotFoundError();
        await this.lanePort?.stopLanes({ scope, organizationId, channelAccountId: account.id });
        const liveCount = await this.accountRepository.countLiveByConnection({
          organizationId,
          channelConnectionId: account.channel_connection_id,
        });
        if (liveCount === 0) {
          await this.connectionTokenService.revokeConnection({
            scope,
            channelConnection: {
              organizationId,
              channelConnectionId: account.channel_connection_id,
            },
          });
        }
      },
    });
    return {
      channelAccountPublicId: snapshot.account.public_id,
      oldValue: { connection_status: snapshot.account.connection_status },
      newValue: { connection_status: CHANNEL_ACCOUNT_STATUS.REVOKED },
    };
  }

  /**
   * Route 9 (CA7): the owner's pause — `paused_at` and `paused_by_user_id`; an already paused
   * account answers the same. Comments and taps are still saved; nothing is sent.
   *
   * @remarks
   * Algorithm: one unit — the team check (`422`), the account (`404` when revoked), the pause, its
   * object. Failure modes: as above. Side effects: one row update (none on a repeat).
   */
  async pauseAccount({
    scope,
    userPublicId,
    channelAccountPublicId,
  }: Omit<ChannelAccountCaller, 'requestId'> & {
    channelAccountPublicId: string;
  }): Promise<{ data: ChannelAccountOutput; change: ChannelAccountChange }> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organizationId = await this.requireWritableOrganization(scope);
        const account = await this.requireLiveAccount({ organizationId, channelAccountPublicId });
        const pausedByUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(userPublicId);
        const paused = await this.accountRepository.pause({
          organizationId,
          channelAccountId: account.id,
          pausedByUserId,
        });
        if (paused === null) throw channelAccountNotFoundError();
        return {
          data: await this.toAccountOutput({ scope, organizationId, account: paused }),
          change: {
            channelAccountPublicId: paused.public_id,
            oldValue: { is_paused: account.paused_at !== null },
            newValue: { is_paused: true },
          },
        };
      },
    });
  }

  /**
   * Route 10 (CA7): clears only the owner's pause — error stops, a team suspend and a plan stop stay;
   * after commit each lane with waiting messages gets one turn again (sub-domain 6).
   *
   * @remarks
   * Algorithm: one unit — the team check (`422`), the account (`404` when revoked), the resume, its
   * object; then the lanes woken. Failure modes: as above. Side effects: one row update (none on a
   * repeat); the lane wake.
   */
  async resumeAccount({
    scope,
    channelAccountPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
  }): Promise<{ data: ChannelAccountOutput; change: ChannelAccountChange }> {
    const result = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organizationId = await this.requireWritableOrganization(scope);
        const account = await this.requireLiveAccount({ organizationId, channelAccountPublicId });
        const resumed = await this.accountRepository.resume({
          organizationId,
          channelAccountId: account.id,
        });
        if (resumed === null) throw channelAccountNotFoundError();
        return {
          organizationId,
          channelAccountId: resumed.id,
          data: await this.toAccountOutput({ scope, organizationId, account: resumed }),
          change: {
            channelAccountPublicId: resumed.public_id,
            oldValue: { is_paused: account.paused_at !== null },
            newValue: { is_paused: false },
          },
        };
      },
    });
    await this.lanePort?.wakeLanes({
      scope,
      organizationId: result.organizationId,
      channelAccountId: result.channelAccountId,
    });
    return { data: result.data, change: result.change };
  }

  /**
   * Route 11 (CA9): makes a "not in your plan" account active, swapping out a named active account
   * at the plan's limit.
   *
   * @remarks
   * Algorithm:
   * 1. Outside any unit: the plan's `channel_accounts_max` (billing's plan read, P83).
   * 2. One unit under the organization's account-limit lock (the pick's, MC7): the team check
   *    (`422`); the account (`404`); not `plan_downgrade` → `409 channel_account_already_active`;
   *    the named account must be another active account of the organization (`400
   *    stop_channel_account_id`); count the active accounts — at the limit with none named →
   *    `409 plan_account_limit`; the named account takes `plan_downgrade` and its lanes stop; the
   *    activated account's `plan_downgrade` gives way to the organization's own plan stop
   *    (`plan_ended` / `plan_limit` through {@link ChannelAccountPlanStopPort}, or none).
   * 3. After commit: the activated account's lanes wake.
   *
   * Failure modes: as above. Side effects: two row updates; the lane steps. Replayed by its
   * `X-Idempotency-Key`, so a network retry gets the swap's answer, not a `409`.
   */
  async activateAccount({
    scope,
    channelAccountPublicId,
    stopChannelAccountPublicId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccountPublicId: string;
    stopChannelAccountPublicId: string | null;
  }): Promise<{
    data: ChannelAccountOutput;
    change: ChannelAccountChange;
    stoppedChannelAccountPublicId: string | null;
  }> {
    const accountsMax = await this.readAccountsMax(scope);
    const result = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organizationId = await this.requireWritableOrganization(scope);
        await this.accountRepository.lockOrganizationForAccountLimit(organizationId);
        const account = await this.requireLiveAccount({ organizationId, channelAccountPublicId });
        if (account.plan_stop_reason !== CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_DOWNGRADE) {
          throw channelAccountAlreadyActiveError();
        }
        const stopAccount = await this.findStopAccount({
          organizationId,
          account,
          stopChannelAccountPublicId,
        });
        const activeCount = await this.accountRepository.countActive(organizationId);
        if (activeCount >= accountsMax && stopAccount === null) throw planAccountLimitError();
        if (stopAccount !== null) {
          await this.accountRepository.setPlanStop({
            organizationId,
            channelAccountId: stopAccount.id,
            reason: CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_DOWNGRADE,
          });
          await this.lanePort?.stopLanes({
            scope,
            organizationId,
            channelAccountId: stopAccount.id,
            planStopReason: CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_DOWNGRADE,
          });
        }
        const organizationStop =
          (await this.planStopPort?.readOrganizationPlanStop({ scope, organizationId })) ?? null;
        const activated = await this.accountRepository.setPlanStop({
          organizationId,
          channelAccountId: account.id,
          reason: organizationStop,
        });
        if (activated === null) throw channelAccountNotFoundError();
        if (organizationStop !== null) {
          await this.lanePort?.stopLanes({
            scope,
            organizationId,
            channelAccountId: activated.id,
            planStopReason: organizationStop,
          });
        }
        return {
          organizationId,
          channelAccountId: activated.id,
          data: await this.toAccountOutput({ scope, organizationId, account: activated }),
          change: {
            channelAccountPublicId: activated.public_id,
            oldValue: { plan_stop_reason: account.plan_stop_reason },
            newValue: { plan_stop_reason: activated.plan_stop_reason },
          },
          stoppedChannelAccountPublicId: stopAccount?.public_id ?? null,
        };
      },
    });
    await this.lanePort?.wakeLanes({
      scope,
      organizationId: result.organizationId,
      channelAccountId: result.channelAccountId,
    });
    return {
      data: result.data,
      change: result.change,
      stoppedChannelAccountPublicId: result.stoppedChannelAccountPublicId,
    };
  }

  /**
   * The guarded break of CA4: `connected → error`, for the connection's break (sub-domain 1, MC11),
   * an account missing from the assigned list, and the send errors (5, 6). The winner enqueues the
   * reconnect notice (WC-46, through the Instagram account service) and stops the account's lanes
   * until a reconnect (`login_expired`, or `account_not_shared` — SN5, through the lane port).
   *
   * @remarks
   * Algorithm: one unit — the account, its Instagram row, the guarded change of the account's
   * status through the Instagram account service (which enqueues the notice), and for the winner
   * the lanes' break stop.
   * Failure modes: none of its own — `false` when the account was not `connected` (another caller won
   * the race, or it was revoked). Side effects: the status change; one notice job per break.
   */
  async markAccountBroken({
    scope,
    organizationId,
    channelAccountId,
    requestId,
    stopReason = 'login_expired',
  }: ChannelConnectionAccountScope & {
    channelAccountId: number;
    requestId?: string | undefined;
    /** The lanes' stop the break starts (SN5): a refused token by default. */
    stopReason?: 'login_expired' | 'account_not_shared' | undefined;
  }): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const account = await this.accountRepository.findById({ organizationId, channelAccountId });
        if (account === null || account.connection_status !== CHANNEL_ACCOUNT_STATUS.CONNECTED) {
          return false;
        }
        const instagram = await this.findInstagramRow({ scope, organizationId, account });
        if (instagram === null) return false;
        const broken = await this.instagramAccountService.markConnectionBroken({
          scope,
          instagramAccount: instagramKeyOf(instagram),
          connectionStatus: 'error',
          requestId,
        });
        if (broken === null) return false;
        await this.lanePort?.startBrokenAccountStop({
          scope,
          organizationId,
          channelAccountId,
          reason: stopReason,
        });
        return true;
      },
    });
  }

  /**
   * The one feature check (CA11 (2), P50): can this channel account use `feature` — allowed, or the
   * first failing reason in the order `channel_lacks_feature`, `permission_not_granted`,
   * `plan_lacks_feature`, `feature_not_offered`.
   *
   * @remarks
   * Algorithm: the plan's switches (billing's plan read, outside any unit), then one unit — the
   * account's channel and its connection's granted permissions — then the constants. Failure modes:
   * `404 channel_account_not_found` when the account is not the organization's. Side effects: none
   * — Postgres and constants only, never Meta. Notes: go-live lists the refusals; a route that
   * refuses outright maps the reason with `channelFeatureRefusalError` (P61).
   */
  async canChannelAccountUseFeature({
    scope,
    organizationId,
    channelAccountId,
    feature,
  }: ChannelConnectionAccountScope & {
    channelAccountId: number;
    feature: ChannelFeature;
  }): Promise<ChannelFeatureCheckResult> {
    const inputs = await this.readFeatureInputs({ scope, organizationId, channelAccountId });
    return checkFeature({ inputs, feature, untestedMetaFeatures: this.untestedMetaFeatures });
  }

  /**
   * Every refusal of the one feature check for a whole automation or broadcast (CA11 (2)), in one
   * read of each input; empty when every feature is allowed.
   *
   * @remarks
   * Algorithm: as {@link canChannelAccountUseFeature}, once per distinct feature over the same
   * inputs. Failure modes: as there. Side effects: none.
   */
  async listChannelAccountFeatureProblems({
    scope,
    organizationId,
    channelAccountId,
    features,
  }: ChannelConnectionAccountScope & {
    channelAccountId: number;
    features: readonly ChannelFeature[];
  }): Promise<ChannelFeatureProblem[]> {
    const inputs = await this.readFeatureInputs({ scope, organizationId, channelAccountId });
    const problems: ChannelFeatureProblem[] = [];
    for (const feature of new Set(features)) {
      const result = checkFeature({
        inputs,
        feature,
        untestedMetaFeatures: this.untestedMetaFeatures,
      });
      if (!result.isAllowed) problems.push({ feature, reason: result.reason });
    }
    return problems;
  }

  /**
   * Every refusal of the one feature check for a whole automation (feat-instagram-dm-sending
   * routes-final § 4 AU34, CA11): the way to start, each step and each message kind against the
   * channel's capability list (`channel_lacks_feature`), the ways and kinds whose Meta test has not
   * passed (`feature_not_offered`, P36 — `APP_UNTESTED_META_TRIGGER_TYPES` /
   * `APP_UNTESTED_META_MESSAGE_KINDS`), then each plan feature through
   * {@link listChannelAccountFeatureProblems}. Empty when every part is allowed.
   *
   * @remarks
   * Algorithm: the capability and untested lists are code constants; the features read the inputs
   * once. Failure modes: `404 channel_account_not_found` when the account is gone. Side effects: none.
   */
  async listChannelAccountAutomationProblems({
    scope,
    organizationId,
    channelAccountId,
    channel,
    parts,
  }: ChannelConnectionAccountScope & {
    channelAccountId: number;
    channel: ChannelAccountChannel;
    parts: {
      triggerType: string;
      steps: readonly string[];
      messageKinds: readonly string[];
      features: readonly ChannelFeature[];
    };
  }): Promise<ChannelAutomationPartProblem[]> {
    const capability = CHANNEL_CAPABILITIES[channel];
    const problems: ChannelAutomationPartProblem[] = [];
    const checkPart = ({
      kind,
      part,
      supported,
      untested,
    }: {
      kind: ChannelAutomationPartProblem['kind'];
      part: string;
      supported: readonly string[];
      untested: readonly string[];
    }) => {
      if (!supported.includes(part)) {
        problems.push({ kind, part, reason: 'channel_lacks_feature' });
      } else if (untested.includes(part)) {
        problems.push({ kind, part, reason: 'feature_not_offered' });
      }
    };
    checkPart({
      kind: 'trigger_type',
      part: parts.triggerType,
      supported: capability.triggerTypes,
      untested: APP_UNTESTED_META_TRIGGER_TYPES,
    });
    for (const step of new Set(parts.steps)) {
      checkPart({ kind: 'step', part: step, supported: capability.steps, untested: [] });
    }
    for (const messageKind of new Set(parts.messageKinds)) {
      checkPart({
        kind: 'message_kind',
        part: messageKind,
        supported: capability.messageKinds,
        untested: APP_UNTESTED_META_MESSAGE_KINDS,
      });
    }
    if (parts.features.length > 0) {
      const featureProblems = await this.listChannelAccountFeatureProblems({
        scope,
        organizationId,
        channelAccountId,
        features: parts.features,
      });
      problems.push(
        ...featureProblems.map((featureProblem) => ({
          kind: 'feature' as const,
          part: featureProblem.feature,
          reason: featureProblem.reason,
        })),
      );
    }
    return problems;
  }

  /**
   * A channel account as the automations read it (feat-instagram-dm-sending routes-final § 4.A):
   * by public id (route 28's account, route 27's list) or internal id (go-live), locked `FOR UPDATE`
   * when asked (go-live's starter-question count — the account first, 4.A.10), with its connection's
   * status and its Instagram username and privacy; `null` when absent. In the caller's unit.
   *
   * @remarks
   * Algorithm: the account read (or lock), its connection, its extension. Failure modes: none of its
   * own. Side effects: a row lock when `isLocked`.
   */
  async readAutomationAccount({
    scope,
    organizationId,
    account,
    isLocked = false,
  }: ChannelConnectionAccountScope & {
    account: { channelAccountPublicId: string } | { channelAccountId: number };
    isLocked?: boolean;
  }): Promise<AutomationChannelAccount | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        let row: ChannelAccountRow | null;
        if ('channelAccountPublicId' in account) {
          row = await this.accountRepository.findByPublicId({
            organizationId,
            channelAccountPublicId: account.channelAccountPublicId,
          });
          if (row !== null && isLocked) {
            row = await this.accountRepository.lockById({
              organizationId,
              channelAccountId: row.id,
            });
          }
        } else {
          row = isLocked
            ? await this.accountRepository.lockById({
                organizationId,
                channelAccountId: account.channelAccountId,
              })
            : await this.accountRepository.findById({
                organizationId,
                channelAccountId: account.channelAccountId,
              });
        }
        if (row === null) return null;
        const [connection] = await this.connectionRepository.findByIds({
          organizationId,
          channelConnectionIds: [row.channel_connection_id],
        });
        const extensions = await this.instagramExtensionService.findByChannelAccountIds({
          scope,
          organizationId,
          channelAccountIds: [row.id],
        });
        const extension = extensions.get(row.id);
        return {
          id: row.id,
          public_id: row.public_id,
          channel: row.channel as ChannelAccountChannel,
          connection_status: row.connection_status as AutomationChannelAccount['connection_status'],
          channel_connection_status: connection?.status ?? null,
          username: extension?.username ?? null,
          is_private: extension?.is_private ?? false,
        };
      },
    });
  }

  /**
   * The organization's active accounts (not revoked, not `plan_downgrade`) — the count route 64 shows
   * against the plan's `channel_accounts_max` (SN15), in the caller's unit.
   *
   * @remarks
   * Algorithm: one count. Failure modes: none. Side effects: none.
   */
  async countActiveAccounts({
    scope,
    organizationId,
  }: ChannelConnectionAccountScope): Promise<number> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.accountRepository.countActive(organizationId),
    });
  }

  /**
   * The organization's not-revoked Instagram account by its public id, or `null` — route 63's
   * account (6.A.9 answers `404 instagram_not_connected` for `null`), in the caller's unit.
   *
   * @remarks
   * Algorithm: one read. Failure modes: none. Side effects: none.
   */
  async findLiveInstagramAccount({
    scope,
    organizationId,
    channelAccountPublicId,
  }: ChannelConnectionAccountScope & {
    channelAccountPublicId: string;
  }): Promise<ChannelAccountRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const account = await this.accountRepository.findByPublicId({
          organizationId,
          channelAccountPublicId,
        });
        return account === null ||
          account.connection_status === CHANNEL_ACCOUNT_STATUS.REVOKED ||
          account.channel !== 'instagram'
          ? null
          : account;
      },
    });
  }

  // Route 12's channel account port (routes-final § 2.B, IA12 — ROUTE row R7).

  /**
   * The organization's not-revoked Instagram account by its public id, in the caller's unit — route
   * 12's account (2.5).
   *
   * @remarks
   * Algorithm: one read. Failure modes: `404 channel_account_not_found` when it is another
   * organization's, revoked, missing or not `instagram`. Side effects: none.
   */
  async requireLiveInstagramAccount({
    scope,
    organizationId,
    channelAccountPublicId,
  }: ChannelConnectionAccountScope & {
    channelAccountPublicId: string;
  }): Promise<ChannelAccountRow> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const account = await this.requireLiveAccount({ organizationId, channelAccountPublicId });
        if (account.channel !== 'instagram') throw channelAccountNotFoundError();
        return account;
      },
    });
  }

  /**
   * Sets the account's automation switch (P42) in the caller's unit — route 12 writes it with the
   * Instagram settings in one commit (IA12; no channel-account `PATCH` this iteration).
   *
   * @remarks
   * Algorithm: one guarded update (a repeat writes nothing), then the row. Failure modes: `404
   * channel_account_not_found` when it is revoked. Side effects: one row update.
   */
  async setAutomationEnabled({
    scope,
    organizationId,
    channelAccountId,
    isAutomationEnabled,
  }: ChannelConnectionAccountScope & {
    channelAccountId: number;
    isAutomationEnabled: boolean;
  }): Promise<ChannelAccountRow> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const account = await this.accountRepository.setAutomationEnabled({
          organizationId,
          channelAccountId,
          isAutomationEnabled,
        });
        if (account === null) throw channelAccountNotFoundError();
        return account;
      },
    });
  }

  // The channel connection's account port (routes-final § 1 MC5–MC8).

  /**
   * MC11: every `connected` account of the connection → `error` in the caller's unit, each through
   * the guarded break (CA4), whose winner gets one reconnect notice after the commit (WC-46). Returns
   * the accounts it changed (lane D's R4 added this method to the port, P401).
   */
  async markAccountsOfConnectionBroken({
    scope,
    organizationId,
    channelConnectionId,
    requestId,
  }: ChannelConnectionAccountScope & {
    channelConnectionId: number;
    requestId: string;
  }): Promise<ChannelConnectionAccount[]> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const accounts = await this.accountRepository.listLiveByConnections({
          organizationId,
          channelConnectionIds: [channelConnectionId],
        });
        const broken: ChannelAccountRow[] = [];
        for (const account of accounts) {
          if (account.connection_status !== CHANNEL_ACCOUNT_STATUS.CONNECTED) continue;
          const changed = await this.markAccountBroken({
            scope,
            organizationId,
            channelAccountId: account.id,
            requestId,
          });
          if (!changed) continue;
          const row = await this.accountRepository.findById({
            organizationId,
            channelAccountId: account.id,
          });
          if (row !== null) broken.push(row);
        }
        return this.toConnectionAccounts({ scope, organizationId, accounts: broken });
      },
    });
  }

  /**
   * Billing's accounts port (routes-final § 8.10, `BillingChannelAccountsPort`): the organization's
   * not-revoked channel accounts, oldest connected first, as `{ publicId, instagramUserId,
   * connectedAt }` — the trial's accounts (route 102) and the kept accounts of a move down (route 103).
   *
   * @remarks
   * One read under the organization's verified scope (a surrounding unit of the same organization
   * lends its transaction). The provider account id is the Instagram user id (CAC5). An organization
   * that does not exist answers `[]`.
   */
  async listActiveChannelAccounts({
    organizationPublicId,
  }: {
    organizationPublicId: string;
  }): Promise<{ publicId: string; instagramUserId: string; connectedAt: Date }[]> {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId }),
      callback: async () => {
        const organization =
          await this.organizationService.findOrganizationByPublicId(organizationPublicId);
        if (!organization) return [];
        const accounts = await this.accountRepository.listLive({
          organizationId: organization.id,
          channels: CHANNEL_ACCOUNT_CHANNELS,
        });
        return accounts.map((account) => ({
          publicId: account.public_id,
          instagramUserId: account.provider_account_id,
          connectedAt: account.connected_at,
        }));
      },
    });
  }

  /**
   * Billing's accounts port (routes-final § 8.10): how many not-revoked channel accounts the
   * organization has — route 108's `active_organization.channel_accounts_count` (BL16). `0` for an
   * organization that does not exist.
   */
  async countConnectedChannelAccounts({
    organizationPublicId,
  }: {
    organizationPublicId: string;
  }): Promise<number> {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId }),
      callback: async () => {
        const organization =
          await this.organizationService.findOrganizationByPublicId(organizationPublicId);
        return organization ? this.accountRepository.countLive(organization.id) : 0;
      },
    });
  }

  /** The not-revoked accounts of these connections, oldest connected first. */
  async listAccountsOfConnections({
    scope,
    organizationId,
    channelConnectionIds,
  }: ChannelConnectionAccountScope & {
    channelConnectionIds: readonly number[];
  }): Promise<ChannelConnectionAccount[]> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const accounts = await this.accountRepository.listLiveByConnections({
          organizationId,
          channelConnectionIds,
        });
        return this.toConnectionAccounts({ scope, organizationId, accounts });
      },
    });
  }

  /** The organization's Instagram accounts, any status, with these provider ids. */
  async findAccountsByProviderIds({
    scope,
    organizationId,
    providerAccountIds,
  }: ChannelConnectionAccountScope & {
    providerAccountIds: readonly string[];
  }): Promise<ChannelConnectionAccount[]> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const accounts = await this.accountRepository.findByProviderAccountIds({
          organizationId,
          channel: 'instagram',
          providerAccountIds,
        });
        return this.toConnectionAccounts({ scope, organizationId, accounts });
      },
    });
  }

  /** How many not-revoked accounts the organization has (the pick's count, MC7). */
  async countLiveAccounts({
    scope,
    organizationId,
  }: ChannelConnectionAccountScope): Promise<number> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.accountRepository.countLive(organizationId),
    });
  }

  /**
   * The organization holding this Instagram account live, or `null` — the Instagram user resolver
   * (IA6), which reads `app.channel_accounts` since ROUTE row R6 (2.A.3).
   */
  async resolveLiveOrganizationPublicIdForProviderAccount(
    providerAccountId: string,
  ): Promise<string | null> {
    return this.instagramAccountService.resolveOrganizationPublicIdForInstagramUser(
      providerAccountId,
    );
  }

  /** MC6: the organization's not-revoked accounts of these ids attached to the connection, `connected`. */
  async reconnectAccounts({
    scope,
    organizationId,
    channelConnectionId,
    providerAccountIds,
  }: ChannelConnectionAccountScope & {
    channelConnectionId: number;
    providerAccountIds: readonly string[];
  }): Promise<Array<{ account: ChannelConnectionAccount; previousChannelConnectionId: number }>> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const accounts = await this.accountRepository.findByProviderAccountIds({
          organizationId,
          channel: 'instagram',
          providerAccountIds,
        });
        const reconnected: Array<{
          account: ChannelConnectionAccount;
          previousChannelConnectionId: number;
        }> = [];
        for (const account of accounts) {
          if (account.connection_status === CHANNEL_ACCOUNT_STATUS.REVOKED) continue;
          const attached = await this.accountRepository.attachToConnection({
            organizationId,
            channelAccountId: account.id,
            channelConnectionId,
          });
          if (attached === null) continue;
          const instagram = await this.findInstagramRow({
            scope,
            organizationId,
            account: attached,
          });
          reconnected.push({
            account: toConnectionAccount({ account: attached, instagram: instagram ?? undefined }),
            previousChannelConnectionId: account.channel_connection_id,
          });
        }
        return reconnected;
      },
    });
  }

  /**
   * MC7, CAC5: the picked account connected on this connection — the channel account (new, or the
   * organization's own revoked row back) and its Instagram extension in the same commit, the
   * provider id equal to the Instagram user id; default settings when it has none (AC-2.5).
   */
  async connectPickedAccount({
    scope,
    organizationId,
    channelConnectionId,
    providerAccountId,
    profile,
    username,
    connectedByUserId,
  }: ChannelConnectionAccountScope & {
    channelConnectionId: number;
    providerAccountId: string;
    profile: InstagramAccountProfile | null;
    username: string | null;
    connectedByUserId: number | null;
  }): Promise<ChannelConnectionAccount> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const instagramUsername = profile?.username ?? username ?? providerAccountId;
        const account = await this.accountRepository.upsertConnected({
          organizationId,
          channel: 'instagram',
          channelConnectionId,
          providerAccountId,
          displayName: `@${instagramUsername}`.slice(0, 100),
          connectedByUserId,
        });
        const instagram = await this.instagramExtensionService.createAtPick({
          scope,
          values: {
            organizationId,
            channelAccountId: account.id,
            instagramUserId: providerAccountId,
            username: instagramUsername,
            biography: profile?.biography ?? null,
            website: profile?.website ?? null,
            profilePictureUrl: profile?.profilePictureUrl ?? null,
            // Meta's profile read carries neither (P120): unknown until Meta tells.
            accountType: null,
            isPrivate: false,
            followersCount: profile?.followersCount ?? 0,
            followsCount: profile?.followsCount ?? 0,
            mediaCount: profile?.mediaCount ?? 0,
          },
        });
        await this.instagramSettingsService.createDefaultSettings({
          scope,
          channelAccount: { organizationId, channelAccountId: account.id },
        });
        return toConnectionAccount({ account, instagram });
      },
    });
  }

  /** MC8: every not-revoked account of the connection revoked with its Instagram row. */
  async revokeAccountsOfConnection({
    scope,
    organizationId,
    channelConnectionId,
  }: ChannelConnectionAccountScope & {
    channelConnectionId: number;
  }): Promise<ChannelConnectionAccount[]> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const accounts = await this.accountRepository.listLiveByConnections({
          organizationId,
          channelConnectionIds: [channelConnectionId],
        });
        const revoked: ChannelAccountRow[] = [];
        for (const account of accounts) {
          const row = await this.revokeAccount({ scope, organizationId, account });
          if (row !== null) revoked.push(row);
        }
        return this.toConnectionAccounts({ scope, organizationId, accounts: revoked });
      },
    });
  }

  /** How many not-revoked accounts still use the connection. */
  async countLiveAccountsOfConnection({
    scope,
    organizationId,
    channelConnectionId,
  }: ChannelConnectionAccountScope & { channelConnectionId: number }): Promise<number> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.accountRepository.countLiveByConnection({ organizationId, channelConnectionId }),
    });
  }

  /** After commit: each not-subscribed Instagram account subscribed to the webhook fields (best effort). */
  async subscribeAccountsBestEffort({
    scope,
    accounts,
    encryptedAccessToken,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    accounts: readonly ChannelConnectionAccount[];
    encryptedAccessToken: string;
    requestId: string;
  }): Promise<void> {
    for (const target of accounts) {
      if (target.isWebhookSubscribed) continue;
      const instagram = await this.readInstagramOfPortAccount({ scope, target });
      if (instagram === null) continue;
      await this.instagramAccountService.subscribeWebhookFieldsBestEffort({
        scope,
        account: instagram,
        encryptedAccessToken,
        requestId,
      });
    }
  }

  /** Before "Disconnect business": each Instagram account unsubscribed (best effort). */
  async unsubscribeAccountsBestEffort({
    scope,
    accounts,
    encryptedAccessToken,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    accounts: readonly ChannelConnectionAccount[];
    encryptedAccessToken: string;
    requestId: string;
  }): Promise<void> {
    for (const target of accounts) {
      const instagram = await this.readInstagramOfPortAccount({ scope, target });
      if (instagram === null) continue;
      await this.instagramAccountService.unsubscribeWebhookFieldsBestEffort({
        scope,
        access: {
          account: instagram,
          instagramAccount: instagramKeyOf(instagram),
          encryptedAccessToken,
        },
        requestId,
      });
    }
  }

  /**
   * The account revoked (guarded: `null` when a concurrent disconnect won) and its Instagram
   * extension's webhook stamp cleared, in the caller's unit.
   */
  private async revokeAccount({
    scope,
    organizationId,
    account,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    account: ChannelAccountRow;
  }): Promise<ChannelAccountRow | null> {
    const revoked = await this.accountRepository.revoke({
      organizationId,
      channelAccountId: account.id,
    });
    if (revoked === null) return null;
    const instagram = await this.findInstagramRow({ scope, organizationId, account });
    if (instagram !== null) {
      await this.instagramExtensionService.clearOnRevoke({
        scope,
        instagramAccount: instagramKeyOf(instagram),
      });
    }
    return revoked;
  }

  /** The named account of route 11, checked (CA9) — `null` when none is named. */
  private async findStopAccount({
    organizationId,
    account,
    stopChannelAccountPublicId,
  }: {
    organizationId: number;
    account: ChannelAccountRow;
    stopChannelAccountPublicId: string | null;
  }): Promise<ChannelAccountRow | null> {
    if (stopChannelAccountPublicId === null) return null;
    const stopAccount = await this.accountRepository.findByPublicId({
      organizationId,
      channelAccountPublicId: stopChannelAccountPublicId,
    });
    if (
      stopAccount === null ||
      stopAccount.id === account.id ||
      stopAccount.connection_status === CHANNEL_ACCOUNT_STATUS.REVOKED ||
      stopAccount.plan_stop_reason === CHANNEL_ACCOUNT_PLAN_STOP_REASON.PLAN_DOWNGRADE
    ) {
      throw stopChannelAccountInvalidError();
    }
    return stopAccount;
  }

  /** The feature check's inputs: the account's channel, its connection's scopes, the plan's switches. */
  private async readFeatureInputs({
    scope,
    organizationId,
    channelAccountId,
  }: ChannelConnectionAccountScope & { channelAccountId: number }): Promise<ChannelFeatureInputs> {
    const planAccess = await this.planAccessService.getPlanAccess({
      organizationPublicId: scope.organizationPublicId,
    });
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const account = await this.accountRepository.findById({ organizationId, channelAccountId });
        if (account === null) throw channelAccountNotFoundError();
        const [connection] = await this.connectionRepository.findByIds({
          organizationId,
          channelConnectionIds: [account.channel_connection_id],
        });
        return {
          channel: account.channel as ChannelAccountChannel,
          connectionScopes: connection?.scopes ?? [],
          planSwitches: planAccess.features?.feature_switches ?? null,
        };
      },
    });
  }

  /** The plan's `channel_accounts_max` (Free's when the organization has no readable plan). */
  private async readAccountsMax(scope: OrganizationPrincipalDatabaseScope): Promise<number> {
    const planAccess = await this.planAccessService.getPlanAccess({
      organizationPublicId: scope.organizationPublicId,
    });
    return planAccess.features?.channel_accounts_max ?? CHANNEL_ACCOUNTS_MAX_WITHOUT_PLAN;
  }

  /** The Channel account object of one row, inside the caller's unit. */
  private async toAccountOutput({
    scope,
    organizationId,
    account,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    account: ChannelAccountRow;
  }): Promise<ChannelAccountOutput> {
    const [connection] = await this.connectionRepository.findByIds({
      organizationId,
      channelConnectionIds: [account.channel_connection_id],
    });
    const instagram = await this.findInstagramRow({ scope, organizationId, account });
    const settings =
      instagram === null
        ? null
        : await this.instagramSettingsService.findSettings({
            scope,
            channelAccount: { organizationId, channelAccountId: account.id },
          });
    const userPublicIds = await this.organizationService.resolveUserPublicIdsByInternalIds(
      [account.connected_by_user_id, settings?.updated_by_user_id ?? null].filter(
        (identifier): identifier is number => identifier !== null,
      ),
    );
    const publicIdOf = (identifier: number | null): string | null =>
      identifier === null ? null : (userPublicIds.get(identifier) ?? null);
    const activeStop =
      (await this.lanePort?.readActiveStop({
        scope,
        organizationId,
        channelAccountId: account.id,
      })) ?? null;
    return serializeChannelAccount({
      account,
      channel_connection: {
        id: connection?.public_id ?? '',
        provider: connection?.provider ?? '',
        status: connection?.status ?? '',
      },
      connected_by_user_public_id: publicIdOf(account.connected_by_user_id),
      active_stop: activeStop,
      instagram:
        instagram === null || settings === null
          ? null
          : serializeInstagramAccountExtension({
              instagram,
              settings: serializeInstagramAccountSettings({
                settings,
                channel_account: account,
                updated_by_user_public_id: publicIdOf(settings.updated_by_user_id),
                now: new Date(Date.now()),
              }),
            }),
      now: new Date(Date.now()),
    });
  }

  /** The port accounts of rows, with their Instagram extensions, inside the caller's unit. */
  private async toConnectionAccounts({
    scope,
    organizationId,
    accounts,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    accounts: readonly ChannelAccountRow[];
  }): Promise<ChannelConnectionAccount[]> {
    const instagramById = await this.readInstagramRows({ scope, organizationId, accounts });
    return accounts.map((account) =>
      toConnectionAccount({ account, instagram: instagramById.get(account.id) }),
    );
  }

  /** The Instagram rows of these accounts, by channel account id, inside the caller's unit. */
  private async readInstagramRows({
    scope,
    organizationId,
    accounts,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    accounts: readonly ChannelAccountRow[];
  }): Promise<Map<number, InstagramAccountRow>> {
    return this.instagramExtensionService.findByChannelAccountIds({
      scope,
      organizationId,
      channelAccountIds: accounts.map((account) => account.id),
    });
  }

  /** One account's Instagram row, or `null` (another channel), inside the caller's unit. */
  private async findInstagramRow({
    scope,
    organizationId,
    account,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    account: ChannelAccountRow;
  }): Promise<InstagramAccountRow | null> {
    const rows = await this.readInstagramRows({ scope, organizationId, accounts: [account] });
    return rows.get(account.id) ?? null;
  }

  /** The Instagram row behind a port account, in the scope's organization. */
  private async readInstagramOfPortAccount({
    scope,
    target,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    target: ChannelConnectionAccount;
  }): Promise<InstagramAccountRow | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const account = await this.accountRepository.findByPublicId({
          organizationId: await this.resolveOrganizationId(scope),
          channelAccountPublicId: target.publicId,
        });
        if (account === null) return null;
        return this.findInstagramRow({ scope, organizationId: account.organization_id, account });
      },
    });
  }

  /** One not-revoked account of the organization by its public id, or `404` (CA6). */
  private async requireLiveAccount({
    organizationId,
    channelAccountPublicId,
  }: {
    organizationId: number;
    channelAccountPublicId: string;
  }): Promise<ChannelAccountRow> {
    const account = await this.accountRepository.findByPublicId({
      organizationId,
      channelAccountPublicId,
    });
    if (account === null || account.connection_status === CHANNEL_ACCOUNT_STATUS.REVOKED) {
      throw channelAccountNotFoundError();
    }
    return account;
  }

  /** The scope's organization internal id. */
  private async resolveOrganizationId(scope: OrganizationPrincipalDatabaseScope): Promise<number> {
    const organization = await this.organizationService.requireOrganizationByPublicId(
      scope.organizationPublicId,
    );
    return organization.id;
  }

  /** The team check of a write (`422` for a personal organization) — its internal id. */
  private async requireWritableOrganization(
    scope: OrganizationPrincipalDatabaseScope,
  ): Promise<number> {
    const organization = await this.organizationService.requireOrganizationByPublicId(
      scope.organizationPublicId,
    );
    assertTeamOrganization({ organization, capability: 'INSTAGRAM' });
    return organization.id;
  }

  /** The team check of a read (`404 team_organization_required`) — its internal id. */
  private async requireReadableOrganization(
    scope: OrganizationPrincipalDatabaseScope,
  ): Promise<number> {
    const organization = await this.organizationService.requireOrganizationByPublicId(
      scope.organizationPublicId,
    );
    assertTeamOrganizationForRead({ organization });
    return organization.id;
  }
}

/** The Instagram account's key from its row. */
function instagramKeyOf(account: InstagramAccountRow): InstagramAccountKey {
  return { organizationId: account.organization_id, instagramAccountId: account.id };
}
