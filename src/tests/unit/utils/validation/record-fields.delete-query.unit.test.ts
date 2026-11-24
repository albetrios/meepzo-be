import { describe, expect, it } from 'vitest';
import {
  recordDeleteQuerySchema,
  recordDeleteQuerySchemaOf,
} from '@/shared/utils/validation/record-fields.util.js';

/**
 * The shared `DELETE` query (feat-instagram-dm-sending AU16, P11): the reason stays required by
 * default; `isReasonOptional` lets it be left out while `other` still needs a note.
 */
describe('recordDeleteQuerySchemaOf', () => {
  const optionalReason = recordDeleteQuerySchemaOf({
    reasons: ['mistake', 'duplicate', 'not_needed', 'other'],
    isReasonOptional: true,
  });

  it('keeps the reason required on the default schema', () => {
    expect(recordDeleteQuerySchema.safeParse({}).success).toBe(false);
    expect(recordDeleteQuerySchema.safeParse({ reason: 'mistake' }).success).toBe(true);
  });

  it('accepts no reason when the reason is optional', () => {
    expect(optionalReason.safeParse({}).success).toBe(true);
    expect(optionalReason.safeParse({ reason: 'duplicate' }).success).toBe(true);
  });

  it('still needs a note for other, and refuses an unknown reason', () => {
    const missingNote = optionalReason.safeParse({ reason: 'other' });
    expect(missingNote.success).toBe(false);
    expect(missingNote.error?.issues[0]?.path).toEqual(['note']);
    expect(optionalReason.safeParse({ reason: 'other', note: 'Seasonal' }).success).toBe(true);
    expect(optionalReason.safeParse({ reason: 'gone' }).success).toBe(false);
  });
});
