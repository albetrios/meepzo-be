/**
 * App domain resource schemas — the channel connection (feat-instagram-dm-sending routes-final
 * § 1.6), the channel account (§ 1B.6), the Instagram account settings (§ 2.B.6), the
 * contact (§ 2.6), the automation (§ 3.A.6) and the Instagram webhook event (§ 4.B.6).
 */
import {
  AUTOMATION_NEXT_POST_STATUSES,
  AUTOMATION_STATUSES,
  AUTOMATION_TARGET_SCOPES,
  AUTOMATION_TRIGGER_TYPES,
} from '@/domains/app/sub-domains/automation/automation.constants.js';
import {
  INSTAGRAM_WEBHOOK_EVENT_KINDS,
  INSTAGRAM_WEBHOOK_EVENT_SKIP_REASONS,
  INSTAGRAM_WEBHOOK_EVENT_STATUSES,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.constants.js';

// ── Instagram account settings (feat-instagram-dm-sending routes-final § 2.B.6) ──
// Mirrors serializeInstagramAccountSettings key for key. Each owner limit null = the settings file.
const nullableLimit = (maximum: number, minimum = 1) => ({
  type: 'integer',
  minimum,
  maximum,
  nullable: true,
});

export const instagramAccountSettingsSchema = {
  type: 'object',
  properties: {
    is_automation_enabled: { type: 'boolean' },
    opening_hour_limit: nullableLimit(750),
    opening_day_limit: { type: 'integer', minimum: 1, nullable: true },
    fast_hour_limit: { type: 'integer', minimum: 1, nullable: true },
    person_hour_limit: { type: 'integer', minimum: 1, nullable: true },
    broadcast_hour_limit: nullableLimit(2000),
    effective_limits: {
      type: 'object',
      properties: {
        opening_hour_limit: { type: 'integer' },
        opening_day_limit: { type: 'integer', nullable: true },
        fast_hour_limit: { type: 'integer' },
        person_hour_limit: { type: 'integer' },
        broadcast_hour_limit: { type: 'integer' },
      },
    },
    is_day_limit_enabled: { type: 'boolean' },
    is_automatic_notice_enabled: { type: 'boolean' },
    extra_stop_words: { type: 'array', items: { type: 'string' }, maxItems: 50 },
    is_comment_reply_trigger_enabled: { type: 'boolean' },
    is_once_per_person_per_post_enabled: { type: 'boolean' },
    is_mark_seen_after_reply_enabled: { type: 'boolean' },
    extra_delay_seconds_min: nullableLimit(20),
    extra_delay_seconds_max: nullableLimit(20),
    updated_by_user_id: { type: 'string', nullable: true },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const instagramAccountSettingsExample = {
  is_automation_enabled: true,
  opening_hour_limit: null,
  opening_day_limit: null,
  fast_hour_limit: null,
  person_hour_limit: null,
  broadcast_hour_limit: null,
  effective_limits: {
    opening_hour_limit: 150,
    opening_day_limit: null,
    fast_hour_limit: 10_000,
    person_hour_limit: 60,
    broadcast_hour_limit: 600,
  },
  is_day_limit_enabled: false,
  is_automatic_notice_enabled: false,
  extra_stop_words: [],
  is_comment_reply_trigger_enabled: true,
  is_once_per_person_per_post_enabled: true,
  is_mark_seen_after_reply_enabled: false,
  extra_delay_seconds_min: null,
  extra_delay_seconds_max: null,
  updated_by_user_id: null,
  updated_at: '2026-11-21T09:00:00.000Z',
};

// ── Channel account (feat-instagram-dm-sending routes-final § 1B.6) ──
// Mirrors serializeChannelAccountSummary / serializeChannelAccount key for key. Never a token.
export const channelAccountSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    channel: { type: 'string', enum: ['instagram'] },
    display_name: { type: 'string' },
    profile_picture_url: { type: 'string', nullable: true },
    connection_status: { type: 'string', enum: ['connected', 'error', 'revoked'] },
    channel_connection_id: { type: 'string' },
    is_paused: { type: 'boolean' },
    is_suspended: { type: 'boolean' },
    is_in_plan: { type: 'boolean' },
    is_automation_enabled: { type: 'boolean' },
    has_sending_stop: { type: 'boolean' },
    connected_at: { type: 'string', format: 'date-time' },
  },
};

export const channelAccountSummaryExample = {
  id: 'cha_k7x9m2pqr4w8n1v3a1b2c',
  channel: 'instagram',
  display_name: '@handmade.shop',
  profile_picture_url: 'https://scontent.cdninstagram.com/v/handmade-shop-profile.jpg',
  connection_status: 'connected',
  channel_connection_id: 'chc_p4k8m2x9q1w7n3v5a1b2c',
  is_paused: false,
  is_suspended: false,
  is_in_plan: true,
  is_automation_enabled: true,
  has_sending_stop: false,
  connected_at: '2026-11-21T09:00:00.000Z',
};

export const channelAccountSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    channel: { type: 'string', enum: ['instagram'] },
    display_name: { type: 'string' },
    connection_status: { type: 'string', enum: ['connected', 'error', 'revoked'] },
    channel_connection: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        provider: { type: 'string' },
        status: { type: 'string' },
      },
    },
    is_automation_enabled: { type: 'boolean' },
    is_paused: { type: 'boolean' },
    paused_at: { type: 'string', format: 'date-time', nullable: true },
    is_suspended: { type: 'boolean' },
    is_in_plan: { type: 'boolean' },
    plan_stop_reason: {
      type: 'string',
      enum: ['plan_limit', 'plan_ended', 'plan_downgrade'],
      nullable: true,
    },
    plan_stopped_at: { type: 'string', format: 'date-time', nullable: true },
    active_stop: {
      type: 'object',
      nullable: true,
      properties: {
        lane: { type: 'string' },
        reason: { type: 'string' },
        stop_until: { type: 'string', format: 'date-time', nullable: true },
      },
    },
    new_account_limit_ends_at: { type: 'string', format: 'date-time', nullable: true },
    connected_by_user_id: { type: 'string', nullable: true },
    connected_at: { type: 'string', format: 'date-time' },
    disconnected_at: { type: 'string', format: 'date-time', nullable: true },
    instagram: {
      type: 'object',
      nullable: true,
      properties: {
        instagram_user_id: { type: 'string' },
        username: { type: 'string', nullable: true },
        account_type: { type: 'string', enum: ['business', 'creator'], nullable: true },
        is_private: { type: 'boolean' },
        followers_count: { type: 'integer' },
        profile_picture_url: { type: 'string', nullable: true },
        starter_questions_set_at: { type: 'string', format: 'date-time', nullable: true },
        is_webhook_subscribed: { type: 'boolean' },
        profile_synced_at: { type: 'string', format: 'date-time', nullable: true },
        settings: instagramAccountSettingsSchema,
      },
    },
  },
};

