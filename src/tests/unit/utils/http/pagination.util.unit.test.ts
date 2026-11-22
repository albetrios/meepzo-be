import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { PAGINATION } from '@/shared/constants/index.js';
import {
  buildAscendingIntegerIdCursorCondition,
  buildAscendingNullsLastTextIdCursorCondition,
  buildAscendingNullsLastTimestampIdCursorCondition,
  buildAscendingTextIdCursorCondition,
  buildDescendingIntegerIdCursorCondition,
  buildDescendingNullsLastTextIdCursorCondition,
  buildDescendingNullsLastTimestampIdCursorCondition,
  buildDescendingTextIdCursorCondition,
  cursorPaginationSchema,
  decodeListCursor,
  encodeListCursor,
  type ParsedListCursor,
  parseListCursor,
} from '@/shared/utils/http/pagination.util.js';

describe('pagination.util', () => {
  describe('cursorPaginationSchema', () => {
    it('applies default limit and optional after cursor', () => {
      const result = cursorPaginationSchema.parse({});
      expect(result.limit).toBe(PAGINATION.DEFAULT_LIMIT);
      expect(result.after).toBeUndefined();
    });

    it('accepts after cursor string', () => {
      const result = cursorPaginationSchema.parse({ after: 'cursor-abc', limit: '10' });
      expect(result.after).toBe('cursor-abc');
      expect(result.limit).toBe(10);
    });

    it('rejects limit above MAX_LIMIT', () => {
      expect(() => cursorPaginationSchema.parse({ limit: PAGINATION.MAX_LIMIT + 1 })).toThrow();
    });
  });

  describe('encodeListCursor / decodeListCursor', () => {
    const payload = {
      created_at: '2026-10-05T10:00:00.000Z',
      public_id: 'org_9z3rura5kqvcv8zggriym',
      id: 4217,
      filter_fingerprint: 'a'.repeat(64),
    };

    it('round-trips a payload', () => {
      expect(decodeListCursor(encodeListCursor(payload))).toEqual(payload);
    });

    it('never carries the internal id in readable form', () => {
      const token = encodeListCursor(payload);
      const raw = Buffer.from(token, 'base64url').toString('latin1');
      expect(raw).not.toContain('4217');
      expect(raw).not.toContain('"id"');
      expect(raw).not.toContain('org_9z3rura5kqvcv8zggriym');
    });

    it('mints a different token each time for the same payload', () => {
      expect(encodeListCursor(payload)).not.toBe(encodeListCursor(payload));
    });

    it('decodes a cursor that was edited as nothing (first page)', () => {
      const bytes = Buffer.from(encodeListCursor(payload), 'base64url');
      bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
      expect(decodeListCursor(bytes.toString('base64url'))).toBeNull();
    });

    it('decodes a readable (unencrypted) cursor as nothing — only minted cursors page', () => {
      const forged = Buffer.from(JSON.stringify(payload)).toString('base64url');
      expect(decodeListCursor(forged)).toBeNull();
      expect(parseListCursor(forged)).toBeNull();
    });

    it('fits the longest sort value under PAGINATION.MAX_CURSOR_LENGTH', () => {
      const token = encodeListCursor({ ...payload, sort_value: 'n'.repeat(255) });
      expect(token.length).toBeLessThanOrEqual(PAGINATION.MAX_CURSOR_LENGTH);
    });

    it('round-trips a null sort value — a value-less row under a nulls-last sort (CTC4)', () => {
      const token = encodeListCursor({ ...payload, sort_value: null });
      expect(decodeListCursor(token)).toEqual({ ...payload, sort_value: null });
      expect(parseListCursor(token)?.sort_value).toBeNull();
    });
  });

  describe('nulls-last text keyset builders (CTC4)', () => {
    const dialect = new PgDialect();
    const cursorOf = (over: Partial<ParsedListCursor>): ParsedListCursor => ({
      kind: 'opaque',
      created_at: '2026-10-05T10:00:00.000000Z',
      id: 12,
      ...over,
    });

    it('is no condition without a cursor, a sort value or an id (the first page)', () => {
      for (const build of [
        buildAscendingNullsLastTextIdCursorCondition,
        buildDescendingNullsLastTextIdCursorCondition,
      ]) {
        expect(build({ textColumn: roles.name, idColumn: roles.id, cursor: null })).toBeUndefined();
        expect(
          build({ textColumn: roles.name, idColumn: roles.id, cursor: cursorOf({}) }),
        ).toBeUndefined();
        expect(
          build({
            textColumn: roles.name,
            idColumn: roles.id,
            cursor: {
              kind: 'opaque',
              created_at: '2026-10-05T10:00:00.000000Z',
              sort_value: 'ana',
            },
          }),
        ).toBeUndefined();
      }
    });

    it('pages past a value, then every value-less row', () => {
      const ascending = buildAscendingNullsLastTextIdCursorCondition({
        textColumn: roles.name,
        idColumn: roles.id,
        cursor: cursorOf({ sort_value: 'ana' }),
      });
      const descending = buildDescendingNullsLastTextIdCursorCondition({
        textColumn: roles.name,
        idColumn: roles.id,
        cursor: cursorOf({ sort_value: 'ana' }),
      });
      expect(dialect.sqlToQuery(ascending as SQL).sql).toBe(
        '("tenancy"."roles"."name" > $1 or ("tenancy"."roles"."name" = $2 and "tenancy"."roles"."id" > $3) or "tenancy"."roles"."name" is null)',
      );
      expect(dialect.sqlToQuery(descending as SQL).sql).toBe(
        '("tenancy"."roles"."name" < $1 or ("tenancy"."roles"."name" = $2 and "tenancy"."roles"."id" > $3) or "tenancy"."roles"."name" is null)',
      );
    });

    it('pages inside the value-less rows from a value-less cursor', () => {
      const condition = buildDescendingNullsLastTextIdCursorCondition({
        textColumn: roles.name,
        idColumn: roles.id,
        cursor: cursorOf({ sort_value: null }),
      });
      const query = dialect.sqlToQuery(condition as SQL);
      expect(query.sql).toBe('("tenancy"."roles"."name" is null and "tenancy"."roles"."id" > $1)');
      expect(query.params).toEqual([12]);
    });

    it('the nulls-last timestamp builders cast the microsecond text back to timestamptz (AQ9)', () => {
      const ascending = buildAscendingNullsLastTimestampIdCursorCondition({
        timestampColumn: roles.updated_at,
        idColumn: roles.id,
        cursor: cursorOf({ sort_value: '2026-11-21T09:00:00.123456Z' }),
      });
      const descending = buildDescendingNullsLastTimestampIdCursorCondition({
        timestampColumn: roles.updated_at,
        idColumn: roles.id,
        cursor: cursorOf({ sort_value: null }),
      });
      const ascendingQuery = dialect.sqlToQuery(ascending as SQL);
      expect(ascendingQuery.sql).toBe(
        '("tenancy"."roles"."updated_at" > $1::timestamptz or ("tenancy"."roles"."updated_at" = $2::timestamptz and "tenancy"."roles"."id" > $3) or "tenancy"."roles"."updated_at" is null)',
      );
      expect(ascendingQuery.params).toEqual([
        '2026-11-21T09:00:00.123456Z',
        '2026-11-21T09:00:00.123456Z',
        12,
      ]);
      expect(dialect.sqlToQuery(descending as SQL).sql).toBe(
        '("tenancy"."roles"."updated_at" is null and "tenancy"."roles"."id" > $1)',
      );
      expect(
        buildAscendingNullsLastTimestampIdCursorCondition({
          timestampColumn: roles.updated_at,
          idColumn: roles.id,
          cursor: null,
        }),
      ).toBeUndefined();
    });

    it('the integer builders page past the decimal sort value and restart on a value-less cursor (AQ9)', () => {
      const descending = buildDescendingIntegerIdCursorCondition({
        integerColumn: roles.id,
        idColumn: roles.public_id,
        cursor: cursorOf({ sort_value: '42' }),
      });
      expect(dialect.sqlToQuery(descending as SQL).sql).toBe(
        '("tenancy"."roles"."id" < $1::integer or ("tenancy"."roles"."id" = $2::integer and "tenancy"."roles"."public_id" > $3))',
      );
      const ascending = buildAscendingIntegerIdCursorCondition({
        integerColumn: roles.id,
        idColumn: roles.public_id,
        cursor: cursorOf({ sort_value: '42' }),
      });
      expect(dialect.sqlToQuery(ascending as SQL).sql).toContain(
        '"tenancy"."roles"."id" > $1::integer',
      );
      for (const sortValue of [null, undefined]) {
        expect(
          buildAscendingIntegerIdCursorCondition({
            integerColumn: roles.id,
            idColumn: roles.public_id,
            cursor: cursorOf(sortValue === null ? { sort_value: null } : {}),
          }),
        ).toBeUndefined();
      }
    });

    it('the NOT NULL text builders restart on a value-less cursor', () => {
      expect(
        buildAscendingTextIdCursorCondition({
          textColumn: roles.name,
          idColumn: roles.id,
          cursor: cursorOf({ sort_value: null }),
        }),
      ).toBeUndefined();
      expect(
        buildDescendingTextIdCursorCondition({
          textColumn: roles.name,
          idColumn: roles.id,
          cursor: cursorOf({ sort_value: null }),
        }),
      ).toBeUndefined();
    });
  });
});
