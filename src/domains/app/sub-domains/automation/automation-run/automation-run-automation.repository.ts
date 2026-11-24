import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerDatabaseContext,
  resolveRepositoryDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { databaseNowTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import type { AutomationRow } from '@/domains/app/sub-domains/automation/automation.repository.js';
import { AUTOMATION_LAST_TRIGGERED_UPDATE_SECONDS } from '@/domains/app/sub-domains/automation/automation.constants.js';
import type { AutomationRunTriggerType } from './automation-run.constants.js';

/** The hello as the run engine sends it: its text and the "sends your next step" button title. */
export interface AutomationOpeningMessage {
  text: string;
  /** `null` = no button. */
  button_title: string | null;
}

/** The follow ask as the run engine sends it: its text and both button titles. */
export interface AutomationFollowRequestMessage {
  text: string;
  following_button_title: string;
  profile_button_title: string;
}

/** The email or phone ask as the run engine sends it: its text. */
export interface AutomationTextMessage {
  text: string;
}

/** One link button of the last message. */
export interface AutomationFinalMessageLink {
  title: string;
  url: string;
}

/** The last message as the run engine sends it: its text and up to three links. */
export interface AutomationFinalMessage {
  text: string;
  links: AutomationFinalMessageLink[];
}

/**
 * An automation as the run engine (sub-domain 4.B) reads it until ROUTE row R14 rebuilds the engine
 * around the new `steps` (feat-instagram-dm-sending § 4.B, AUC9): the launch's step fields, derived
 * from the shared `app.automations` row by {@link toAutomationRunAutomation} — the hello's first
 * version, the follow ask's first version, the first email / phone wording, the last text message
 * of the list as the last message, the tag step's tags; `dm_keyword` reads as `dm`, and
 * `is_dm_keyword_trigger_enabled` is "a DM may start it" (`dm_keyword` or "also start from" DM).
 */
export interface AutomationRunAutomationRow {
  id: number;
  public_id: string;
  organization_id: number;
  /** `app.instagram_accounts.id` of the automation's channel account (the engine's account key). */
  instagram_account_id: number;
  name: string;
  status: string;
  trigger_type: string;
  target_scope: string;
  target_instagram_media_id: string | null;
  target_instagram_story_id: string | null;
  next_post_starts_at: Date | null;
  next_post_ends_at: Date | null;
  next_post_status: string | null;
  next_post_linked_at: Date | null;
  is_dm_keyword_trigger_enabled: boolean;
  keywords: string[];
  tags: string[];
  is_public_reply_enabled: boolean;
  public_reply_texts: string[];
  is_opening_message_enabled: boolean;
  opening_message: AutomationOpeningMessage | null;
  is_follow_required: boolean;
  follow_request_message: AutomationFollowRequestMessage | null;
  is_email_collection_enabled: boolean;
  email_request_message: AutomationTextMessage | null;
  is_phone_collection_enabled: boolean;
  phone_request_message: AutomationTextMessage | null;
  final_message: AutomationFinalMessage;
  /** Always `0`: the counts live in `app.automation_counts` (AU19), written from R14. */
  completed_run_count: number;
  last_triggered_at: Date | null;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  deleted_at: Date | null;
  delete_reason: string | null;
  delete_note: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The engine's view of one shared automation row (see {@link AutomationRunAutomationRow}).
 *
 * @remarks
 * Pure. Parts the launch engine cannot send (the message list's other kinds and messages, versions
 * after the first, the starter / ref / ad / tag starts) are left for R14.
 */
export function toAutomationRunAutomation({
  row,
  instagramAccountId,
}: {
  row: AutomationRow;
  instagramAccountId: number;
}): AutomationRunAutomationRow {
  const steps = row.steps;
  const hello = steps.hello?.on === true ? steps.hello.versions[0] : undefined;
  const follow = steps.follow?.on === true ? steps.follow.versions[0] : undefined;
  const email = steps.email?.on === true ? steps.email.wordings[0] : undefined;
  const phone = steps.phone?.on === true ? steps.phone.wordings[0] : undefined;
  const lastText = [...(steps.messages ?? [])].reverse().find((message) => message.kind === 'text');
  return {
    id: row.id,
    public_id: row.public_id,
    organization_id: row.organization_id,
    instagram_account_id: instagramAccountId,
    name: row.name,
    status: row.status,
    trigger_type: row.trigger_type === 'dm_keyword' ? 'dm' : row.trigger_type,
    target_scope: row.target_scope,
    target_instagram_media_id: row.target_instagram_media_id,
    target_instagram_story_id: row.target_instagram_story_id,
    next_post_starts_at: row.target_scope === 'next' ? row.target_starts_at : null,
    next_post_ends_at: null,
    next_post_status: row.next_post_status,
    next_post_linked_at: row.next_post_linked_at,
    is_dm_keyword_trigger_enabled:
      row.trigger_type === 'dm_keyword' || row.also_start_from.includes('dm'),
    keywords: row.keywords,
    tags: steps.tags?.on === true ? steps.tags.list : [],
    is_public_reply_enabled: row.is_public_reply_enabled,
    public_reply_texts: row.public_reply_texts,
    is_opening_message_enabled: hello !== undefined,
    opening_message:
      hello === undefined
        ? null
        : {
            text: hello.text,
            button_title: hello.buttons.find((button) => button.action === 'next')?.title ?? null,
          },
    is_follow_required: follow !== undefined,
    follow_request_message:
      follow === undefined
        ? null
        : {
            text: follow.text,
            following_button_title: follow.following_button_title,
            profile_button_title: follow.profile_button_title,
          },
    is_email_collection_enabled: steps.email?.on === true,
    email_request_message: email === undefined ? null : { text: email },
    is_phone_collection_enabled: steps.phone?.on === true,
    phone_request_message: phone === undefined ? null : { text: phone },
    final_message:
      lastText?.kind === 'text'
        ? {
            text: lastText.text,
            links: (lastText.buttons ?? []).map((button) => ({
              title: button.title,
              url: button.url,
            })),
          }
        : { text: '', links: [] },
    completed_run_count: 0,
    last_triggered_at: row.last_triggered_at,
    created_by_user_id: row.created_by_user_id,
    updated_by_user_id: row.updated_by_user_id,
    deleted_at: row.deleted_at,
    delete_reason: row.delete_reason,
    delete_note: row.delete_note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The ways to start the launch engine answers, as stored (`dm` is `dm_keyword`). */
const ENGINE_STORED_TRIGGER_TYPES = ['comment', 'story_reply', 'dm_keyword'] as const;

/** The automation's Instagram extension id, inside the same organization. */
const OWN_INSTAGRAM_ACCOUNT = and(
  eq(instagram_accounts.organization_id, automations.organization_id),
  eq(instagram_accounts.channel_account_id, automations.channel_account_id),
);

/**
 * The run engine's reads and locks of `app.automations` (feat-instagram-dm-sending § 4.B, ROUTE row
 * R13's bridge until R14): the account's live candidates of one event, an automation as it is now,
 * the `FOR KEY SHARE` locks a run's unit takes first (D47), and `last_triggered_at`.
 *
 * @remarks
 * - **Algorithm:** each read joins the automation's Instagram extension (its `id` is the engine's
 *   account key) and maps the row through {@link toAutomationRunAutomation}. Every statement names
 *   `organization_id`.
 * - **Failure modes:** none of its own.
 * - **Side effects:** {@link AutomationRunAutomationRepository.markRunStarted} writes
 *   `last_triggered_at` only when over 60 s old (AU19) and never `updated_at`.
 */
export class AutomationRunAutomationRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /** Rows with their Instagram extension id, mapped for the engine. */
  private async select(where: SQL | undefined): Promise<AutomationRunAutomationRow[]> {
    const rows = await this.db()
      .select({ automation: automations, instagramAccountId: instagram_accounts.id })
      .from(automations)
      .innerJoin(instagram_accounts, OWN_INSTAGRAM_ACCOUNT)
      .where(where)
      .orderBy(asc(automations.created_at), asc(automations.id));
    return rows.map((row) =>
      toAutomationRunAutomation({
        row: row.automation,
        instagramAccountId: row.instagramAccountId,
      }),
    );
  }

  /**
   * The account's live automations (`status = 'live'`, not deleted), oldest first — one event's
   * candidates: one engine kind (`dm` = `dm_keyword`), or every kind a DM may start
   * (`isDmKeywordTriggerRequired`). Reads `idx_automations_live_triggers`.
   */
  async listLiveAutomationsOfAccount({
    organizationId,
    instagramAccountId,
    triggerType,
    isDmKeywordTriggerRequired,
  }: {
    organizationId: number;
    /** `app.instagram_accounts.id` of the event's account. */
    instagramAccountId: number;
    /** One engine kind; `null` = every kind the engine answers. */
    triggerType: AutomationRunTriggerType | null;
    /** Only the automations a DM may start. */
    isDmKeywordTriggerRequired: boolean;
  }): Promise<AutomationRunAutomationRow[]> {
    const storedType = triggerType === 'dm' ? 'dm_keyword' : triggerType;
    return this.select(
      and(
        eq(automations.organization_id, organizationId),
        eq(instagram_accounts.id, instagramAccountId),
        eq(automations.status, 'live'),
        sql`${automations.deleted_at} IS NULL`,
        storedType === null
          ? inArray(automations.trigger_type, [...ENGINE_STORED_TRIGGER_TYPES])
          : eq(automations.trigger_type, storedType),
        isDmKeywordTriggerRequired
          ? or(
              eq(automations.trigger_type, 'dm_keyword'),
              sql`'dm' = ANY(${automations.also_start_from})`,
            )
          : undefined,
      ),
    );
  }

  /** The organization's automation with this internal id, deleted ones included; `null` when absent. */
  async findByIdIncludingDeleted({
    organizationId,
    automationId,
  }: {
    organizationId: number;
    automationId: number;
  }): Promise<AutomationRunAutomationRow | null> {
    const [row] = await this.select(
      and(eq(automations.organization_id, organizationId), eq(automations.id, automationId)),
    );
    return row ?? null;
  }

  /** The organization's automation with this public id, deleted ones included; `null` when absent. */
  async findByPublicIdIncludingDeleted({
    organizationId,
    automationPublicId,
  }: {
    organizationId: number;
    automationPublicId: string;
  }): Promise<AutomationRunAutomationRow | null> {
    const [row] = await this.select(
      and(
        eq(automations.organization_id, organizationId),
        eq(automations.public_id, automationPublicId),
      ),
    );
    return row ?? null;
  }

  /**
   * Locks automations `FOR KEY SHARE`, by id, until the unit ends — what the run engine and the
   * contact erase take before they lock or change any run of them (D47). Nothing to lock is a no-op.
   */
  async lockForRunChanges({
    organizationId,
    automationIds,
  }: {
    organizationId: number;
    automationIds: readonly number[];
  }): Promise<void> {
    if (automationIds.length === 0) return;
    await this.db()
      .select({ id: automations.id })
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          inArray(automations.id, [...automationIds]),
        ),
      )
      .orderBy(asc(automations.id))
      .for('key share');
  }

  /**
   * The automation a run is about to start on, locked `FOR KEY SHARE` until the unit ends — proof it
   * is still live; `null` when deleted, not live or absent: nothing starts.
   */
  async lockLiveForRunStart({
    organizationId,
    automationId,
  }: {
    organizationId: number;
    automationId: number;
  }): Promise<AutomationRunAutomationRow | null> {
    const rows = await this.db()
      .select({ id: automations.id })
      .from(automations)
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.id, automationId),
          eq(automations.status, 'live'),
          sql`${automations.deleted_at} IS NULL`,
        ),
      )
      .limit(1)
      .for('key share');
    if (rows[0] === undefined) return null;
    return this.findByIdIncludingDeleted({ organizationId, automationId });
  }

  /**
   * Moves `last_triggered_at` to now when a run starts — only when over 60 s old
   * (`AUTOMATION_LAST_TRIGGERED_UPDATE_SECONDS`, AU19), so a viral automation does not rewrite its
   * row on every comment; `updated_at` is left as it is.
   */
  async markRunStarted({
    organizationId,
    automationId,
  }: {
    organizationId: number;
    automationId: number;
  }): Promise<void> {
    await this.db()
      .update(automations)
      .set({ last_triggered_at: databaseNowTimestamp })
      .where(
        and(
          eq(automations.organization_id, organizationId),
          eq(automations.id, automationId),
          sql`(${automations.last_triggered_at} IS NULL OR ${automations.last_triggered_at} < now() - make_interval(secs => ${AUTOMATION_LAST_TRIGGERED_UPDATE_SECONDS}))`,
        ),
      );
  }
}

/** {@link AutomationRunAutomationRepository} bound to a job's organization handle (the engine's units). */
export function createWorkerAutomationRunAutomationRepository(
  databaseHandle: WorkerDatabaseHandle,
): AutomationRunAutomationRepository {
  assertWorkerDatabaseContext(['organization']);
  return new AutomationRunAutomationRepository(databaseHandle);
}
