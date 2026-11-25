import { describe, expect, it } from 'vitest';
import {
  buildAutomationButtonPayload,
  parseAutomationButtonPayload,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-button-payload.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/**
 * The "sends your next step" button payload (plan §30.8, WH8; ROUTE row R44): `<aut_…>::<run_…>`
 * with the message's `igm_…` as a third part, read back by the intake; anything else is not ours.
 */
describe('automation button payload', () => {
  const automationPublicId = generatePublicId('automation');
  const runPublicId = generatePublicId('automationRun');
  const messagePublicId = generatePublicId('instagramMessage');

  it('builds and reads the three-part payload, and still reads a two-part one', () => {
    const payload = buildAutomationButtonPayload({
      automationPublicId,
      runPublicId,
      messagePublicId,
    });
    expect(payload).toBe(`${automationPublicId}::${runPublicId}::${messagePublicId}`);
    expect(parseAutomationButtonPayload(payload)).toEqual({
      automationPublicId,
      runPublicId,
      messagePublicId,
    });
    const twoParts = buildAutomationButtonPayload({ automationPublicId, runPublicId });
    expect(parseAutomationButtonPayload(twoParts)).toEqual({ automationPublicId, runPublicId });
  });

  it('refuses a payload it never sent', () => {
    expect(parseAutomationButtonPayload(`${automationPublicId}::${runPublicId}::nope`)).toBeNull();
    expect(
      parseAutomationButtonPayload(`${automationPublicId}::${runPublicId}::${messagePublicId}::x`),
    ).toBeNull();
    expect(parseAutomationButtonPayload(`starter:${automationPublicId}`)).toBeNull();
  });
});
