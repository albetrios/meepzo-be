import {
  ConfigurationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/shared/errors/index.js';
import { isPostgresUniqueViolation } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { isDisposableEmailBlocked } from '@/shared/utils/text/email.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import { assertRecordNotChangedSince } from '@/shared/utils/validation/record-fields.util.js';
import {
  MAINTENANCE_SCOPE,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
  withMaintenanceDatabaseContext,
  type OrganizationPrincipalDatabaseScope,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  acquireResourceQuotaLock,
  RESOURCE_QUOTA_LOCK_NAMESPACE,
} from '@/infrastructure/database/resource-quota-lock.util.js';
import type { UserSettingsService } from '@/domains/user/sub-domains/user-settings/user-settings.service.js';
import {
  isFactoryDefaultUserLocaleSettings,
  preferredLocalesForOrganizationDefaultLocale,
} from '@/domains/user/sub-domains/user-settings/user-settings-locale-defaults.util.js';
import { buildPlanRefusal } from '@/domains/billing/sub-domains/entitlement/entitlement-refusal.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { OrganizationMembershipContext } from '@/domains/tenancy/sub-domains/organization/organization.types.js';
import { assertTeamOrganization } from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import type { MemberRoleService } from '@/domains/tenancy/sub-domains/member-roles/member-role.service.js';
import type { MemberRolePermissionService } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.service.js';
import type { AuthorizationService } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import type { PermissionRepository } from '@/domains/tenancy/sub-domains/permission/permission.repository.js';
import {
  assertCallerCanGrantPermissionCodes,
  assertCallerHoldsMemberPermissionCodes,
} from '@/domains/tenancy/sub-domains/permission/assert-grantable-permissions.util.js';
import type { MembershipListQuery, MembershipRepository } from './membership.repository.js';
import {
  type CallerMembershipContext,
  type MembershipAccessRefs,
  type MembershipActionOptions,
  type MembershipInviteeInput,
  type MembershipInviteLine,
  type MembershipInviteResultWithInvited,
  type MembershipOutput,
  type MembershipProfileData,
  type MembershipRoleCount,
  type MembershipRow,
  membershipStatusConsumesSeat,
  type MembershipUserSummary,
} from './membership.types.js';
import {
  isInvitableEmail,
  validateCreateMembership,
  validateDeleteMembershipQuery,
  validateUpdateMembership,
  validateListMembershipsQuery,
  validateTransferOwnership,
} from './membership.validator.js';
import { serializeMembership } from './membership.serializer.js';
import { buildDomainEvent, eventBus } from '@/core/events/event-bus.js';
import type { OrganizationResourceEventPayload } from '@/core/events/organization-resource-event.js';
import { MEMBERSHIP_EVENT, type MembershipEventType } from './events/membership.events.js';
import {
  MEMBERSHIP_NOTICE_EVENT,
  type MembershipRemovedPayload,
  type MembershipRoleChangedPayload,
} from './events/membership-notice.events.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { DEFAULT_LANGUAGE } from '@/shared/constants/i18n.constants.js';
import { resolveStoredMediaReadUrl } from '@/shared/utils/infrastructure/media-url.util.js';
import type { ObjectStoragePort } from '@/infrastructure/storage/object-storage.port.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { MembershipInvitationService } from './membership-invitation/membership-invitation.service.js';
import {
  attachInvitationTokenEcho,
  serializeMembershipInvitation,
} from './membership-invitation/membership-invitation.serializer.js';
import type { MembershipInvitationOutput } from './membership-invitation/membership-invitation.types.js';
import { invalidatePermissions } from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import type { OrganizationApiKeyRepository } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.repository.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { assertMembershipRolesAllowed } from '@/domains/tenancy/sub-domains/member-roles/member-role-capability.js';
import { MembershipAdditionalRolesRepository } from './membership-additional-roles/membership-additional-roles.repository.js';
import {
  MEMBERSHIP_DELETE_REASON,
  MEMBERSHIP_INVITE_RESULT,
  MEMBERSHIP_ROLE_IDS_MAX,
  MEMBERSHIP_STATUS,
  type MembershipDeleteReason,
} from './membership.constants.js';
import { ADMIN_ROLE_NAME } from '@/domains/tenancy/sub-domains/member-roles/member-role.constants.js';
import type { UpdateMembershipInput } from './membership.dto.js';

/** An invite's expiry when the body names none, in days (the `expires_in_days` default). */
const DEFAULT_INVITE_EXPIRES_IN_DAYS = 7;

/**
 * Ends a manager cannot undo (B2-6): the person left or deleted their account, or the invite was
 * declined or expired — only the person can come back, by a new invite.
 */
const UNRESTORABLE_DELETE_REASONS: ReadonlySet<MembershipDeleteReason> = new Set([
  MEMBERSHIP_DELETE_REASON.LEFT,
  MEMBERSHIP_DELETE_REASON.ACCOUNT_DELETED,
  MEMBERSHIP_DELETE_REASON.DECLINED,
  MEMBERSHIP_DELETE_REASON.INVITATION_EXPIRED,
]);

/** A role row as the member-role service resolves it. */
type ResolvedRole = Awaited<ReturnType<MemberRoleService['requireRoleRecordForOrganization']>>;

/** What serializing a membership needs of its organization: the public id and who owns it. */
type SerializingOrganization = Pick<OrganizationMembershipContext, 'public_id' | 'owner_user_id'>;

/**
 * What ending a membership does in a product domain, satisfied by that domain when it is built.
 *
 * @remarks
 * - **Algorithm:** {@link MembershipService} calls `releaseEndedMembership` inside the same
 *   organization transaction that ends the membership — for a removal, for leaving and for a
 *   deleted account alike — so what the person *does now* is cleared and what is *theirs alone*
 *   goes in one step, while what they *did* stays.
 * - **Failure modes:** an error rolls the whole leave back — the membership is not ended.
 * - **Notes:** late-wired via {@link MembershipService.wireLeaveStep}, so tenancy does not import
 *   a product domain; without it (today, and in a minimal harness) only the membership ends.
 */
export type MembershipLeavePort = {
  releaseEndedMembership(options: { organizationId: number; membershipId: number }): Promise<void>;
};

/**
 * Cross-domain port for REQ-4 seat enforcement and Stripe seat reconciliation: the locked seat
 * ceiling is answered by billing's entitlement module (`EntitlementService`, change-plan-gates SE1,
 * K3), which delegates to subscription's locked read; the Stripe seat sync by billing's
 * `SubscriptionService`.
 *
 * @remarks
 * - **Algorithm:** declared as a minimal structural interface (not a billing service import)
 *   so tenancy does not depend on billing's services — billing already depends on tenancy, so
 *   importing a concrete service here would create a cycle. The composition root late-wires the
 *   two billing services in via {@link MembershipService.wireSeatEnforcement}.
 * - **Failure modes:** `reserveSeatCeilingForMemberAdd` returns `null` (no ceiling) when the organization has
 *   no active subscription or the plan is unlimited; the implementer takes a row lock so concurrent
 *   adds serialize. `enqueueSeatQuantitySync` is best-effort (swallows enqueue failures).
 * - **Side effects:** the implementer acquires a `FOR UPDATE` lock (reserve) / enqueues a job (sync).
 */
export type MembershipSeatEnforcementPort = {
  reserveSeatCeilingForMemberAdd(organizationId: number): Promise<number | null>;
  enqueueSeatQuantitySync(options: {
    organization_public_id: string;
    idempotencyKey?: string | undefined;
  }): void;
};

/**
 * HTTP response shape for `GET /organization/memberships/:membership_id/permissions` — the
 * member's effective codes (launch §2.B.6 "Member permissions", T15).
 *
 * @remarks
 * - **Algorithm:** the union of the codes of every role the member holds, main and extra (D5).
 * - **Failure modes:** carries no state of its own; producers raise
 *   `NotFoundError('Membership')` when the membership cannot be resolved (or has ended).
 * - **Side effects:** none — this is a plain DTO.
 * - **Notes:** codes are flat strings matching the entries in `tenancy.permissions`.
 */
export interface MembershipPermissionsOutput {
  permission_codes: string[];
}

/**
 * What the team picker asks of the membership list (launch §2.A, K5): the filters already parsed by
 * the app's `GET /app/memberships` DTO.
 *
 * @remarks
 * - **Notes:** a role is a public id — an unknown one is an empty page, never a 400;
 *   `includeEnded` lists every membership (any status, live or ended), otherwise live active ones.
 */
export interface MembershipDirectoryQuery {
  q?: string | undefined;
  rolePublicId?: string | undefined;
  /** Only members one of whose roles grants this code (T8); an unknown code matches nobody. */
  holdsPermissionCode?: string | undefined;
  /** Every membership — any status, live or ended; otherwise live active members only. */
  includeEnded: boolean;
  publicIds?: readonly string[] | undefined;
  limit: number;
  after?: string | undefined;
}

/**
 * The 403 for a change the organization owner's membership never takes — their status, their main
 * role, their removal (sec-new-T1): ownership is handed over first.
 *
 * @remarks
 * - **Notes:** `reason: owner_membership_fixed` (launch D81 (4)) so a client tells it from a
 *   missing permission; the owner's extra roles and staff profile stay editable.
 */
function ownerMembershipFixedError(messageKey: string): ForbiddenError {
  return new ForbiddenError(messageKey).withReason('owner_membership_fixed');
}

/** The 400 on `former_owner_role_id` of an ownership transfer, with the given message key. */
function formerOwnerRoleError(options: {
  messageKey: string;
  messageParams?: Record<string, string>;
}): ValidationError {
  return new ValidationError(options.messageKey, options.messageParams, undefined, [
    {
      field: 'former_owner_role_id',
      messageKey: options.messageKey,
      ...(options.messageParams ? { messageParams: options.messageParams } : {}),
    },
  ]);
}

/**
 * The checks of an edit of a live member (T10, K3, sec-new-T1): their name follows their profile,
 * the owner's status is locked, working hours end after they start, and an invited member's status
 * moves only by accepting the invite. The owner's roles are checked once resolved
 * ({@link assertOwnerKeepsMainRole}).
 *
 * @remarks
 * - **Failure modes:** `ValidationError` on `display_name`, `work_ends_at`, `status`;
 *   `ForbiddenError` (`owner_membership_fixed`) for the owner's status.
 */
function assertLiveMembershipEdit(options: {
  parsed: UpdateMembershipInput;
  membership: { user_id: number; status: string; work_starts_at: string; work_ends_at: string };
  ownerUserId: number | null;
}): void {
  const { parsed, membership } = options;
  if (parsed.display_name !== undefined) {
    // K3: a live member's name follows their profile in every organization.
    throw new ValidationError(
      'errors:validation.membershipNameFollowsProfile',
      undefined,
      undefined,
      [{ field: 'display_name', messageKey: 'errors:validation.membershipNameFollowsProfile' }],
    );
  }
  /**
   * sec-new-T1: The organization owner's membership must not be modified by other members.
   * An Admin holding MEMBERSHIP_UPDATE could otherwise SUSPEND the owner, locking
   * them out of all RBAC-gated routes with no self-recovery path. The ownership
   * transfer endpoint is the correct mechanism for any ownership-adjacent change.
   */
  // The owner's staff profile (phone, tone, hours) and extra roles stay editable; their
  // status is locked, and so is their main role (assertOwnerKeepsMainRole).
  if (parsed.status !== undefined && options.ownerUserId === membership.user_id) {
    throw ownerMembershipFixedError('errors:ownerMembershipCannotBeModified');
  }
  // Working hours: the DTO checks both ends when both come; one end is checked against the row.
  const workStartsAt = parsed.work_starts_at ?? membership.work_starts_at.slice(0, 5);
  const workEndsAt = parsed.work_ends_at ?? membership.work_ends_at.slice(0, 5);
  if (workEndsAt <= workStartsAt) {
    throw new ValidationError('errors:validation.workEndsBeforeStarts', undefined, undefined, [
      { field: 'work_ends_at', messageKey: 'errors:validation.workEndsBeforeStarts' },
    ]);
  }
  // T10: status moves only between active and suspended — an invited member becomes active
  // only by accepting the invite.
  if (
    parsed.status !== undefined &&
    parsed.status !== membership.status &&
    membership.status === MEMBERSHIP_STATUS.INVITED
  ) {
    throw new ValidationError('errors:validation.membershipStatusMove', undefined, undefined, [
      { field: 'status', messageKey: 'errors:validation.membershipStatusMove' },
    ]);
  }
}

/**
 * The owner may hold extra roles (launch D81 (4) — the owner is often the clinic's doctor), but
 * their main role stays first: a `role_ids` whose first role is not the one they hold now is
 * refused, so the owner never loses the role that gives them the whole organization.
 *
 * @remarks
 * - **Failure modes:** `ForbiddenError` (`owner_membership_fixed`) when the main role would change.
 * - **Notes:** the grant guard still runs after it — the caller must hold every code of every role
 *   in the new set, so in practice the owner sets their own extra roles.
 */
function assertOwnerKeepsMainRole(options: {
  membership: { user_id: number; role_id: number };
  ownerUserId: number | null;
  mainRoleId: number | undefined;
}): void {
  if (options.ownerUserId !== options.membership.user_id) return;
  if (options.mainRoleId !== options.membership.role_id) {
    throw ownerMembershipFixedError('errors:ownerMembershipCannotBeModified');
  }
}

/**
 * Application service for organization memberships: list/get/create/update/
 * delete, plus self-service `leaveOrganization` and `transferOwnership`.
 *
 * @remarks
 * - **Algorithm:** every public method runs inside
 *   {@link withAppDatabaseContext} and resolves the caller's
 *   organization through
 *   {@link OrganizationService.requireOrganizationRecordByPublicId}
 *   before touching the membership repository. `transferOwnership` flips
 *   `owner_user_id` through {@link OrganizationService.transferOrganizationOwnership}
 *   and moves both people's main roles (the Owner role to the new owner, the
 *   former owner to Admin) in the same transaction.
 *   When a brand-new member is created, the service also pushes the
 *   organization's default locale onto the new user via
 *   {@link UserSettingsService.update} if the user is still on factory-default
 *   locale settings.
 * - **Failure modes:** `NotFoundError('Membership' | 'Organization' | 'Role' |
 *   'User')` for missing rows; `ForbiddenError('errors:ownerCannotLeave')` (`owner_cannot_leave`)
 *   when the organization owner tries to leave; `ForbiddenError` (`owner_membership_fixed`) for
 *   the owner's status, main role or removal;
 *   `ForbiddenError('errors:onlyOwnerCanTransfer')` for non-owner ownership
 *   transfers;
 *   `ValidationError` on `status` when a PATCH moves a status other than
 *   `active` ↔ `suspended` (T10 — `invited` → `active` only by accepting the invite);
 *   `ValidationError` from Zod-backed validators.
 * - **Side effects:** writes through `MembershipRepository` (insert / update /
 *   soft-delete with `deleted_at`); calls {@link invalidatePermissions} after
 *   every membership mutation that changes effective permissions (create,
 *   update, delete, leave, transfer) so the affected user's Redis permission cache is
 *   purged immediately instead of lingering for the cache TTL; updates
 *   {@link UserSettingsService} for locale defaults.
 * - **Notes:** `getPermissions` reads through
 *   {@link MemberRolePermissionService.listPermissionCodesForRole} so role
 *   permissions remain a single source of truth.
 */
export class MembershipService {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly memberRoleService: MemberRoleService,
    private readonly memberRolePermissionService: MemberRolePermissionService,
    private readonly membershipRepository: MembershipRepository,
    private readonly authorizationService: AuthorizationService,
    private readonly permissionRepository: PermissionRepository,
    private readonly organizationSettingsService?: OrganizationSettingsService,
    private readonly userSettingsService?: UserSettingsService,
    // reaudit-#7: optional so minimal test harnesses can omit it; the container always wires it.
    private readonly organizationApiKeyRepository?: OrganizationApiKeyRepository,
    // REQ-2: presigns the embedded member `avatar_url`; optional so minimal harnesses can omit it
    // (then the raw stored key is passed through). The container always wires the S3 adapter.
    private readonly objectStorage?: ObjectStoragePort,
    // REQ-1: add-member-by-email provisions/finds the invitee and issues the invitation. Optional so
    // minimal harnesses can omit them; the container always wires both. `create` requires them.
    private readonly userService?: UserService,
    private readonly membershipInvitationService?: MembershipInvitationService,
    // Launch ROUTE #4 (D5): the roles a person holds besides the main one.
    private readonly membershipAdditionalRolesRepository: MembershipAdditionalRolesRepository = new MembershipAdditionalRolesRepository(),
  ) {}

  /** The app domain's part of the leave step (launch K4); null in minimal test harnesses. */
  private leaveStep: MembershipLeavePort | null = null;

  /** Late-wires the app domain's part of the leave step; see {@link MembershipLeavePort}. */
  wireLeaveStep(leaveStep: MembershipLeavePort): void {
    this.leaveStep = leaveStep;
  }

  /**
   * The one leave step (launch K4): ends the membership with its reason, revokes the API keys the
   * person created here and lets the app clear what they do now and delete what is theirs alone —
   * the same for a removal, leaving and a deleted account. MUST run inside the organization's
   * database context, so all of it commits or rolls back together.
   *
   * @remarks
   * - **Algorithm:** the guarded soft delete first (it refuses the organization's owner); then the
   *   API keys; then {@link MembershipLeavePort.releaseEndedMembership}; then `membership.deleted`.
   * - **Failure modes:** returns null when the soft delete refused (the owner, or no live row) and
   *   then does nothing else — the caller surfaces the precise error.
   * - **Side effects:** writes `tenancy.memberships`, the organization's API keys and, through the
   *   port, the app's tables; one `membership.deleted` event (webhook fan-out). Permission caches
   *   and the seat sync are the caller's, after commit.
   */
  private async endMembershipInContext(options: {
    organization: SerializingOrganization & { id: number };
    membershipPublicId: string;
    reason: MembershipDeleteReason;
    note: string | null;
  }): Promise<MembershipRow | null> {
    const ended = await this.membershipRepository.softDelete(
      options.membershipPublicId,
      options.organization.id,
      { delete_reason: options.reason, delete_note: options.note },
    );
    if (!ended) return null;
    // reaudit-#7: revoke the departed member's API keys so they lose access too.
    await this.revokeApiKeysForDepartedMember({
      userId: ended.user_id,
      organizationId: options.organization.id,
    });
    await this.leaveStep?.releaseEndedMembership({
      organizationId: options.organization.id,
      membershipId: ended.id,
    });
    await this.emitMembershipEvents({
      type: MEMBERSHIP_EVENT.DELETED,
      memberships: [ended],
      organization: options.organization,
    });
    return ended;
  }

  /**
   * Resolves `role_ids` (main first) to live roles of the organization, in order.
   *
   * @remarks
   * - **Failure modes:** an id that is no live role here is a `ValidationError` on `role_ids`
   *   (400) — the list is the body, not the path.
   */
  private async resolveRoleIds({
    organizationId,
    rolePublicIds,
  }: {
    organizationId: number;
    rolePublicIds: readonly string[];
  }): Promise<ResolvedRole[]> {
    const resolved: ResolvedRole[] = [];
    for (const rolePublicId of rolePublicIds) {
      try {
        resolved.push(
          await this.memberRoleService.requireRoleRecordForOrganization({
            organization_id: organizationId,
            role_public_id: rolePublicId,
          }),
        );
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        throw new ValidationError(
          'errors:validation.membershipRoleNotFound',
          { role_id: rolePublicId },
          undefined,
          [{ field: 'role_ids', messageKey: 'errors:validation.membershipRoleNotFound' }],
        );
      }
    }
    return resolved;
  }

  /**
   * Privilege-escalation guard over every role being assigned: the caller must already hold each
   * permission the roles grant together (access is their union, D5).
   */
  private async assertCallerCanGrantRoles(options: {
    roleIds: readonly number[];
    callerUserPublicId: string | undefined;
    organizationPublicId: string;
  }): Promise<void> {
    const requestedPermissionCodes = new Set<string>();
    for (const roleId of options.roleIds) {
      for (const code of await this.memberRolePermissionService.listPermissionCodesForRole(
        roleId,
      )) {
        requestedPermissionCodes.add(code);
      }
    }
    await assertCallerCanGrantPermissionCodes({
      authorizationService: this.authorizationService,
      permissionRepository: this.permissionRepository,
      callerUserPublicId: options.callerUserPublicId,
      organizationPublicId: options.organizationPublicId,
      requestedPermissionCodes: [...requestedPermissionCodes],
    });
  }

  /**
   * Role ordering for update and delete: the caller must hold every permission the member's live
   * roles (main and additional) grant — see {@link assertCallerHoldsMemberPermissionCodes}.
   */
  private async assertCallerHoldsMemberPermissions(options: {
    organizationPublicId: string;
    membership: MembershipRow;
    callerUserPublicId: string | undefined;
    callerApiKeyScopes: readonly string[] | undefined;
  }): Promise<void> {
    const roleIds = [
      options.membership.role_id,
      ...(await this.membershipAdditionalRolesRepository.listRoleIdsForMembership(
        options.membership.id,
      )),
    ];
    const memberPermissionCodes = new Set<string>();
    for (const roleId of roleIds) {
      for (const code of await this.memberRolePermissionService.listPermissionCodesForRole(
        roleId,
      )) {
        memberPermissionCodes.add(code);
      }
    }
    await assertCallerHoldsMemberPermissionCodes({
      authorizationService: this.authorizationService,
      callerUserPublicId: options.callerUserPublicId,
      callerApiKeyScopes: options.callerApiKeyScopes,
      organizationPublicId: options.organizationPublicId,
      memberPermissionCodes: [...memberPermissionCodes],
    });
  }

  /** The staff profile columns of a create or update body (`commission_percent` as numeric text). */
  private toProfileData(
    parsed: Pick<
      UpdateMembershipInput,
      'phone' | 'tone' | 'working_days' | 'work_starts_at' | 'work_ends_at' | 'commission_percent'
    >,
  ): MembershipProfileData {
    return omitUndefined({
      phone: parsed.phone,
      tone: parsed.tone,
      working_days: parsed.working_days,
      work_starts_at: parsed.work_starts_at,
      work_ends_at: parsed.work_ends_at,
      commission_percent:
        parsed.commission_percent === undefined ? undefined : parsed.commission_percent.toFixed(2),
    });
  }

  /** Writes the additional roles of a membership just created or edited, when sent. */
  private async writeMembershipAccess(options: {
    organizationId: number;
    membershipId: number;
    additionalRoles: readonly ResolvedRole[] | undefined;
    actingUserId: number | null;
  }): Promise<void> {
    if (options.additionalRoles !== undefined) {
      await this.membershipAdditionalRolesRepository.replaceForMembership({
        membership_id: options.membershipId,
        organization_id: options.organizationId,
        role_ids: options.additionalRoles.map((role) => role.id),
        created_by_user_id: options.actingUserId,
      });
    }
  }

  /**
   * REQ-4 seat enforcement + Stripe seat-sync port, late-wired by the composition root.
   *
   * @remarks
   * billing (the entitlement module answers the locked seat ceiling, `SubscriptionService` enqueues
   * the Stripe quantity sync) itself depends on tenancy for `seats_used`, so the membership↔billing
   * relationship is a true cycle. It is broken by constructing both services, then setting this
   * field via {@link MembershipService.wireSeatEnforcement} — never a constructor param. Left
   * `null` in minimal test harnesses, where seat enforcement is simply skipped.
   */
  private seatEnforcement: MembershipSeatEnforcementPort | null = null;

  /** Late-wires the billing seat-enforcement port (REQ-4); see {@link seatEnforcement}. */
  wireSeatEnforcement(seatEnforcement: MembershipSeatEnforcementPort): void {
    this.seatEnforcement = seatEnforcement;
  }

  /**
   * Revokes every API key the departing member created in this organization (reaudit-#7), so a
   * removed/left member's keys lose access along with their session. Runs inside the caller's
   * organization DB context (RLS-scoped). Best-effort: skipped when the api-key repository is not
   * wired (minimal test harness).
   */
  private async revokeApiKeysForDepartedMember({
    userId,
    organizationId,
  }: {
    userId: number;
    organizationId: number;
  }): Promise<void> {
    if (!this.organizationApiKeyRepository) return;
    await this.organizationApiKeyRepository.revokeAllByCreatorInOrganization(
      organizationId,
      userId,
    );
  }

  /**
   * Enforces the plan seat limit before a member is added (REQ-4). MUST run inside the organization
   * transaction so the advisory lock (and the billing port's FOR UPDATE, when a subscription
   * exists) serializes concurrent adds. No-op when the seat-enforcement port is unwired (minimal
   * harness) or when the plan grants unlimited seats (`ceiling === null`). Throws the entitlement
   * module's refusal (`buildPlanRefusal`, change-plan-gates SE2: `409`
   * `errors:seatLimitReached`) with reason `seat_limit_reached` once
   * `used >= ceiling` (a seat is consumed by ACTIVE + INVITED memberships, so an outstanding invite
   * already counts and a burst of invites cannot overshoot the limit).
   *
   * @remarks
   * audit-#M1: the FOR UPDATE row lock only exists when the organization has an ACTIVE subscription. On the
   * free-tier / no-subscription branch the ceiling is a catalog value with no row to lock, so two
   * concurrent adds could both pass `used < ceiling` and overshoot a plan with `included_seats > 1`.
   * A per-organization advisory xact lock (`MEMBERSHIP_SEAT`) taken up front serializes the count+insert on
   * BOTH paths, independent of whether the free ceiling happens to be 1.
   */
  private async assertSeatAvailableForMemberAdd(organizationInternalId: number): Promise<void> {
    if (!this.seatEnforcement) return;
    // Serialize concurrent member-adds for this organization before the count so the free-tier path (no
    // FOR UPDATE row to lock) cannot race two inserts past the ceiling. Auto-released at COMMIT.
    await acquireResourceQuotaLock({
      namespace: RESOURCE_QUOTA_LOCK_NAMESPACE.MEMBERSHIP_SEAT,
      key: organizationInternalId,
    });
    const seatCeiling =
      await this.seatEnforcement.reserveSeatCeilingForMemberAdd(organizationInternalId);
    if (seatCeiling === null) return;
    const seatsUsed =
      await this.membershipRepository.countActiveByOrganization(organizationInternalId);
    if (seatsUsed >= seatCeiling) {
      throw buildPlanRefusal({ reason: 'seat_limit_reached', limit: seatCeiling, used: seatsUsed });
    }
  }

  /**
   * Best-effort enqueue of a Stripe seat-quantity reconciliation after a member add/remove (REQ-4).
   * Swallows when the port is unwired; the billing port itself swallows enqueue failures so member
   * management never fails on a Redis blip.
   */
  private enqueueSeatQuantitySync(organizationPublicId: string): void {
    if (!this.seatEnforcement) return;
    try {
      this.seatEnforcement.enqueueSeatQuantitySync({
        organization_public_id: organizationPublicId,
      });
    } catch (error) {
      logger.warn({ error, organizationPublicId }, 'membership.seat_sync.enqueue_failed');
    }
  }

  private async invalidatePermissionsForMembership({
    user_internal_id,
    organization_public_id,
  }: {
    user_internal_id: number;
    organization_public_id: string;
  }): Promise<void> {
    const userPublicId =
      await this.organizationService.resolveUserPublicIdByInternalId(user_internal_id);
    if (userPublicId) {
      await invalidatePermissions({ userId: userPublicId, organizationId: organization_public_id });
    }
  }

  private async applyOrganizationLocaleDefaults({
    userPublicId,
    organizationPublicId,
  }: {
    userPublicId: string;
    organizationPublicId: string;
  }): Promise<void> {
    if (!(this.organizationSettingsService && this.userSettingsService)) return;
    const currentSettings = await this.userSettingsService.getForInvitedUser(userPublicId);
    if (!isFactoryDefaultUserLocaleSettings(currentSettings)) return;
    const defaultLocale =
      await this.organizationSettingsService.resolveDefaultLocaleForOrganization(
        organizationPublicId,
      );
    await this.userSettingsService.updateForInvitedUser({
      user_public_id: userPublicId,
      body: {
        language: defaultLocale,
        preferred_locales: preferredLocalesForOrganizationDefaultLocale(defaultLocale),
      },
    });
  }

  /**
   * Resolves membership public ids (`mem_…`) of one organization to their internal ids, inside the
   * CALLER's database context — for another domain storing a membership foreign key.
   *
   * @remarks
   * - **Algorithm:** one `IN` lookup over the live memberships of `organizationId`; duplicates in
   *   the input collapse.
   * - **Failure modes:** none raised — an unknown, deleted or foreign id is simply absent from the
   *   map, so the caller decides the error (it knows the field the id came from).
   * - **Side effects:** none; runs on the ambient `withAppDatabaseContext` handle, so call it only
   *   from inside the caller's context.
   */
  async resolveMembershipIdsByPublicIds(options: {
    organizationId: number;
    membershipPublicIds: readonly string[];
  }): Promise<Map<string, number>> {
    const rows = await this.membershipRepository.findIdsByPublicIds(options.organizationId, [
      ...new Set(options.membershipPublicIds),
    ]);
    return new Map(rows.map((row) => [row.public_id, row.id]));
  }

  /**
   * Resolves user summaries, the main role's public id, the extra roles and (for
   * live `invited` rows) the pending invitation for a page of memberships, and serializes them. The
   * internal `user_id`/`role_id` are never emitted; user summaries go through the SECURITY DEFINER
   * resolver (auth.users is FORCE RLS and unreachable by a plain join under organization-only
   * context), and each distinct avatar key is presigned for read. `is_owner` comes from the
   * organization's `owner_user_id` (launch D81 (4)).
   */
  private async serializeMemberships(options: {
    rows: MembershipRow[];
    organization: SerializingOrganization;
  }): Promise<MembershipOutput[]> {
    const { rows, organization } = options;
    if (rows.length === 0) return [];
    const membershipIds = rows.map((row) => row.id);
    const [userSummaryRows, roleSummaryRows, invitationRows, additionalRoleIds] = await Promise.all(
      [
        this.membershipRepository.resolveUserSummariesByInternalIds(rows.map((row) => row.user_id)),
        this.membershipRepository.resolveRoleSummariesByInternalIds(rows.map((row) => row.role_id)),
        this.membershipRepository.resolveLiveInvitationsByMembershipIds(
          rows
            .filter((row) => row.status === MEMBERSHIP_STATUS.INVITED && row.deleted_at === null)
            .map((row) => row.id),
        ),
        this.membershipAdditionalRolesRepository.listRolePublicIdsByMembershipIds(membershipIds),
      ],
    );
    const userSummaries = new Map<number, MembershipUserSummary>();
    for (const [userInternalId, row] of userSummaryRows) {
      userSummaries.set(userInternalId, {
        id: row.public_id,
        email: row.email,
        first_name: row.first_name,
        last_name: row.last_name,
        // Presign the raw avatar key for read (network-free signature); pass through when no
        // object-storage adapter is wired (minimal test harness).
        avatar_url: this.objectStorage
          ? await resolveStoredMediaReadUrl({
              objectStorage: this.objectStorage,
              storedValue: row.avatar_url,
            })
          : row.avatar_url,
      });
    }
    return rows.map((row) => {
      const user: MembershipUserSummary = userSummaries.get(row.user_id) ?? {
        id: String(row.user_id),
        email: '',
        first_name: null,
        last_name: null,
        avatar_url: null,
      };
      const mainRolePublicId = roleSummaryRows.get(row.role_id)?.public_id ?? String(row.role_id);
      const access: MembershipAccessRefs = {
        role_ids: [mainRolePublicId, ...(additionalRoleIds.get(row.id) ?? [])],
      };
      return serializeMembership({
        row,
        organization_public_id: organization.public_id,
        user,
        invitation: invitationRows.get(row.id) ?? null,
        access,
        is_owner: row.user_id === organization.owner_user_id,
      });
    });
  }

  private async resolveAndSerializeMembership(options: {
    membership: MembershipRow;
    organization: SerializingOrganization;
  }): Promise<MembershipOutput> {
    const [output] = await this.serializeMemberships({
      rows: [options.membership],
      organization: options.organization,
    });
    return output!;
  }

  /**
   * Emits a membership resource event per row, each with the membership's public JSON.
   *
   * @remarks
   * - **Algorithm:** serializes the rows in one batch ({@link serializeMemberships}), then emits
   *   one {@link MEMBERSHIP_EVENT} per membership.
   * - **Failure modes:** a serialization read failure propagates (it runs in the caller's
   *   transaction); handler failures are swallowed by the bus.
   * - **Side effects:** the notify handler records PENDING webhook delivery attempts.
   * - **Notes:** call it inside the write's organization database context, so the fan-out joins its
   *   transaction. Public because {@link MembershipInvitationService} (accept) changes memberships
   *   too and emits through it.
   */
  async emitMembershipEvents(options: {
    type: MembershipEventType;
    memberships: MembershipRow[];
    organization: SerializingOrganization;
  }): Promise<MembershipOutput[]> {
    const outputs = await this.serializeMemberships({
      rows: options.memberships,
      organization: options.organization,
    });
    for (const output of outputs) {
      await eventBus.emit(
        buildDomainEvent<OrganizationResourceEventPayload>({
          type: options.type,
          payload: {
            organization_public_id: options.organization.public_id,
            data: { ...output },
          },
        }),
      );
    }
    return outputs;
  }

  /** {@link emitMembershipNotice} for a role change — only when the main role moved on a joined member. */
  private async emitMainRoleChangedNotice(options: {
    before: MembershipRow;
    after: MembershipRow;
    organization: SerializingOrganization & { id: number; name: string };
    actingUserId: number | null;
  }): Promise<void> {
    if (
      options.after.role_id === options.before.role_id ||
      options.after.status === MEMBERSHIP_STATUS.INVITED
    ) {
      return;
    }
    await this.emitMembershipNotice({
      notice: { type: 'role_changed', previousRoleId: options.before.role_id },
      membership: options.after,
      organization: options.organization,
      actingUserId: options.actingUserId,
    });
  }

  /**
   * Tells the people concerned that a live member's main role changed or that a manager removed
   * them (feat-instagram-dm-sending UN8, UNC6) — the notify domain sends `membership.role_changed` /
   * `membership.removed` to the `membership:update` holders and the member, minus `actingUserId`.
   *
   * @remarks
   * - **Algorithm:** inside the write's organization context: the recipients, the role names (a
   *   role change), the organization's language; one {@link MEMBERSHIP_NOTICE_EVENT} emitted with
   *   them. The once key is the membership's public id with its `updated_at` (a role change) or
   *   `removed` (a removal).
   * - **Failure modes:** none escape — a failure is logged and the write stands (the bus swallows
   *   handler errors; the reads here are wrapped).
   * - **Side effects:** one in-process event; the notify handler writes the notifications in this
   *   unit.
   * - **Notes:** an invited member (never joined) gets no notice. The kind's recipients resolver
   *   (`resolveNotificationRecipients`, ROUTE R34) may take this over later.
   */
  private async emitMembershipNotice(options: {
    notice: { type: 'role_changed'; previousRoleId: number } | { type: 'removed' };
    membership: MembershipRow;
    organization: SerializingOrganization & { id: number; name: string };
    actingUserId: number | null;
  }): Promise<void> {
    const { membership, organization } = options;
    try {
      const managerUserIds = await this.membershipRepository.findUserIdsWithPermission(
        organization.id,
        TENANCY_PERMISSIONS.MEMBERSHIP_UPDATE,
      );
      const recipientUserIds = [...new Set([...managerUserIds, membership.user_id])].filter(
        (userId) => userId !== options.actingUserId,
      );
      if (recipientUserIds.length === 0) return;
      const [output] = await this.serializeMemberships({ rows: [membership], organization });
      const base = {
        recipient_user_ids: recipientUserIds,
        organization_id: organization.id,
        organization_name: organization.name,
        membership_public_id: membership.public_id,
        member_name: output?.display_name ?? '',
        locale:
          (await this.organizationSettingsService?.resolveDefaultLocaleForOrganization(
            organization.public_id,
          )) ?? DEFAULT_LANGUAGE,
      };
      if (options.notice.type === 'removed') {
        await eventBus.emit(
          buildDomainEvent({
            type: MEMBERSHIP_NOTICE_EVENT.REMOVED,
            payload: {
              ...base,
              dedupe_key: `${membership.public_id}:removed`,
            } satisfies MembershipRemovedPayload,
          }),
        );
        return;
      }
      const [role, previousRole] = await Promise.all([
        this.memberRoleService.findRoleRecordByInternalId({
          organization_id: organization.id,
          role_internal_id: membership.role_id,
        }),
        this.memberRoleService.findRoleRecordByInternalId({
          organization_id: organization.id,
          role_internal_id: options.notice.previousRoleId,
        }),
      ]);
      await eventBus.emit(
        buildDomainEvent({
          type: MEMBERSHIP_NOTICE_EVENT.ROLE_CHANGED,
          payload: {
            ...base,
            role_name: role?.name ?? '',
            previous_role_name: previousRole?.name ?? '',
            dedupe_key: `${membership.public_id}:${membership.updated_at.toISOString()}`,
          } satisfies MembershipRoleChangedPayload,
        }),
      );
    } catch (error) {
      logger.error(
        { err: error, membershipPublicId: membership.public_id, notice: options.notice.type },
        'membership.notice.failed',
      );
    }
  }

  /**
   * Turns a role named by public id into the list filter; `null` when it is not of this
   * organization — the list is then empty, never a 400 (a filter, not a write).
   */
  private async resolveListFilters(options: {
    organizationId: number;
    rolePublicId: string | undefined;
  }): Promise<Pick<MembershipListQuery, 'roleId'> | null> {
    const filters: Pick<MembershipListQuery, 'roleId'> = {};
    if (options.rolePublicId !== undefined) {
      try {
        const role = await this.memberRoleService.requireRoleRecordForOrganization({
          organization_id: options.organizationId,
          role_public_id: options.rolePublicId,
        });
        filters.roleId = role.id;
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    }
    return filters;
  }

  /**
   * The team list (launch §2.B route 2): every status, filtered by `status`, `role_id` and `q`; ended members with `include_ended=true` (D58); the capped total on
   * the first page; and `counts_by_role` — live members per main role, Owner first, whatever the
   * filters (feat-instagram-dm-sending TN9, route 116).
   */
  async list({ scope, query }: { scope: OrganizationPrincipalDatabaseScope; query: unknown }) {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateListMembershipsQuery(query);
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationRecordByPublicId(
            organization_public_id,
          );
        const counts_by_role: MembershipRoleCount[] = (
          await this.membershipRepository.countLiveByMainRole(organization.id)
        ).map((row) => ({ role_id: row.role_public_id, name: row.name, count: row.count }));
        const filters = await this.resolveListFilters({
          organizationId: organization.id,
          rolePublicId: parsed.role_id,
        });
        if (filters === null) {
          return {
            items: [],
            total: 0,
            limit: parsed.limit,
            has_more: false,
            next_cursor: null,
            counts_by_role,
          };
        }
        const result = await this.membershipRepository.list(organization.id, {
          ...filters,
          after: parsed.after,
          limit: parsed.limit,
          q: parsed.q,
          sort: parsed.sort,
          order: parsed.order,
          statuses: parsed.status === undefined ? undefined : [parsed.status],
          includeEnded: parsed.include_ended === 'true',
          withTotal: true,
        });
        return {
          ...result,
          // Batch-resolve user + role summaries + live invitations for the page (no N+1).
          items: await this.serializeMemberships({ rows: result.items, organization }),
          counts_by_role,
        };
      },
    });
  }

  /**
   * The member directory behind the app's team picker (launch §2.A route 1, K5): live active
   * members by name; with `includeEnded`, every membership of the organization — any status, live
   * or ended — so an id a record holds always resolves to a name.
   *
   * @remarks
   * - **Algorithm:** the same keyset list as {@link MembershipService.list}, sorted by
   *   `display_name`; an unknown role is an empty page; `holdsPermissionCode` keeps the
   *   members one of whose live roles grants it (T8 — e.g. who can be given a task).
   * - **Failure modes:** none beyond the query.
   */
  async listDirectory({
    scope,
    query,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    query: MembershipDirectoryQuery;
  }) {
    const organization_public_id = scope.organizationPublicId;
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationRecordByPublicId(
            organization_public_id,
          );
        const filters = await this.resolveListFilters({
          organizationId: organization.id,
          rolePublicId: query.rolePublicId,
        });
        if (filters === null) {
          return { items: [], total: null, limit: query.limit, has_more: false, next_cursor: null };
        }
        const result = await this.membershipRepository.list(organization.id, {
          ...filters,
          after: query.after,
          limit: query.limit,
          q: query.q,
          sort: 'name',
          order: 'asc',
          publicIds: query.publicIds,
          holdsPermissionCode: query.holdsPermissionCode,
          statuses: query.includeEnded ? undefined : [MEMBERSHIP_STATUS.ACTIVE],
          includeEnded: query.includeEnded,
        });
        return {
          ...result,
          items: await this.serializeMemberships({ rows: result.items, organization }),
        };
      },
    });
  }

  /** One member, live or ended (launch D58); 404 when not of this organization. */
  async getByPublicId({
    scope,
    membership_public_id,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    membership_public_id: string;
  }): Promise<MembershipOutput> {
    const organization_public_id = scope.organizationPublicId;
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationRecordByPublicId(
            organization_public_id,
          );
        const membership = await this.membershipRepository.findAnyByPublicId(
          membership_public_id,
          organization.id,
        );
        if (!membership) throw new NotFoundError('Membership');
        return this.resolveAndSerializeMembership({ membership, organization });
      },
    });
  }

  /** Refuses the Owner role (the owner's main role) in `role_ids`: a 400 on `role_ids` (§ 9.C.9). */
  private async assertNotOwnerRole(options: {
    organization: OrganizationMembershipContext;
    roleIds: readonly number[];
  }): Promise<void> {
    const ownerMembership = await this.membershipRepository.findByUserAndOrganization(
      options.organization.owner_user_id,
      options.organization.id,
    );
    if (ownerMembership && options.roleIds.includes(ownerMembership.role_id)) {
      throw new ValidationError('errors:validation.inviteOwnerRole', undefined, undefined, [
        { field: 'role_ids', messageKey: 'errors:validation.inviteOwnerRole' },
      ]);
    }
  }

  /**
   * The role checks of a member add — a TEAM organization, `role_ids` that are live roles here
   * (main first, D5) and allowed while custom roles are off, the caller holding every code they
   * grant. MUST run inside the organization's database context. The invite runs it once for the
   * whole request (with the Owner-role refusal); each address's add runs it again with the seat
   * check.
   */
  private async assertMemberRolesGrantable(options: {
    organizationPublicId: string;
    rolePublicIds: readonly string[];
    invitedByUserPublicId: string | undefined;
  }): Promise<{
    organization: OrganizationMembershipContext;
    role: ResolvedRole;
    additionalRoles: ResolvedRole[];
  }> {
    const organization = await this.organizationService.requireOrganizationRecordByPublicId(
      options.organizationPublicId,
    );
    // Capability matrix: a PERSONAL organization is single-member by definition. Collaboration
    // requires a TEAM organization — reject here so the single-member invariant holds at every door.
    assertTeamOrganization({ organization, capability: 'MEMBERS' });
    // `role_ids`, main first (D5): the main role is the membership's `role_id`, the rest are
    // its additional roles.
    const roles = await this.resolveRoleIds({
      organizationId: organization.id,
      rolePublicIds: options.rolePublicIds,
    });
    // TN3: one system role while custom roles are off (403 custom_roles_off).
    assertMembershipRolesAllowed({ roles });
    const [role, ...additionalRoles] = roles;
    if (!role) throw new ValidationError('errors:invalidInput');
    const roleIds = roles.map((resolved) => resolved.id);
    // Privilege-escalation guard: the caller must already hold every permission the assigned roles
    // would grant, or a MEMBERSHIP_CREATE holder could mint an Admin membership for a throwaway
    // address and accept it → full organization takeover. Runs BEFORE any row is persisted.
    await this.assertCallerCanGrantRoles({
      roleIds,
      callerUserPublicId: options.invitedByUserPublicId,
      organizationPublicId: options.organizationPublicId,
    });
    return { organization, role, additionalRoles };
  }

  /**
   * The checks a member add must pass, in order — a TEAM organization, `role_ids` that are live roles
   * here (main first, D5), the caller holding every code those roles grant, and a free seat — and
   * what passed them. MUST run inside the organization's database context; the seat check takes the
   * per-organization seat lock, held until that context commits.
   *
   * @remarks
   * - **Failure modes:** `UnprocessableEntityError` for a PERSONAL organization; `ValidationError` on
   *   `role_ids`; `ForbiddenError` (`custom_roles_off` — more than one role, or a custom one, while
   *   custom roles are off; `cannotGrantPermissionNotHeld`); `ConflictError`
   *   (`seat_limit_reached`).
   */
  private async assertMemberAddAllowed(options: {
    organizationPublicId: string;
    rolePublicIds: readonly string[];
    invitedByUserPublicId: string | undefined;
  }): Promise<{
    organization: OrganizationMembershipContext;
    role: ResolvedRole;
    additionalRoles: ResolvedRole[];
  }> {
    const allowed = await this.assertMemberRolesGrantable(options);
    // REQ-4: enforce the plan seat limit before persisting the new membership. Runs INSIDE the
    // caller's organization transaction so the per-organization advisory lock (plus the FOR UPDATE
    // row lock when a subscription exists) serializes concurrent adds — two simultaneous adds cannot
    // both pass the same count and exceed the limit, on the paid OR the free-tier path (audit-#M1).
    // Ceiling of null (unlimited plan / unwired port) is a no-op.
    await this.assertSeatAvailableForMemberAdd(allowed.organization.id);
    return allowed;
  }

  /**
   * Invites one address (one line of {@link MembershipService.invite}): provisions or finds the
   * login, creates (or revives, K7) an `invited` membership with the given role and emails its
   * invitation.
   *
   * @remarks
   * - **Algorithm:** the add checks in a short unit of work first (team, roles, the grant guard, a
   *   free seat — B2-7), then the login in its own transaction, then the membership,
   *   the invitation and the events in the organization's unit of work. After commit: the
   *   permission cache and the Stripe seat quantity.
   * - **Failure modes:** `ValidationError` (`disposable_email`, `role_ids`); `ForbiddenError`
   *   (`custom_roles_off`, a code the caller does not hold); `UnprocessableEntityError` (a personal
   *   organization); `ConflictError` (`membership_already_exists` — a live membership of the login,
   *   `seat_limit_reached`); `NotFoundError('User')` for an unknown inviter.
   * - **Side effects:** may create a login; writes the membership and invitation; emails the token.
   */
  async create({
    scope,
    body,
    invited_by_user_public_id,
    options,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    body: MembershipInviteeInput;
    invited_by_user_public_id: string | undefined;
    options?: { requestId?: string } | undefined;
  }): Promise<MembershipOutput> {
    const organization_public_id = scope.organizationPublicId;
    const parsed = {
      ...body,
      expires_in_days: body.expires_in_days ?? DEFAULT_INVITE_EXPIRES_IN_DAYS,
    };
    const userService = this.userService;
    const membershipInvitationService = this.membershipInvitationService;
    if (!(userService && membershipInvitationService)) {
      throw new ConfigurationError(
        'UserService and MembershipInvitationService must be wired on MembershipService (tenancy.container).',
      );
    }
    // Block disposable invitee addresses up front (no DB/context needed) — mirrors the prior
    // invitation-create guard now that the email enters at the membership door.
    if (isDisposableEmailBlocked(parsed.email)) {
      throw new ValidationError('errors:disposableEmail', undefined, undefined, [
        { field: 'email', messageKey: 'errors:disposableEmail' },
      ]).withReason('disposable_email');
    }
    // B2-7: every check that can refuse the add (team organization, roles, the grant guard, a free
    // seat) runs first, in a short unit of work of its own — a refused invite never provisions a
    // login for the address. They run again inside the write below, which holds the seat lock.
    await withAppDatabaseContext({
      scope,
      callback: () =>
        this.assertMemberAddAllowed({
          organizationPublicId: organization_public_id,
          rolePublicIds: parsed.role_ids,
          invitedByUserPublicId: invited_by_user_public_id,
        }),
    });
    // Provision/find the invitee in its OWN transaction (BEFORE the organization context) so the public-id
    // collision retry can open fresh transactions — a pinned organization transaction would abort on retry.
    // A user left with no membership by a later failure (a race past the checks above) is harmless and
    // reused on the next attempt.
    const inviteeUser = await userService.findOrCreateInvitedByEmail({
      email: parsed.email,
    });
    const result = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const { organization, role, additionalRoles } = await this.assertMemberAddAllowed({
          organizationPublicId: organization_public_id,
          rolePublicIds: parsed.role_ids,
          invitedByUserPublicId: invited_by_user_public_id,
        });
        const inviterId =
          await this.organizationService.resolveUserInternalIdByPublicId(invited_by_user_public_id);
        if (inviterId === null) throw new NotFoundError('User');
        let created: MembershipRow;
        try {
          // K7 / KC6: the same login added again gets its ended membership back — same id, staff
          // number and history, invited again — instead of a new row. A different login is always a
          // new member (an email can pass to another person).
          const ended = await this.membershipRepository.findLatestEndedForUser({
            userId: inviteeUser.id,
            organizationId: organization.id,
          });
          const revived = ended
            ? await this.membershipRepository.reviveAsInvited({
                id: ended.id,
                organizationId: organization.id,
                roleId: role.id,
                invitedByUserId: inviterId,
                profile: {},
              })
            : null;
          created =
            revived ??
            (await this.membershipRepository.create({
              organization_id: organization.id,
              user_id: inviteeUser.id,
              role_id: role.id,
              status: MEMBERSHIP_STATUS.INVITED,
              invited_by_user_id: inviterId,
              created_by_user_id: inviterId,
              profile: {},
            }));
        } catch (error) {
          // The invitee already belongs to this organization (idx_memberships_user_org_unique) —
          // surface a clean 409 instead of an unhandled unique_violation 500. Covers an existing
          // active member and a still-live invited one (the FE resends in that case).
          if (isPostgresUniqueViolation(error)) {
            throw new ConflictError('errors:membershipAlreadyExists').withReason(
              'membership_already_exists',
            );
          }
          throw error;
        }
        await this.writeMembershipAccess({
          organizationId: organization.id,
          membershipId: created.id,
          additionalRoles,
          actingUserId: inviterId,
        });
        // Issue the invitation (token + email) in this same organization transaction.
        const issuedInvitation = await membershipInvitationService.createForMembership({
          organization_name: organization.name ?? organization.public_id,
          organization_id: organization.id,
          membership_id: created.id,
          membership_public_id: created.public_id,
          email: inviteeUser.email,
          expires_in_days: parsed.expires_in_days,
          invited_by_user_id: inviterId,
          organization_public_id,
          ...(options?.requestId !== undefined ? { requestId: options.requestId } : {}),
        });
        await this.applyOrganizationLocaleDefaults({
          userPublicId: inviteeUser.public_id,
          organizationPublicId: organization_public_id,
        });
        const [output] = await this.emitMembershipEvents({
          type: MEMBERSHIP_EVENT.CREATED,
          memberships: [created],
          organization,
        });
        // ROUTE #164: the dev-only accept-token echo rides on the embedded invitation (flag off → none).
        return attachInvitationTokenEcho({ membership: output!, issued: issuedInvitation });
      },
    });
    // sec-R11: invalidate the invitee's cached permissions AFTER the organization transaction commits.
    // Doing it pre-commit left a race where a concurrent recompute re-cached the stale set.
    await invalidatePermissions({
      userId: inviteeUser.public_id,
      organizationId: organization_public_id,
    });
    // REQ-4: the seat count just grew — reconcile the Stripe subscription quantity out-of-band.
    // Enqueued AFTER the organization transaction commits so the worker re-reads the new count. Best-effort.
    this.enqueueSeatQuantitySync(organization_public_id);
    return result;
  }

  /**
   * The "Invite" action (feat-instagram-dm-sending route 117, TN10, P82): 1–20 addresses with one
   * role, one line per address.
   *
   * @remarks
   * - **Algorithm:** validate the body; fold repeats (the addresses are already trimmed and
   *   lower-cased); refuse the whole invite up front when the role cannot be given (a team
   *   organization, one live system role — not the Owner role — the caller holding its codes); then
   *   each address in order, each in its own unit of work: not an email we accept →
   *   `invalid_email`; a live membership of that login → `already_member` (or `already_invited`
   *   while it is `invited`); else {@link MembershipService.create} → `invited`. A membership a
   *   concurrent request created between the read and the write is read again and classified.
   * - **Failure modes:** `ValidationError` (`emails`, `role_ids`), `ForbiddenError`
   *   (`custom_roles_off`, `cannotGrantPermissionNotHeld`), `UnprocessableEntityError` (personal
   *   organization) — before any address is touched; `ConflictError` `seat_limit_reached` from an
   *   address (unreachable while plans carry no seats, TN4) ends the request after the lines before
   *   it were committed — a retry with the same key re-runs and answers those `already_invited`.
   * - **Side effects:** per `invited` address, as {@link MembershipService.create}.
   */
  async invite({
    scope,
    body,
    invited_by_user_public_id,
    options,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    body: unknown;
    invited_by_user_public_id: string | undefined;
    options?: { requestId?: string } | undefined;
  }): Promise<MembershipInviteResultWithInvited> {
    const parsed = validateCreateMembership(body);
    const userService = this.userService;
    if (!userService) {
      throw new ConfigurationError(
        'UserService must be wired on MembershipService (tenancy.container).',
      );
    }
    const organization = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const allowed = await this.assertMemberRolesGrantable({
          organizationPublicId: scope.organizationPublicId,
          rolePublicIds: parsed.role_ids,
          invitedByUserPublicId: invited_by_user_public_id,
        });
        // § 9.C.9: the Owner role is never given by an invite — ownership passes only by transfer.
        await this.assertNotOwnerRole({
          organization: allowed.organization,
          roleIds: [allowed.role.id, ...allowed.additionalRoles.map((extra) => extra.id)],
        });
        return allowed.organization;
      },
    });
    const results: MembershipInviteLine[] = [];
    const invited: MembershipOutput[] = [];
    for (const email of [...new Set(parsed.emails)]) {
      if (!isInvitableEmail(email) || isDisposableEmailBlocked(email)) {
        results.push({
          email,
          result: MEMBERSHIP_INVITE_RESULT.INVALID_EMAIL,
          membership_id: null,
        });
        continue;
      }
      const existing = await this.classifyExistingInvitee({ scope, organization, email });
      if (existing) {
        results.push(existing);
        continue;
      }
      try {
        const membership = await this.create({
          scope,
          body: { email, role_ids: parsed.role_ids, expires_in_days: parsed.expires_in_days },
          invited_by_user_public_id,
          options,
        });
        invited.push(membership);
        const echoedToken = membership.invitation?.debug_invitation_token;
        results.push({
          email,
          result: MEMBERSHIP_INVITE_RESULT.INVITED,
          membership_id: membership.id,
          ...(echoedToken === undefined ? {} : { debug_invitation_token: echoedToken }),
        });
      } catch (error) {
        if (!(error instanceof ConflictError && error.reason === 'membership_already_exists')) {
          throw error;
        }
        results.push(
          (await this.classifyExistingInvitee({ scope, organization, email })) ?? {
            email,
            result: MEMBERSHIP_INVITE_RESULT.ALREADY_INVITED,
            membership_id: null,
          },
        );
      }
    }
    return {
      output: {
        results,
        invited_count: results.filter((line) => line.result === MEMBERSHIP_INVITE_RESULT.INVITED)
          .length,
      },
      invited,
    };
  }

  /**
   * The invite line of an address whose login already holds a live membership here:
   * `already_invited` while it is `invited`, else `already_member` with its id; `null` when the
   * address has no login or the login no live membership.
   */
  private async classifyExistingInvitee(options: {
    scope: OrganizationPrincipalDatabaseScope;
    organization: OrganizationMembershipContext;
    email: string;
  }): Promise<MembershipInviteLine | null> {
    const user = await this.userService?.findByEmail(options.email);
    if (!user || user.deleted_at) return null;
    const membership = await withAppDatabaseContext({
      scope: options.scope,
      callback: () =>
        this.membershipRepository.findByUserAndOrganization(user.id, options.organization.id),
    });
    if (!membership) return null;
    return membership.status === MEMBERSHIP_STATUS.INVITED
      ? {
          email: options.email,
          result: MEMBERSHIP_INVITE_RESULT.ALREADY_INVITED,
          membership_id: null,
        }
      : {
          email: options.email,
          result: MEMBERSHIP_INVITE_RESULT.ALREADY_MEMBER,
          membership_id: membership.public_id,
        };
  }

  /**
   * Changes a member (launch §2.B route 5): a live member's status (`active` ↔ `suspended`, T10),
   * roles and staff profile; an ended member's `display_name` only (K6, D58).
   *
   * @remarks
   * - **Algorithm:** inside the organization context — the member (live or ended, 404 otherwise);
   *   `expected_updated_at` (T14); an ended member → rename; a live one → the owner guard (status;
   *   the owner may hold extra roles, but their main role stays first — D81 (4)), the status move,
   *   the seat check on reactivation, the role grant guard, then the write and the access lists.
   *   After commit: the permission cache and, when a seat changed, the Stripe quantity.
   * - **Failure modes:** `NotFoundError('Membership')`; `ValidationError` on `display_name` (a live
   *   member's name follows the profile), `membership_ended` (anything but a rename on an ended
   *   member), `status` (a move other than `active` ↔ `suspended`), `work_ends_at`, `role_ids`;
   *   `ForbiddenError` (`owner_membership_fixed`) for the owner's status or main role
   *   and for a code the caller does not hold; `ConflictError` `record_changed` and
   *   `seat_limit_reached`.
   */
  async update({
    scope,
    membership_public_id,
    body,
    updated_by_user_public_id,
    options,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    membership_public_id: string;
    body: unknown;
    updated_by_user_public_id: string | undefined;
    options?: MembershipActionOptions | undefined;
  }): Promise<MembershipOutput> {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateUpdateMembership(body);
    let affectedUserInternalId: number | undefined;
    let seatUsageChanged = false;
    const result = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationRecordByPublicId(
            organization_public_id,
          );
        const membership = await this.membershipRepository.findAnyByPublicId(
          membership_public_id,
          organization.id,
        );
        if (!membership) throw new NotFoundError('Membership');
        // T14 / D43: a save based on an older version is refused with who and when.
        await assertRecordNotChangedSince({
          row: membership,
          expected: parsed.expected_updated_at,
          resolveUserPublicId: (userInternalId) =>
            this.organizationService.resolveUserPublicIdByInternalId(userInternalId),
        });
        const userId =
          await this.organizationService.resolveUserInternalIdByPublicId(updated_by_user_public_id);
        if (membership.deleted_at !== null) {
          return this.renameEndedMembership({
            membership,
            parsed,
            organization,
            updatedByUserId: userId ?? null,
          });
        }
        assertLiveMembershipEdit({ parsed, membership, ownerUserId: organization.owner_user_id });
        // The roles asked for, main first (D5). The owner's main role is fixed whoever asks (D81 (4)),
        // so that refusal comes before role ordering and names the owner, not the caller's codes.
        const roles =
          parsed.role_ids === undefined
            ? undefined
            : await this.resolveRoleIds({
                organizationId: organization.id,
                rolePublicIds: parsed.role_ids,
              });
        if (roles !== undefined) {
          // TN3: one system role while custom roles are off (403 custom_roles_off).
          assertMembershipRolesAllowed({ roles });
          assertOwnerKeepsMainRole({
            membership,
            ownerUserId: organization.owner_user_id,
            mainRoleId: roles[0]?.id,
          });
        }
        // Role ordering: only a caller holding every permission of the member's roles changes them.
        await this.assertCallerHoldsMemberPermissions({
          organizationPublicId: organization_public_id,
          membership,
          callerUserPublicId: updated_by_user_public_id,
          callerApiKeyScopes: options?.callerApiKeyScopes,
        });
        /**
         * F1: reactivating a suspended member re-consumes a seat — suspended memberships are NOT
         * counted toward the cap, so a `suspended -> active` transition adds one to the live seat
         * count. Without this check, suspend → add-a-new-member-into-the-freed-slot → reactivate
         * overshoots the plan's seat ceiling unbounded. Run the same seat-availability check as
         * `create`, inside this organization transaction so the subscription `FOR UPDATE` lock serializes it.
         */
        if (
          parsed.status === MEMBERSHIP_STATUS.ACTIVE &&
          membership.status !== MEMBERSHIP_STATUS.ACTIVE
        ) {
          await this.assertSeatAvailableForMemberAdd(organization.id);
        }
        let roleInternalId: number | undefined;
        let additionalRoles: ResolvedRole[] | undefined;
        if (roles !== undefined) {
          // REQ-3: the same privilege-escalation guard as create — a caller must already hold every
          // permission the roles grant together, so a MEMBERSHIP_UPDATE holder cannot escalate a
          // member past their own access.
          await this.assertCallerCanGrantRoles({
            roleIds: roles.map((resolved) => resolved.id),
            callerUserPublicId: updated_by_user_public_id,
            organizationPublicId: organization_public_id,
          });
          const [mainRole, ...rest] = roles;
          roleInternalId = mainRole?.id;
          additionalRoles = rest;
        }
        const updated = await this.membershipRepository.update(
          membership_public_id,
          organization.id,
          omitUndefined({
            status: parsed.status,
            role_id: roleInternalId,
            profile: this.toProfileData(parsed),
          }),
          userId ?? null,
        );
        if (!updated) throw new NotFoundError('Membership');
        await this.writeMembershipAccess({
          organizationId: organization.id,
          membershipId: updated.id,
          additionalRoles,
          actingUserId: userId ?? null,
        });
        affectedUserInternalId = updated.user_id;
        // REQ-4: suspended does not occupy a seat, so crossing that line in either direction moves
        // `seats_used` and has to reach Stripe. A role-only PATCH, or a status change that stays on
        // the same side of the line, leaves the count alone and must NOT enqueue a job.
        seatUsageChanged =
          membershipStatusConsumesSeat(membership.status) !==
          membershipStatusConsumesSeat(updated.status);
        const [output] = await this.emitMembershipEvents({
          type: MEMBERSHIP_EVENT.UPDATED,
          memberships: [updated],
          organization,
        });
        await this.emitMainRoleChangedNotice({
          before: membership,
          after: updated,
          organization,
          actingUserId: userId ?? null,
        });
        return output!;
      },
    });
    // sec-R11: invalidate AFTER commit so a racing recompute can't re-cache the stale role set.
    if (affectedUserInternalId !== undefined) {
      await this.invalidatePermissionsForMembership({
        user_internal_id: affectedUserInternalId,
        organization_public_id,
      });
    }
    // REQ-4: suspending a member frees a seat and reactivating one takes it back, exactly like the
    // add/remove paths below — enqueued after the commit so the worker re-reads the settled count.
    if (seatUsageChanged) {
      this.enqueueSeatQuantitySync(organization_public_id);
    }
    return result;
  }

  /**
   * K6 / D58: an ended membership accepts one change — its name (e.g. "Former member"), so a former
   * member can disappear from the organization's records. Anything else is a 400.
   */
  private async renameEndedMembership(options: {
    membership: MembershipRow;
    parsed: UpdateMembershipInput;
    organization: SerializingOrganization;
    updatedByUserId: number | null;
  }): Promise<MembershipOutput> {
    const otherFields = Object.keys(options.parsed).filter(
      (field) => field !== 'display_name' && field !== 'expected_updated_at',
    );
    const displayName = options.parsed.display_name;
    if (otherFields.length > 0 || displayName === undefined) {
      const fields = otherFields.length > 0 ? otherFields : ['display_name'];
      throw new ValidationError(
        'errors:validation.membershipEnded',
        undefined,
        undefined,
        fields.map((field) => ({ field, messageKey: 'errors:validation.membershipEnded' })),
      ).withReason('membership_ended');
    }
    const renamed = await this.membershipRepository.renameEnded({
      publicId: options.membership.public_id,
      organizationId: options.membership.organization_id,
      displayName,
      updatedByUserId: options.updatedByUserId,
    });
    if (!renamed) throw new NotFoundError('Membership');
    return this.resolveAndSerializeMembership({
      membership: renamed,
      organization: options.organization,
    });
  }

  async delete({
    scope,
    membership_public_id,
    query,
    options,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    membership_public_id: string;
    query: unknown;
    options?: MembershipActionOptions | undefined;
  }): Promise<void> {
    const organization_public_id = scope.organizationPublicId;
    // RC-143: a manager's removal carries why (and a note for `other`).
    const removal = validateDeleteMembershipQuery(query);
    let affectedUserInternalId: number | undefined;
    await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationRecordByPublicId(
            organization_public_id,
          );
        const membership = await this.membershipRepository.findByPublicId(
          membership_public_id,
          organization.id,
        );
        if (!membership) throw new NotFoundError('Membership');
        // The owner cannot be removed — they must transfer ownership first, or the organization
        // would be left without an owner.
        if (organization.owner_user_id === membership.user_id) {
          throw ownerMembershipFixedError('errors:ownerCannotBeRemoved');
        }
        await this.assertCallerHoldsMemberPermissions({
          organizationPublicId: organization_public_id,
          membership,
          callerUserPublicId: scope.userPublicId,
          callerApiKeyScopes: options?.callerApiKeyScopes,
        });
        const deleted = await this.endMembershipInContext({
          organization,
          membershipPublicId: membership_public_id,
          reason: removal.reason,
          note: removal.note ?? null,
        });
        if (!deleted) {
          // The atomic owner-guard refused the delete (a concurrent transfer made this member the
          // owner after the check above) or the row vanished — re-resolve for the precise error.
          const current =
            await this.organizationService.requireOrganizationRecordByPublicId(
              organization_public_id,
            );
          if (current.owner_user_id === membership.user_id) {
            throw ownerMembershipFixedError('errors:ownerCannotBeRemoved');
          }
          throw new NotFoundError('Membership');
        }
        if (membership.status !== MEMBERSHIP_STATUS.INVITED) {
          await this.emitMembershipNotice({
            notice: { type: 'removed' },
            membership: deleted,
            organization,
            actingUserId: await this.organizationService.resolveUserInternalIdByPublicId(
              scope.userPublicId,
            ),
          });
        }
        affectedUserInternalId = deleted.user_id;
      },
    });
    // sec-R11: invalidate AFTER commit so a racing recompute can't re-cache the removed member's
    // stale permissions (delayed revocation).
    if (affectedUserInternalId !== undefined) {
      await this.invalidatePermissionsForMembership({
        user_internal_id: affectedUserInternalId,
        organization_public_id,
      });
    }
    // REQ-4: the seat count just shrank — reconcile the Stripe subscription quantity out-of-band.
    this.enqueueSeatQuantitySync(organization_public_id);
  }

  async getPermissions({
    scope,
    membership_public_id,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    membership_public_id: string;
  }): Promise<MembershipPermissionsOutput> {
    const organization_public_id = scope.organizationPublicId;
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationRecordByPublicId(
            organization_public_id,
          );
        const membership = await this.membershipRepository.findByPublicId(
          membership_public_id,
          organization.id,
        );
        if (!membership) throw new NotFoundError('Membership');
        // The union across the main role and the additional ones (D5).
        const roleIds = [
          membership.role_id,
          ...(await this.membershipAdditionalRolesRepository.listRoleIdsForMembership(
            membership.id,
          )),
        ];
        const permissionCodes = new Set<string>();
        for (const roleId of roleIds) {
          for (const code of await this.memberRolePermissionService.listPermissionCodesForRole(
            roleId,
          )) {
            permissionCodes.add(code);
          }
        }
        return { permission_codes: [...permissionCodes] };
      },
    });
  }

  /**
   * Undoes a member's removal (RC-144 — the 10-second undo, and later within the purge window).
   *
   * @remarks
   * - **Algorithm:** inside the organization context, find the soft-deleted membership (404 when
   *   none; 409 when it is live), refuse an end that is not a manager's removal (B2-6: the person
   *   left, deleted their account or declined, or the invite expired or was revoked), run role
   *   ordering and the grant guard over the roles the row would bring back (B2-2), re-check the
   *   plan's seat limit when the row takes a seat, clear `deleted_at` and the removal reason; after
   *   commit, drop the person's cached permissions and reconcile the seat count.
   * - **Failure modes:** `NotFoundError('Membership')`; `ConflictError` (`membership_not_deleted`)
   *   for a live row, (`membership_not_restorable`) for an end only the person (or their invite)
   *   can undo, (`membership_already_exists`) when the person already has a live membership again,
   *   (`seat_limit_reached`) when no seat is free; `ForbiddenError` when the roles hold a code the
   *   caller does not.
   * - **Notes:** the API keys revoked at removal stay revoked.
   */
  async restore({
    scope,
    membership_public_id,
    restored_by_user_public_id,
    options,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    membership_public_id: string;
    restored_by_user_public_id: string | undefined;
    options?: MembershipActionOptions | undefined;
  }): Promise<MembershipOutput> {
    const organization_public_id = scope.organizationPublicId;
    let restoredUserInternalId: number | undefined;
    let seatTaken = false;
    const result = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationRecordByPublicId(
            organization_public_id,
          );
        const deleted = await this.membershipRepository.findDeletedByPublicId(
          membership_public_id,
          organization.id,
        );
        if (!deleted) {
          const live = await this.membershipRepository.findByPublicId(
            membership_public_id,
            organization.id,
          );
          if (live) {
            throw new ConflictError('errors:membershipNotDeleted').withReason(
              'membership_not_deleted',
            );
          }
          throw new NotFoundError('Membership');
        }
        await this.assertMembershipRestorable(deleted);
        // B2-2: restoring hands the roles back, so it passes the same guards as giving them —
        // role ordering over the member and the grant guard over every role the row holds.
        await this.assertCallerHoldsMemberPermissions({
          organizationPublicId: organization_public_id,
          membership: deleted,
          callerUserPublicId: restored_by_user_public_id,
          callerApiKeyScopes: options?.callerApiKeyScopes,
        });
        await this.assertCallerCanGrantRoles({
          roleIds: [
            deleted.role_id,
            ...(await this.membershipAdditionalRolesRepository.listRoleIdsForMembership(
              deleted.id,
            )),
          ],
          callerUserPublicId: restored_by_user_public_id,
          organizationPublicId: organization_public_id,
        });
        seatTaken = membershipStatusConsumesSeat(deleted.status);
        if (seatTaken) await this.assertSeatAvailableForMemberAdd(organization.id);
        const userId = await this.organizationService.resolveUserInternalIdByPublicId(
          restored_by_user_public_id,
        );
        let restored: MembershipRow | null;
        try {
          restored = await this.membershipRepository.restore(
            membership_public_id,
            organization.id,
            userId ?? null,
          );
        } catch (error) {
          if (isPostgresUniqueViolation(error)) {
            throw new ConflictError('errors:membershipAlreadyExists').withReason(
              'membership_already_exists',
            );
          }
          throw error;
        }
        if (!restored) throw new NotFoundError('Membership');
        restoredUserInternalId = restored.user_id;
        return this.resolveAndSerializeMembership({ membership: restored, organization });
      },
    });
    if (restoredUserInternalId !== undefined) {
      await this.invalidatePermissionsForMembership({
        user_internal_id: restoredUserInternalId,
        organization_public_id,
      });
    }
    if (seatTaken) this.enqueueSeatQuantitySync(organization_public_id);
    return result;
  }

  /**
   * Refuses to undo an end that was not a manager's removal (B2-6): the person left, deleted their
   * account or declined the invite, the invite expired — or, for a row still `invited`, its invite
   * is no longer open (revoked or expired). Only the person can come back from those, by a new
   * invite.
   */
  private async assertMembershipRestorable(membership: MembershipRow): Promise<void> {
    const reason = membership.delete_reason as MembershipDeleteReason | null;
    let restorable = reason === null || !UNRESTORABLE_DELETE_REASONS.has(reason);
    if (restorable && membership.status === MEMBERSHIP_STATUS.INVITED) {
      const invitations = await this.membershipRepository.resolveLiveInvitationsByMembershipIds([
        membership.id,
      ]);
      const invitation = invitations.get(membership.id);
      restorable = invitation !== undefined && invitation.expires_at.getTime() > Date.now();
    }
    if (!restorable) {
      throw new ConflictError('errors:membershipNotRestorable').withReason(
        'membership_not_restorable',
      );
    }
  }

  /**
   * Revokes an invited member's pending invite (launch §2.C route 9): the invite is revoked and the
   * invited membership ends (`not_needed`) through the one leave step, in one transaction.
   *
   * @remarks
   * - **Algorithm:** inside the organization context — the live `invited` member, role ordering
   *   (B2-11: the caller must hold every code the invited member's roles grant, as for a removal),
   *   its pending invitation (revoked), then {@link MembershipService.endMembershipInContext}. After
   *   commit: the permission cache and the seat sync (an invited member holds a seat).
   * - **Failure modes:** `NotFoundError('Membership invitation')` when there is no pending invite —
   *   accepted, revoked, or the member removed; `ForbiddenError`
   *   (`cannotManageMemberWithPermissionsNotHeld`) for an invite above the caller.
   * - **Side effects:** writes `tenancy.membership_invitations`, `tenancy.memberships` and, through
   *   the leave step, the app's tables.
   */
  async revokeInvitation({
    scope,
    membership_public_id,
    options,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    membership_public_id: string;
    options?: MembershipActionOptions | undefined;
  }): Promise<void> {
    const organization_public_id = scope.organizationPublicId;
    const invitationService = this.requireInvitationService();
    let affectedUserInternalId: number | undefined;
    await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationRecordByPublicId(
            organization_public_id,
          );
        const membership = await this.membershipRepository.findByPublicId(
          membership_public_id,
          organization.id,
        );
        if (membership?.status !== MEMBERSHIP_STATUS.INVITED) {
          throw new NotFoundError('Membership invitation');
        }
        await this.assertCallerHoldsMemberPermissions({
          organizationPublicId: organization_public_id,
          membership,
          callerUserPublicId: scope.userPublicId,
          callerApiKeyScopes: options?.callerApiKeyScopes,
        });
        const revoked = await invitationService.revokePendingForMembership(membership.id);
        if (!revoked) throw new NotFoundError('Membership invitation');
        const ended = await this.endMembershipInContext({
          organization,
          membershipPublicId: membership_public_id,
          reason: MEMBERSHIP_DELETE_REASON.NOT_NEEDED,
          note: null,
        });
        if (!ended) throw new NotFoundError('Membership invitation');
        affectedUserInternalId = ended.user_id;
      },
    });
    if (affectedUserInternalId !== undefined) {
      await this.invalidatePermissionsForMembership({
        user_internal_id: affectedUserInternalId,
        organization_public_id,
      });
    }
    // REQ-4: an invited membership holds a seat, so revoking the invite frees one.
    this.enqueueSeatQuantitySync(organization_public_id);
  }

  /**
   * The invitee turns down an invitation (launch D84 (3), ROUTE #174): the invite is revoked, the
   * invited membership ends (`declined`) through the one leave step, and the inviter is told — in
   * one transaction in the inviting organization.
   *
   * @remarks
   * - **Algorithm:** the verified invitee and the invitation's organization (the SECURITY DEFINER
   *   lookup — the invitee is no member there); inside that organization's context the invitation
   *   is revoked for the invitee's email, the still-`invited` membership ended, and the decline
   *   notice emitted. After commit: the permission cache and the seat sync (an invited member
   *   holds a seat).
   * - **Failure modes:** `NotFoundError` (no invitation, or its membership or organization gone);
   *   `ForbiddenError` (`invitationRequiresVerifiedEmail`, `invitationEmailMismatch`);
   *   `ValidationError` `invitation_revoked` / `invitation_already_accepted`.
   * - **Side effects:** writes `tenancy.membership_invitations`, `tenancy.memberships` and, through
   *   the leave step, the app's tables; one in-app notification.
   * - **Notes:** an expired invitation can be declined too — it frees the seat at once.
   */
  async declineInvitation(options: {
    invitationPublicId: string;
    actingUserPublicId: string;
  }): Promise<MembershipInvitationOutput & { organization_id: string }> {
    const invitationService = this.requireInvitationService();
    const { invitee, lookup } = await invitationService.resolveInviteeAndOrganization({
      invitation_public_id: options.invitationPublicId,
      actingUserPublicId: options.actingUserPublicId,
    });
    let affectedUserInternalId: number | undefined;
    const revoked = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: lookup.organization_public_id }),
      callback: async () => {
        const invitation = await invitationService.revokeForInvitee({
          invitation_public_id: options.invitationPublicId,
          inviteeEmail: invitee.email,
        });
        const organization = await this.organizationService.requireOrganizationRecordByPublicId(
          lookup.organization_public_id,
        );
        const ended = await this.endInvitedMembershipInContext({
          organization,
          membershipPublicId: lookup.membership_public_id,
          reason: MEMBERSHIP_DELETE_REASON.DECLINED,
        });
        if (!ended) throw new NotFoundError('Membership invitation');
        affectedUserInternalId = ended.user_id;
        await invitationService.notifyDeclined({
          invitation,
          organizationId: lookup.organization_id,
          organizationPublicId: lookup.organization_public_id,
          inviteeUserId: ended.user_id,
          inviteeName:
            [invitee.first_name, invitee.last_name].filter(Boolean).join(' ').trim() ||
            invitee.email,
        });
        return invitation;
      },
    });
    if (affectedUserInternalId !== undefined) {
      await this.invalidatePermissionsForMembership({
        user_internal_id: affectedUserInternalId,
        organization_public_id: lookup.organization_public_id,
      });
    }
    this.enqueueSeatQuantitySync(lookup.organization_public_id);
    return {
      ...serializeMembershipInvitation({
        row: revoked,
        membership_public_id: lookup.membership_public_id,
      }),
      organization_id: lookup.organization_public_id,
    };
  }

  /**
   * Ends an invited membership whose invitation expired before `expiredBefore` (launch D84 (4),
   * ROUTE #175) — the expiry sweep's step for one membership: the invite is revoked and the
   * membership ends (`invitation_expired`) through the one leave step, freeing its seat.
   *
   * @remarks
   * - **Algorithm:** inside the organization's context (ids the sweep's own scan proved): the
   *   still-`invited` membership, its latest invitation revoked only while open and that long
   *   expired, then the leave step. After commit: the permission cache and the seat sync.
   * - **Failure modes:** none of its own — anything no longer due (accepted, revoked, resent,
   *   removed) is a `false` skip, so the sweep is safe to run twice.
   * - **Side effects:** as {@link MembershipService.declineInvitation}, without a notice.
   */
  async endExpiredInvitation(options: {
    organizationPublicId: string;
    membershipPublicId: string;
    expiredBefore: Date;
  }): Promise<boolean> {
    const invitationService = this.requireInvitationService();
    const ended = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: options.organizationPublicId }),
      callback: async () => {
        const found = await this.organizationService.findOrganizationByPublicId(
          options.organizationPublicId,
        );
        if (!found) return null;
        const organization = await this.organizationService.requireOrganizationRecordByPublicId(
          options.organizationPublicId,
        );
        const membership = await this.membershipRepository.findByPublicId(
          options.membershipPublicId,
          organization.id,
        );
        if (membership?.status !== MEMBERSHIP_STATUS.INVITED) return null;
        const revoked = await invitationService.revokeExpiredForMembership({
          membership_id: membership.id,
          expiredBefore: options.expiredBefore,
        });
        if (!revoked) return null;
        return this.endInvitedMembershipInContext({
          organization,
          membershipPublicId: options.membershipPublicId,
          reason: MEMBERSHIP_DELETE_REASON.INVITATION_EXPIRED,
        });
      },
    });
    if (!ended) return false;
    await this.invalidatePermissionsForMembership({
      user_internal_id: ended.user_id,
      organization_public_id: options.organizationPublicId,
    });
    this.enqueueSeatQuantitySync(options.organizationPublicId);
    return true;
  }

  /** The wired invitation service; a {@link ConfigurationError} in a harness that left it out. */
  private requireInvitationService(): MembershipInvitationService {
    if (!this.membershipInvitationService) {
      throw new ConfigurationError(
        'MembershipInvitationService must be wired on MembershipService (tenancy.container).',
      );
    }
    return this.membershipInvitationService;
  }

  /**
   * Ends a membership that is still `invited` through the one leave step — the invitee declined
   * or the invite expired (launch D84). `null` when it is no longer invited (accepted meanwhile,
   * or already ended). MUST run inside the organization context.
   */
  private async endInvitedMembershipInContext(options: {
    organization: SerializingOrganization & { id: number };
    membershipPublicId: string;
    reason: MembershipDeleteReason;
  }): Promise<MembershipRow | null> {
    const membership = await this.membershipRepository.findByPublicId(
      options.membershipPublicId,
      options.organization.id,
    );
    if (membership?.status !== MEMBERSHIP_STATUS.INVITED) return null;
    return this.endMembershipInContext({
      organization: options.organization,
      membershipPublicId: options.membershipPublicId,
      reason: options.reason,
      note: null,
    });
  }

  /**
   * The caller's membership in their active organization — its public id and every live role it
   * holds, the main role first (D5), each with its name, tone and system flag — for
   * `GET /auth/me/context` (`membership_id`, `my_role_ids`, `my_roles`; launch ROUTE #156, N10, S3).
   * `null` with no active organization or no live membership.
   *
   * @remarks
   * - **Algorithm:** one user-and-organization context: the caller's live membership, its
   *   additional roles' ids in `position` order, then one read naming the live roles — a deleted
   *   role drops out of the list.
   * - **Failure modes:** none beyond the queries; an unknown organization reads as no membership.
   */
  async getCallerMembershipContext(
    scope: UserPrincipalDatabaseScope,
  ): Promise<CallerMembershipContext | null> {
    const organizationPublicId = scope.organizationPublicId;
    if (!organizationPublicId) return null;
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService
          .requireOrganizationRecordByPublicId(organizationPublicId)
          .catch((error: unknown) => {
            if (error instanceof NotFoundError) return null;
            throw error;
          });
        const userId = await this.organizationService.resolveUserInternalIdByPublicId(
          scope.userPublicId,
        );
        if (!organization || userId === null) return null;
        const membership = await this.membershipRepository.findByUserAndOrganization(
          userId,
          organization.id,
        );
        if (!membership) return null;
        const roleIds = [
          membership.role_id,
          ...(await this.membershipAdditionalRolesRepository.listRoleIdsForMembership(
            membership.id,
          )),
        ];
        const summaries =
          await this.membershipRepository.resolveRoleSummariesByInternalIds(roleIds);
        return {
          membership_id: membership.public_id,
          roles: roleIds.flatMap((roleId) => {
            const summary = summaries.get(roleId);
            return summary
              ? [
                  {
                    id: summary.public_id,
                    name: summary.name,
                    tone: summary.tone,
                    is_system: summary.is_system,
                  },
                ]
              : [];
          }),
        };
      },
    });
  }

  async leaveOrganization({
    scope,
    user_public_id,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    user_public_id: string;
  }): Promise<void> {
    const organization_public_id = scope.organizationPublicId;
    await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationRecordByPublicId(
            organization_public_id,
          );
        const userId =
          await this.organizationService.resolveUserInternalIdByPublicId(user_public_id);
        if (userId === null) throw new NotFoundError('User');
        const membership = await this.membershipRepository.findByUserAndOrganization(
          userId,
          organization.id,
        );
        if (!membership) throw new NotFoundError('Membership');
        if (organization.owner_user_id === userId) {
          throw new ForbiddenError('errors:ownerCannotLeave').withReason('owner_cannot_leave');
        }
        const deleted = await this.endMembershipInContext({
          organization,
          membershipPublicId: membership.public_id,
          reason: MEMBERSHIP_DELETE_REASON.LEFT,
          note: null,
        });
        if (!deleted) {
          // The atomic owner-guard refused the delete: a concurrent transfer made this user the
          // owner after the pre-check above (which would otherwise orphan the organization), or the row
          // vanished. Re-resolve so the race surfaces the same ownerCannotLeave as the pre-check.
          const current =
            await this.organizationService.requireOrganizationRecordByPublicId(
              organization_public_id,
            );
          if (current.owner_user_id === userId) {
            throw new ForbiddenError('errors:ownerCannotLeave').withReason('owner_cannot_leave');
          }
          throw new NotFoundError('Membership');
        }
      },
    });
    // sec-R11: invalidate AFTER commit so a racing recompute can't re-cache the stale set.
    await invalidatePermissions({ userId: user_public_id, organizationId: organization_public_id });
    // REQ-4: the seat count just shrank — reconcile the Stripe subscription quantity out-of-band.
    this.enqueueSeatQuantitySync(organization_public_id);
  }

  /**
   * Hands the organization to another active member (launch D81 (4)): `owner_user_id` moves, the
   * role the owner holds as their main one (the locked Owner role) becomes the new owner's main role,
   * and the former owner moves to the Admin role — or to `former_owner_role_id` — in one transaction.
   *
   * @remarks
   * - **Algorithm:** inside the organization context — the caller must be the owner; the new owner
   *   must be an active member; the former owner's new main role is resolved (the named one, else
   *   the Admin system role, else the new owner's current main role) and may never be the Owner
   *   role. Then the guarded `owner_user_id` flip
   *   ({@link OrganizationService.transferOrganizationOwnership}), the new owner's main role (their
   *   previous main role stays as an extra role) and the former owner's (the Owner role leaves their
   *   extra roles too), and one `membership.updated` each. After commit, both people's cached
   *   permissions are purged.
   * - **Failure modes:** `ForbiddenError('errors:onlyOwnerCanTransfer')` for a non-owner;
   *   `NotFoundError('User' | 'Membership')`; `ValidationError` on `former_owner_role_id` (no live
   *   role here, or the Owner role itself); `ConflictError` when the new owner stopped being
   *   active before the write.
   * - **Notes:** naming the owner themselves is a no-op that changes nothing.
   */
  async transferOwnership({
    scope,
    body,
    current_user_public_id,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    body: unknown;
    current_user_public_id: string;
  }): Promise<MembershipOutput> {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateTransferOwnership(body);
    const result = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization =
          await this.organizationService.requireOrganizationRecordByPublicId(
            organization_public_id,
          );
        // A PERSONAL organization belongs solely to its owner and cannot be handed off.
        assertTeamOrganization({ organization, capability: 'MUTATION' });
        const currentUserId =
          await this.organizationService.resolveUserInternalIdByPublicId(current_user_public_id);
        if (currentUserId === null) throw new NotFoundError('User');
        if (organization.owner_user_id !== currentUserId) {
          throw new ForbiddenError('errors:onlyOwnerCanTransfer');
        }
        const newOwnerUserId = await this.organizationService.resolveUserInternalIdByPublicId(
          parsed.new_owner_user_id,
        );
        if (newOwnerUserId === null) throw new NotFoundError('User');
        const newOwnerMembership = await this.membershipRepository.findByUserAndOrganization(
          newOwnerUserId,
          organization.id,
        );
        if (newOwnerMembership?.status !== MEMBERSHIP_STATUS.ACTIVE) {
          // The new owner has no active membership here: as far as this organization goes, there
          // is no such member.
          throw new NotFoundError('Membership');
        }
        if (newOwnerUserId === currentUserId) {
          return this.resolveAndSerializeMembership({
            membership: newOwnerMembership,
            organization,
          });
        }
        const formerOwnerMembership = await this.membershipRepository.findByUserAndOrganization(
          currentUserId,
          organization.id,
        );
        // The owner's main role is fixed while they own the organization (assertOwnerKeepsMainRole),
        // so it is the role that gives them the whole organization — the locked Owner role.
        const ownerRoleId = formerOwnerMembership?.role_id;
        const formerOwnerRoleId =
          ownerRoleId === undefined
            ? undefined
            : await this.resolveFormerOwnerRoleId({
                organizationId: organization.id,
                requestedRolePublicId: parsed.former_owner_role_id,
                ownerRoleId,
                newOwnerMainRoleId: newOwnerMembership.role_id,
              });
        const transferred = await this.organizationService.transferOrganizationOwnership({
          organization_public_id,
          new_owner_user_id: newOwnerUserId,
        });
        if (
          !(formerOwnerMembership && ownerRoleId !== undefined && formerOwnerRoleId !== undefined)
        ) {
          return this.resolveAndSerializeMembership({
            membership: newOwnerMembership,
            organization: transferred,
          });
        }
        const newOwnerUpdated = await this.moveMainRole({
          organizationId: organization.id,
          membership: newOwnerMembership,
          mainRoleId: ownerRoleId,
          keepPreviousMainRole: true,
          dropRoleIds: [],
          actingUserId: currentUserId,
        });
        const formerOwnerUpdated = await this.moveMainRole({
          organizationId: organization.id,
          membership: formerOwnerMembership,
          mainRoleId: formerOwnerRoleId,
          keepPreviousMainRole: false,
          dropRoleIds: [ownerRoleId],
          actingUserId: currentUserId,
        });
        // Serialized against the new owner, so the answer reads `is_owner: true`.
        const [output] = await this.emitMembershipEvents({
          type: MEMBERSHIP_EVENT.UPDATED,
          memberships: [newOwnerUpdated, formerOwnerUpdated],
          organization: transferred,
        });
        for (const [before, after] of [
          [newOwnerMembership, newOwnerUpdated],
          [formerOwnerMembership, formerOwnerUpdated],
        ] as const) {
          await this.emitMainRoleChangedNotice({
            before,
            after,
            organization: { ...transferred, id: organization.id },
            actingUserId: currentUserId,
          });
        }
        return output!;
      },
    });
    // sec-R11b: purge both people's cached permission sets after commit — their main roles just
    // changed, so the former owner loses the Owner role's codes at once, not after the cache TTL.
    await invalidatePermissions({
      userId: current_user_public_id,
      organizationId: organization_public_id,
    });
    await invalidatePermissions({
      userId: parsed.new_owner_user_id,
      organizationId: organization_public_id,
    });
    return result;
  }

  /**
   * The main role a former owner moves to on a transfer: the role the request names, else the
   * organization's Admin system role, else the new owner's current main role — never the Owner role.
   */
  private async resolveFormerOwnerRoleId(options: {
    organizationId: number;
    requestedRolePublicId: string | undefined;
    ownerRoleId: number;
    newOwnerMainRoleId: number;
  }): Promise<number> {
    let roleId: number;
    if (options.requestedRolePublicId === undefined) {
      const admin = await this.memberRoleService.findSystemRoleForOrganization({
        organization_id: options.organizationId,
        name: ADMIN_ROLE_NAME,
      });
      roleId = admin?.id ?? options.newOwnerMainRoleId;
    } else {
      const requested = await this.memberRoleService
        .requireRoleRecordForOrganization({
          organization_id: options.organizationId,
          role_public_id: options.requestedRolePublicId,
        })
        .catch((error: unknown) => {
          if (!(error instanceof NotFoundError)) throw error;
          throw formerOwnerRoleError({
            messageKey: 'errors:validation.membershipRoleNotFound',
            messageParams: { role_id: options.requestedRolePublicId ?? '' },
          });
        });
      roleId = requested.id;
    }
    if (roleId === options.ownerRoleId) {
      throw formerOwnerRoleError({
        messageKey: 'errors:validation.formerOwnerRoleIsOwnerRole',
      });
    }
    return roleId;
  }

  /**
   * Makes `mainRoleId` a membership's main role, keeping its other roles: with
   * `keepPreviousMainRole` the role it held as main stays as an extra role (first); the new main
   * role and every `dropRoleIds` role leave the extra roles. MUST run inside the organization
   * context.
   */
  private async moveMainRole(options: {
    organizationId: number;
    membership: MembershipRow;
    mainRoleId: number;
    keepPreviousMainRole: boolean;
    dropRoleIds: readonly number[];
    actingUserId: number;
  }): Promise<MembershipRow> {
    const { membership } = options;
    const extraRoleIds = await this.membershipAdditionalRolesRepository.listRoleIdsForMembership(
      membership.id,
    );
    const keptRoleIds = [
      ...new Set([...(options.keepPreviousMainRole ? [membership.role_id] : []), ...extraRoleIds]),
    ]
      .filter((roleId) => roleId !== options.mainRoleId && !options.dropRoleIds.includes(roleId))
      .slice(0, MEMBERSHIP_ROLE_IDS_MAX - 1);
    const updated = await this.membershipRepository.update(
      membership.public_id,
      options.organizationId,
      { role_id: options.mainRoleId },
      options.actingUserId,
    );
    if (!updated) throw new NotFoundError('Membership');
    await this.membershipAdditionalRolesRepository.replaceForMembership({
      membership_id: membership.id,
      organization_id: options.organizationId,
      role_ids: keptRoleIds,
      created_by_user_id: options.actingUserId,
    });
    return updated;
  }

  /**
   * Counts the seat-occupying memberships (ACTIVE + INVITED) in an organization (REQ-4).
   *
   * @remarks
   * - **Algorithm:** runs {@link MembershipRepository.countActiveByOrganization} inside
   *   {@link withAppDatabaseContext} so the `memberships` RLS policy resolves the
   *   org's rows. Resolves the org's internal id from its public id first.
   * - **Failure modes:** `NotFoundError('Organization')` when the public id does not resolve.
   * - **Side effects:** one read-only COUNT query under the organization GUC.
   * - **Notes:** this is the cross-domain SERVICE entry point billing's `SubscriptionService`
   *   calls to compute `seats_used` — billing never reaches the membership repository/schema
   *   directly (cross-domain reads go service→service).
   */
  async countActiveMembers(options: { organizationPublicId: string }): Promise<number> {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: options.organizationPublicId }),
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          options.organizationPublicId,
        );
        return this.membershipRepository.countActiveByOrganization(organization.id);
      },
    });
  }

  /**
   * The internal user ids of every ACTIVE member of the scope's organization whose role (main or
   * additional, not deleted) grants `permissionCode` — the cross-domain SERVICE entry point over
   * {@link MembershipRepository.findUserIdsWithPermission}.
   *
   * @remarks
   * - **Algorithm:** one read in the caller's organization scope (joining the caller's open unit
   *   of work for the same organization): resolve the organization, then the distinct holders.
   * - **Failure modes:** `NotFoundError('Organization')` when the scope's organization does not
   *   resolve.
   * - **Side effects:** none — read-only.
   * - **Notes:** the app domain's reconnect notice (launch IA9) finds its recipients here
   *   (`channel-account:manage` holders); other domains read memberships only through this
   *   service, never the repository.
   */
  async findActiveUserIdsWithPermission({
    scope,
    permissionCode,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    permissionCode: string;
  }): Promise<number[]> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        return this.membershipRepository.findUserIdsWithPermission(organization.id, permissionCode);
      },
    });
  }

  /**
   * The internal user ids of every ACTIVE member of the scope's organization — the cross-domain
   * SERVICE entry point over {@link MembershipRepository.findActiveUserIds}.
   *
   * @remarks
   * - **Algorithm:** one read in the caller's organization scope (joining the caller's open unit
   *   of work for the same organization): resolve the organization, then its active members.
   * - **Failure modes:** `NotFoundError('Organization')` when the scope's organization does not
   *   resolve.
   * - **Side effects:** none — read-only.
   * - **Notes:** the notify domain's recipients resolver reads the "every member" rule here
   *   (feat-instagram-dm-sending UN2).
   */
  async findActiveUserIds({
    scope,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
  }): Promise<number[]> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        return this.membershipRepository.findActiveUserIds(organization.id);
      },
    });
  }

  /**
   * Ends every membership of a login whose account is being deleted (launch K6), as a manager's
   * removal would — each through the one leave step with `delete_reason = account_deleted`, in its
   * own organization, so the clinics keep the frozen membership name and what the person did — and
   * returns the organizations the user belonged to (ended now or earlier), so account deletion can
   * erase the user's details there too.
   *
   * @remarks
   * - **Algorithm:** the user's membership rows span tenants, so they are listed under the retention
   *   maintenance context; each live membership of a live TEAM organization is then ended under that
   *   organization's own context (API keys revoked, the app's part released, `membership.deleted`
   *   emitted), its permissions purged after the commit and its seat count reconciled. The personal
   *   organization is tombstoned whole by the organization service.
   * - **Failure modes:** propagates; account deletion is re-runnable and every step is idempotent. A
   *   membership the owner guard refuses is skipped (account deletion already refuses an owner).
   * - **Side effects:** see {@link MembershipService} `endMembershipInContext`.
   */
  async removeAllForDepartingUser(
    userInternalId: number,
  ): Promise<{ organizationPublicIds: string[] }> {
    const rows = await withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      callback: () => this.membershipRepository.listForDepartingUser(userInternalId),
    });
    for (const row of rows) {
      if (
        row.membership_deleted_at !== null ||
        row.organization_deleted_at !== null ||
        row.organization_type === 'PERSONAL'
      ) {
        continue;
      }
      const ended = await withAppDatabaseContext({
        scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: row.organization_public_id }),
        callback: async () => {
          const organization = await this.organizationService.requireOrganizationRecordByPublicId(
            row.organization_public_id,
          );
          return this.endMembershipInContext({
            organization,
            membershipPublicId: row.membership_public_id,
            reason: MEMBERSHIP_DELETE_REASON.ACCOUNT_DELETED,
            note: null,
          });
        },
      });
      if (ended) {
        await this.invalidatePermissionsForMembership({
          user_internal_id: userInternalId,
          organization_public_id: row.organization_public_id,
        });
        this.enqueueSeatQuantitySync(row.organization_public_id);
      }
    }
    return {
      organizationPublicIds: [
        ...new Set(
          rows
            .filter((row) => row.organization_deleted_at === null)
            .map((row) => row.organization_public_id),
        ),
      ],
    };
  }

  /**
   * Lists organization memberships for a GDPR data-export bundle under the requesting user's RLS
   * context (cross-organization read scoped to the owner).
   */
  async listOrganizationsForUserDataExport(options: {
    userPublicId: string;
    userInternalId: number;
    limit: number;
  }) {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: options.userPublicId }),
      callback: (_databaseHandle) =>
        this.membershipRepository.listOrganizationsForUserDataExport(
          options.userInternalId,
          options.limit,
        ),
    });
  }
}
