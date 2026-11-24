import { MEMBERSHIP_STATUS } from '@/domains/tenancy/sub-domains/membership/membership.constants.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { AUDIT_PERMISSIONS } from '@/domains/audit/audit.permissions.js';
import { BILLING_PERMISSIONS } from '@/domains/billing/billing.permissions.js';
import { NOTIFY_PERMISSIONS } from '@/domains/notify/notify.permissions.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { UPLOAD_PERMISSIONS } from '@/domains/upload/upload.permissions.js';
import {
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from '@/domains/tenancy/sub-domains/member-roles/member-role.constants.js';
import { MemberRoleRepository } from '@/domains/tenancy/sub-domains/member-roles/member-role.repository.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { role_permissions } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import {
  listLiveTeamOrganizationPublicIds,
  OrganizationRepository,
  organizationLogoColorFromName,
} from '@/domains/tenancy/sub-domains/organization/organization.repository.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import type { Organization } from '@/domains/tenancy/sub-domains/organization/organization.types.js';
import type { OrganizationLogoColor } from '@/domains/tenancy/sub-domains/organization/organization.constants.js';
import { invalidateOrganizationPermissions } from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import {
  MAINTENANCE_SCOPE,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { WorkerContextDatabaseHandle } from '@/infrastructure/database/utils/database-handle.types.js';
import { CHIP_TONE, type ChipTone } from '@/shared/constants/record-fields.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/** Name of the auto-provisioned, undeletable owner role created with every organization. */
export const OWNER_ROLE_NAME = 'Owner';

/** The Owner role's colour — the design's role tone (launch D81 (4)). */
const OWNER_ROLE_TONE = CHIP_TONE.SLATE;

/** Every tenancy permission code — part of the set the owner role is granted. */
const ALL_TENANCY_PERMISSION_CODES: readonly string[] = Object.values(TENANCY_PERMISSIONS);

/**
 * Every notify permission code — webhooks are a TEAM organization surface.
 *
 * @remarks
 * These codes were seeded into `tenancy.permissions` but granted to no role in
 * any organization, ever. `/notify/webhooks` therefore answered 403 to every
 * caller including the organization's own owner, and the frontend's integrations
 * panel — which gates its webhook section on `webhook:read` — rendered an
 * API-keys list under a heading that promised "API keys and webhooks". A
 * permission nothing can hold is not a security boundary, it is a dead route.
 */
const ALL_NOTIFY_PERMISSION_CODES: readonly string[] = Object.values(NOTIFY_PERMISSIONS);

/**
 * Audit and upload permission codes — granted to every owner, TEAM and PERSONAL alike.
 *
 * @remarks
 * Both were the same dead-permission shape the notify codes above describe: seeded into
 * `tenancy.permissions` and granted to no role anywhere, so the routes enforcing them
 * answered 403 to every caller including the organization's own owner. Unlike billing and
 * notify these are not team surfaces — `/tenancy/organization/audit-logs` and `/uploads` are
 * both organization-scope `both`, and a personal workspace needs `upload:manage` to set its
 * own logo — so withholding them from PERSONAL would recreate the dead route it fixes.
 */
const ALL_AUDIT_PERMISSION_CODES: readonly string[] = Object.values(AUDIT_PERMISSIONS);

const ALL_UPLOAD_PERMISSION_CODES: readonly string[] = Object.values(UPLOAD_PERMISSIONS);

/**
 * Every app permission code — Instagram, automations and contacts are a TEAM organization surface
 * (launch IA2, IA3), so like the notify codes only a TEAM Owner and Admin hold them all.
 */
const ALL_APP_PERMISSION_CODES: readonly string[] = Object.values(APP_PERMISSIONS);

/**
 * Permission codes granted to the auto-provisioned Owner role.
 *
 * @remarks
 * Every owner receives the tenancy, audit and upload codes, plus **`subscription:read`**.
 * TEAM organizations additionally receive `subscription:manage` so the creator can use the
 * billing write routes, notify read/manage so they can use `/notify/webhooks/*`, and the nine app
 * codes (Instagram, automations, contacts — launch IA2). A PERSONAL owner holds none of the app
 * codes: the surface is team-only, so its permission gate answers 403 before the team-only check
 * (launch IA3).
 *
 * A PERSONAL owner gets the billing READ code because Billing is an **account-level**
 * surface they reach, and the route catalog already says so: every `subscription:read`
 * route is organization-scope `both`, while every team-only billing route requires
 * `subscription:manage`. Withholding the read code made those `both` routes unreachable
 * for the only person who can call them — the frontend's billing panel had nothing to
 * render and went blank.
 *
 * `subscription:manage` stays TEAM-only, and that is enforced twice over: the code is not
 * granted here, and `subscription.service.ts` calls `assertTeamOrganization({ organization, capability: 'BILLING' })`
 * on every write path regardless, so a personal organization is refused with 422 even if
 * the code were somehow held.
 */
export function ownerPermissionCodesForOrganizationType(
  type: ProvisionOrganizationInput['type'],
): readonly string[] {
  const everyOwnerCodes = [
    ...ALL_TENANCY_PERMISSION_CODES,
    ...ALL_AUDIT_PERMISSION_CODES,
    ...ALL_UPLOAD_PERMISSION_CODES,
    // Billing is account-level, so a personal owner reads it too; the write half stays TEAM.
    BILLING_PERMISSIONS.SUBSCRIPTION_READ,
  ];
  if (type === 'TEAM') {
    // Only what TEAM adds ON TOP of the base. Spreading the whole billing set here would
    // repeat `subscription:read`, and `role_permissions` is keyed on
    // (role_id, permission_code) — so provisioning a TEAM organization died on a duplicate
    // key rather than granting anything twice.
    return [
      ...everyOwnerCodes,
      BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE,
      ...ALL_NOTIFY_PERMISSION_CODES,
      ...ALL_APP_PERMISSION_CODES,
    ];
  }
  return everyOwnerCodes;
}

/** A default non-owner role auto-provisioned into every TEAM organization. */
export interface DefaultTeamRole {
  /** Role name; unique within the organization, fixed for a system role. */
  name: string;
  /** Purpose line shown under the name (Users › Roles). */
  description: string;
  /** The role's colour — the design's role tones (D81 (4)). */
  tone: ChipTone;
  /** A locked role's access cannot be changed (Admin, D40; Owner is locked too). */
  isLocked: boolean;
  /** The permission codes granted at provisioning. */
  permissionCodes: readonly string[];
}

/**
 * Admin's codes: every team code but `organization:delete` (D8), billing, webhooks, audit logs,
 * uploads and the nine app codes (launch IA2).
 *
 * @remarks
 * Escalation to Owner stays closed on three independent paths —
 * `assertCallerCanGrantPermissionCodes` limits any grant to codes the caller already holds (so an
 * Admin can never hand out `organization:delete`), the same guard runs on membership create and
 * update (so an Admin cannot assign the Owner role to anyone), and `is_locked` blocks editing the
 * Owner role's codes (launch D81 (4)).
 */
const ADMIN_PERMISSION_CODES: readonly string[] = [
  TENANCY_PERMISSIONS.ORGANIZATION_READ,
  TENANCY_PERMISSIONS.ORGANIZATION_UPDATE,
  TENANCY_PERMISSIONS.MEMBERSHIP_READ,
  TENANCY_PERMISSIONS.MEMBERSHIP_CREATE,
  TENANCY_PERMISSIONS.MEMBERSHIP_UPDATE,
  TENANCY_PERMISSIONS.MEMBERSHIP_DELETE,
  TENANCY_PERMISSIONS.ROLE_READ,
  TENANCY_PERMISSIONS.ROLE_CREATE,
  TENANCY_PERMISSIONS.ROLE_UPDATE,
  TENANCY_PERMISSIONS.ROLE_DELETE,
  TENANCY_PERMISSIONS.API_KEY_READ,
  TENANCY_PERMISSIONS.API_KEY_MANAGE,
  TENANCY_PERMISSIONS.NOTIFICATION_POLICY_READ,
  TENANCY_PERMISSIONS.NOTIFICATION_POLICY_MANAGE,
  BILLING_PERMISSIONS.SUBSCRIPTION_READ,
  BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE,
  NOTIFY_PERMISSIONS.WEBHOOK_READ,
  NOTIFY_PERMISSIONS.WEBHOOK_MANAGE,
  AUDIT_PERMISSIONS.AUDIT_LOG_READ,
  UPLOAD_PERMISSIONS.UPLOAD_MANAGE,
  ...ALL_APP_PERMISSION_CODES,
];

/**
 * Member's codes (launch D2, K4, D31): view the organization, view the Instagram account, view,
 * create and edit automations, view contacts — exactly these six. Connecting or managing Instagram,
 * deleting an automation or a contact and the Instagram webhook-event list stay with Owner and Admin.
 */
const MEMBER_PERMISSION_CODES: readonly string[] = [
  TENANCY_PERMISSIONS.ORGANIZATION_READ,
  APP_PERMISSIONS.INSTAGRAM_ACCOUNT_READ,
  APP_PERMISSIONS.AUTOMATION_READ,
  APP_PERMISSIONS.AUTOMATION_CREATE,
  APP_PERMISSIONS.AUTOMATION_UPDATE,
  APP_PERMISSIONS.CONTACT_READ,
];

/**
 * Non-owner system roles every TEAM organization holds — Admin and Member — so a new organization
 * can invite its team straight away.
 *
 * @remarks
 * - Every entry is `is_system: true`: its name is fixed and it cannot be deleted. Both are locked
 *   (Admin D40, Member launch D3): their codes never change through the API — the guards read the
 *   row's `is_system` / `is_locked` flags, not its name. The Owner role is locked as well (D81 (4)).
 * - PERSONAL organizations are single-member and reject custom roles, so they receive only Owner;
 *   these defaults apply to TEAM organizations exclusively.
 * - The one definition both provisioning and {@link reconcileDefaultTeamRoles} apply, so a team
 *   created before a change here gets exactly what a new one gets.
 * - Every permission code must exist in the seeded `tenancy.permissions` reference table (the grant
 *   insert carries an FK to it).
 */
export const DEFAULT_TEAM_ROLES: readonly DefaultTeamRole[] = [
  {
    name: ADMIN_ROLE_NAME,
    description: 'Runs the organization: settings, team and roles.',
    tone: CHIP_TONE.LAVENDER,
    isLocked: true,
    permissionCodes: ADMIN_PERMISSION_CODES,
  },
  {
    name: MEMBER_ROLE_NAME,
    description: 'Does the daily work: Instagram content, automations and contacts.',
    tone: CHIP_TONE.SAGE,
    isLocked: true,
    permissionCodes: MEMBER_PERMISSION_CODES,
  },
];

/** Input for {@link provisionOrganizationWithOwner}. */
export interface ProvisionOrganizationInput {
  name: string;
  /** Null for a PERSONAL organization; kebab string for a TEAM. */
  slug: string | null;
  type: 'PERSONAL' | 'TEAM';
  ownerUserId: number;
  /** The chosen tile colour; absent → the name's colour ({@link organizationLogoColorFromName}). */
  logoColor?: OrganizationLogoColor | undefined;
}

/** Result of {@link provisionOrganizationWithOwner}. */
export interface ProvisionOrganizationResult {
  organization: Organization;
  roleId: number;
  membershipPublicId: string;
}

/**
 * Atomically bootstrap an organization with full owner access: organization row →
 * system, locked `Owner` role (slate) → every tenancy, audit and upload permission granted to it (plus billing,
 * notify read/manage and the app codes for TEAM organizations) → the owner's ACTIVE membership. Without this, a freshly created
 * organization's owner resolves zero permissions (the permission path is a strict
 * role→membership join with no owner shortcut).
 *
 * @remarks
 * - **Algorithm:** pre-generates the organization `public_id` and runs every insert inside one
 *   `withAppDatabaseContext(PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: publicId }), …)` transaction, so `app.current_organization_public_id`
 *   equals the organization being created. The organization row then satisfies its tenant-isolation WITH CHECK
 *   (`public_id = app.current_organization_public_id`) and the child rows (roles, role_permissions,
 *   memberships) satisfy theirs (`organization_id` → the just-inserted organization) — all under the
 *   non-superuser `meepzo_be_app` role with NO admin escape hatch (the tenancy policies do not honor
 *   `app.global_admin`; only `auth`/`audit` do, which is why the former global-admin path failed
 *   its WITH CHECK with 42501 in deployed environments). One transaction keeps the owner-bootstrap
 *   atomic — a partial failure can never leave an organization whose owner has no access. TEAM
 *   organizations additionally insert the default {@link DEFAULT_TEAM_ROLES}
 *   (the default team roles) and their grants so a new team can assign a role and invite members
 *   immediately; PERSONAL organizations get Owner only. This is a server-side bootstrap only;
 *   the inputs are not user-controlled beyond name/slug/type.
 * - **Failure modes:** the whole transaction rolls back on any insert failure (unique slug,
 *   one-personal-per-owner index, missing permission reference rows). Callers map
 *   `unique_violation` to a 409.
 * - **Side effects:** table inserts (organizations, roles, role_permissions, memberships); TEAM
 *   organizations additionally insert the default team roles (Admin and Member, both locked) and
 *   their grants.
 * - **Notes:** the owner and default roles are `is_system: true` so they cannot be deleted via the
 *   role API; the Owner role is also `is_locked` (launch D81 (4) — its codes never change through
 *   the API, `PUT …/roles/{role_id}/permissions` answers 403 `role_locked`). Permission reference
 *   rows (the `permissions` table) are assumed seeded — they are reference data present in every
 *   environment.
 */
export async function provisionOrganizationWithOwner(
  input: ProvisionOrganizationInput,
): Promise<ProvisionOrganizationResult> {
  return provisionOrganization(input);
}

/** Default display name for an auto-provisioned personal organization. */
export const PERSONAL_ORGANIZATION_NAME = 'Personal';

/**
 * Provision the single PERSONAL organization for a user at signup: a `type=PERSONAL`,
 * slug-less organization owned by the user, with full owner access. The partial unique
 * index guarantees at most one personal organization per owner.
 */
export async function provisionPersonalOrganization({
  ownerUserId,
  name = PERSONAL_ORGANIZATION_NAME,
}: {
  ownerUserId: number;
  name?: string | undefined;
}): Promise<ProvisionOrganizationResult> {
  return provisionOrganization({
    name,
    slug: null,
    type: 'PERSONAL',
    ownerUserId,
  });
}

async function provisionOrganization(
  input: ProvisionOrganizationInput,
): Promise<ProvisionOrganizationResult> {
  // Pre-generate the organization public_id so the entire owner-bootstrap runs INSIDE the new org's own
  // RLS context (`app.current_organization_public_id` = this id): every tenant-isolation WITH CHECK then
  // passes naturally — the organization row (`public_id = app.current_organization_public_id`) and its child rows
  // (roles, role_permissions, memberships, all `organization_id`-scoped to the just-inserted organization).
  // This replaces `withMaintenanceDatabaseContext`, which was both improper on a self-service
  // login/signup path AND ineffective: the tenancy policies never honor `app.global_admin` (only
  // auth/audit do), so the organization INSERT failed its WITH CHECK with SQLSTATE 42501 under the
  // non-superuser `meepzo_be_app` role in deployed environments.
  const organizationPublicId = generatePublicId('organization');
  return withAppDatabaseContext({
    scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organizationPublicId }),
    callback: async (databaseHandle) => {
      const [organization] = await databaseHandle
        .insert(organizations)
        .values({
          public_id: organizationPublicId,
          name: input.name,
          slug: input.slug,
          type: input.type,
          logo_color: input.logoColor ?? organizationLogoColorFromName(input.name),
          owner_user_id: input.ownerUserId,
          created_by_user_id: input.ownerUserId,
          updated_by_user_id: input.ownerUserId,
        })
        .returning();

      const [role] = await databaseHandle
        .insert(roles)
        .values({
          public_id: generatePublicId('memberRole'),
          organization_id: organization!.id,
          name: OWNER_ROLE_NAME,
          tone: OWNER_ROLE_TONE,
          is_system: true,
          is_locked: true,
          created_by_user_id: input.ownerUserId,
        })
        .returning();

      await databaseHandle.insert(role_permissions).values(
        ownerPermissionCodesForOrganizationType(input.type).map((permission_code) => ({
          role_id: role!.id,
          permission_code,
          created_by_user_id: input.ownerUserId,
        })),
      );

      const [membership] = await databaseHandle
        .insert(memberships)
        .values({
          public_id: generatePublicId('membership'),
          user_id: input.ownerUserId,
          organization_id: organization!.id,
          role_id: role!.id,
          status: MEMBERSHIP_STATUS.ACTIVE,
          joined_at: new Date(),
        })
        .returning();

      // TEAM organizations also receive the default roles (Admin, Member) so the team can invite
      // straight away — through the same step the reconcile runs for teams that already exist.
      // PERSONAL organizations are single-member and reject custom roles, so they get Owner only.
      if (input.type === 'TEAM') {
        await ensureDefaultTeamRoles({
          databaseHandle,
          organizationId: organization!.id,
          actorUserId: input.ownerUserId,
        });
      }

      return {
        organization: organization! as Organization,
        roleId: role!.id,
        membershipPublicId: membership!.public_id,
      };
    },
  });
}

