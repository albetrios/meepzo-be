import { and, eq, inArray } from 'drizzle-orm';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import type { AutomationSteps } from '@/domains/app/sub-domains/automation/automation-steps.dto.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { AutomationRepository } from '@/domains/app/sub-domains/automation/automation.repository.js';
import { AutomationService } from '@/domains/app/sub-domains/automation/automation.service.js';
import { AutomationCountRepository } from '@/domains/app/sub-domains/automation/automation-count.repository.js';
import { AutomationCountService } from '@/domains/app/sub-domains/automation/automation-count.service.js';
import { AutomationReplyStateRepository } from '@/domains/app/sub-domains/automation/automation-reply-state.repository.js';
import { AutomationReplyStateService } from '@/domains/app/sub-domains/automation/automation-reply-state.service.js';
import type { AutomationOpenRunCancelStep } from '@/domains/app/sub-domains/automation/automation.types.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { entitlementSnapshotOf } from '@/domains/app/__tests__/factories/entitlement.factory.js';

/** `GET` / `POST /app/automations` (routes 27–28). */
export const AUTOMATIONS_PATH = testApiPath('/app/automations');

/** `GET` / `PATCH` / `DELETE /app/automations/{automation_id}` (routes 29–31). */
export function automationPath(automationPublicId: string): string {
  return `${AUTOMATIONS_PATH}/${automationPublicId}`;
}

/** `POST /app/automations/{automation_id}/<action>` (routes 32–35). */
export function automationActionPath({
  automationPublicId,
  action,
}: {
  automationPublicId: string;
  action: 'go-live' | 'pause' | 'duplicate' | 'keyword-test';
}): string {
  return `${automationPath(automationPublicId)}/${action}`;
}

/** The launch engine's default email ask (`common:automation.emailQuestion`) — a fixture's wording when it names none. */
const LEGACY_EMAIL_QUESTION = 'Please share your email to continue!';

/** The launch engine's default phone ask (`common:automation.phoneQuestion`). */
const LEGACY_PHONE_QUESTION = 'Please share your phone number to continue!';

/** One `app.automations` row as the fixtures write and read it. */
export type AutomationFixtureRow = typeof automations.$inferSelect;

/** The smallest steps that pass go-live for a comment: a hello with its next button, one text message. */
export function completeAutomationSteps(overrides: Partial<AutomationSteps> = {}): AutomationSteps {
  return {
    hello: {
      on: true,
      versions: [
        { text: 'Thanks for your comment!', buttons: [{ title: 'Send it', action: 'next' }] },
      ],
    },
    messages: [
      {
        kind: 'text',
        wait_minutes: 0,
        text: 'Here you go',
        buttons: [{ title: 'Shop', url: 'https://shop.example.com' }],
      },
    ],
    ...overrides,
  };
}

/** The smallest draft body (route 28): a name, the account and a way to start, with complete steps. */
export function commentAutomationBody({
  channelAccountPublicId,
  overrides = {},
}: {
  channelAccountPublicId: string;
  overrides?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    name: 'Comment for the link',
    channel_account_id: channelAccountPublicId,
    trigger_type: 'comment',
    steps: completeAutomationSteps(),
    ...overrides,
  };
}

/**
 * The launch's step fields a run-engine fixture still names (the engine reads automations through
 * its step view until ROUTE row R14): each maps onto the shared shape's `steps`.
 */
export interface LegacyAutomationFixtureFields {
  is_opening_message_enabled?: boolean;
  opening_message?: { text: string; button_title?: string | null } | null;
  is_follow_required?: boolean;
  follow_request_message?: {
    text: string;
    following_button_title: string;
    profile_button_title: string;
  } | null;
  is_email_collection_enabled?: boolean;
  email_request_message?: { text: string } | null;
  is_phone_collection_enabled?: boolean;
  phone_request_message?: { text: string } | null;
  final_message?: { text: string; links?: { title: string; url: string }[] };
  tags?: string[];
  is_dm_keyword_trigger_enabled?: boolean;
  /** The launch's window start — the go-live time of a `next` automation now. */
  next_post_starts_at?: Date | null;
  /** Gone (P12) — ignored. */
  next_post_ends_at?: Date | null;
}

