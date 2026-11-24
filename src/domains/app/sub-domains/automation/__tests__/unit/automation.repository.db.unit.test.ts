import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import {
  getPostgresConstraintName,
  getPostgresErrorCode,
} from '@/shared/utils/infrastructure/postgres-error.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { AutomationCountRepository } from '@/domains/app/sub-domains/automation/automation-count.repository.js';
import { AutomationCountService } from '@/domains/app/sub-domains/automation/automation-count.service.js';
import {
  type AutomationFixtureOverrides,
  createTestAutomationService,
  completeAutomationSteps,
  insertAutomation,
  readAutomationRow,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { insertAutomationRun } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The shared automations' own SQL against the database (feat-instagram-dm-sending routes-final
 * § 4.A.3 — AU9, AU19, AU20): the table's go-live CHECKs on a live row only, the per-account unique
 * `ref_code`, the 16 count slots summed and kept after a run is gone, "next post" linking with no end
 * date, and the two contact keys this migration adds (`ON DELETE SET NULL (<column>)`). Every
 * statement runs in the organization's own context, so the suite also holds under
 * `pnpm test:rls-role`.
 */
describe('AutomationRepository and AutomationCountRepository (database)', () => {
  let organization: { id: number; public_id: string; type: string };
  let account: { id: number; public_id: string; channel_account_id: number };

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
  });

  const scope = () => PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id });

  function insertOwn(overrides: AutomationFixtureOverrides = {}) {
    return insertAutomation({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      ...overrides,
    });
  }

  /** The constraint a failing insert broke. */
  async function brokenConstraint(insert: Promise<unknown>): Promise<string | undefined> {
    try {
      await insert;
    } catch (error) {
      expect(getPostgresErrorCode(error)).toMatch(/^23/);
      return getPostgresConstraintName(error);
    }
    return undefined;
  }

  it('lets a draft hold anything and refuses a live row that breaks a go-live rule (AU9, P2)', async () => {
    const helloWithoutNext = {
      hello: {
        on: true,
        versions: [
          {
            text: 'Hi',
            buttons: [{ title: 'Shop', action: 'link' as const, url: 'https://x.example' }],
          },
        ],
      },
      messages: [{ kind: 'text' as const, wait_minutes: 0, text: 'Here' }],
    };
    expect(
      await brokenConstraint(insertOwn({ status: 'draft', steps: helloWithoutNext })),
    ).toBeUndefined();
    expect(await brokenConstraint(insertOwn({ status: 'live', steps: helloWithoutNext }))).toBe(
      'chk_automations_live_hello_next_button',
    );
    expect(await brokenConstraint(insertOwn({ status: 'live', steps: { messages: [] } }))).toBe(
      'chk_automations_live_messages',
    );
    expect(
      await brokenConstraint(
        insertOwn({ status: 'live', trigger_type: 'ref_link', steps: completeAutomationSteps() }),
      ),
    ).toBe('chk_automations_live_trigger_fields');
  });

  it('keeps a ref code unique per account, drafts included (D43, AC-6.12)', async () => {
    await insertOwn({ trigger_type: 'ref_link', ref_code: 'spring' });
    expect(
      await brokenConstraint(insertOwn({ trigger_type: 'ref_link', ref_code: 'spring' })),
    ).toBe('idx_automations_account_ref_code');
    const other = await insertInstagramAccount({ organizationId: organization.id });
    await insertAutomation({
      organizationId: organization.id,
      channelAccountId: other.channel_account_id,
      trigger_type: 'ref_link',
      ref_code: 'spring',
    });
  });

  it('sums the 16 count slots and keeps them after the run is gone (AU19, AC-6.22 groundwork)', async () => {
    const automation = await insertOwn({ status: 'live', steps: completeAutomationSteps() });
    const contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
    });
    const counts = new AutomationCountService(new AutomationCountRepository());
    const runIds: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const run = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
        status: 'completed',
        completed_at: new Date(),
        waiting_for: null,
        waiting_since_at: null,
      });
      runIds.push(run.id);
      await counts.increment({
        scope: scope(),
        increment: {
          organizationId: organization.id,
          automationId: automation.id,
          automationRunId: run.id,
          counter: 'runs_started',
          versionKey: 'hello.1',
        },
      });
    }
    await counts.increment({
      scope: scope(),
      increment: {
        organizationId: organization.id,
        automationId: automation.id,
        automationRunId: runIds[0] ?? 0,
        counter: 'taps',
        versionKey: 'hello.1',
      },
    });
    const slotRows = await operatorQuery<Array<{ total: string }>>`
      SELECT count(*)::text AS total FROM app.automation_counts WHERE automation_id = ${automation.id}`;
    expect(Number(slotRows[0]?.total)).toBeLessThanOrEqual(16);
    await operatorQuery`DELETE FROM app.automation_runs WHERE automation_id = ${automation.id}`;
    const summed = await counts.readCounts({
      scope: scope(),
      organizationId: organization.id,
      automationIds: [automation.id],
    });
    expect(summed.get(automation.id)).toEqual({
      runs_started: 20,
      taps: 1,
      typed_answers: 0,
      tapped_percent: 5,
      by_version: { 'hello.1': { runs_started: 20, taps: 1, typed_answers: 0 } },
    });
  });

  it('links the first post after go-live with no end date; a repeat changes nothing (AU20, P12)', async () => {
    const waiting = await insertOwn({
      status: 'live',
      target_scope: 'next',
      target_starts_at: new Date(Date.now() - MILLISECONDS_PER_DAY),
      next_post_status: 'waiting',
      steps: completeAutomationSteps(),
    });
    const service = createTestAutomationService({
      organizationService: {
        requireOrganizationByPublicId: async () => organization,
      } as unknown as OrganizationService,
    });
    const before = await service.linkNextPostAutomations({
      scope: scope(),
      channelAccountPublicId: account.public_id,
      instagramMediaId: '18000000000000001',
      publishedAt: new Date(Date.now() - 2 * MILLISECONDS_PER_DAY),
    });
    expect(before).toEqual([]);
    const linked = await service.linkNextPostAutomations({
      scope: scope(),
      channelAccountPublicId: account.public_id,
      instagramMediaId: '18000000000000002',
      publishedAt: new Date(Date.now() + 30 * MILLISECONDS_PER_DAY),
    });
    expect(linked).toEqual([waiting.public_id]);
    expect(await readAutomationRow(waiting.public_id)).toMatchObject({
      next_post_status: 'linked',
      target_instagram_media_id: '18000000000000002',
    });
    const again = await service.linkNextPostAutomations({
      scope: scope(),
      channelAccountPublicId: account.public_id,
      instagramMediaId: '18000000000000003',
      publishedAt: new Date(),
    });
    expect(again).toEqual([]);
  });

  it('sets the two contact keys null when an automation is purged (§ 4.3, R10, R11)', async () => {
    const automation = await insertOwn({ deleted_at: new Date(), delete_reason: 'mistake' });
    const contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      first_automation_id: automation.id,
    });
    await operatorQuery`
      INSERT INTO app.contact_tag_events (organization_id, channel_account_id, contact_id, tag, kind, source, source_automation_id)
      VALUES (${organization.id}, ${account.channel_account_id}, ${contact.id}, 'vip', 'added', 'automation', ${automation.id})`;
    await operatorQuery`DELETE FROM app.automations WHERE id = ${automation.id}`;
    const rows = await operatorQuery<
      Array<{ first_automation_id: string | null; organization_id: string }>
    >`
      SELECT first_automation_id, organization_id FROM app.contacts WHERE id = ${contact.id}`;
    expect(rows[0]).toMatchObject({
      first_automation_id: null,
      organization_id: String(organization.id),
    });
    const events = await operatorQuery<Array<{ source_automation_id: string | null }>>`
      SELECT source_automation_id FROM app.contact_tag_events WHERE contact_id = ${contact.id}`;
    expect(events[0]?.source_automation_id).toBeNull();
  });
});