/** Reads and renames for the default-team-roles step; the inserts stay on the unit of work's handle. */
const memberRoleRepository = new MemberRoleRepository();

/** Reads the organization the per-organization reconcile works on. */
const organizationRepository = new OrganizationRepository();

/** What {@link ensureDefaultTeamRoles} changed in one TEAM organization; all empty when nothing. */
export interface DefaultTeamRolesChange {
  /** Names of the default roles it added. */
  addedRoleNames: string[];
  /** Custom roles it renamed because they held a default role's name (launch IQ5). */
  renamedRoles: Array<{ rolePublicId: string; fromName: string; toName: string }>;
  /** Permission grants it added to the Owner and the default roles. */
  grantedCodeCount: number;
}

/** The name a custom role moves to when a default role needs its name: "Member (custom)". */
function customRoleNameFor({
  name,
  takenNames,
}: {
  name: string;
  takenNames: ReadonlySet<string>;
}): string {
  const preferred = `${name} (custom)`;
  if (!takenNames.has(preferred)) return preferred;
  // The organization already has a "Member (custom)" too: count on until a name is free.
  let counter = 2;
  while (takenNames.has(`${name} (custom ${counter})`)) counter += 1;
  return `${name} (custom ${counter})`;
}

/**
 * The one step that gives a TEAM organization its default roles — run by provisioning (a new team)
 * and by the reconcile (a team that already exists), so the two never drift.
 *
 * @remarks
 * - **Algorithm:** inside the caller's organization-scoped unit of work: reads the live roles; for
 *   each {@link DEFAULT_TEAM_ROLES} entry with no live system role of its name, renames a live
 *   custom role holding that name to "<name> (custom)" — keeping its id, people and codes (launch
 *   IQ5) — and inserts the system role (tone, description, lock from the definition); then grants
 *   the TEAM Owner codes to the live `Owner` system role and each default role its codes, `ON
 *   CONFLICT DO NOTHING`, so only missing grants land. Owner, Admin and Member are all locked, so
 *   adding their missing codes never undoes an organization's own choice.
 * - **Failure modes:** propagates database errors; the caller's transaction rolls back whole.
 * - **Side effects:** may update `tenancy.roles` (the rename), insert `tenancy.roles` and
 *   `tenancy.role_permissions`. Invalidating the permission cache is the caller's (after commit).
 */