export const channelAccountExample = {
  id: 'cha_k7x9m2pqr4w8n1v3a1b2c',
  channel: 'instagram',
  display_name: '@handmade.shop',
  connection_status: 'connected',
  channel_connection: { id: 'chc_p4k8m2x9q1w7n3v5a1b2c', provider: 'meta', status: 'connected' },
  is_automation_enabled: true,
  is_paused: false,
  paused_at: null,
  is_suspended: false,
  is_in_plan: true,
  plan_stop_reason: null,
  plan_stopped_at: null,
  active_stop: null,
  new_account_limit_ends_at: '2026-11-28T09:00:00.000Z',
  connected_by_user_id: 'usr_m7n2p5q8w1r4x9k3a1b2c',
  connected_at: '2026-11-21T09:00:00.000Z',
  disconnected_at: null,
  instagram: {
    instagram_user_id: '17841400000000001',
    username: 'handmade.shop',
    account_type: 'business',
    is_private: false,
    followers_count: 1204,
    profile_picture_url: 'https://scontent.cdninstagram.com/v/handmade-shop-profile.jpg',
    starter_questions_set_at: null,
    is_webhook_subscribed: true,
    profile_synced_at: '2026-11-21T09:00:00.000Z',
    settings: instagramAccountSettingsExample,
  },
};

