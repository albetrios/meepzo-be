import {
  ConflictError,
  ForbiddenError,
  ConfigurationError,
  NotFoundError,
  UnprocessableEntityError,
  ValidationError,
} from '@/shared/errors/index.js';
import { assertTeamOrganization } from './organization-capability.js';
import { env } from '@/shared/config/env.config.js';
import {
  PRINCIPAL_SCOPE,
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
  withAppDatabaseContext,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationRepository } from './organization.repository.js';
import type {
  Organization,
  OrganizationBillingContext,
  OrganizationChooserOutput,
  OrganizationCounts,
  OrganizationMembershipContext,
  OrganizationOutput,
} from './organization.types.js';
import {
  validateCreateOrganization,
  validateUpdateOrganization,
  validateListOrganizationChooserQuery,
  validateUploadLogo,
} from './organization.validator.js';
import { buildDomainEvent, eventBus } from '@/core/events/event-bus.js';
import type { OrganizationResourceEventPayload } from '@/core/events/organization-resource-event.js';
import {
  ORGANIZATION_EVENT,
  type OrganizationEventType,
} from '@/domains/tenancy/sub-domains/organization/events/organization.events.js';
import { serializeOrganization } from './organization.serializer.js';
import { resolveStoredMediaReadUrl } from '@/shared/utils/infrastructure/media-url.util.js';
import { provisionOrganizationWithOwner } from './organization-provisioning.js';
import { invalidateOrganizationPermissions } from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import { buildOrganizationLogoKeyPrefix } from '@/domains/upload/upload.constants.js';
import { isSvgContentType } from '@/domains/upload/utils/upload-svg.util.js';
import type { ObjectStoragePort } from '@/infrastructure/storage/object-storage.port.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  getPostgresConstraintName,
  isPostgresUniqueViolation,
} from '@/shared/utils/infrastructure/postgres-error.util.js';
import { generateRandomLowercaseAlphanumeric } from '@/shared/utils/identity/public-id.util.js';
import { slugFromText } from '@/shared/utils/validation/validation.util.js';
import {
  ORGANIZATION_SLUG_FALLBACK,
  ORGANIZATION_SLUG_MAX_ATTEMPTS,
  ORGANIZATION_SLUG_MAX_LENGTH,
  ORGANIZATION_SLUG_SUFFIX_LENGTH,
} from './organization.constants.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import type { UploadService } from '@/domains/upload/upload.service.js';

/** An organization row as serialized: the serializer's columns plus the owner's internal id. */
type OrganizationOutputRow = Omit<
  Parameters<typeof serializeOrganization>[0],
  'owner_user_public_id'
> & {
  owner_user_id: number;
};

/** The live-slug unique index a taken team slug collides with. */
const ORGANIZATION_SLUG_UNIQUE_INDEX = 'idx_organizations_slug';

/**
 * The slugs a create tries when the body names none (TN7): the name in kebab form first, then that
 * form with a short random suffix (`acme-x7k2p9`), up to {@link ORGANIZATION_SLUG_MAX_ATTEMPTS}.
 */
function madeOrganizationSlugCandidates(name: string): string[] {
  const suffixLength = ORGANIZATION_SLUG_SUFFIX_LENGTH + 1;
  const base =
    slugFromText({ text: name, maxLength: ORGANIZATION_SLUG_MAX_LENGTH - suffixLength }) ||
    ORGANIZATION_SLUG_FALLBACK;
  return [
    base,
    ...Array.from(
      { length: ORGANIZATION_SLUG_MAX_ATTEMPTS - 1 },
      () => `${base}-${generateRandomLowercaseAlphanumeric(ORGANIZATION_SLUG_SUFFIX_LENGTH)}`,
    ),
  ];
}

/** `409 organization_slug_exists` for a taken slug. */
function organizationSlugExistsError(slug: string): ConflictError {
  return new ConflictError(
    'errors:organizationSlugExists',
    { slug },
    `Organization with slug "${slug}" already exists`,
  ).withReason('organization_slug_exists');
}

/**
 * Structural port for the billing side of organization offboarding (route-audit-#2).
 *
 * @remarks
 * - **Algorithm:** declared as a minimal interface (not an import of `SubscriptionService`) so a
 *   call to `delete` can cancel the org's subscription without tenancy depending on billing.
 * - **Failure modes:** the implementer throws on a payment-provider outage, aborting the delete.
 * - **Side effects:** none on this type — the implementer makes the Stripe call + local write.
 * - **Notes:** billing already depends on tenancy, so importing the concrete service here would
 *   create a cycle; the composition root supplies `SubscriptionService` structurally.
 */
export type OrganizationSubscriptionOffboardingPort = {
  cancelActiveForOrganizationOffboarding(organizationPublicId: string): Promise<void>;
};

/**
 * What an organization delete erased of its Instagram accounts (launch D54): the accounts something
 * changed on, and how many stored posts went with them — for the delete's audit entry.
 *
 * @remarks
 * - **Algorithm:** the answer of {@link OrganizationInstagramOffboardingPort}; a structural shape, so
 *   tenancy imports nothing from the `app` domain.
 * - **Failure modes:** none — a return shape.
 * - **Side effects:** none.
 * - **Notes:** public ids and a count only — never a username or a token.
 */
export interface OrganizationInstagramErasure {
  /** `cha_…` of every account something changed on. */
  instagramAccountPublicIds: string[];
  /** Stored posts erased. */
  erasedPostCount: number;
}

