/** Billing resource schemas. */
// ── Plan ──
export const planSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string', nullable: true },
    price_monthly: { type: 'string' },
    price_yearly: { type: 'string', nullable: true },
    price_yearly_per_month: {
      type: 'string',
      nullable: true,
      description: '`price_yearly` ÷ 12, two decimals; null without a yearly price.',
    },
    billing_cycles: { type: 'array', items: { type: 'string', enum: ['monthly', 'yearly'] } },
    currency: { type: 'string' },
    is_active: { type: 'boolean' },
    features: {
      type: 'object',
      description:
        'The typed plan features: the two limits, priority support and one on / off switch per feature key.',
      properties: {
        message_month_limit: { type: 'integer', minimum: 0 },
        channel_accounts_max: { type: 'integer', minimum: 1, maximum: 100 },
        has_priority_support: { type: 'boolean' },
        feature_switches: {
          type: 'object',
          additionalProperties: { type: 'boolean' },
          description: 'One boolean per feature key (`PLAN_FEATURE_KEYS`).',
        },
      },
    },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const planExample = {
  id: 'pln_j5h8t3rwy6m1k9n2a1b2c',
  name: 'Creator',
  description: null,
  price_monthly: '29.00',
  price_yearly: '276.00',
  price_yearly_per_month: '23.00',
  billing_cycles: ['monthly', 'yearly'],
  currency: 'USD',
  is_active: true,
  features: {
    message_month_limit: 10000,
    channel_accounts_max: 3,
    has_priority_support: false,
    feature_switches: {
      email_ask: true,
      phone_ask: true,
      reply_like_person: true,
      multiple_public_reply_lines: true,
      message_versions: true,
      broadcasts: true,
      segments: true,
      past_comments: true,
      extra_delay: true,
      starter_questions: true,
      mark_seen: true,
    },
  },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

// ── Subscription ──
export const subscriptionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    organization_id: { type: 'string' },
    plan_id: { type: 'string' },
    status: {
      type: 'string',
      enum: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'PAUSED'],
      description: 'Possible values: TRIALING | ACTIVE | PAST_DUE | CANCELED | PAUSED',
      example: 'TRIALING',
    },
    billing_cycle: {
      type: 'string',
      enum: ['monthly', 'yearly'],
      description: 'Possible values: monthly | yearly',
      example: 'monthly',
    },
    current_period_start: { type: 'string', format: 'date-time' },
    current_period_end: { type: 'string', format: 'date-time' },
    cancel_at_period_end: { type: 'boolean' },
    trial_end: { type: 'string', format: 'date-time', nullable: true },
    is_trial: {
      type: 'boolean',
      description: 'The 7-day no-card trial runs (`status` is `TRIALING`).',
    },
    scheduled_change: {
      type: 'object',
      nullable: true,
      description:
        'A move to a smaller plan waiting for the period end (null when none): the plan it moves to, when, and the channel accounts kept active after it (empty: the oldest connected stay).',
      properties: {
        plan_id: { type: 'string' },
        change_at: { type: 'string', format: 'date-time' },
        keep_channel_account_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['plan_id', 'change_at', 'keep_channel_account_ids'],
    },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const subscriptionExample = {
  id: 'sub_w1r4x9k3m7n2p5q8a1b2c',
  organization_id: 'org_k7x9m2pqr4w8n1v3a1b2c',
  plan_id: 'pln_j5h8t3rwy6m1k9n2a1b2c',
  status: 'ACTIVE',
  billing_cycle: 'monthly',
  current_period_start: '2026-02-01T00:00:00.000Z',
  current_period_end: '2026-03-01T00:00:00.000Z',
  cancel_at_period_end: false,
  trial_end: null,
  is_trial: false,
  scheduled_change: {
    plan_id: 'pln_k2m8q4r6t1v3x5z7a1b2c',
    change_at: '2026-03-01T00:00:00.000Z',
    keep_channel_account_ids: ['cha_a1b2c3d4e5f6g7h8i9j0k'],
  },
  created_at: '2026-01-15T10:30:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
};

// ── Stripe webhook acknowledgement (protocol-owned 200) ──
// ── Plan access (owner decision D3: read-only mode for unpaid organizations) ──
export const planAccessSchema = {
  type: 'object',
  description:
    "The organization's plan access. `active`: a live plan — Free never ends (always for a personal organization, and for every organization while read-only mode is off). `grace`: a lapsed paid plan, writes allowed until `grace_ends_at`. `read_only`: a lapsed or cancelled paid plan since `grace_ends_at`.",
  properties: {
    state: {
      type: 'string',
      enum: ['active', 'grace', 'read_only'],
      description: 'Possible values: active | grace | read_only',
      example: 'grace',
    },
    grace_ends_at: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description:
        'When the grace ends (`grace`) or ended, i.e. when read-only began (`read_only`); null when `active`.',
    },
    trial_ends_at: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description: 'When the 7-day trial ends while it runs; null otherwise.',
    },
    plan: {
      type: 'object',
      nullable: true,
      description: 'The plan whose features apply; null only with no Free plan in the catalog.',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      required: ['id', 'name'],
    },
    features: {
      ...planSchema.properties.features,
      nullable: true,
      description: "That plan's typed features; null exactly when `plan` is.",
    },
    is_plan_choice_required: {
      type: 'boolean',
      description:
        'True while the subscription is on a switched-off plan (Starter, Growth, Pro): the organization is held to Free until it picks Creator or Studio.',
    },
  },
  required: [
    'state',
    'grace_ends_at',
    'trial_ends_at',
    'plan',
    'features',
    'is_plan_choice_required',
  ],
};