async function ensureDefaultTeamRoles({
  databaseHandle,
  organizationId,
  actorUserId,
}: {
  databaseHandle: WorkerContextDatabaseHandle;
  organizationId: number;
  /** Who the rows are attributed to — the owner at provisioning, nobody for the reconcile. */
  actorUserId: number | null;
}): Promise<DefaultTeamRolesChange> {
  const liveRoles = await memberRoleRepository.findLiveRoleSummariesForOrganization(organizationId);
  const takenNames = new Set(liveRoles.map((role) => role.name));
  const change: DefaultTeamRolesChange = {
    addedRoleNames: [],
    renamedRoles: [],
    grantedCodeCount: 0,
  };
  const grants: Array<{ roleId: number; permissionCodes: readonly string[] }> = [];

  const ownerRole = liveRoles.find((role) => role.is_system && role.name === OWNER_ROLE_NAME);
  if (ownerRole) {
    grants.push({
      roleId: ownerRole.id,
      permissionCodes: ownerPermissionCodesForOrganizationType('TEAM'),
    });
  }

  for (const defaultRole of DEFAULT_TEAM_ROLES) {
    const holder = liveRoles.find((role) => role.name === defaultRole.name);
    if (holder?.is_system) {
      grants.push({ roleId: holder.id, permissionCodes: defaultRole.permissionCodes });
      continue;
    }
    if (holder) {
      const toName = customRoleNameFor({ name: defaultRole.name, takenNames });
      await memberRoleRepository.update(
        holder.public_id,
        organizationId,
        { name: toName },
        actorUserId,
      );
      takenNames.add(toName);
      change.renamedRoles.push({
        rolePublicId: holder.public_id,
        fromName: holder.name,
        toName,
      });
    }
    const [created] = await databaseHandle
      .insert(roles)
      .values({
        public_id: generatePublicId('memberRole'),
        organization_id: organizationId,
        name: defaultRole.name,
        description: defaultRole.description,
        tone: defaultRole.tone,
        is_system: true,
        is_locked: defaultRole.isLocked,
        created_by_user_id: actorUserId,
      })
      .returning({ id: roles.id });
    change.addedRoleNames.push(defaultRole.name);
    grants.push({ roleId: created!.id, permissionCodes: defaultRole.permissionCodes });
  }

  for (const grant of grants) {
    if (grant.permissionCodes.length === 0) continue;
    const inserted = await databaseHandle
      .insert(role_permissions)
      .values(
        grant.permissionCodes.map((permission_code) => ({
          role_id: grant.roleId,
          permission_code,
          created_by_user_id: actorUserId,
        })),
      )
      .onConflictDoNothing()
      .returning({ permission_code: role_permissions.permission_code });
    change.grantedCodeCount += inserted.length;
  }
  return change;
}