/**
 * Structural port for the Instagram side of organization offboarding (launch D54).
 *
 * @remarks
 * - **Algorithm:** declared as a minimal interface (not an import of the `app` domain's service) so
 *   `delete` can erase the organization's Instagram accounts without tenancy depending on `app`,
 *   which already depends on tenancy. Called in the organization's own scope while it is live: after
 *   the soft delete row-level security hides its rows from that scope.
 * - **Failure modes:** the implementer throws on a database failure, aborting the delete before the
 *   soft delete; its Instagram call (the webhook unsubscribe) is best-effort and never throws.
 * - **Side effects:** none on this type — the implementer revokes the accounts and erases their
 *   tokens, profiles and stored posts.
 * - **Notes:** safe to repeat (the reconcile worker runs the delete again); `null` when there was
 *   nothing to erase.
 */
export type OrganizationInstagramOffboardingPort = {
  eraseForOrganizationOffboarding(
    scope: OrganizationPrincipalDatabaseScope,
  ): Promise<OrganizationInstagramErasure | null>;
};

/**
 * The app's counts port for the organization chooser (feat-instagram-dm-sending UN1, UN5): members,
 * channel accounts and live automations of the caller's organizations.
 *
 * @remarks
 * - **Algorithm:** declared here as a minimal interface (not an import of the `app` domain's service)
 *   so the chooser can show app numbers without tenancy depending on `app`, which already depends on
 *   tenancy — the launch's erase-step pattern ({@link OrganizationInstagramOffboardingPort}). The app's
 *   implementation calls one SECURITY DEFINER function once per page.
 * - **Failure modes:** the implementer propagates a database failure; the route answers 500.
 * - **Side effects:** none — a read.
 * - **Notes:** the implementer answers only organizations where the user holds an active membership;
 *   an organization missing from the answer reads as zero counts.
 */
export type OrganizationCountsPort = {
  listOrganizationCountsForUser(options: {
    userPublicId: string;
    organizationPublicIds: readonly string[];
  }): Promise<OrganizationCounts[]>;
};

/**
 * What {@link OrganizationService.delete} did on the way — for the caller's audit entry.
 *
 * @remarks
 * - **Algorithm:** returned once the organization is soft-deleted.
 * - **Failure modes:** none — a return shape; a failed step throws instead.
 * - **Side effects:** none.
 * - **Notes:** the audit entry is the controller's, after the delete. The reconcile worker's
 *   {@link OrganizationService.resumeOffboarding} returns nothing and writes none.
 */
export interface OrganizationDeletionResult {
  /** The Instagram accounts the delete erased (launch D54), or `null` when there was nothing to erase. */
  erasedInstagram: OrganizationInstagramErasure | null;
}

/**
 * Optional collaborators wired into {@link OrganizationService} after the
 * upload (and billing and app) domains have booted, used to tombstone tenant uploads,
 * confirm S3 keys during logo attachment, and on delete cancel the org's subscription and erase its
 * Instagram accounts.
 *
 * @remarks
 * - **Algorithm:** populated lazily by `wireOffboardingUploadService` so the
 *   tenancy container can be constructed before the upload/billing/app containers exist.
 * - **Failure modes:** until wired, `uploadLogo` and `delete` either throw
 *   (logo confirmation requires the upload service) or silently skip the
 *   upload-tombstone / subscription-cancel / Instagram-erase step.
 * - **Side effects:** none on construction; downstream calls invoke
 *   `UploadService.tombstoneAllByOrganizationId`, `assertKeyConfirmedForOwner`,
 *   `OrganizationSubscriptionOffboardingPort.cancelActiveForOrganizationOffboarding` and
 *   `OrganizationInstagramOffboardingPort.eraseForOrganizationOffboarding`.
 * - **Notes:** the public {@link OrganizationService.offboardingUploadService}
 *   reference exists for composition-root assertions only.
 */
export type OrganizationOffboardingDependencies = {
  uploadService: UploadService;
  /** route-audit-#2: cancels the org's active subscription on delete so billing stops. */
  subscriptionService?: OrganizationSubscriptionOffboardingPort | undefined;
  /** Launch D54: erases the organization's Instagram accounts on delete. */
  instagramErasureService?: OrganizationInstagramOffboardingPort | undefined;
};

/**
 * Authoritative tenancy service for the organization aggregate — list / get /
 * create / update / soft-delete plus logo lifecycle.
 *
 * @remarks
 * - **Algorithm:** every mutation runs inside `withAppDatabaseContext`
 *   (sets `app.current_organization_public_id` for RLS) and reads use
 *   `withAppDatabaseContext (user scope)` to satisfy the `organizations_user_discovery`
 *   policy (read-only: a write needs the organization's own context). Slug uniqueness is enforced explicitly; access checks short-
 *   circuit for global admins and otherwise require ownership or an active
 *   membership via {@link OrganizationRepository.userCanAccessOrganization}.
 * - **Failure modes:** `NotFoundError` for missing organizations, members,
 *   logos, or callers; `ConflictError('errors:organizationSlugExists')` on
 *   slug collision; `ValidationError` for bad logo keys, missing S3 objects,
 *   or disallowed `image/svg+xml` content.
 * - **Side effects:** S3 deletes and head-object calls via the injected
 *   {@link ObjectStoragePort}; tombstones uploads, clears the logo URL, cancels the subscription and
 *   erases the Instagram accounts on organization deletion (cross-domain wiring through
 *   {@link OrganizationOffboardingDependencies}); purges the org's permission
 *   cache on soft-delete via {@link invalidateOrganizationPermissions}; does not
 *   emit domain events or write audit logs directly.
 * - **Notes:** soft-delete only — the row remains until the tombstone
 *   retention worker hard-deletes it; offboarding S3/upload-service work runs
 *   outside the DB context to avoid holding a transaction across HTTP.
 */
export class OrganizationService {
  private offboardingDependencies: OrganizationOffboardingDependencies | null = null;
  private organizationCounts: OrganizationCountsPort | null = null;
  /** Public reference for composition-root assertions; populated at boot via wireOffboardingUploadService. */
  public offboardingUploadService: UploadService | null = null;

