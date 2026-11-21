/** App domain resource schemas — the Instagram account (routes-final § 1.A.6, § 1.B.6). */
// ── Instagram account settings ──
// Mirrors serializeInstagramAccountSettings key for key.
export const instagramAccountSettingsSchema = {
  type: 'object',
  properties: {
    is_automation_enabled: { type: 'boolean' },
    is_public_reply_safety_enabled: { type: 'boolean' },
    public_reply_chance_percent: { type: 'integer', minimum: 0, maximum: 100 },
    public_reply_hour_limit: { type: 'integer', minimum: 1, maximum: 1000 },
    public_reply_gap_min_seconds: { type: 'integer', minimum: 5, maximum: 3600 },
    public_reply_gap_max_seconds: { type: 'integer', minimum: 5, maximum: 3600 },
    updated_by_user_id: { type: 'string', nullable: true },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const instagramAccountSettingsExample = {
  is_automation_enabled: true,
  is_public_reply_safety_enabled: false,
  public_reply_chance_percent: 80,
  public_reply_hour_limit: 60,
  public_reply_gap_min_seconds: 20,
  public_reply_gap_max_seconds: 60,
  updated_by_user_id: null,
  updated_at: '2026-11-21T09:00:00.000Z',
};

// ── Instagram account ──
// Mirrors serializeInstagramAccount key for key. Never the token.
export const instagramAccountSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    instagram_user_id: { type: 'string' },
    username: { type: 'string', nullable: true },
    name: { type: 'string', nullable: true },
    biography: { type: 'string', nullable: true },
    website: { type: 'string', nullable: true },
    profile_picture_url: { type: 'string', nullable: true },
    profile_url: { type: 'string', format: 'uri', nullable: true },
    followers_count: { type: 'integer' },
    follows_count: { type: 'integer' },
    media_count: { type: 'integer' },
    scopes: { type: 'array', items: { type: 'string' } },
    connection_status: { type: 'string', enum: ['connected', 'expired', 'error'] },
    access_expires_at: { type: 'string', format: 'date-time', nullable: true },
    is_webhook_subscribed: { type: 'boolean' },
    settings: instagramAccountSettingsSchema,
    connected_by_user_id: { type: 'string', nullable: true },
    connected_at: { type: 'string', format: 'date-time' },
    profile_synced_at: { type: 'string', format: 'date-time', nullable: true },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const instagramAccountExample = {
  id: 'iga_k7x9m2pqr4w8n1v3a1b2c',
  instagram_user_id: '17841400000000001',
  username: 'handmade.shop',
  name: 'Handmade Shop',
  biography: 'Handmade things, shipped weekly.',
  website: 'https://example.com/shop',
  profile_picture_url: 'https://scontent.cdninstagram.com/v/handmade-shop-profile.jpg',
  profile_url: 'https://instagram.com/handmade.shop',
  followers_count: 1204,
  follows_count: 87,
  media_count: 54,
  scopes: [
    'instagram_business_basic',
    'instagram_business_manage_messages',
    'instagram_business_manage_comments',
  ],
  connection_status: 'connected',
  access_expires_at: '2027-01-20T09:00:00.000Z',
  is_webhook_subscribed: true,
  settings: instagramAccountSettingsExample,
  connected_by_user_id: 'usr_m7n2p5q8w1r4x9k3a1b2c',
  connected_at: '2026-11-21T09:00:00.000Z',
  profile_synced_at: '2026-11-21T09:00:00.000Z',
  updated_at: '2026-11-21T09:00:00.000Z',
};

// ── Instagram connect result ──
export const instagramConnectResultSchema = {
  type: 'object',
  properties: {
    is_new_connection: { type: 'boolean' },
    instagram_account: instagramAccountSchema,
  },
};

export const instagramConnectResultExample = {
  is_new_connection: true,
  instagram_account: instagramAccountExample,
};
