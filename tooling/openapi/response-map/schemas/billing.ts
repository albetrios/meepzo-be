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
  },
  required: ['state', 'grace_ends_at', 'trial_ends_at'],
};

export const planAccessExample = {
  state: 'grace',
  grace_ends_at: '2026-10-31T09:30:00.000Z',
  trial_ends_at: null,
};

export const webhookReceivedSchema = {
  type: 'object',
  properties: { received: { type: 'boolean' } },
};

export const webhookReceivedExample = { received: true };
