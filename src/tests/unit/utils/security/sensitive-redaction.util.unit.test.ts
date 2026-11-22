import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import pino from 'pino';
import {
  isSecretKey,
  isSensitiveKey,
  PERSONAL_DATA_KEY_FRAGMENTS,
  SECRET_KEY_FRAGMENTS,
  listDatabaseErrorMessages,
  redactSensitive,
  sanitizeDatabaseError,
  redactSensitiveQueryString,
  redactSensitiveUrl,
  SENSITIVE_KEY_FRAGMENTS,
  SENSITIVE_REDACTION_PLACEHOLDER,
} from '@/shared/utils/security/sensitive-redaction.util.js';
import { PINO_REDACT_PATHS } from '@/shared/utils/http/fastify-server.util.js';

// audit #27: PINO_REDACT_PATHS is now derived from SENSITIVE_KEY_FRAGMENTS (one source of truth).
// This pins the no-drift invariant: every recursive fragment is also a Pino fast-path, and every
// bare (non-nested) Pino path is recognised as sensitive by the recursive matcher.
describe('redaction single-source invariant (audit #27)', () => {
  it('PINO_REDACT_PATHS includes every SENSITIVE_KEY_FRAGMENTS entry', () => {
    for (const fragment of SENSITIVE_KEY_FRAGMENTS) {
      expect(PINO_REDACT_PATHS).toContain(fragment);
    }
  });

  it('every bare Pino path is caught by the recursive isSensitiveKey matcher', () => {
    const barePaths = PINO_REDACT_PATHS.filter(
      (path) => !(path.includes('.') || path.includes('[')),
    );
    for (const path of barePaths) {
      expect(isSensitiveKey(path)).toBe(true);
    }
  });
});

// Launch D38 (CT12): the logs hide a contact's personal data, but a response may carry it and the
// idempotency layer may replay it — so the log list is the secret list plus personal data, and
// the secret test stays the secrets only.
describe('the log list and the secret list (launch D38, D40)', () => {
  const PERSONAL_KEYS = [
    'username',
    'phone',
    'full_name',
    'profile_picture_url',
    'email',
    'is_email_collection_enabled',
    'email_request_message',
    // The run engine's copies of what a person wrote (launch AU26, AUC13).
    'trigger_text',
    'comment_text',
    'commenter_username',
    'email_received',
    'phone_received',
  ];

  it('derives the log list from the secret list and the personal data — one source, no drift', () => {
    expect(SENSITIVE_KEY_FRAGMENTS).toEqual([
      ...SECRET_KEY_FRAGMENTS,
      ...PERSONAL_DATA_KEY_FRAGMENTS,
    ]);
    for (const fragment of PERSONAL_DATA_KEY_FRAGMENTS) {
      expect(SECRET_KEY_FRAGMENTS).not.toContain(fragment);
    }
  });

  it.each(PERSONAL_KEYS)('hides %s in logs but does not call it a secret', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
    expect(isSecretKey(key)).toBe(false);
  });

  it.each(['access_token', 'client_secret', 'password', 'raw_key', 'Authorization'])(
    'calls %s a secret, and hides it in logs',
    (key) => {
      expect(isSecretKey(key)).toBe(true);
      expect(isSensitiveKey(key)).toBe(true);
    },
  );

  it('a log line masks a contact username, phone, full name, picture and email', () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    // The process logger's two halves: the Pino paths and the recursive formatter.
    const logger = pino(
      {
        redact: { paths: [...PINO_REDACT_PATHS], censor: SENSITIVE_REDACTION_PLACEHOLDER },
        formatters: { log: (object) => redactSensitive(object) },
      },
      destination,
    );

    logger.info(
      {
        username: 'jordan.lee',
        contact: {
          username: 'jordan.lee',
          phone: '+15550100123',
          full_name: 'Jordan Lee',
          profile_picture_url: 'https://cdn.example.com/jordan.jpg',
          email: 'jordan.lee@example.com',
        },
        contactPublicId: 'con_p3k8w2m9x4r7n1v5a1b2c',
      },
      'app.contact.probe',
    );

    const line = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(line.username).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(line.contact).toEqual({
      username: SENSITIVE_REDACTION_PLACEHOLDER,
      phone: SENSITIVE_REDACTION_PLACEHOLDER,
      full_name: SENSITIVE_REDACTION_PLACEHOLDER,
      profile_picture_url: SENSITIVE_REDACTION_PLACEHOLDER,
      email: SENSITIVE_REDACTION_PLACEHOLDER,
    });
    expect(line.contactPublicId).toBe('con_p3k8w2m9x4r7n1v5a1b2c');
    expect(lines.join('')).not.toContain('jordan');
  });

  it('masks a username in a logged query string too', () => {
    expect(redactSensitiveQueryString('username=jordan&limit=25')).toBe(
      `username=${SENSITIVE_REDACTION_PLACEHOLDER}&limit=25`,
    );
  });
});