/** Whether {@link ensureDefaultTeamRoles} changed anything. */
function hasDefaultTeamRolesChange(change: DefaultTeamRolesChange): boolean {
  return (
    change.addedRoleNames.length > 0 ||
    change.renamedRoles.length > 0 ||
    change.grantedCodeCount > 0
  );
}

/**
 * Brings one existing TEAM organization's default roles up to {@link DEFAULT_TEAM_ROLES} and its
 * Owner's codes up to {@link ownerPermissionCodesForOrganizationType}, inside that organization's
 * own scope.
 *
 * @remarks
 * - **Algorithm:** one `withAppDatabaseContext(PRINCIPAL_SCOPE.VERIFIED(...))` unit of work — the
 *   organization was resolved by the caller (the reconcile's lister, or the seed that created it) —
 *   reads the live organization and, when it is TEAM, runs {@link ensureDefaultTeamRoles}. After the
 *   commit it logs each renamed custom role (launch IQ5).
 * - **Failure modes:** propagates database errors (that organization's changes roll back).
 * - **Side effects:** see {@link ensureDefaultTeamRoles}.
 * - **Notes:** returns null for an organization that is gone or PERSONAL. Safe to repeat: a second
 *   run finds nothing to add and changes nothing. It does not touch the permission cache: a caller
 *   that changes an organization whose members may hold cached sets invalidates it after (as
 *   {@link reconcileDefaultTeamRoles} does); the bulk seed, whose organizations are new, needs not.
 */
