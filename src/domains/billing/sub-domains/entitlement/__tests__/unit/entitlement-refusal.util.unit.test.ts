import { describe, expect, it } from 'vitest';
import { buildPlanRefusal } from '@/domains/billing/sub-domains/entitlement/entitlement-refusal.util.js';
import { ConflictError, ForbiddenError } from '@/shared/errors/index.js';

/** The body parts the error handler serializes from a refusal (status, key, params, reason, fields). */
function body(error: ForbiddenError | ConflictError) {
  return {
    statusCode: error.statusCode,
    messageKey: error.messageKey,
    messageParams: error.messageParams,
    reason: error.reason,
    fields: error.fields,
  };
}

/**
 * The one plan refusal builder (change-plan-gates EN5, ENC4, P6, P7): each reason answers exactly
 * the body the code answers today — the month refusal gains its numbers (P6), no plan id (P7).
 */
describe('buildPlanRefusal (EN5)', () => {
  it('organization_read_only: 403 with grace_ends_at and upgrade_required', () => {
    const error = buildPlanRefusal({
      reason: 'organization_read_only',
      graceEndsAt: new Date('2026-12-10T00:00:00.000Z'),
    });
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(body(error)).toEqual({
      statusCode: 403,
      messageKey: 'errors:organizationReadOnly',
      messageParams: undefined,
      reason: 'organization_read_only',
      fields: { grace_ends_at: '2026-12-10T00:00:00.000Z', upgrade_required: true },
    });
    expect(
      buildPlanRefusal({ reason: 'organization_read_only', graceEndsAt: null }).fields,
    ).toEqual({ grace_ends_at: null, upgrade_required: true });
  });

  it('plan_lacks_feature: 403 with the switch as feature and upgrade_required', () => {
    const error = buildPlanRefusal({ reason: 'plan_lacks_feature', feature: 'broadcasts' });
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(body(error)).toEqual({
      statusCode: 403,
      messageKey: 'errors:planLacksFeature',
      messageParams: undefined,
      reason: 'plan_lacks_feature',
      fields: { feature: 'broadcasts', upgrade_required: true },
    });
  });

  it('plan_account_limit: 409 with limit, used and upgrade_required', () => {
    const error = buildPlanRefusal({ reason: 'plan_account_limit', limit: 3, used: 3 });
    expect(error).toBeInstanceOf(ConflictError);
    expect(body(error)).toEqual({
      statusCode: 409,
      messageKey: 'errors:planAccountLimit',
      messageParams: undefined,
      reason: 'plan_account_limit',
      fields: { limit: 3, used: 3, upgrade_required: true },
    });
  });

  it('seat_limit_reached: 409 with the seat numbers in the message and the fields', () => {
    const error = buildPlanRefusal({ reason: 'seat_limit_reached', limit: 5, used: 5 });
    expect(error).toBeInstanceOf(ConflictError);
    expect(body(error)).toEqual({
      statusCode: 409,
      messageKey: 'errors:seatLimitReached',
      messageParams: { used: 5, limit: 5 },
      reason: 'seat_limit_reached',
      fields: { limit: 5, used: 5, upgrade_required: true },
    });
  });

  it('message_month_limit_reached: 409 with limit, used and resets_on (P6)', () => {
    const error = buildPlanRefusal({
      reason: 'message_month_limit_reached',
      limit: 1000,
      used: 1000,
      resetsOn: '2026-12-01',
    });
    expect(error).toBeInstanceOf(ConflictError);
    expect(body(error)).toEqual({
      statusCode: 409,
      messageKey: 'errors:messageMonthLimitReached',
      messageParams: undefined,
      reason: 'message_month_limit_reached',
      fields: { limit: 1000, used: 1000, resets_on: '2026-12-01' },
    });
  });

  it('never names a plan id (P7)', () => {
    const refusals = [
      buildPlanRefusal({ reason: 'organization_read_only', graceEndsAt: null }),
      buildPlanRefusal({ reason: 'plan_lacks_feature', feature: 'segments' }),
      buildPlanRefusal({ reason: 'plan_account_limit', limit: 1, used: 1 }),
      buildPlanRefusal({ reason: 'seat_limit_reached', limit: 1, used: 1 }),
      buildPlanRefusal({
        reason: 'message_month_limit_reached',
        limit: 1,
        used: 1,
        resetsOn: '2026-12-01',
      }),
    ];
    for (const refusal of refusals) {
      expect(JSON.stringify(refusal.fields)).not.toMatch(/pln_|plan_id/);
    }
  });
});
