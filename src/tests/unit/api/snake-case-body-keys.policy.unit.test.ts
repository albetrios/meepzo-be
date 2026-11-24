/**
 * Policy: request body (`*.dto.ts`) and response body (`*.serializer.ts`) property keys are
 * snake_case. The public API contract exposes snake_case field names only — the single external
 * identifier is `id`. Internal TypeScript identifiers (local variables, private helpers) may stay
 * camelCase; this guard scans the wire-contract surfaces where a camelCase key would leak onto
 * the HTTP request/response. A serializer also emits its own row's public id under exactly that
 * key, `id` (`export_id` was the one exception). See `agent-os/rules/be-api-contract.mdc`.
 *
 * Documented exceptions (third-party / browser-native payloads passed through verbatim, plus
 * internal-only structures that are never serialized to a response):
 *  - WebAuthn DTOs mirror the W3C `navigator.credentials` JSON, which is camelCase by spec.
 *  - The audit serializer's internal public-id resolution maps are inputs, not response keys.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();
const DOMAINS_ROOT = join(PROJECT_ROOT, 'src/domains');

/** Files whose camelCase keys are a third-party / browser-native contract, not our wire format. */
const EXEMPT_FILES = new Set<string>([
  'src/domains/auth/sub-domains/auth-webauthn/webauthn.dto.ts',
]);

/** Internal (non-response) camelCase keys allowed in specific files. */
const EXEMPT_KEYS_BY_FILE: Record<string, ReadonlySet<string>> = {
  // Internal internal-id → public-id resolution maps consumed by the serializer; never emitted.
  'src/domains/audit/audit.serializer.ts': new Set(['userPublicIds', 'organizationPublicIds']),
  // Internal serializer input identifying the caller's current session; used only to derive the
  // snake_case `is_current` response flag — never emitted as a response key.
  'src/domains/auth/sub-domains/auth-session/auth-session.serializer.ts': new Set([
    'currentSessionPublicId',
  ]),
  // Routes 63–64's serializer inputs (feat-instagram-dm-sending § 6.A, R18): the options of
  // `serializeLane` / `serializeInstagramSendingStatus` / `serializeAppUsage` and their type
  // literals — read to build the snake_case body, never emitted as response keys.
  'src/domains/app/sub-domains/instagram-sending/instagram-sending.serializer.ts': new Set([
    'waitingCount',
    'openStops',
    'planStopReason',
    'waitingByLane',
    'windowClosedByAutomation',
    'lastBroadcast',
    'lastBackfill',
    'lastRetry',
    'sendingState',
    'planAccess',
  ]),
  // The options key of the shared end-after-start refinement (`addEndAfterStartIssue`); its value
  // names the snake_case body field the issue is reported on — never a body key itself.
  'src/domains/tenancy/sub-domains/membership/membership.dto.ts': new Set(['endField']),
  // The options key of the shared record-delete query builder (`recordDeleteQuerySchemaOf`) on
  // route 31 (feat-instagram-dm-sending R13) — configures the schema, never a query key itself.
  'src/domains/app/sub-domains/automation/automation.dto.ts': new Set(['isReasonOptional']),
  // The options of `buildAutomationLinkUrl` (R13, AU17) and its call — read to build the
  // snake_case `link_url`, never emitted as response keys.
  'src/domains/app/sub-domains/automation/automation.serializer.ts': new Set([
    'triggerType',
    'refCode',
  ]),
};

/** A line-leading `<identifier>:` declares an object/schema property or a type field. */
const PROPERTY_KEY = /^\s*([a-zA-Z_$][\w$]*)\s*:/;
/** A camelCase hump (lower/digit immediately followed by an uppercase letter). */
const CAMEL_CASE_HUMP = /[a-z0-9][A-Z]/;
/**
 * A serializer line emitting its own row's public id: `<key>: row.public_id` (`item` is the other
 * name serializers give their input). A comparison such as `row.public_id === …` does not match.
 */
const OWN_PUBLIC_ID_FIELD = /^\s*([a-z_]\w*)\s*:\s*(?:row|item)\.public_id,?\s*$/;

function collectFiles(directory: string, suffix: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      collectFiles(fullPath, suffix, collected);
    } else if (entry.endsWith(suffix)) {
      collected.push(fullPath);
    }
  }
  return collected;
}

function findCamelCaseKeys(absolutePath: string): string[] {
  const relativePath = relative(PROJECT_ROOT, absolutePath);
  if (EXEMPT_FILES.has(relativePath)) {
    return [];
  }
  const exemptKeys = EXEMPT_KEYS_BY_FILE[relativePath] ?? new Set<string>();
  const offenders: string[] = [];
  readFileSync(absolutePath, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      const match = PROPERTY_KEY.exec(line);
      if (!match) {
        return;
      }
      const key = match[1] as string;
      if (!CAMEL_CASE_HUMP.test(key) || exemptKeys.has(key)) {
        return;
      }
      offenders.push(`${relativePath}:${index + 1} → ${key}`);
    });
  return offenders;
}

function findRenamedOwnIds(absolutePath: string): string[] {
  const relativePath = relative(PROJECT_ROOT, absolutePath);
  return readFileSync(absolutePath, 'utf8')
    .split('\n')
    .flatMap((line, index) => {
      const key = OWN_PUBLIC_ID_FIELD.exec(line)?.[1];
      return key !== undefined && key !== 'id' ? [`${relativePath}:${index + 1} → ${key}`] : [];
    });
}

describe('snake_case body/response key policy', () => {
  it('every request DTO (*.dto.ts) declares only snake_case property keys', () => {
    const offenders = collectFiles(DOMAINS_ROOT, '.dto.ts').flatMap(findCamelCaseKeys);
    expect(offenders).toEqual([]);
  });

  it('every response serializer (*.serializer.ts) declares only snake_case property keys', () => {
    const offenders = collectFiles(DOMAINS_ROOT, '.serializer.ts').flatMap(findCamelCaseKeys);
    expect(offenders).toEqual([]);
  });

  it('every response serializer emits its own public id as `id`', () => {
    const offenders = collectFiles(DOMAINS_ROOT, '.serializer.ts').flatMap(findRenamedOwnIds);
    expect(offenders).toEqual([]);
  });
});