// ── Channel connection (feat-instagram-dm-sending routes-final § 1.6) ──
// Mirrors serializeChannelConnection key for key. Never the token.
const channelConnectionAccountSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    channel: { type: 'string', enum: ['instagram'] },
    display_name: { type: 'string' },
    profile_picture_url: { type: 'string', nullable: true },
    connection_status: { type: 'string', enum: ['connected', 'error', 'revoked'] },
  },
};

const channelConnectionAccountExample = {
  id: 'cha_k7x9m2pqr4w8n1v3a1b2c',
  channel: 'instagram',
  display_name: '@handmade.shop',
  profile_picture_url: 'https://scontent.cdninstagram.com/v/handmade-shop-profile.jpg',
  connection_status: 'connected',
};

export const channelConnectionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    provider: { type: 'string', enum: ['meta'] },
    client_business_id: { type: 'string' },
    login_type: { type: 'string', enum: ['unified'] },
    status: { type: 'string', enum: ['connected', 'error', 'revoked'] },
    status_changed_at: { type: 'string', format: 'date-time' },
    scopes: { type: 'array', items: { type: 'string' } },
    has_ads_access: { type: 'boolean' },
    connected_by_user_id: { type: 'string', nullable: true },
    connected_at: { type: 'string', format: 'date-time' },
    last_checked_at: { type: 'string', format: 'date-time', nullable: true },
    last_check_error: { type: 'string', nullable: true },
    disconnected_at: { type: 'string', format: 'date-time', nullable: true },
    channel_accounts: { type: 'array', items: channelConnectionAccountSchema },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const channelConnectionExample = {
  id: 'chc_q4w8n1v3a1b2ck7x9m2pr',
  provider: 'meta',
  client_business_id: '5550001234567890',
  login_type: 'unified',
  status: 'connected',
  status_changed_at: '2026-11-24T09:00:00.000Z',
  scopes: ['instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments'],
  has_ads_access: false,
  connected_by_user_id: 'usr_m7n2p5q8w1r4x9k3a1b2c',
  connected_at: '2026-11-24T09:00:00.000Z',
  last_checked_at: '2026-11-24T09:00:00.000Z',
  last_check_error: null,
  disconnected_at: null,
  channel_accounts: [channelConnectionAccountExample],
  created_at: '2026-11-24T09:00:00.000Z',
  updated_at: '2026-11-24T09:00:00.000Z',
};

// Routes 1 and 40.
export const channelConnectStartSchema = {
  type: 'object',
  properties: {
    login_url: { type: 'string', format: 'uri' },
    state_expires_at: { type: 'string', format: 'date-time' },
  },
};

export const channelConnectStartExample = {
  login_url:
    'https://www.facebook.com/dialog/oauth?client_id=1234567890&config_id=987654321&redirect_uri=https%3A%2F%2Fapp.example.com%2Fconnect%2Fmeta&response_type=code&state=Vh3k-example-state-43-characters-long-aaaaa&prompt=login',
  state_expires_at: '2026-11-24T09:10:00.000Z',
};

const channelAccountPlanRoomSchema = {
  type: 'object',
  properties: {
    accounts_max: { type: 'integer' },
    accounts_used: { type: 'integer' },
    accounts_free: { type: 'integer' },
  },
};

const channelAccountPlanRoomExample = { accounts_max: 3, accounts_used: 1, accounts_free: 2 };

// Route 2.
export const channelConnectResultSchema = {
  type: 'object',
  properties: {
    is_reconnect: { type: 'boolean' },
    channel_connection: channelConnectionSchema,
    accounts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          channel: { type: 'string', enum: ['instagram'] },
          provider_account_id: { type: 'string' },
          username: { type: 'string', nullable: true },
          profile_picture_url: { type: 'string', nullable: true },
          state: { type: 'string', enum: ['connected_here', 'connected_elsewhere', 'free'] },
          channel_account_id: { type: 'string', nullable: true },
        },
      },
    },
    reconnected_account_ids: { type: 'array', items: { type: 'string' } },
    plan_room: channelAccountPlanRoomSchema,
  },
};

