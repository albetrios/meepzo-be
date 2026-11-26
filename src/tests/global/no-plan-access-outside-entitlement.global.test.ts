import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PLANS } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';

/**
 * change-plan-gates EN7, K3 (ENC7): only the entitlement module reads plan access.
 *
 * `SubscriptionService.getPlanAccess` stays in subscription (it owns the SQL), and outside it only
 * the entitlement module calls it; every other domain asks the module for a snapshot, a switch, a
 * limit or a refusal (`resolve`, `can`, `limit`, `buildPlanRefusal`). And no feature code decides by
 * a plan's **name** (`plan.name === 'Pro'`): a plan's features and limits are the registry's keys,
 * so a renamed or new plan never needs a code change.
 *
 * Scans the source text of every non-test, non-seed `.ts` file under `src/` (comments removed).
 */
const SOURCE_ROOT = join(process.cwd(), 'src');

/** Where `getPlanAccess` may be named: its owner and the one module that reads through it. */
const PLAN_ACCESS_READER_DIRECTORIES = [
  'src/domains/billing/sub-domains/subscription/',
  'src/domains/billing/sub-domains/entitlement/',
] as const;

/** Billing's plan catalog: the one place a plan's name is data (its rows, its seed). */
const PLAN_CATALOG_DIRECTORY = 'src/domains/billing/sub-domains/plan/';

/** Tests, fixtures and seeds are not feature code. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['__tests__', 'tests', 'seed']);

/** The catalog's plan names, read from the plan seed — never a hand list. */
const PLAN_NAMES: readonly string[] = DEFAULT_PLANS.map((plan) => plan.name);

interface ScannedFile {
  path: string;
  code: string;
}

function toRepositoryPath(fullPath: string): string {
  return relative(process.cwd(), fullPath).split(sep).join('/');
}

/** The file's text without its comments (line breaks kept), so a TSDoc mention is not a call. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function readFeatureSource(
  directory: string = SOURCE_ROOT,
  files: ScannedFile[] = [],
): ScannedFile[] {
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry)) continue;
      readFeatureSource(fullPath, files);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      if (entry.endsWith('.seed.ts')) continue;
      files.push({
        path: toRepositoryPath(fullPath),
        code: withoutComments(readFileSync(fullPath, 'utf8')),
      });
    }
  }
  return files;
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The one-based line of `index` in `text`. */
function lineOf({ text, index }: { text: string; index: number }): number {
  return text.slice(0, index).split('\n').length;
}

/**
 * Every place `code` uses a plan name as a condition: compared (`===`, `!==`, `==`, `!=`, either
 * side), a `case`, a list of names asked `.includes(…)`, or compared to a constant holding one.
 * Names match as the catalog spells them (`'Free'`, not a lowercase `'free'` gate kind).
 */
function findPlanNameConditions({
  code,
  planNameConstants,
}: {
  code: string;
  planNameConstants: ReadonlySet<string>;
}): { index: number; text: string }[] {
  const names = PLAN_NAMES.map(escapeForPattern).join('|');
  const literal = `(['"\`])(?:${names})\\1`;
  const patterns = [
    new RegExp(`[!=]==?\\s*${literal}`, 'g'),
    new RegExp(`${literal}\\s*[!=]==?`, 'g'),
    new RegExp(`\\bcase\\s+${literal}\\s*:`, 'g'),
    new RegExp(`\\[[^\\]]*${literal}[^\\]]*\\]\\s*\\.includes\\(`, 'g'),
  ];
  if (planNameConstants.size > 0) {
    const constants = [...planNameConstants].map(escapeForPattern).join('|');
    patterns.push(new RegExp(`[!=]==?\\s*\\b(?:${constants})\\b`, 'g'));
    patterns.push(new RegExp(`\\b(?:${constants})\\b\\s*[!=]==?`, 'g'));
  }
  return patterns.flatMap((pattern) =>
    [...code.matchAll(pattern)].map((match) => ({ index: match.index, text: match[0] })),
  );
}

describe('Global: only the entitlement module reads plan access (change-plan-gates EN7, K3)', () => {
  const files = readFeatureSource();

  it('scans the feature source and the catalog’s plan names', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(PLAN_NAMES).toContain('Free');
    expect(PLAN_NAMES.length).toBeGreaterThan(1);
  });

  it('names getPlanAccess only in subscription and the entitlement module', () => {
    const offenders = files
      .filter(({ path }) => !PLAN_ACCESS_READER_DIRECTORIES.some((root) => path.startsWith(root)))
      .flatMap(({ path, code }) =>
        [...code.matchAll(/\bgetPlanAccess\b/g)].map(
          (match) => `${path}:${lineOf({ text: code, index: match.index })}`,
        ),
      );
    expect(
      offenders,
      `getPlanAccess outside subscription/ and entitlement/ — ask the entitlement module (resolve, can, limit, buildPlanRefusal):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('never uses a plan name as a condition outside billing’s plan catalog', () => {
    const featureFiles = files.filter(({ path }) => !path.startsWith(PLAN_CATALOG_DIRECTORY));
    const planNameConstants = new Set<string>();
    const nameSet = new Set(PLAN_NAMES);
    for (const { code } of featureFiles) {
      for (const match of code.matchAll(
        /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*(['"`])([^'"`]*)\2/g,
      )) {
        const [, constantName, , value] = match;
        if (constantName !== undefined && value !== undefined && nameSet.has(value)) {
          planNameConstants.add(constantName);
        }
      }
    }
    const offenders = featureFiles.flatMap(({ path, code }) =>
      findPlanNameConditions({ code, planNameConstants }).map(
        ({ index, text }) => `${path}:${lineOf({ text: code, index })} → ${text}`,
      ),
    );
    expect(
      offenders,
      `Plan names used as conditions — decide by an entitlement key (can / limit), never a plan's name:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
