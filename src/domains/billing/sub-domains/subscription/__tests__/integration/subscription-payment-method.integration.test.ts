import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { audit_outbox } from '@/domains/audit/audit-outbox.schema.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { BILLING_PERMISSIONS } from '@/domains/billing/billing.permissions.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedAllPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  EDITOR_ROLE_NAME,
  VIEWER_ROLE_NAME,
} from '@/domains/tenancy/sub-domains/member-roles/member-role.constants.js';
import { DEFAULT_TEAM_ROLES } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { stripeCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { decodeStripeEncodedForm } from '@/tests/contract/helpers/stripe-form.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';

/**
 * The card routes (feat-instagram-dm-sending routes-final § 8.C — routes 104–106, AC-11.11, AC-11.13)
 * through the real Stripe client, with Stripe answered by nock: the ownership check, the last card
 * kept while a paid plan is on, the default set on the customer and the subscription, the shape and
 * permission refusals, and Stripe down.
 */
const STRIPE = 'https://api.stripe.com';
const CUSTOMER_ID = 'cus_cardRoutesOwn';
const OTHER_CUSTOMER_ID = 'cus_cardRoutesOther';
const CARD_ID = 'pm_cardRoutesFirst';
const SECOND_CARD_ID = 'pm_cardRoutesSecond';

function stripeCard(options: { id: string; customer: string | null; last4?: string }) {
  return {
    id: options.id,
    object: 'payment_method',
    type: 'card',
    customer: options.customer,
    card: { brand: 'visa', last4: options.last4 ?? '4242', exp_month: 12, exp_year: 2030 },
  };
}

/** The error envelope of a refused request. */
type ErrorBody = {
  error: { code: string; reason?: string; detail: string; errors?: { field: string }[] };
};

function errorOf(response: { json: () => unknown }): ErrorBody['error'] {
  return (response.json() as ErrorBody).error;
}

function stripeCardList(cards: ReturnType<typeof stripeCard>[]) {
  return { object: 'list', url: '/v1/payment_methods', has_more: false, data: cards };
}

describe('Billing cards — routes 104–106 (feat-instagram-dm-sending § 8.C)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
  });

  afterEach(async () => {
    const pending = nock.pendingMocks();
    nock.cleanAll();
    await stripeCircuit.reset();
    expect(pending).toEqual([]);
  });

  /** A team organization, a member with `codes`, and (unless `status` is null) a Stripe-backed row. */
  async function createCardContext(options?: {
    status?: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'INCOMPLETE' | null;
    codes?: readonly string[];
    type?: 'TEAM' | 'PERSONAL';
  }) {
    const user = await createTestUser();
    const organization = await createTestOrganization({
      ownerUserId: user.id,
      ...(options?.type ? { type: options.type } : {}),
    });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [
        ...(options?.codes ?? [
          BILLING_PERMISSIONS.SUBSCRIPTION_READ,
          BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE,
        ]),
      ],
    });
    await createMembership({ userId: user.id, organizationId: organization.id, roleId: role.id });
    const status = options?.status === undefined ? 'ACTIVE' : options.status;
    const providerSubscriptionId = `sub_cardRoutes${randomUUID().replaceAll('-', '')}`;
    if (status !== null) {
      const plan = await createTestPlan();
      await createTestSubscription({
        organizationId: organization.id,
        planId: plan.id,
        status,
        providerSubscriptionId,
        providerCustomerId: CUSTOMER_ID,
        createdByUserId: user.id,
      });
    }
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { token, providerSubscriptionId };
  }

  function removeCard(token: string, paymentMethodId = CARD_ID) {
    return injectAuthenticated(app, {
      method: 'DELETE',
      url: testApiPath(`/billing/payment-methods/${paymentMethodId}`),
      token,
    });
  }

  function makeDefault(token: string, options?: { paymentMethodId?: string; key?: string | null }) {
    const key = options?.key === undefined ? `card-default-${randomUUID()}` : options.key;
    return injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath(`/billing/payment-methods/${options?.paymentMethodId ?? CARD_ID}/default`),
      token,
      ...(key === null ? {} : { headers: { 'x-idempotency-key': key } }),
    });
  }

  function nockRetrieveCard(card: ReturnType<typeof stripeCard>) {
    nock(STRIPE).get(`/v1/payment_methods/${card.id}`).reply(200, card);
  }

  function nockListCards(cards: ReturnType<typeof stripeCard>[]) {
    nock(STRIPE)
      .get('/v1/payment_methods')
      .query((query) => query.customer === CUSTOMER_ID && query.type === 'card')
      .reply(200, stripeCardList(cards));
  }

  async function auditRows(action: string) {
    return getOperatorDatabase().select().from(audit_outbox).where(eq(audit_outbox.action, action));
  }

  it('route 104 lists the cards with the customer default marked', async () => {
    const { token } = await createCardContext();
    nockListCards([
      stripeCard({ id: CARD_ID, customer: CUSTOMER_ID }),
      stripeCard({ id: SECOND_CARD_ID, customer: CUSTOMER_ID, last4: '1881' }),
    ]);
    nock(STRIPE)
      .get(`/v1/customers/${CUSTOMER_ID}`)
      .reply(200, {
        id: CUSTOMER_ID,
        object: 'customer',
        invoice_settings: { default_payment_method: SECOND_CARD_ID },
      });

    const response = await injectAuthenticated(app, {
      url: testApiPath('/billing/payment-methods'),
      token,
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: unknown }).data).toEqual([
      {
        id: CARD_ID,
        brand: 'visa',
        last4: '4242',
        exp_month: 12,
        exp_year: 2030,
        is_default: false,
      },
      {
        id: SECOND_CARD_ID,
        brand: 'visa',
        last4: '1881',
        exp_month: 12,
        exp_year: 2030,
        is_default: true,
      },
    ]);
  });

  it('route 105 removes a card while another remains, and audits brand and last 4 only', async () => {
    const { token } = await createCardContext();
    nockRetrieveCard(stripeCard({ id: CARD_ID, customer: CUSTOMER_ID }));
    nockListCards([
      stripeCard({ id: CARD_ID, customer: CUSTOMER_ID }),
      stripeCard({ id: SECOND_CARD_ID, customer: CUSTOMER_ID }),
    ]);
    nock(STRIPE)
      .post(`/v1/payment_methods/${CARD_ID}/detach`)
      .reply(200, stripeCard({ id: CARD_ID, customer: null }));

    const response = await removeCard(token);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    const [audit] = await auditRows('billing.payment_method.delete');
    expect(audit).toMatchObject({
      resource_type: 'payment_method',
      severity: 'WARNING',
      metadata: { card_brand: 'visa', card_last_digits: '4242' },
    });
  });

  it.each(['ACTIVE', 'TRIALING', 'PAST_DUE'] as const)(
    'route 105 refuses the only card while a paid plan is %s — 409 default_card_in_use',
    async (status) => {
      const { token } = await createCardContext({ status });
      nockRetrieveCard(stripeCard({ id: CARD_ID, customer: CUSTOMER_ID }));
      nockListCards([stripeCard({ id: CARD_ID, customer: CUSTOMER_ID })]);

      const response = await removeCard(token);

      expect(response.statusCode).toBe(409);
      expect(errorOf(response)).toMatchObject({ code: 'conflict', reason: 'default_card_in_use' });
      expect(await auditRows('billing.payment_method.delete')).toEqual([]);
    },
  );

  it('route 105 removes the only card when no paid plan is on (an incomplete subscription)', async () => {
    const { token } = await createCardContext({ status: 'INCOMPLETE' });
    nockRetrieveCard(stripeCard({ id: CARD_ID, customer: CUSTOMER_ID }));
    nock(STRIPE)
      .post(`/v1/payment_methods/${CARD_ID}/detach`)
      .reply(200, stripeCard({ id: CARD_ID, customer: null }));

    expect((await removeCard(token)).statusCode).toBe(204);
  });

  it("routes 105 and 106 answer 404 for another organization's card, and touch nothing", async () => {
    const { token } = await createCardContext();
    nock(STRIPE)
      .get(`/v1/payment_methods/${CARD_ID}`)
      .times(2)
      .reply(200, stripeCard({ id: CARD_ID, customer: OTHER_CUSTOMER_ID }));

    const removed = await removeCard(token);
    const defaulted = await makeDefault(token);

    expect(removed.statusCode).toBe(404);
    expect(defaulted.statusCode).toBe(404);
    expect(errorOf(removed).detail).toBe(errorOf(defaulted).detail);
  });

  it('route 105 answers 404 when Stripe has no such card, and when the organization has no customer', async () => {
    const { token } = await createCardContext();
    nock(STRIPE)
      .get(`/v1/payment_methods/${CARD_ID}`)
      .reply(404, {
        error: {
          type: 'invalid_request_error',
          code: 'resource_missing',
          message: `No such PaymentMethod: '${CARD_ID}'`,
        },
      });
    expect((await removeCard(token)).statusCode).toBe(404);

    const withoutCustomer = await createCardContext({ status: null });
    expect((await removeCard(withoutCustomer.token)).statusCode).toBe(404);
  });

  it('routes 105 and 106 refuse a malformed card id — 400 naming params.payment_method_id', async () => {
    const { token } = await createCardContext();
    for (const response of [
      await removeCard(token, 'card_123'),
      await makeDefault(token, { paymentMethodId: 'pm_' }),
      await removeCard(token, 'pm_has-dash'),
    ]) {
      expect(response.statusCode).toBe(400);
      expect(errorOf(response).errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'params.payment_method_id' })]),
      );
    }
  });

  it('routes 105 and 106 refuse a personal organization — 422', async () => {
    const { token } = await createCardContext({ type: 'PERSONAL', status: null });
    expect((await removeCard(token)).statusCode).toBe(422);
    expect((await makeDefault(token)).statusCode).toBe(422);
  });

  it('route 106 sets the default on the customer and the subscription, forwarding the key, and answers the cards', async () => {
    const { token, providerSubscriptionId } = await createCardContext();
    const key = `card-default-${randomUUID()}`;
    nockRetrieveCard(stripeCard({ id: SECOND_CARD_ID, customer: CUSTOMER_ID }));
    const stripeKeys: string[] = [];
    nock(STRIPE)
      .post(
        `/v1/customers/${CUSTOMER_ID}`,
        (body) =>
          decodeStripeEncodedForm(body)['invoice_settings[default_payment_method]'] ===
          SECOND_CARD_ID,
      )
      .matchHeader('idempotency-key', (value: string | null) => stripeKeys.push(value ?? '') > 0)
      .reply(200, { id: CUSTOMER_ID, object: 'customer' });
    nock(STRIPE)
      .post(
        `/v1/subscriptions/${providerSubscriptionId}`,
        (body) => decodeStripeEncodedForm(body).default_payment_method === SECOND_CARD_ID,
      )
      .matchHeader('idempotency-key', (value: string | null) => stripeKeys.push(value ?? '') > 0)
      .reply(200, { id: providerSubscriptionId, object: 'subscription' });
    nockListCards([
      stripeCard({ id: CARD_ID, customer: CUSTOMER_ID }),
      stripeCard({ id: SECOND_CARD_ID, customer: CUSTOMER_ID, last4: '1881' }),
    ]);

    const response = await makeDefault(token, { paymentMethodId: SECOND_CARD_ID, key });

    expect(response.statusCode).toBe(200);
    expect(
      (response.json() as { data: { id: string; is_default: boolean }[] }).data.map((card) => [
        card.id,
        card.is_default,
      ]),
    ).toEqual([
      [CARD_ID, false],
      [SECOND_CARD_ID, true],
    ]);
    expect(stripeKeys).toHaveLength(2);
    expect(stripeKeys[0]).toMatch(
      new RegExp(`^pm-default:org_[a-z0-9]{21}:${key}:customer-default$`),
    );
    expect(stripeKeys[1]).toMatch(/:subscription-default$/);
    const [audit] = await auditRows('billing.payment_method.set_default');
    expect(audit).toMatchObject({
      severity: 'WARNING',
      metadata: { card_brand: 'visa', card_last_digits: '4242' },
    });
  });

  it('route 106 requires X-Idempotency-Key — 422 without one', async () => {
    const { token } = await createCardContext();
    const response = await makeDefault(token, { key: null });
    expect(response.statusCode).toBe(422);
  });

  it("a card id longer than Fastify's 100-character path parameter is refused 414 before the shape check", async () => {
    const { token } = await createCardContext();
    expect((await removeCard(token, `pm_${'a'.repeat(120)}`)).statusCode).toBe(414);
  });

  it('routes 105 and 106 answer 503 when Stripe is down', async () => {
    const { token } = await createCardContext();
    nock(STRIPE)
      .get(`/v1/payment_methods/${CARD_ID}`)
      .times(2)
      .reply(
        503,
        { error: { type: 'api_error', message: 'down' } },
        { 'Stripe-Should-Retry': 'false' },
      );

    expect((await removeCard(token)).statusCode).toBe(503);
    expect((await makeDefault(token)).statusCode).toBe(503);
  });

  it.each([EDITOR_ROLE_NAME, VIEWER_ROLE_NAME])(
    'an %s is refused the cards and every card change — 403 missing_permission (AC-11.13)',
    async (roleName) => {
      const role = DEFAULT_TEAM_ROLES.find((candidate) => candidate.name === roleName);
      const { token } = await createCardContext({ codes: role?.permissionCodes ?? [] });

      const responses = [
        await injectAuthenticated(app, { url: testApiPath('/billing/payment-methods'), token }),
        await removeCard(token),
        await makeDefault(token),
      ];

      for (const response of responses) {
        expect(response.statusCode).toBe(403);
        expect(errorOf(response).reason).toBe('missing_permission');
      }
    },
  );
});