export const channelConnectResultExample = {
  is_reconnect: false,
  channel_connection: { ...channelConnectionExample, channel_accounts: [] },
  accounts: [
    {
      channel: 'instagram',
      provider_account_id: '17841400000000001',
      username: 'handmade.shop',
      profile_picture_url: null,
      state: 'free',
      channel_account_id: null,
    },
  ],
  reconnected_account_ids: [],
  plan_room: { accounts_max: 3, accounts_used: 0, accounts_free: 3 },
};

// Route 3.
export const channelAccountPickResultSchema = {
  type: 'object',
  properties: {
    channel_connection_id: { type: 'string' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          provider_account_id: { type: 'string' },
          result: {
            type: 'string',
            enum: ['connected', 'already_connected', 'connected_elsewhere', 'not_assigned'],
          },
          channel_account: { ...channelConnectionAccountSchema, nullable: true },
        },
      },
    },
    plan_room: channelAccountPlanRoomSchema,
  },
};

export const channelAccountPickResultExample = {
  channel_connection_id: 'chc_q4w8n1v3a1b2ck7x9m2pr',
  results: [
    {
      provider_account_id: '17841400000000001',
      result: 'connected',
      channel_account: channelConnectionAccountExample,
    },
  ],
  plan_room: channelAccountPlanRoomExample,
};

// ── The ad picker (routes 41 and 15, MC13) ──
// Mirror serializeMetaAdAccount / serializeMetaAd key for key (routes-final § 1.6).
export const metaAdAccountSchema = {
  type: 'object',
  properties: {
    ad_account_id: { type: 'string', description: "Meta's ad account id, digits, no act_ prefix" },
    name: { type: 'string', nullable: true },
    account_status: {
      type: 'integer',
      nullable: true,
      description: "Meta's account_status (1 active, 2 disabled, …)",
    },
  },
};

export const metaAdAccountExample = {
  ad_account_id: '1234567890123',
  name: 'Handmade Shop ads',
  account_status: 1,
};

export const metaAdSchema = {
  type: 'object',
  properties: {
    ad_id: { type: 'string' },
    name: { type: 'string', nullable: true },
    status: { type: 'string', nullable: true, description: "Meta's effective_status" },
    ad_account_id: { type: 'string' },
    instagram_media_id: { type: 'string', nullable: true },
    channel_account_id: {
      type: 'string',
      nullable: true,
      description:
        "The organization's channel account the ad runs as (matched by its Instagram id)",
    },
    thumbnail_url: { type: 'string', nullable: true },
    created_at: { type: 'string', nullable: true, description: "Meta's created_time, as sent" },
  },
};

export const metaAdExample = {
  ad_id: '120200000000000001',
  name: 'Winter sale',
  status: 'ACTIVE',
  ad_account_id: '1234567890123',
  instagram_media_id: '18030000000000001',
  channel_account_id: 'iga_q4w8n1v3a1b2ck7x9m2pr',
  thumbnail_url: 'https://scontent.cdninstagram.com/v/ad-thumbnail.jpg',
  created_at: '2026-11-01T10:00:00+0000',
};

/** `meta.ad_access` of the ad picker (MC13): `missing` → an empty list and "Connect an ad account". */
export const adAccessMetaProperty = {
  ad_access: {
    type: 'string',
    enum: ['granted', 'missing'],
    description:
      'granted when the connection holds ads_read; missing → the list is empty (offer Connect an ad account)',
  },
};

// ── Instagram media item (route 5) ──
// Mirrors serializeInstagramMediaItem key for key (routes-final § 1.C.6).
const instagramMediaChildSchema = {
  type: 'object',
  properties: {
    instagram_media_id: { type: 'string' },
    media_type: { type: 'string', enum: ['image', 'video'], nullable: true },
    media_url: { type: 'string', nullable: true },
  },
};