/**
 * The `steps` and start fields of a launch-shaped fixture: the opening message with its button is
 * the hello (P2 — an opening without a button has no counterpart and is left out), the final
 * message the one text message.
 */
function stepsFromLegacy(legacy: LegacyAutomationFixtureFields): {
  steps: AutomationSteps;
  alsoStartFromDm: boolean;
} {
  const opening =
    legacy.is_opening_message_enabled === false
      ? null
      : legacy.opening_message === undefined
        ? { text: 'Hi there', button_title: 'Send it' }
        : legacy.opening_message;
  const final = legacy.final_message ?? { text: 'Here you go', links: [] };
  const finalMessage = {
    kind: 'text' as const,
    wait_minutes: 0,
    text: final.text,
    ...((final.links ?? []).length > 0 ? { buttons: final.links ?? [] } : {}),
  };
  const hasButton = opening !== null && (opening.button_title ?? null) !== null;
  const steps: AutomationSteps = {
    ...(hasButton
      ? {
          hello: {
            on: true,
            versions: [
              {
                text: opening.text,
                buttons: [{ title: opening.button_title as string, action: 'next' as const }],
              },
            ],
          },
        }
      : {}),
    ...(legacy.is_follow_required === true && legacy.follow_request_message
      ? { follow: { on: true, versions: [legacy.follow_request_message] } }
      : {}),
    ...(legacy.is_email_collection_enabled === true
      ? {
          email: {
            on: true,
            wordings: [legacy.email_request_message?.text ?? LEGACY_EMAIL_QUESTION],
          },
        }
      : {}),
    ...(legacy.is_phone_collection_enabled === true
      ? {
          phone: {
            on: true,
            wordings: [legacy.phone_request_message?.text ?? LEGACY_PHONE_QUESTION],
          },
        }
      : {}),
    messages: [finalMessage],
    ...(legacy.tags !== undefined && legacy.tags.length > 0
      ? { tags: { on: true, list: legacy.tags } }
      : {}),
  };
  return { steps, alsoStartFromDm: legacy.is_dm_keyword_trigger_enabled === true };
}

/** The channel account of an Instagram extension row, read as the operator. */
async function channelAccountIdOfInstagramAccount({
  organizationId,
  instagramAccountId,
}: {
  organizationId: number;
  instagramAccountId: number;
}): Promise<number> {
  const [row] = await getOperatorDatabase()
    .select({ channelAccountId: instagram_accounts.channel_account_id })
    .from(instagram_accounts)
    .where(
      and(
        eq(instagram_accounts.organization_id, organizationId),
        eq(instagram_accounts.id, instagramAccountId),
      ),
    )
    .limit(1);
  if (row === undefined) throw new Error('automation fixture: no such Instagram account');
  return row.channelAccountId;
}

/** Every column a fixture may set, and the launch's step fields the run-engine fixtures still name. */
export type AutomationFixtureOverrides = LegacyAutomationFixtureFields &
  Partial<
    Omit<
      AutomationFixtureRow,
      'id' | 'organization_id' | 'channel_account_id' | 'status' | 'trigger_type'
    >
  > & { status?: string; trigger_type?: string };

/**
 * Inserts one automation through the operator; every column may be overridden. Name the account by
 * `channelAccountId`, or by the Instagram extension's `instagramAccountId` (the run-engine
 * fixtures). The default is a `draft` comment automation on any post with a hello and one text
 * message; the launch's step fields ({@link LegacyAutomationFixtureFields}) map onto `steps`, a
 * launch `inactive` status onto `paused`, a launch `dm` onto `dm_keyword`.
 */