  constructor(
    private readonly repository: OrganizationRepository,
    private readonly objectStorage: ObjectStoragePort,
  ) {}

  wireOffboardingUploadService({
    uploadService,
    subscriptionService,
    instagramErasureService,
  }: OrganizationOffboardingDependencies): void {
    this.offboardingDependencies = { uploadService, subscriptionService, instagramErasureService };
    this.offboardingUploadService = uploadService;
  }

  /**
   * Wires the app's counts port for the chooser (UN1) — at boot, after the app container exists.
   */
  wireOrganizationCounts(organizationCounts: OrganizationCountsPort): void {
    this.organizationCounts = organizationCounts;
  }

  /**
   * Serializes organization rows to {@link OrganizationOutput}: `logo_url` resolved to a
   * short-lived signed read URL (TEN-07: private bucket + signed-on-read — a network-free local
   * signature, safe inside a database context) and `owner_user_id` to the owner's user public id
   * (launch D81 (4)) — one batch lookup for the whole set.
   */
  private async toOrganizationOutputs(
    rows: readonly OrganizationOutputRow[],
  ): Promise<OrganizationOutput[]> {
    if (rows.length === 0) return [];
    const ownerPublicIds = await this.repository.resolveUserPublicIdsByInternalIds([
      ...new Set(rows.map((row) => row.owner_user_id)),
    ]);
    return Promise.all(
      rows.map(async (row) => ({
        ...serializeOrganization({
          ...row,
          owner_user_public_id: ownerPublicIds.get(row.owner_user_id) ?? null,
        }),
        logo_url: await resolveStoredMediaReadUrl({
          objectStorage: this.objectStorage,
          storedValue: row.logo_url,
        }),
      })),
    );
  }

  /** {@link OrganizationService.toOrganizationOutputs} for one row. */
  private async toOrganizationOutput(row: OrganizationOutputRow): Promise<OrganizationOutput> {
    const [output] = await this.toOrganizationOutputs([row]);
    return output!;
  }

  /**
   * Emits an organization resource event with the organization's public JSON. Called inside the
   * write's database context so the webhook fan-out joins its transaction.
   */
  private async emitOrganizationEvent({
    type,
    organization,
  }: {
    type: OrganizationEventType;
    organization: OrganizationOutput;
  }): Promise<void> {
    await eventBus.emit(
      buildDomainEvent<OrganizationResourceEventPayload>({
        type,
        payload: {
          organization_public_id: organization.id,
          data: { ...organization },
        },
      }),
    );
  }

  /**
   * Best-effort reclaim of the S3 object behind the stored organization-logo key. The column only
   * ever holds a key written by `uploadLogo`; the prefix guard keeps a reclaim from reaching any
   * object outside this organization's logo prefix. Does NOT mutate the column — callers decide
   * what to write — so it is reused by per-asset delete, logo replacement, and offboarding.
   */
  private async deleteOwnedOrganizationLogoObject({
    public_id,
    logo_url,
  }: {
    public_id: string;
    logo_url: string | null;
  }): Promise<void> {
    if (!logo_url?.startsWith(buildOrganizationLogoKeyPrefix(public_id))) return;
    const objectDelete = await this.objectStorage.deleteObject(logo_url);
    if (objectDelete.kind !== 'deleted') {
      logger.warn({ publicId: public_id, logoKey: logo_url }, 'organization.logo.deleteFailed');
    }
  }

  private async clearOrganizationLogoStorage({
    scope,
    logo_url,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    logo_url: string | null;
  }): Promise<void> {
    const public_id = scope.organizationPublicId;
    await this.deleteOwnedOrganizationLogoObject({ public_id, logo_url });
    const updated = await withAppDatabaseContext({
      scope,
      callback: () => this.repository.update(public_id, { logo_url: null }, null),
    });
    if (!updated) throw new NotFoundError('Organization');
  }

  /**
   * Refuses a caller who is not the organization's owner (`owner_user_id`) — an API key, which has
   * no user, included. MUST run inside the organization's database context.
   */
  private async assertCallerOwnsOrganization(options: {
    organization: Pick<Organization, 'owner_user_id'>;
    callerUserPublicId: string | undefined;
    messageKey: string;
  }): Promise<void> {
    const callerUserId = await this.repository.resolveUserIdByPublicId(options.callerUserPublicId);
    if (callerUserId === null || callerUserId !== options.organization.owner_user_id) {
      throw new ForbiddenError(options.messageKey).withReason('owner_only');
    }
  }

  async requireOrganizationByPublicId(public_id: string): Promise<OrganizationBillingContext> {
    const organization = await this.requireOrganizationRecordByPublicId(public_id);
    return {
      id: organization.id,
      public_id: organization.public_id,
      name: organization.name,
      slug: organization.slug,
      type: organization.type,
      stripe_customer_id: organization.stripe_customer_id,
    };
  }