export const instagramMediaItemSchema = {
  type: 'object',
  properties: {
    instagram_media_id: { type: 'string' },
    caption: { type: 'string', nullable: true },
    media_type: { type: 'string', enum: ['image', 'video', 'carousel_album'], nullable: true },
    media_product_type: {
      type: 'string',
      enum: ['feed', 'reels', 'story', 'ad'],
      nullable: true,
    },
    media_url: { type: 'string', nullable: true },
    thumbnail_url: { type: 'string', nullable: true },
    permalink: { type: 'string', nullable: true },
    published_at: { type: 'string', format: 'date-time', nullable: true },
    comments_count: { type: 'integer', nullable: true },
    like_count: { type: 'integer', nullable: true },
    children: { type: 'array', items: instagramMediaChildSchema, nullable: true },
  },
};

export const instagramMediaItemExample = {
  instagram_media_id: '18030000000000004',
  caption: 'Three colours, one price — comment SHOP',
  media_type: 'carousel_album',
  media_product_type: 'feed',
  media_url: 'https://scontent.cdninstagram.com/v/handmade-shop-carousel-cover.jpg',
  thumbnail_url: null,
  permalink: 'https://www.instagram.com/p/HandmadeShopCarousel/',
  published_at: '2026-11-18T12:00:00.000Z',
  comments_count: 31,
  like_count: 512,
  children: [
    {
      instagram_media_id: '18030000000000005',
      media_type: 'image',
      media_url: 'https://scontent.cdninstagram.com/v/handmade-shop-carousel-red.jpg',
    },
    {
      instagram_media_id: '18030000000000006',
      media_type: 'video',
      media_url: 'https://scontent.cdninstagram.com/o1/v/handmade-shop-carousel-blue.mp4',
    },
  ],
};