describe('redactSensitive', () => {
  it('redacts case-insensitive and nested sensitive keys', () => {
    const input = {
      Authorization: 'Bearer abc',
      headers: {
        'X-Api-Key': 'k-123',
        'set-cookie': 'session=zzz',
        'content-type': 'application/json',
      },
      body: {
        password: 'hunter2',
        nested: { refresh_token: 'r-1', keepThis: 'visible' },
      },
      raw_key: 'sk_live_xyz',
    };

    const result = redactSensitive(input);

    expect(result.Authorization).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.headers['X-Api-Key']).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.headers['set-cookie']).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.body.password).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.body.nested.refresh_token).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.body.nested.keepThis).toBe('visible');
    expect(result.raw_key).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
  });

  it('redacts the Instagram token ciphertext in either casing (launch IA5)', () => {
    // The exact Pino fast-path, and the recursive formatter for the column and the code's name.
    expect(PINO_REDACT_PATHS).toContain('encrypted_access_token');
    const result = redactSensitive({
      row: { encrypted_access_token: 'v1:abc', expires_at: '2027-01-01' },
      encryptedAccessToken: 'v1:def',
    });
    expect(result.row).toEqual({
      encrypted_access_token: SENSITIVE_REDACTION_PLACEHOLDER,
      expires_at: '2027-01-01',
    });
    expect(result.encryptedAccessToken).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
  });

  it('redacts email PII keys (object and query string)', () => {
    const result = redactSensitive({
      email: 'user@example.com',
      body: { user_email: 'a@b.com', name: 'ok' },
    });
    expect(result.email).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.body.user_email).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.body.name).toBe('ok');
    expect(redactSensitive('email=user%40example.com&page=1')).toBe(
      `email=${SENSITIVE_REDACTION_PLACEHOLDER}&page=1`,
    );
  });

  it('redacts sensitive keys inside arrays', () => {
    const input = { items: [{ apiKey: 'a' }, { name: 'ok' }] };
    const result = redactSensitive(input);
    expect(result.items[0]!.apiKey).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.items[1]!.name).toBe('ok');
  });

  it('does not mutate the original object', () => {
    const input = { token: 'secret-value' };
    const result = redactSensitive(input);
    expect(input.token).toBe('secret-value');
    expect(result.token).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
  });

  it('returns non-query primitives unchanged', () => {
    expect(redactSensitive('plain')).toBe('plain');
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBeNull();
  });

  it('redacts sensitive values in query strings', () => {
    expect(redactSensitive('token=secret&page=1')).toBe(
      `token=${SENSITIVE_REDACTION_PLACEHOLDER}&page=1`,
    );
    expect(redactSensitive('?raw_key=sk_live&name=bob')).toBe(
      `?raw_key=${SENSITIVE_REDACTION_PLACEHOLDER}&name=bob`,
    );
  });

  it('redacts sensitive values in URL strings', () => {
    expect(redactSensitive('https://api.example.com/v1/items?api_key=secret&page=2')).toBe(
      `https://api.example.com/v1/items?api_key=${SENSITIVE_REDACTION_PLACEHOLDER}&page=2`,
    );
  });

  it('handles cyclic structures without reintroducing secrets', () => {
    const cyclic: Record<string, unknown> = { name: 'root', password: 'x' };
    cyclic.self = cyclic;
    expect(() => redactSensitive(cyclic)).not.toThrow();
    const result = redactSensitive(cyclic) as Record<string, unknown>;
    expect(result.password).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(result.self).not.toBe(cyclic);
    const nestedSelf = result.self as Record<string, unknown>;
    expect(nestedSelf.password).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
  });

  it('does not return original objects beyond max depth', () => {
    const leafSecret = 'must-not-appear-beyond-max-depth';
    const root: Record<string, unknown> = { nested: {} };
    let current = root.nested as Record<string, unknown>;
    for (let depth = 0; depth < 15; depth += 1) {
      const next: Record<string, unknown> = {};
      current.child = next;
      current = next;
    }
    current.payload = leafSecret;

    const result = redactSensitive(root) as Record<string, unknown>;
    expect(result.nested).not.toBe(root.nested);
    expect(JSON.stringify(result)).not.toContain(leafSecret);
  });
});

describe('redactSensitiveQueryString', () => {
  it('redacts only sensitive query parameter values', () => {
    expect(redactSensitiveQueryString('foo=bar&token=abc')).toBe(
      `foo=bar&token=${SENSITIVE_REDACTION_PLACEHOLDER}`,
    );
    expect(redactSensitiveQueryString('?x-api-key=secret&limit=10')).toBe(
      `?x-api-key=${SENSITIVE_REDACTION_PLACEHOLDER}&limit=10`,
    );
  });
});

