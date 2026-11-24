import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from '@/shared/errors/index.js';
import { resetPlanCatalogMemoForTests } from '@/domains/billing/sub-domains/plan/plan-catalog-memo.js';
import {
  PlanService,
  isPaidPlan,
  supportsPlanBillingCycle,
  yearlyPricePerMonth,
} from '@/domains/billing/sub-domains/plan/plan.service.js';
import type { PlanRepository } from '@/domains/billing/sub-domains/plan/plan.repository.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';

const planRow = {
  id: 1,
  public_id: 'plan_public',
  name: 'Pro',
  description: null,
  price_monthly: '10',
  price_yearly: '100',
  currency: 'USD',
  is_active: true,
  // BL12 (P83): the typed features flow through toOutput.
  features: CREATOR_PLAN_FEATURES,
  included_seats: null,
  created_at: new Date(),
  updated_at: new Date(),
};

describe('PlanService', () => {
  const repository = {
    findByPublicId: vi.fn().mockResolvedValue(planRow),
    findById: vi.fn().mockResolvedValue(planRow),
    findAllActive: vi.fn().mockResolvedValue([planRow]),
  } as unknown as PlanRepository;

  const service = new PlanService(repository);

  it('advertises Free as monthly only without an annual zero-price offer', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValueOnce({
      ...planRow,
      name: 'Free',
      price_monthly: '0.00',
      price_yearly: '0.00',
      features: FREE_PLAN_FEATURES,
      stripe_product_id: null,
      stripe_price_monthly_id: null,
      stripe_price_yearly_id: null,
      created_by_user_id: null,
      updated_by_user_id: null,
    });
    const output = await service.getByPublicId('plan_public');
    expect(output.price_monthly).toBe('0.00');
    expect(output.price_yearly).toBeNull();
    expect(output.price_yearly_per_month).toBeNull();
    expect(output.billing_cycles).toEqual(['monthly']);
  });

  beforeEach(() => {
    // `list()` is memoized in process for a minute, so without this the second case in this file
    // would assert against the first case's catalog.
    resetPlanCatalogMemoForTests();
    vi.clearAllMocks();
    vi.mocked(repository.findByPublicId).mockResolvedValue(planRow as never);
    vi.mocked(repository.findById).mockResolvedValue(planRow as never);
  });

  it('list returns active plans', async () => {
    const plans = await service.list();
    expect(plans).toHaveLength(1);
    expect(plans[0]?.id).toBe('plan_public');
  });

  it('list returns an empty array when no active plans exist', async () => {
    vi.mocked(repository.findAllActive).mockResolvedValue([]);
    await expect(service.list()).resolves.toEqual([]);
  });

  it('list maps nullable description to output', async () => {
    vi.mocked(repository.findAllActive).mockResolvedValue([
      { ...planRow, description: 'Annual plan' },
      { ...planRow, public_id: 'plan_basic', description: null },
    ] as never);

    const plans = await service.list();

    expect(plans[0]?.description).toBe('Annual plan');
    expect(plans[1]?.description).toBeNull();
  });

  it('getByPublicId returns plan output', async () => {
    const plan = await service.getByPublicId('plan_public');
    expect(plan.name).toBe('Pro');
  });

  it('BL12: surfaces the typed features verbatim and no `limits` (BL13)', async () => {
    const plan = await service.getByPublicId('plan_public');
    expect(plan.features).toEqual(CREATOR_PLAN_FEATURES);
    expect(plan).not.toHaveProperty('limits');
  });

  it('BL13: answers the yearly price per month — price_yearly ÷ 12, two decimals', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...planRow,
      price_monthly: '29.00',
      price_yearly: '276.00',
    } as never);
    const plan = await service.getByPublicId('plan_public');
    expect(plan.price_yearly_per_month).toBe('23.00');
    expect(yearlyPricePerMonth({ priceYearly: '100' })).toBe('8.33');
    expect(yearlyPricePerMonth({ priceYearly: '756.00' })).toBe('63.00');
  });

  it('getByPublicId maps null description values', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...planRow,
      description: null,
    } as never);

    const plan = await service.getByPublicId('plan_public');

    expect(plan.description).toBeNull();
  });

  it('requirePlanRecordByPublicId returns the plan row', async () => {
    const row = await service.requirePlanRecordByPublicId('plan_public');
    expect(row.public_id).toBe('plan_public');
  });

  it('requirePlanRecordByPublicId throws when missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(service.requirePlanRecordByPublicId('missing')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('requirePlanRecordByInternalId returns row', async () => {
    const row = await service.requirePlanRecordByInternalId(1);
    expect(row.public_id).toBe('plan_public');
  });

  it('getByPublicId throws when plan is missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(service.getByPublicId('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('route-#7: getByPublicId 404s an inactive (retired/draft) plan — public catalog must not leak it', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...planRow,
      is_active: false,
    } as never);
    await expect(service.getByPublicId('plan_public')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('route-#7: requirePlanRecordByPublicId still returns an inactive row for internal callers', async () => {
    // The internal resolver must NOT 404 inactive plans (the Stripe webhook needs to map them);
    // only the PUBLIC getByPublicId path hides them.
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...planRow,
      is_active: false,
    } as never);
    const row = await service.requirePlanRecordByPublicId('plan_public');
    expect(row.is_active).toBe(false);
  });

  it('requirePlanRecordByInternalId throws when plan is missing', async () => {
    vi.mocked(repository.findById).mockResolvedValue(null);
    await expect(service.requirePlanRecordByInternalId(999)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('isPaidPlan — the one definition of a paid plan', () => {
  it('is a price above zero on either cycle; zero on both is the Free plan', () => {
    expect(isPaidPlan({ plan: { price_monthly: '1999.00', price_yearly: '0.00' } })).toBe(true);
    expect(isPaidPlan({ plan: { price_monthly: '0.00', price_yearly: '19990.00' } })).toBe(true);
    expect(isPaidPlan({ plan: { price_monthly: '0.00', price_yearly: '0.00' } })).toBe(false);
  });

  it('decides annual billing: the Free plan renews monthly only', () => {
    const free = { price_monthly: '0', price_yearly: '0' };
    expect(supportsPlanBillingCycle({ plan: free, billingCycle: 'yearly' })).toBe(false);
    expect(supportsPlanBillingCycle({ plan: free, billingCycle: 'monthly' })).toBe(true);
    expect(supportsPlanBillingCycle({ plan: planRow, billingCycle: 'yearly' })).toBe(true);
  });
});