export const planAccessExample = {
  state: 'grace',
  grace_ends_at: '2026-10-31T09:30:00.000Z',
  trial_ends_at: null,
  plan: { id: 'pln_j5h8t3rwy6m1k9n2a1b2c', name: 'Creator' },
  features: planExample.features,
  is_plan_choice_required: false,
};

// ── Payment method (a card — Stripe-proxied, routes-final § 8.C.6) ──
export const paymentMethodSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: "Stripe's card id (`pm_…`)." },
    brand: { type: 'string' },
    last4: { type: 'string' },
    exp_month: { type: 'integer' },
    exp_year: { type: 'integer' },
    is_default: { type: 'boolean' },
  },
};

export const paymentMethodExample = {
  id: 'pm_1QExampleCardA1b2C3d4',
  brand: 'visa',
  last4: '4242',
  exp_month: 12,
  exp_year: 2030,
  is_default: true,
};

export const webhookReceivedSchema = {
  type: 'object',
  properties: { received: { type: 'boolean' } },
};

export const webhookReceivedExample = { received: true };

// ── Entitlement override (plan-gating close, P270) ──
export const entitlementOverrideSchema = {
  type: 'object',
  description:
    "One organization's override of a plan key — a feature switch (`value` boolean) or a limit (`value` integer) — set by a global admin.",
  properties: {
    id: { type: 'string', description: '`ovr_…`' },
    organization_id: { type: 'string', description: '`org_…`' },
    key: {
      type: 'string',
      description: 'A plan feature key, `message_month_limit` or `channel_accounts_max`.',
    },
    value: { oneOf: [{ type: 'boolean' }, { type: 'integer' }] },
    expires_at: { type: 'string', format: 'date-time', nullable: true },
    is_active: { type: 'boolean', description: 'In force now (not past `expires_at`).' },
    reason: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'organization_id',
    'key',
    'value',
    'expires_at',
    'is_active',
    'reason',
    'created_at',
    'updated_at',
  ],
};

export const entitlementOverrideExample = {
  id: 'ovr_a1b2c3d4e5f6g7h8i9j0k',
  organization_id: 'org_a1b2c3d4e5f6g7h8i9j0k',
  key: 'broadcasts',
  value: true,
  expires_at: '2026-12-31T00:00:00.000Z',
  is_active: true,
  reason: 'Support deal',
  created_at: '2026-11-26T12:00:00.000Z',
  updated_at: '2026-11-26T12:00:00.000Z',
};

// ── Entitlements (plan-gating close, P271) ──
const entitlementLimitSchema = {
  type: 'object',
  properties: {
    used: { type: 'integer' },
    limit: { type: 'integer', nullable: true, description: 'null = unlimited (or no plan).' },
  },
  required: ['used', 'limit'],
};

export const entitlementsSchema = {
  type: 'object',
  description:
    "The active organization's entitlements: plan state, plan, features after overrides, limits with usage, dates and the overrides in force.",
  properties: {
    state: planAccessSchema.properties.state,
    plan: planAccessSchema.properties.plan,
    features: {
      ...planSchema.properties.features,
      nullable: true,
      description: "The plan's typed features with the active overrides laid over them.",
    },
    limits: {
      type: 'object',
      properties: {
        direct_messages: {
          ...entitlementLimitSchema,
          properties: {
            ...entitlementLimitSchema.properties,
            resets_on: { type: 'string', format: 'date', description: 'The 1st of next month.' },
          },
          required: ['used', 'limit', 'resets_on'],
        },
        channel_accounts: entitlementLimitSchema,
        seats: entitlementLimitSchema,
      },
      required: ['direct_messages', 'channel_accounts', 'seats'],
    },
    trial_ends_at: planAccessSchema.properties.trial_ends_at,
    grace_ends_at: planAccessSchema.properties.grace_ends_at,
    is_plan_choice_required: planAccessSchema.properties.is_plan_choice_required,
    overrides: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          expires_at: { type: 'string', format: 'date-time', nullable: true },
        },
        required: ['key', 'expires_at'],
      },
    },
    sources: {
      type: 'object',
      description:
        'Where each value came from (change-plan-gates EN6), one entry per entitlement key — the 11 feature switches, `message_month_limit`, `channel_accounts_max` and `seats`: `override` (an active override set it), `plan` (the plan row carried it) or `default` (the registry default filled it — a switch the plan row lacks reads off).',
      additionalProperties: { type: 'string', enum: ['override', 'plan', 'default'] },
    },
  },
  required: [
    'state',
    'plan',
    'features',
    'limits',
    'trial_ends_at',
    'grace_ends_at',
    'is_plan_choice_required',
    'overrides',
    'sources',
  ],
};

export const entitlementsExample = {
  state: 'active',
  plan: { id: 'pln_j5h8t3rwy6m1k9n2a1b2c', name: 'Creator' },
  features: planExample.features,
  limits: {
    direct_messages: { used: 1240, limit: 25000, resets_on: '2026-12-01' },
    channel_accounts: { used: 2, limit: 3 },
    seats: { used: 4, limit: null },
  },
  trial_ends_at: null,
  grace_ends_at: null,
  is_plan_choice_required: false,
  overrides: [{ key: 'channel_accounts_max', expires_at: '2026-12-31T00:00:00.000Z' }],
  sources: {
    email_ask: 'plan',
    phone_ask: 'plan',
    reply_like_person: 'plan',
    multiple_public_reply_lines: 'plan',
    message_versions: 'plan',
    broadcasts: 'plan',
    segments: 'plan',
    past_comments: 'plan',
    extra_delay: 'plan',
    starter_questions: 'plan',
    mark_seen: 'plan',
    message_month_limit: 'plan',
    channel_accounts_max: 'override',
    seats: 'plan',
  },
};