describe('redactSensitiveUrl', () => {
  it('redacts sensitive query parameters in absolute URLs', () => {
    expect(redactSensitiveUrl('https://example.com/path?password=hunter2&id=1')).toBe(
      `https://example.com/path?password=${SENSITIVE_REDACTION_PLACEHOLDER}&id=1`,
    );
  });
});

/**
 * `Object.entries` sees only own ENUMERABLE properties, and an Error keeps
 * `name` / `message` / `stack` non-enumerable — so the generic object walk
 * copied none of them and every error collapsed to `{}`. Pino runs
 * `formatters.log` before its serializers, so `stdSerializers.err` never saw an
 * Error and every `logger.error({ error }, …)` in the codebase shipped without a
 * message or a stack.
 */
describe('redactSensitive — Error values', () => {
  it('keeps the message and stack instead of collapsing to an empty object', () => {
    const error = new Error('connection refused');

    const redacted = redactSensitive(error);

    expect(redacted).toBeInstanceOf(Error);
    expect(redacted.message).toBe('connection refused');
    expect(redacted.stack).toContain('connection refused');
    expect(Object.keys(redacted as unknown as Record<string, unknown>)).not.toContain('name');
  });

  it('survives nested inside a log object', () => {
    const redacted = redactSensitive({ error: new Error('boom'), scope: 'worker' }) as {
      error: Error;
      scope: string;
    };

    expect(redacted.error).toBeInstanceOf(Error);
    expect(redacted.error.message).toBe('boom');
    expect(redacted.scope).toBe('worker');
  });

  it('redacts a secret in the message and in the stack header, keeping the frames', () => {
    const error = new Error('GET https://api.example.com/v1?access_token=super-secret');

    const redacted = redactSensitive(error);

    expect(redacted.message).toContain(SENSITIVE_REDACTION_PLACEHOLDER);
    expect(redacted.message).not.toContain('super-secret');
    expect(redacted.stack).not.toContain('super-secret');
    // The frames below the header line must survive the substitution.
    expect(redacted.stack).toContain('at ');
  });

  it('redacts sensitive own properties an error carries', () => {
    const error = Object.assign(new Error('auth failed'), {
      statusCode: 401,
      access_token: 'leaked',
    });

    const redacted = redactSensitive(error) as unknown as Record<string, unknown>;

    expect(redacted.statusCode).toBe(401);
    expect(redacted.access_token).toBe(SENSITIVE_REDACTION_PLACEHOLDER);
  });

  it('carries the cause across without making it enumerable', () => {
    const redacted = redactSensitive(new Error('outer', { cause: new Error('inner') })) as Error & {
      cause?: Error;
    };

    expect(redacted.cause).toBeInstanceOf(Error);
    expect(redacted.cause?.message).toBe('inner');
    expect(Object.keys(redacted as unknown as Record<string, unknown>)).not.toContain('cause');
  });

  it('never mutates the error it was handed', () => {
    const error = Object.assign(new Error('GET /x?token=abc'), { token: 'abc' });

    redactSensitive(error);

    expect(error.message).toBe('GET /x?token=abc');
    expect(error.token).toBe('abc');
  });

  it('returns the same copy for an error reachable twice (no infinite walk)', () => {
    const error = new Error('shared');
    const redacted = redactSensitive({ first: error, second: error }) as {
      first: Error;
      second: Error;
    };

    expect(redacted.first).toBe(redacted.second);
    expect(redacted.first.message).toBe('shared');
  });
});

describe('redactSensitiveUrl — relative paths', () => {
  it('does not double the question mark when redacting a relative URL', () => {
    expect(redactSensitiveUrl('/v1/callback?token=abc&id=1')).toBe(
      `/v1/callback?token=${SENSITIVE_REDACTION_PLACEHOLDER}&id=1`,
    );
  });
});

/**
 * C-1 — Drizzle's `Failed query: <sql>\nparams: <values>` and the driver error's row `detail`
 * carry customer data; key-based redaction cannot see a value, so database failures are reduced to
 * `{ name, code, constraint, table }` before they reach a log, Sentry or the dead-letter ledger.
 */