export async function reconcileTeamOrganizationDefaultRoles({
  organizationPublicId,
}: {
  organizationPublicId: string;
}): Promise<DefaultTeamRolesChange | null> {
  const change = await withAppDatabaseContext({
    scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId }),
    callback: async (databaseHandle) => {
      const organization = await organizationRepository.findByPublicId(organizationPublicId);
      if (organization?.type !== 'TEAM') return null;
      return ensureDefaultTeamRoles({
        databaseHandle,
        organizationId: organization.id,
        actorUserId: null,
      });
    },
  });
  for (const renamed of change?.renamedRoles ?? []) {
    logger.info(
      { organizationPublicId, ...renamed },
      'tenancy.default_team_roles.custom_role_renamed',
    );
  }
  return change;
}

/** What {@link reconcileDefaultTeamRoles} did across every TEAM organization. */
export interface DefaultTeamRolesReconcileResult {
  /** Live TEAM organizations it checked. */
  organizations: number;
  /** Of those, the ones where something changed. */
  changedOrganizations: number;
  /** Default roles added. */
  addedRoles: number;
  /** Custom roles renamed to free a default role's name (launch IQ5). */
  renamedRoles: number;
  /** Permission grants added. */
  grantedCodes: number;
}

/**
 * Gives every existing TEAM organization what provisioning gives a new one (launch IA2, D3, IQ5):
 * any missing default role (Member), the missing codes on Owner and the default roles, and a fresh
 * permission cache where something changed. Run by `prepareDatabase` right after the permission
 * catalog is seeded, so every deploy and test database gets it.
 *
 * @remarks
 * - **Algorithm:** lists the public ids of the live TEAM organizations under the
 *   `app.global_retention_cleanup` arm (read only — the account-deletion pattern: a cross-tenant
 *   list on the maintenance pool, since the tenant policies show no organization before a GUC is
 *   set), then reconciles each one in its OWN `VERIFIED` scope through
 *   {@link reconcileTeamOrganizationDefaultRoles}, one transaction per organization, and invalidates
 *   the permission cache of each organization that changed, after its commit. No write runs under
 *   the bypass arm.
 * - **Failure modes:** propagates the first failing organization's error; organizations reconciled
 *   before it keep their changes, and a re-run picks up the rest. A cache invalidation failure is
 *   logged and closed by the permission cache itself, never thrown.
 * - **Side effects:** see {@link reconcileTeamOrganizationDefaultRoles}; one permission-cache
 *   version bump per changed organization.
 * - **Notes:** idempotent — a second run reports zero changes. Needs the permission catalog seeded
 *   first (the grants carry an FK to it).
 */
export async function reconcileDefaultTeamRoles(): Promise<DefaultTeamRolesReconcileResult> {
  const teamOrganizationPublicIds = await withMaintenanceDatabaseContext({
    scope: MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
    callback: (databaseHandle) => listLiveTeamOrganizationPublicIds(databaseHandle),
  });
  const result: DefaultTeamRolesReconcileResult = {
    organizations: teamOrganizationPublicIds.length,
    changedOrganizations: 0,
    addedRoles: 0,
    renamedRoles: 0,
    grantedCodes: 0,
  };
  for (const organizationPublicId of teamOrganizationPublicIds) {
    const change = await reconcileTeamOrganizationDefaultRoles({ organizationPublicId });
    if (change === null || !hasDefaultTeamRolesChange(change)) continue;
    // After its commit: members of an existing organization may hold a cached permission set.
    await invalidateOrganizationPermissions(organizationPublicId);
    result.changedOrganizations += 1;
    result.addedRoles += change.addedRoleNames.length;
    result.renamedRoles += change.renamedRoles.length;
    result.grantedCodes += change.grantedCodeCount;
  }
  return result;
}
