import { describe, expect, it } from 'vitest';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { AUDIT_PERMISSIONS } from '@/domains/audit/audit.permissions.js';
import { BILLING_PERMISSIONS } from '@/domains/billing/billing.permissions.js';
import { NOTIFY_PERMISSIONS } from '@/domains/notify/notify.permissions.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { UPLOAD_PERMISSIONS } from '@/domains/upload/upload.permissions.js';
import { SYSTEM_PERMISSIONS } from '@/domains/tenancy/sub-domains/permission/seed/permission.reference.seed.js';

/** Every permission code a domain declares — what a role may be granted. */
const DECLARED_CODES = [
  TENANCY_PERMISSIONS,
  AUDIT_PERMISSIONS,
  BILLING_PERMISSIONS,
  NOTIFY_PERMISSIONS,
  UPLOAD_PERMISSIONS,
  APP_PERMISSIONS,
].flatMap((codes) => Object.values(codes) as string[]);

/**
 * The permission catalog (`GET /tenancy/permissions`, the reference seed) is exactly the codes the
 * domains declare — no code a role could never be granted, none missing — so its size is a fact of
 * the code, not a number to keep in a document (launch USERS-M7: a report once said 132 when the
 * catalog served 82).
 */
describe('permission catalog (policy)', () => {
  it('seeds every declared code once, and nothing else', () => {
    const seeded = SYSTEM_PERMISSIONS.map((permission) => permission.code);
    expect(new Set(seeded).size).toBe(seeded.length);
    expect([...seeded].sort()).toEqual([...new Set(DECLARED_CODES)].sort());
  });

  // Launch IA2 / AC-1.1, feat-instagram-dm-sending TN2: the app codes sit in three Roles-matrix rows.
  it('files the app codes under the Instagram, Automations and Contacts rows', () => {
    const categoryOf = new Map(
      SYSTEM_PERMISSIONS.map((permission) => [permission.code as string, permission.category]),
    );
    expect(Object.values(APP_PERMISSIONS).map((code) => [code, categoryOf.get(code)])).toEqual([
      ['instagram-account:read', 'instagram'],
      ['instagram-account:manage', 'instagram'],
      ['instagram-webhook-event:read', 'instagram'],
      ['automation:read', 'automations'],
      ['automation:create', 'automations'],
      ['automation:update', 'automations'],
      ['automation:delete', 'automations'],
      ['contact:read', 'contacts'],
      ['contact:update', 'contacts'],
      ['contact:delete', 'contacts'],
    ]);
  });
});