describe('sanitizeDatabaseError', () => {
  const boundValue = 'Priya Sharma, +91 98200 00000';

  function foreignKeyViolation(): Error {
    const driverError = Object.assign(new Error('insert violates foreign key constraint'), {
      code: '23503',
      severity: 'ERROR',
      constraint: 'customers_region_id_fkey',
      table: 'customers',
      detail: `Failing row contains (17, ${boundValue}).`,
    });
    return new DrizzleQueryError(
      'insert into "app"."customers" ("name", "region_id") values ($1, $2)',
      [boundValue, 99],
      driverError,
    );
  }

  it('keeps only the code, constraint and table of a Drizzle-wrapped server error', () => {
    const sanitized = sanitizeDatabaseError(foreignKeyViolation()) as Error &
      Record<string, unknown>;

    expect(sanitized.name).toBe('DatabaseQueryError');
    expect(sanitized.message).toBe(
      'Database query failed (SQLSTATE 23503, constraint customers_region_id_fkey, table customers)',
    );
    expect({ ...sanitized }).toEqual({
      code: '23503',
      constraint: 'customers_region_id_fkey',
      table: 'customers',
    });
    expect(sanitized.cause).toBeUndefined();
    expect(sanitized.stack).toMatch(/^DatabaseQueryError: Database query failed \(SQLSTATE 23503/);
    expect(sanitized.stack).toContain('\n    at ');
    expect(JSON.stringify([sanitized.message, sanitized.stack])).not.toContain('Priya');
  });

  it('reduces a bare node-postgres DatabaseError (its message can quote an input value)', () => {
    const driverError = Object.assign(
      new Error('value "99999999999" is out of range for type integer'),
      {
        code: '22003',
        severity: 'ERROR',
      },
    );
    const sanitized = sanitizeDatabaseError(driverError) as Error;

    expect(sanitized.message).toBe('Database query failed (SQLSTATE 22003)');
    expect(sanitized.stack).not.toContain('99999999999');
  });

  it('names a client-side failure under a Drizzle wrapper and keeps it as the cause', () => {
    const dropped = new Error('Connection terminated unexpectedly');
    const sanitized = sanitizeDatabaseError(
      new DrizzleQueryError('select 1 where id = $1', [boundValue], dropped),
    ) as Error;

    expect(sanitized.message).toBe('Database query failed: Connection terminated unexpectedly');
    expect(sanitized.cause).toBe(dropped);
    expect(sanitized.message).not.toContain('Priya');
  });

  it('returns any other value unchanged', () => {
    const error = new Error('plain');
    expect(sanitizeDatabaseError(error)).toBe(error);
    expect(sanitizeDatabaseError('text')).toBe('text');
    // A socket code is not a SQLSTATE: not a server error.
    const socketError = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(sanitizeDatabaseError(socketError)).toBe(socketError);
  });

  it('is what redactSensitive does to a database failure anywhere in a log object', () => {
    const redacted = redactSensitive({
      error: foreignKeyViolation(),
      nested: { cause: foreignKeyViolation() },
    });

    expect(redacted.error).toMatchObject({ code: '23503', table: 'customers' });
    expect(redacted.error.message).toMatch(/^Database query failed/);
    expect(JSON.stringify(redacted)).not.toContain('Priya');
  });

  it('scrubs Drizzle query text from plain strings — a logged message, a stack, a cut-short value', () => {
    const error = foreignKeyViolation();
    const cutShort = `${error.message.slice(0, 40)}...`;

    expect(redactSensitive(error.message)).toBe('Database query failed');
    expect(redactSensitive(error.stack)).toContain('Database query failed');
    expect(redactSensitive(`job failed: ${cutShort}`)).toBe('job failed: Database query failed');
    expect(redactSensitive(String(error.stack))).not.toContain('Priya');
  });

  it('cuts the query text at the first stack frame and keeps scrubbing after it', () => {
    const text =
      'Failed query: select 1\nparams: Priya\n    at first (a.ts:1:1)\n' +
      'Caused by: Failed query: select 2\nparams: Ravi\n\n   at second (b.ts:2:2)';

    expect(redactSensitive(text)).toBe(
      'Database query failed\n    at first (a.ts:1:1)\nCaused by: Database query failed\n\n   at second (b.ts:2:2)',
    );
  });

  it('stays linear on input built to make a backtracking pattern explode (SonarQube S5852)', () => {
    const hostile = `Failed query: ${'\n '.repeat(100_000)}x${'\n'.repeat(100_000)}y`;
    const startedAt = performance.now();

    expect(redactSensitive(hostile)).toBe('Database query failed');
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it('lists each database failure on a cause chain with its sanitized message', () => {
    const error = foreignKeyViolation();
    const wrapped = new Error('unit of work failed', { cause: error });

    expect(listDatabaseErrorMessages(wrapped)).toEqual([
      {
        message: error.message,
        sanitizedMessage:
          'Database query failed (SQLSTATE 23503, constraint customers_region_id_fkey, table customers)',
      },
      {
        message: 'insert violates foreign key constraint',
        sanitizedMessage:
          'Database query failed (SQLSTATE 23503, constraint customers_region_id_fkey, table customers)',
      },
    ]);
  });
});