  /**
   * Counts the active organizations owned by a user (route-audit-#2 follow-up). Runs in the user's
   * discovery context so the `organizations_user_discovery` RLS policy resolves the owned rows; used
   * by user offboarding to block deleting a user who still owns organizations.
   */
  async countOrganizationsOwnedByUser({
    userPublicId,
    userInternalId,
  }: {
    userPublicId: string;
    userInternalId: number;
  }): Promise<number> {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      callback: () => this.repository.countActiveOwnedByUser(userInternalId),
    });
  }

  /**
   * Resolves the organization row for the active-organization public id, throwing `NotFoundError` when it
   * does not exist. Renamed from `requireOrganizationMembershipByPublicId` (audit-#T2).
   *
   * @remarks
   * - **Algorithm:** a single `findByPublicId` under the caller's RLS-scoped context; shapes the
   *   row into an {@link OrganizationMembershipContext}.
   * - **Failure modes:** `NotFoundError('Organization')` if no row resolves.
   * - **Side effects:** none (read-only).
   * - **Notes:** this does **NOT** assert that the caller is a member of the organization — it only
   *   resolves the row (the old name falsely implied a membership check). Authorization is enforced
   *   upstream by the route's `requireOrganizationPermission` preHandler and Postgres RLS scoped to
   *   `app.current_organization_public_id`. Do not add a route that relies on this method as its sole
   *   authorization gate; always pair it with a permission preHandler.
   */
  async requireOrganizationRecordByPublicId(
    public_id: string,
  ): Promise<OrganizationMembershipContext> {
    const organization = await this.repository.findByPublicId(public_id);
    if (!organization) throw new NotFoundError('Organization');
    return {
      id: organization.id,
      public_id: organization.public_id,
      name: organization.name,
      slug: organization.slug,
      type: organization.type,
      stripe_customer_id: organization.stripe_customer_id,
      owner_user_id: organization.owner_user_id,
    };
  }

  /**
   * The IANA time zone the organization's timed work runs in (launch D7, D41) — its "today".
   *
   * @remarks
   * - **Algorithm:** one `findByPublicId` under the caller's RLS-scoped context.
   * - **Failure modes:** `NotFoundError('Organization')` if no row resolves.
   * - **Side effects:** none (read-only).
   */
  async requireOrganizationTimeZone(public_id: string): Promise<string> {
    const organization = await this.repository.findByPublicId(public_id);
    if (!organization) throw new NotFoundError('Organization');
    return organization.timezone;
  }

  async transferOrganizationOwnership({
    organization_public_id,
    new_owner_user_id,
  }: {
    organization_public_id: string;
    new_owner_user_id: number;
  }): Promise<OrganizationMembershipContext> {
    const updated = await this.repository.updateOwner(organization_public_id, new_owner_user_id);
    if (!updated) {
      // updateOwner only writes when the target is still an active member (atomic EXISTS guard);
      // a null result means a concurrent suspend/removal won the race after the caller's check.
      throw new ConflictError('errors:ownershipTransferTargetNotActive');
    }
    return this.requireOrganizationRecordByPublicId(organization_public_id);
  }

  async findOrganizationByInternalId(
    identifier: number,
  ): Promise<OrganizationBillingContext | null> {
    const organization = await this.repository.findById(identifier);
    if (!organization) return null;
    return {
      id: organization.id,
      public_id: organization.public_id,
      name: organization.name,
      slug: organization.slug,
      type: organization.type,
      stripe_customer_id: organization.stripe_customer_id,
    };
  }

  async findOrganizationByPublicId(public_id: string): Promise<OrganizationBillingContext | null> {
    const organization = await this.repository.findByPublicId(public_id);
    if (!organization) return null;
    return {
      id: organization.id,
      public_id: organization.public_id,
      name: organization.name,
      slug: organization.slug,
      type: organization.type,
      stripe_customer_id: organization.stripe_customer_id,
    };
  }

  async resolveUserInternalIdByPublicId(
    user_public_id: string | undefined,
  ): Promise<number | null> {
    // An API-key principal has no acting user, so the public id is `undefined`; resolve to a
    // null actor rather than looking up an empty string.
    if (!user_public_id) return null;
    return this.repository.resolveUserIdByPublicId(user_public_id);
  }

  /**
   * Resolve a user's public id from their internal numeric id.
   *
   * @remarks
   * - **Algorithm:** delegates to
   *   {@link OrganizationRepository.resolveUserPublicIdByInternalId}, which
   *   reads the active `users` row by internal id.
   * - **Failure modes:** returns `null` when no active user matches; never
   *   throws on a miss.
   * - **Side effects:** single read-only Postgres lookup.
   * - **Notes:** the inverse of {@link resolveUserInternalIdByPublicId}; used by
   *   tenancy services that hold a membership's internal `user_id` but need the
   *   public id to invalidate the per-user permission cache.
   */
  async resolveUserPublicIdByInternalId(user_internal_id: number): Promise<string | null> {
    return this.repository.resolveUserPublicIdByInternalId(user_internal_id);
  }

  /**
   * The batch form of {@link resolveUserPublicIdByInternalId}, for a caller holding a whole
   * set of internal ids.
   *
   * @remarks
   * - **Why:** resolving a set one id at a time costs one round trip per id. The underlying
   *   `auth.resolve_user_public_ids_by_ids` resolver answers the whole set in one statement.
   * - **Failure modes:** none raised. An id with no active user is absent from the map, which
   *   is the same signal the single-id version gives with `null`.
   * - **Side effects:** one read-only Postgres lookup, or none for empty input.
   */
  async resolveUserPublicIdsByInternalIds(
    user_internal_ids: readonly number[],
  ): Promise<Map<number, string>> {
    return this.repository.resolveUserPublicIdsByInternalIds(user_internal_ids);
  }

  async updateStripeCustomerIdForOrganization({
    organization_public_id,
    stripe_customer_id,
  }: {
    organization_public_id: string;
    stripe_customer_id: string;
  }): Promise<void> {
    // tenancy.organizations is FORCE RLS — persist the Stripe customer id under the organization GUC
    // so the update is not silently dropped when called from the payment provider outside HTTP.
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization_public_id }),
      callback: async () => {
        const organization = await this.repository.findByPublicId(organization_public_id);
        if (!organization) throw new NotFoundError('Organization');
        await this.repository.updateStripeCustomerId(organization.id, stripe_customer_id);
      },
    });
  }

  /**
   * Membership gate for the single-organization reads.
   *
   * @remarks
   * This used to short-circuit for a global admin. The bypass could never fire: these reads run in
   * the caller's USER context, where `tenancy.organizations` is visible only through
   * `organizations_user_discovery` (owner or active member). No tenancy policy carries an
   * `app.global_admin` arm — that invisibility is deliberate and pinned by
   * `tenancy-global-admin-invisibility.security.test.ts` — so an admin's read returned their own
   * organizations either way and the bypass only decided whether the miss surfaced as a 404 here
   * or as an empty row set one query later. A real cross-tenant admin view needs a SECURITY DEFINER
   * resolver and a role-guarded route, not a branch here.
   */
  private async requireAccessibleOrganization({
    user_public_id,
    organization_public_id,
  }: {
    user_public_id: string;
    organization_public_id: string;
  }): Promise<Organization> {
    const organization = await this.repository.userCanAccessOrganization(
      user_public_id,
      organization_public_id,
    );
    if (!organization) {
      throw new NotFoundError('Organization');
    }
    return organization;
  }

  private async assertUserCanAccessLoadedOrganization({
    user_public_id,
    organization,
  }: {
    user_public_id: string;
    organization: Organization;
  }): Promise<void> {
    const canAccess = await this.repository.userCanAccessLoadedOrganization(
      user_public_id,
      organization,
    );
    if (!canAccess) {
      throw new NotFoundError('Organization');
    }
  }

  /**
   * The organization chooser (`GET /users/me/organizations`, route 132, feat-instagram-dm-sending UN5).
   *
   * @remarks
   * - **Algorithm:** one `withAppDatabaseContext` in the user scope (the `organizations_user_discovery`
   *   and `memberships_user_self_discovery` policies read `app.current_user_public_id`): the team
   *   organizations the caller owns or actively belongs to, `q` on the name, cursor paging; then for
   *   the page, ONE read of the caller's main roles (`tenancy.resolve_main_roles_for_user`) and ONE
   *   call of the app's counts port ({@link OrganizationCountsPort}), merged per organization.
   * - **Failure modes:** a bad query → `ValidationError`; the counts port not wired →
   *   `ConfigurationError` (a boot-order bug).
   * - **Side effects:** none — reads.
   * - **Notes:** the personal organization is never listed (plan:L7857). An organization the counts
   *   port does not answer (an owner without an active membership) reads as zero counts.
   */
  async listForUser({ query, user_public_id }: { query: unknown; user_public_id: string }) {
    const parsed = validateListOrganizationChooserQuery(query);
    const organizationCounts = this.organizationCounts;
    if (!organizationCounts) {
      throw new ConfigurationError(
        'Organization counts port is not wired (wireOrganizationCounts).',
      );
    }
    const pagination = omitUndefined({
      after: parsed.after,
      limit: parsed.limit,
      q: parsed.q,
    });
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: user_public_id }),
      callback: async () => {
        const result = await this.repository.findAllForUser(user_public_id, pagination);
        const organizationIds = result.items.map((row) => row.id);
        // Sequential, not Promise.all: the reads share this unit of work's one connection.
        const outputs = await this.toOrganizationOutputs(result.items);
        const mainRoles = await this.repository.resolveMainRolesForUser(
          user_public_id,
          organizationIds,
        );
        const counts =
          organizationIds.length === 0
            ? []
            : await organizationCounts.listOrganizationCountsForUser({
                userPublicId: user_public_id,
                organizationPublicIds: result.items.map((row) => row.public_id),
              });
        const roleByOrganizationId = new Map(mainRoles.map((row) => [row.organization_id, row]));
        const countsByPublicId = new Map(counts.map((row) => [row.organizationPublicId, row]));
        const items: OrganizationChooserOutput[] = result.items.map((row, index) => {
          const role = roleByOrganizationId.get(row.id);
          const organizationCount = countsByPublicId.get(row.public_id);
          return {
            ...outputs[index]!,
            role: role ? { id: role.role_public_id, name: role.role_name } : null,
            members_count: organizationCount?.membersCount ?? 0,
            channel_accounts_count: organizationCount?.channelAccountsCount ?? 0,
            live_automations_count: organizationCount?.liveAutomationsCount ?? 0,
          };
        });
        return { ...result, items };
      },
    });
  }

  async getByPublicId({
    public_id,
    user_public_id,
  }: {
    public_id: string;
    user_public_id: string;
  }): Promise<OrganizationOutput> {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: user_public_id }),
      callback: async () => {
        // One read, not two: the access check hands back the row it fetched.
        const organization = await this.requireAccessibleOrganization({
          user_public_id,
          organization_public_id: public_id,
        });
        return this.toOrganizationOutput(organization);
      },
    });
  }

  async getBySlug({
    slug,
    user_public_id,
  }: {
    slug: string;
    user_public_id: string;
  }): Promise<OrganizationOutput> {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: user_public_id }),
      callback: async () => {
        const organization = await this.repository.findBySlug(slug);
        if (!organization) throw new NotFoundError('Organization');
        // The row is already in hand from the slug lookup, so check against it rather
        // than re-reading the same organization by public id.
        await this.assertUserCanAccessLoadedOrganization({ user_public_id, organization });
        return this.toOrganizationOutput(organization);
      },
    });
  }

  async create({
    body,
    owner_user_public_id,
  }: {
    body: unknown;
    owner_user_public_id: string;
  }): Promise<OrganizationOutput> {
    // Capability gate: this endpoint only ever provisions a TEAM organization (personal organizations are
    // auto-provisioned, never created here). Enforce what `/users/me` advertises — in a
    // personal-only deployment (TEAM_ORGANIZATION_ENABLED=false) team-organization creation is rejected
    // server-side, not merely hidden by the frontend.
    if (!env.TEAM_ORGANIZATION_ENABLED) {
      throw new ForbiddenError('errors:teamOrganizationsDisabled');
    }
    const parsed = validateCreateOrganization(body);
    /**
     * The quota count and the slug check read under the user's identity
     * (`organizations_user_discovery`, read-only); the INSERT itself runs in the new
     * organization's own context (`provisionOrganizationWithOwner`).
     */
    const created = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: owner_user_public_id }),
      callback: async () => {
        const ownerId = await this.repository.resolveUserIdByPublicId(owner_user_public_id);
        if (ownerId === null) throw new NotFoundError('User');
        // Anti-abuse: cap the number of TEAM organizations a single account may own (personal is
        // exempt — countActiveOwnedByUser already counts only type='TEAM').
        // TEN-02 / audit-#8 / audit-R12: serialize the count + insert with ONE per-owner
        // transaction-scoped advisory lock (the canonical resource-quota lock; releases at COMMIT) so
        // concurrent creates by the same owner cannot both pass the same count and overshoot the cap.
        // Previously this path ALSO took a second, redundant lock from the parallel resource-cap-lock
        // module (now removed) — either lock alone fully serializes, so the second was dead weight.
        await this.repository.acquireOwnedOrganizationQuotaLock(ownerId);
        const ownedTeamCount = await this.repository.countActiveOwnedByUser(ownerId);
        if (ownedTeamCount >= env.MAX_TEAM_ORGANIZATIONS_PER_OWNER) {
          throw new ConflictError(
            'errors:maxTeamOrganizationsReached',
            { max: env.MAX_TEAM_ORGANIZATIONS_PER_OWNER },
            `Maximum number of team organizations (${env.MAX_TEAM_ORGANIZATIONS_PER_OWNER}) reached for this account`,
          );
        }
        // A chosen slug is checked and kept (a clash is 409, as built); without one the slug is made
        // from the name (TN7) and a clash moves on to a suffixed candidate. Only the caller's own
        // organizations are visible here (`organizations_user_discovery`), so the live-slug unique
        // index is the real arbiter: provisioning runs in its own transaction, so a collision there
        // leaves this context usable for the next candidate.
        const candidates =
          parsed.slug === undefined ? madeOrganizationSlugCandidates(parsed.name) : [parsed.slug];
        if (parsed.slug !== undefined && (await this.repository.findBySlug(parsed.slug))) {
          throw organizationSlugExistsError(parsed.slug);
        }
        for (const [attempt, slug] of candidates.entries()) {
          try {
            // Atomically create the organization AND bootstrap the owner's role + full
            // permissions + membership — without this the creator resolves zero permissions
            // on their own organization (the permission path is a strict role→membership join).
            const { organization } = await provisionOrganizationWithOwner({
              name: parsed.name,
              slug,
              type: 'TEAM',
              ownerUserId: ownerId,
              logoColor: parsed.logo_color,
            });
            return await this.toOrganizationOutput(organization);
          } catch (error) {
            // Two concurrent creates can both pass the findBySlug pre-check; the loser hits the
            // `idx_organizations_slug` unique index. Map the Postgres unique_violation to a 409
            // instead of a 500 — or, for a made slug, try the next candidate.
            if (!isPostgresUniqueViolation(error)) throw error;
            const slugTaken = getPostgresConstraintName(error) === ORGANIZATION_SLUG_UNIQUE_INDEX;
            if (slugTaken && attempt < candidates.length - 1) continue;
            throw organizationSlugExistsError(slug);
          }
        }
        throw organizationSlugExistsError(candidates.at(-1) ?? parsed.name);
      },
    });
    // After the create's own context: provisioning committed the organization in its own
    // transaction, and the fan-out reads under the new organization's scope — from inside this
    // user-scoped transaction it would hold a second pooled connection. (A brand-new organization
    // has no webhooks yet, so this reaches none; it is emitted for completeness.)
    await this.emitOrganizationEvent({ type: ORGANIZATION_EVENT.CREATED, organization: created });
    return created;
  }

  /**
   * Changes the organization (`PATCH /tenancy/organization`): name, tile colour, time zone —
   * and `status`, which only its owner may change (B2-3). The slug is read only (TN7).
   *
   * @remarks
   * - **Algorithm:** a body carrying `slug` is refused before anything is read; then, inside the
   *   organization context, a body carrying `status` is refused unless the caller is the owner (the
   *   route also demands a fresh step-up for it); the row is written and `organization.updated`
   *   emitted. After commit, a status change purges the organization's cached permissions, so
   *   suspending it stops every member at once (the owner keeps what reactivating it takes — see
   *   the permission repository).
   * - **Failure modes:** `UnprocessableEntityError` (`slug_read_only`) for a body with `slug`;
   *   `NotFoundError('Organization')`; `ForbiddenError` (`owner_only`) for a `status` from anyone
   *   but the owner, an API key included.
   * - **Side effects:** one `tenancy.organizations` write; one event; a permission-cache purge on a
   *   status change.
   */
  async update({
    scope,
    body,
    updated_by_user_public_id,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    body: unknown;
    updated_by_user_public_id: string | undefined;
  }): Promise<OrganizationOutput> {
    const public_id = scope.organizationPublicId;
    const { slug, ...changes } = validateUpdateOrganization(body);
    if (slug !== undefined) {
      // TN7: the slug is made once at create and never changes.
      throw new UnprocessableEntityError('errors:slugReadOnly').withReason('slug_read_only');
    }
    let statusChanged = false;
    const result = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.repository.findByPublicId(public_id);
        if (!organization) throw new NotFoundError('Organization');
        if (changes.status !== undefined) {
          // B2-3: suspending or archiving decides whether anyone can use the organization — the owner's
          // call alone, never an Admin's (who could otherwise lock the owner out).
          await this.assertCallerOwnsOrganization({
            organization,
            callerUserPublicId: updated_by_user_public_id,
            messageKey: 'errors:onlyOwnerCanChangeOrganizationStatus',
          });
        }
        const userId = await this.repository.resolveUserIdByPublicId(updated_by_user_public_id);
        const updated = await this.repository.update(
          public_id,
          omitUndefined(changes),
          userId ?? null,
        );
        if (!updated) throw new NotFoundError('Organization');
        statusChanged = updated.status !== organization.status;
        const output = await this.toOrganizationOutput(updated);
        await this.emitOrganizationEvent({
          type: ORGANIZATION_EVENT.UPDATED,
          organization: output,
        });
        return output;
      },
    });
    // After commit, so a racing recompute cannot re-cache the old status's permission sets.
    if (statusChanged) await invalidateOrganizationPermissions(public_id);
    return result;
  }

  /**
   * Re-drives a STUCK organization offboarding (TEN-06 reconciler entry point).
   *
   * @remarks
   * - **Algorithm:** delegates to the idempotent {@link OrganizationService.delete}
   *   sequence; `deletion_started_at` makes each step safe to re-run, so a partial
   *   offboarding resumes (logo/upload cleanup, subscription cancel, Instagram erase, soft-delete,
   *   permission-cache purge) and completes.
   * - **Failure modes:** propagates so the reconciler can count + alert and retry on
   *   the next tick; a PERSONAL organization (never deletable standalone, and excluded by the
   *   reconciler scan) would surface `ConflictError`.
   * - **Side effects:** same as `delete`.
   * - **Notes:** kept distinct from `delete` so the reconciler's intent is explicit at the call
   *   site; it re-drives a deletion the owner already started, so it runs without a caller (no
   *   owner check).
   */
  async resumeOffboarding(scope: OrganizationPrincipalDatabaseScope): Promise<void> {
    await this.offboardOrganization({
      scope,
      options: { personalAllowed: false, ownerOnly: false },
    });
  }

  /**
   * Deletes the organization on its owner's request (`DELETE /tenancy/organization`).
   *
   * @remarks
   * - **Algorithm:** the {@link OrganizationService.offboardOrganization} sequence, after checking
   *   the caller is the organization's owner — holding `organization:delete` is not enough (B2-1:
   *   a former owner, or a role edited to carry the code, must not delete the organization).
   * - **Failure modes:** `ForbiddenError('errors:onlyOwnerCanDeleteOrganization')` (`owner_only`)
   *   for anyone but the owner, an API key included; `NotFoundError('Organization')`;
   *   `ConflictError` for a PERSONAL organization.
   * - **Side effects:** as `offboardOrganization`. Returns what it erased of the organization's
   *   Instagram accounts (launch D54), for the caller's audit entry.
   */
  async delete(scope: OrganizationPrincipalDatabaseScope): Promise<OrganizationDeletionResult> {
    return this.offboardOrganization({
      scope,
      options: { personalAllowed: false, ownerOnly: true },
    });
  }

  /**
   * Tombstones the personal organization of a user whose account is being deleted — the only way a
   * PERSONAL organization is ever deleted. Same steps as {@link delete}: logo and uploads removed,
   * subscription cancelled, Instagram erased (a personal organization never has one), soft-deleted,
   * permissions purged. No-op when it is already gone.
   */
  async offboardPersonalOrganization({
    userInternalId,
    userPublicId,
  }: {
    userInternalId: number;
    userPublicId: string;
  }): Promise<void> {
    const personalOrganizationPublicId = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      callback: () => this.repository.findPersonalOrganizationPublicId(userInternalId),
    });
    if (personalOrganizationPublicId === null) return;
    await this.offboardOrganization({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: personalOrganizationPublicId }),
      options: { personalAllowed: true, ownerOnly: false },
    });
  }

  /**
   * The deletion sequence behind {@link delete}, {@link resumeOffboarding} and
   * {@link offboardPersonalOrganization}; `ownerOnly` refuses a caller who is not the owner.
   */
  private async offboardOrganization({
    scope,
    options,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    options: { personalAllowed: boolean; ownerOnly: boolean };
  }): Promise<OrganizationDeletionResult> {
    const public_id = scope.organizationPublicId;
    const organization = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const found = await this.repository.findByPublicId(public_id);
        if (!found) throw new NotFoundError('Organization');
        if (options.ownerOnly) {
          await this.assertCallerOwnsOrganization({
            organization: found,
            callerUserPublicId: scope.userPublicId,
            messageKey: 'errors:onlyOwnerCanDeleteOrganization',
          });
        }
        // A PERSONAL organization is the user's own account-level workspace — it is never
        // deletable on its own; it goes only with the account (offboardPersonalOrganization).
        if (!options.personalAllowed)
          assertTeamOrganization({ organization: found, capability: 'MUTATION' });
        const marked = await this.repository.markDeletionStarted(public_id);
        if (!(marked || found.deletion_started_at)) {
          throw new NotFoundError('Organization');
        }
        return found;
      },
    });
    // External I/O (S3) and the upload-service tombstone run outside the deletion transaction.
    await this.clearOrganizationLogoStorage({ scope, logo_url: organization.logo_url });
    if (this.offboardingDependencies) {
      await this.offboardingDependencies.uploadService.tombstoneAllByOrganizationId(
        organization.id,
      );
      // route-audit-#2: cancel the org's active subscription so deleting the organization stops Stripe
      // billing (offboarding previously never touched billing). Done BEFORE the soft-delete so a
      // Stripe failure aborts the whole delete instead of soft-deleting an organization that keeps billing.
      await this.offboardingDependencies.subscriptionService?.cancelActiveForOrganizationOffboarding(
        public_id,
      );
    }
    // Launch D54: erase the organization's Instagram accounts, so each is free to connect elsewhere and
    // no token outlives the team. The last step before the soft-delete — after a Stripe failure nothing
    // is erased, and the window a late connect could fall into is the shortest — and in the
    // organization's own scope while it is live: once soft-deleted, RLS hides its rows from that scope
    // and the erase would silently change none.
    const erasedInstagram =
      (await this.offboardingDependencies?.instagramErasureService?.eraseForOrganizationOffboarding(
        scope,
      )) ?? null;
    // The tombstoning UPDATE runs under the global-retention context: sec-new-D3 keeps
    // `deleted_at IS NULL` on the tenant SELECT arm, and Postgres requires the UPDATE's
    // NEW row to stay SELECT-visible — under the plain organization scope the soft-delete is
    // RLS-rejected (42501) AFTER Stripe cancellation already ran. The retention arm
    // covers USING, WITH CHECK, and new-row visibility; identity columns are unchanged.
    const deleted = await withMaintenanceDatabaseContext({
      scope: MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      callback: () => this.repository.softDelete(public_id),
    });
    if (!deleted) throw new NotFoundError('Organization');
    // Purge every member's cached permissions for this organization so access stops
    // immediately on soft-delete rather than lingering until the cache TTL.
    await invalidateOrganizationPermissions(public_id);
    return { erasedInstagram };
  }

  async uploadLogo({
    scope,
    body,
    updated_by_user_public_id,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    body: unknown;
    updated_by_user_public_id: string | undefined;
  }): Promise<OrganizationOutput> {
    const public_id = scope.organizationPublicId;
    const parsed = validateUploadLogo(body);
    const expectedPrefix = buildOrganizationLogoKeyPrefix(public_id);
    if (!parsed.key.startsWith(expectedPrefix)) {
      throw new ValidationError('errors:validation.logoKeyNotOwned', undefined, undefined, [
        { field: 'key', messageKey: 'errors:validation.logoKeyNotOwned' },
      ]);
    }
    if (!this.offboardingUploadService) {
      throw new Error('UploadService is not wired for logo-attach confirmation');
    }
    // The database first: the key is caller-supplied, and only a confirmed upload of THIS
    // organization may cost a storage call. The type checked is the one verified at confirm.
    const { mimeType } = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.repository.findByPublicId(public_id);
        if (!organization) throw new NotFoundError('Organization');
        return this.offboardingUploadService!.assertKeyConfirmedForOwner({
          fileKey: parsed.key,
          organizationInternalId: organization.id,
        });
      },
    });
    if (isSvgContentType(mimeType)) {
      throw new ValidationError('errors:validation.svgLogoNotAllowed', undefined, undefined, [
        { field: 'key', messageKey: 'errors:validation.svgLogoNotAllowed' },
      ]);
    }
    // External I/O (S3) runs outside the DB context. Confirmed, yet gone from storage: refuse.
    const metadata = await this.objectStorage.headObject(parsed.key);
    if (!metadata) {
      throw new ValidationError('errors:validation.logoNotFound', undefined, undefined, [
        { field: 'key', messageKey: 'errors:validation.logoNotFound' },
      ]);
    }
    // TEN-07: store the object KEY (private bucket + signed-on-read), not a permanent
    // unsigned public URL. Reads mint a short-lived signed URL via toOrganizationOutput.
    const logoStorageKey = parsed.key;
    const { serialized, previousLogoUrl } = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.repository.findByPublicId(public_id);
        if (!organization) throw new NotFoundError('Organization');
        // Re-bound in the writing transaction (route-audit L2) — not only via the key prefix, and
        // not only before the storage call — so the upload cannot be deleted between check and write.
        await this.offboardingUploadService!.assertKeyConfirmedForOwner({
          fileKey: parsed.key,
          organizationInternalId: organization.id,
        });
        const previous = organization.logo_url;
        const userId = await this.repository.resolveUserIdByPublicId(updated_by_user_public_id);
        const result = await this.repository.update(
          public_id,
          { logo_url: logoStorageKey },
          userId ?? null,
        );
        if (!result) throw new NotFoundError('Organization');
        const output = await this.toOrganizationOutput(result);
        await this.emitOrganizationEvent({
          type: ORGANIZATION_EVENT.UPDATED,
          organization: output,
        });
        return { serialized: output, previousLogoUrl: previous };
      },
    });
    // Reclaim the PREVIOUS owned logo object outside the DB context — replacing a logo previously
    // orphaned the old S3 object (storage leak). Best-effort + prefix-guarded.
    if (previousLogoUrl && previousLogoUrl !== logoStorageKey) {
      await this.deleteOwnedOrganizationLogoObject({ public_id, logo_url: previousLogoUrl });
    }
    return serialized;
  }

  async deleteLogo({
    scope,
    updated_by_user_public_id,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    updated_by_user_public_id: string | undefined;
  }): Promise<OrganizationOutput> {
    const public_id = scope.organizationPublicId;
    const organization = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const found = await this.repository.findByPublicId(public_id);
        if (!found) throw new NotFoundError('Organization');
        return found;
      },
    });
    // Reclaim the backing S3 object before clearing the column (prefix-guarded; external URLs are
    // left untouched) — previously DELETE left the object orphaned in the bucket (storage leak).
    // External I/O (S3) runs outside the DB context; best-effort, so a missing object still clears.
    await this.deleteOwnedOrganizationLogoObject({ public_id, logo_url: organization.logo_url });
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const userId = await this.repository.resolveUserIdByPublicId(updated_by_user_public_id);
        const updated = await this.repository.update(public_id, { logo_url: null }, userId ?? null);
        if (!updated) throw new NotFoundError('Organization');
        const output = await this.toOrganizationOutput(updated);
        await this.emitOrganizationEvent({
          type: ORGANIZATION_EVENT.UPDATED,
          organization: output,
        });
        return output;
      },
    });
  }
}