// ── Instagram story (route 6) ──
// Mirrors serializeInstagramStory key for key; expires_at = published_at + 24 h.
export const instagramStorySchema = {
  type: 'object',
  properties: {
    instagram_story_id: { type: 'string' },
    media_type: { type: 'string', enum: ['image', 'video'], nullable: true },
    media_url: { type: 'string', nullable: true },
    thumbnail_url: { type: 'string', nullable: true },
    permalink: { type: 'string', nullable: true },
    published_at: { type: 'string', format: 'date-time', nullable: true },
    expires_at: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const instagramStoryExample = {
  instagram_story_id: '17900000000000002',
  media_type: 'video',
  media_url: 'https://scontent.cdninstagram.com/o1/v/handmade-shop-story.mp4',
  thumbnail_url: 'https://scontent.cdninstagram.com/v/handmade-shop-story-thumbnail.jpg',
  permalink: 'https://www.instagram.com/stories/handmade.shop/17900000000000002/',
  published_at: '2026-11-21T09:40:00.000Z',
  expires_at: '2026-11-22T09:40:00.000Z',
};

// ── Meta callbacks (routes 7–8, § 1.D.6) ──
// Route 7's `data` is always null — Meta reads only the 200.
export const metaDeauthorizeAcknowledgementSchema = {
  type: 'object',
  nullable: true,
  description: "Always null — Meta reads only the status; the account's changes are not echoed.",
};

// Route 8: Meta's documented shape, outside the { data, meta } envelope.
// Mirrors serializeMetaDataDeletionAnswer key for key.
export const metaDataDeletionAnswerSchema = {
  type: 'object',
  description:
    "Meta's data-deletion answer — sent as it is, outside the { data, meta } envelope (Meta reads these two keys at the top level).",
  properties: {
    url: {
      type: 'string',
      format: 'uri',
      description:
        "The frontend's status page for this request: FRONTEND_URL + /instagram/data-deletion?code=<confirmation_code>.",
    },
    confirmation_code: {
      type: 'string',
      pattern: '^[a-z0-9]{21}$',
      description:
        'Derived from the signed request — Meta repeating one request gets the same code.',
    },
  },
  required: ['url', 'confirmation_code'],
  example: {
    url: 'http://localhost:5173/instagram/data-deletion?code=k3v9q2x7m1p8z4w6t0r5a',
    confirmation_code: 'k3v9q2x7m1p8z4w6t0r5a',
  },
};

// ── Contact ──
// Mirrors serializeContact key for key (routes-final § 2.6). Never the internal ids or deleted_at.
export const contactSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    instagram_account_id: { type: 'string' },
    instagram_user_id: { type: 'string' },
    username: { type: 'string', nullable: true },
    full_name: { type: 'string', nullable: true },
    profile_picture_url: { type: 'string', nullable: true },
    followers_count: { type: 'integer', minimum: 0, nullable: true },
    is_following_account: { type: 'boolean', nullable: true },
    follow_checked_at: { type: 'string', format: 'date-time', nullable: true },
    email: { type: 'string', format: 'email', nullable: true },
    email_collected_at: { type: 'string', format: 'date-time', nullable: true },
    phone: { type: 'string', nullable: true },
    phone_collected_at: { type: 'string', format: 'date-time', nullable: true },
    tags: { type: 'array', items: { type: 'string' } },
    first_seen_at: { type: 'string', format: 'date-time' },
    last_message_received_at: { type: 'string', format: 'date-time' },
    last_direct_message_received_at: { type: 'string', format: 'date-time', nullable: true },
    last_message_sent_at: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const contactExample = {
  id: 'con_p3k8w2m9x4r7n1v5a1b2c',
  instagram_account_id: 'cha_k7x9m2pqr4w8n1v3a1b2c',
  instagram_user_id: '17841455500000001',
  username: 'jordan.lee',
  full_name: 'Jordan Lee',
  profile_picture_url: 'https://scontent.cdninstagram.com/v/jordan-lee-profile.jpg',
  followers_count: 812,
  is_following_account: true,
  follow_checked_at: '2026-11-21T09:05:00.000Z',
  email: 'jordan.lee@example.com',
  email_collected_at: '2026-11-21T09:06:00.000Z',
  phone: '+15550100123',
  phone_collected_at: '2026-11-21T09:06:20.000Z',
  tags: ['giveaway'],
  first_seen_at: '2026-11-21T09:00:00.000Z',
  last_message_received_at: '2026-11-21T09:06:20.000Z',
  last_direct_message_received_at: '2026-11-21T09:06:20.000Z',
  last_message_sent_at: '2026-11-21T09:06:30.000Z',
  created_at: '2026-11-21T09:00:00.000Z',
  updated_at: '2026-11-21T09:06:30.000Z',
};

// ── Instagram webhook event ──
// Mirrors serializeInstagramWebhookEvent key for key. The payload is masked (WH17).
export const instagramWebhookEventSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    instagram_user_id: { type: 'string' },
    contact_instagram_user_id: { type: 'string', nullable: true },
    event_kind: { type: 'string', enum: [...INSTAGRAM_WEBHOOK_EVENT_KINDS] },
    event_key: { type: 'string' },
    status: { type: 'string', enum: [...INSTAGRAM_WEBHOOK_EVENT_STATUSES] },
    skip_reason: {
      type: 'string',
      enum: [...INSTAGRAM_WEBHOOK_EVENT_SKIP_REASONS],
      nullable: true,
    },
    error_message: { type: 'string', nullable: true },
    attempt_count: { type: 'integer', minimum: 0 },
    payload: { type: 'object', additionalProperties: true },
    occurred_at: { type: 'string', format: 'date-time', nullable: true },
    received_at: { type: 'string', format: 'date-time' },
    processed_at: { type: 'string', format: 'date-time', nullable: true },
  },
};

export const instagramWebhookEventExample = {
  id: 'iwe_k3m9p2q7r5t1v8w4x6y0z',
  instagram_user_id: '17841400000000001',
  contact_instagram_user_id: '17841400000000777',
  event_kind: 'comment',
  event_key: 'comment:18012345678901234',
  status: 'processed',
  skip_reason: null,
  error_message: null,
  attempt_count: 1,
  payload: {
    field: 'comments',
    value: {
      id: '18012345678901234',
      text: 'Send me the link please, write to a***@e',
      from: { id: '17841400000000777', username: 'acme_customer' },
      media: { id: '17900000000000001', media_product_type: 'FEED' },
    },
  },
  occurred_at: '2026-11-21T09:00:00.000Z',
  received_at: '2026-11-21T09:00:01.000Z',
  processed_at: '2026-11-21T09:00:03.000Z',
};