export async function insertAutomation({
  organizationId,
  instagramAccountId,
  channelAccountId,
  ...overrides
}: {
  organizationId: number;
  instagramAccountId?: number;
  channelAccountId?: number;
} & AutomationFixtureOverrides): Promise<AutomationFixtureRow> {
  const {
    is_opening_message_enabled,
    opening_message,
    is_follow_required,
    follow_request_message,
    is_email_collection_enabled,
    email_request_message,
    is_phone_collection_enabled,
    phone_request_message,
    final_message,
    tags,
    is_dm_keyword_trigger_enabled,
    next_post_starts_at,
    next_post_ends_at: _nextPostEndsAt,
    status,
    trigger_type,
    ...columns
  } = overrides;
  const resolvedChannelAccountId =
    channelAccountId ??
    (await channelAccountIdOfInstagramAccount({
      organizationId,
      instagramAccountId: instagramAccountId ?? 0,
    }));
  const legacy = stepsFromLegacy({
    is_opening_message_enabled,
    opening_message,
    is_follow_required,
    follow_request_message,
    is_email_collection_enabled,
    email_request_message,
    is_phone_collection_enabled,
    phone_request_message,
    final_message,
    tags,
    is_dm_keyword_trigger_enabled,
  } as LegacyAutomationFixtureFields);
  const triggerType = trigger_type === 'dm' ? 'dm_keyword' : (trigger_type ?? 'comment');
  const [automation] = await getOperatorDatabase()
    .insert(automations)
    .values({
      public_id: generatePublicId('automation'),
      organization_id: organizationId,
      channel_account_id: resolvedChannelAccountId,
      name: 'Fixture automation',
      trigger_type: triggerType,
      status: status === 'inactive' ? 'paused' : (status ?? 'draft'),
      steps: legacy.steps,
      also_start_from: legacy.alsoStartFromDm && triggerType === 'comment' ? ['dm'] : [],
      ...(next_post_starts_at === undefined ? {} : { target_starts_at: next_post_starts_at }),
      ...columns,
    })
    .returning();
  if (automation === undefined) throw new Error('automation fixture insert returned no row');
  return automation;
}

/** One automation row by its public id, read as the operator (deleted rows included). */
export async function readAutomationRow(
  automationPublicId: string,
): Promise<AutomationFixtureRow | undefined> {
  const rows = await getOperatorDatabase()
    .select()
    .from(automations)
    .where(eq(automations.public_id, automationPublicId))
    .limit(1);
  return rows[0];
}

/** Revokes an organization's Instagram account through the operator, as a disconnect leaves it. */
export async function revokeInstagramAccount({
  organizationId,
  instagramAccountId,
}: {
  organizationId: number;
  instagramAccountId: number;
}): Promise<void> {
  // The status is the channel account's since R6 (2.A.3).
  const channelAccountIdOf = getOperatorDatabase()
    .select({ id: instagram_accounts.channel_account_id })
    .from(instagram_accounts)
    .where(
      and(
        eq(instagram_accounts.organization_id, organizationId),
        eq(instagram_accounts.id, instagramAccountId),
      ),
    );
  await getOperatorDatabase()
    .update(channel_accounts)
    .set({ connection_status: 'revoked', disconnected_at: new Date() })
    .where(
      and(
        eq(channel_accounts.organization_id, organizationId),
        inArray(channel_accounts.id, channelAccountIdOf),
      ),
    );
}

/**
 * An automation service for the suites that only delete or link (the run engine's lock order,
 * event processing): the real repositories, with no account, plan or later-row port — the reads
 * those paths never make answer empty.
 */
export function createTestAutomationService({
  organizationService,
  openRunCancelSteps = [],
}: {
  organizationService: OrganizationService;
  openRunCancelSteps?: readonly AutomationOpenRunCancelStep[];
}): AutomationService {
  return new AutomationService(
    new AutomationRepository(),
    new AutomationCountService(new AutomationCountRepository()),
    new AutomationReplyStateService(new AutomationReplyStateRepository()),
    {
      readAutomationAccount: async () => null,
      listChannelAccountAutomationProblems: async () => [],
    },
    { resolve: async () => entitlementSnapshotOf({ features: null }) },
    organizationService,
    openRunCancelSteps,
  );
}
