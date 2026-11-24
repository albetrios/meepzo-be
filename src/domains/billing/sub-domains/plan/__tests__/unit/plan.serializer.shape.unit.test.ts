import { describe, expect, it } from 'vitest';
import { PlanSerializer } from '@/domains/billing/sub-domains/plan/plan.serializer.js';
import type { PlanOutput } from '@/domains/billing/sub-domains/plan/plan.types.js';
import { STUDIO_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';

describe('plan.serializer shape (regression-guard)', () => {
  const samplePlan: PlanOutput = {
    id: 'pln_01',
    name: 'Pro',
    description: 'For growing teams',
    price_monthly: '29.00',
    price_yearly: '290.00',
    price_yearly_per_month: '24.17',
    billing_cycles: ['monthly', 'yearly'],
    currency: 'USD',
    is_active: true,
    // BL12 (P83): the typed features are part of the public shape; no `limits` (BL13).
    features: STUDIO_PLAN_FEATURES,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  };

  it('PlanSerializer.one exposes only the documented PlanOutput fields', () => {
    const result = PlanSerializer.one(samplePlan);
    expect(Object.keys(result).sort()).toEqual(
      [
        'billing_cycles',
        'created_at',
        'currency',
        'description',
        'features',
        'id',
        'is_active',
        'name',
        'price_monthly',
        'price_yearly',
        'price_yearly_per_month',
        'updated_at',
      ].sort(),
    );
  });

  it('BL12: PlanSerializer.one surfaces the typed features verbatim', () => {
    const result = PlanSerializer.one(samplePlan);
    expect(result.features).toEqual(STUDIO_PLAN_FEATURES);
  });

  it('PlanSerializer.one preserves a null description without coercion', () => {
    const planWithoutDescription: PlanOutput = { ...samplePlan, description: null };
    const result = PlanSerializer.one(planWithoutDescription);
    expect(result.description).toBeNull();
  });

  it('PlanSerializer.many preserves input order across plans', () => {
    const planA: PlanOutput = { ...samplePlan, id: 'pln_a', name: 'A' };
    const planB: PlanOutput = { ...samplePlan, id: 'pln_b', name: 'B' };
    const planC: PlanOutput = { ...samplePlan, id: 'pln_c', name: 'C' };
    const result = PlanSerializer.many([planA, planB, planC]);
    expect(result.map((plan) => plan.id)).toEqual(['pln_a', 'pln_b', 'pln_c']);
  });
});