// ── Automation ──
// Mirrors serializeAutomation key for key (routes-final § 3.A.6). Never the internal ids or the
// soft-delete columns; every value list typed as its list (D19).
const automationOpeningMessageSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    button_title: { type: 'string', nullable: true },
  },
};

const automationFollowRequestMessageSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    following_button_title: { type: 'string' },
    profile_button_title: { type: 'string' },
  },
};

const automationTextMessageSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
};

export const automationSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    instagram_account_id: { type: 'string' },
    name: { type: 'string' },
    status: { type: 'string', enum: [...AUTOMATION_STATUSES] },
    trigger_type: { type: 'string', enum: [...AUTOMATION_TRIGGER_TYPES] },
    target_scope: { type: 'string', enum: [...AUTOMATION_TARGET_SCOPES] },
    target_instagram_media_id: { type: 'string', nullable: true },
    target_instagram_story_id: { type: 'string', nullable: true },
    next_post_starts_at: { type: 'string', format: 'date-time', nullable: true },
    next_post_ends_at: { type: 'string', format: 'date-time', nullable: true },
    next_post_status: { type: 'string', enum: [...AUTOMATION_NEXT_POST_STATUSES], nullable: true },
    next_post_linked_at: { type: 'string', format: 'date-time', nullable: true },
    is_dm_keyword_trigger_enabled: { type: 'boolean' },
    keywords: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
    is_public_reply_enabled: { type: 'boolean' },
    public_reply_texts: { type: 'array', items: { type: 'string' } },
    is_opening_message_enabled: { type: 'boolean' },
    opening_message: { ...automationOpeningMessageSchema, nullable: true },
    is_follow_required: { type: 'boolean' },
    follow_request_message: { ...automationFollowRequestMessageSchema, nullable: true },
    is_email_collection_enabled: { type: 'boolean' },
    email_request_message: { ...automationTextMessageSchema, nullable: true },
    is_phone_collection_enabled: { type: 'boolean' },
    phone_request_message: { ...automationTextMessageSchema, nullable: true },
    final_message: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        links: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, url: { type: 'string', format: 'uri' } },
          },
        },
      },
    },
    completed_run_count: { type: 'integer', minimum: 0 },
    last_triggered_at: { type: 'string', format: 'date-time', nullable: true },
    created_by_user_id: { type: 'string', nullable: true },
    updated_by_user_id: { type: 'string', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

export const automationExample = {
  id: 'aut_m4q8x2k7p9r3t1v5a1b2c',
  instagram_account_id: 'cha_k7x9m2pqr4w8n1v3a1b2c',
  name: 'Comment SHOP for the link',
  status: 'live',
  trigger_type: 'comment',
  target_scope: 'specific',
  target_instagram_media_id: '18030000000000004',
  target_instagram_story_id: null,
  next_post_starts_at: null,
  next_post_ends_at: null,
  next_post_status: null,
  next_post_linked_at: null,
  is_dm_keyword_trigger_enabled: true,
  keywords: ['shop', 'link'],
  tags: ['launch'],
  is_public_reply_enabled: true,
  public_reply_texts: ['Check your DMs!', 'Sent you the link'],
  is_opening_message_enabled: true,
  opening_message: {
    text: 'Thanks for your comment! Tap below for the link.',
    button_title: 'Send it',
  },
  is_follow_required: false,
  follow_request_message: null,
  is_email_collection_enabled: true,
  email_request_message: null,
  is_phone_collection_enabled: false,
  phone_request_message: null,
  final_message: {
    text: 'Here is the shop — enjoy!',
    links: [{ title: 'Open the shop', url: 'https://shop.example.com/launch' }],
  },
  completed_run_count: 42,
  last_triggered_at: '2026-11-21T09:00:00.000Z',
  created_by_user_id: 'usr_a1b2c3d4e5f6g7h8i9j0k',
  updated_by_user_id: 'usr_a1b2c3d4e5f6g7h8i9j0k',
  created_at: '2026-11-21T08:00:00.000Z',
  updated_at: '2026-11-21T08:30:00.000Z',
};
