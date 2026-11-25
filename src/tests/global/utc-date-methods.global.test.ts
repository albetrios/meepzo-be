import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard: runtime date math works in UTC.
 *
 * Every stored time is UTC (`timestamptz`), partitions are cut on UTC days, weeks and months, and the
 * process pins `TZ=UTC` in both images. The local-time `Date` methods (`getDate`, `setMonth`,
 * `getFullYear`, `getHours`, …) follow the host's zone instead, so a host or developer machine on
 * another zone (Asia/Kolkata is UTC+5:30) would move a billing period end, a retention cutoff or an
 * expiry by hours. Runtime code under `src/` (tests excluded) uses the `getUTC*` / `setUTC*` methods;
 * an organization's own zone goes through `Intl.DateTimeFormat` or SQL `AT TIME ZONE`, never the
 * local getters.
 */
describe('Global: runtime date math uses the UTC Date methods', () => {
  const LOCAL_TIME_METHOD =
    /\.(get|set)(Date|Day|Month|FullYear|Hours|Minutes|Seconds|Milliseconds)\(/;

  async function listRuntimeFiles(directory: string): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'tests' || entry.name === 'node_modules') {
          continue;
        }
        files.push(...(await listRuntimeFiles(path)));
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push(path);
      }
    }
    return files;
  }

  it('no runtime file under src/ calls a local-time Date getter or setter', async () => {
    const offenders: string[] = [];
    for (const file of await listRuntimeFiles('src')) {
      const lines = (await fs.readFile(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (LOCAL_TIME_METHOD.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, 'use the getUTC*/setUTC* Date methods instead').toEqual([]);
  });

  it('both images pin the process time zone to UTC', async () => {
    for (const dockerfile of ['Dockerfile', 'Dockerfile.worker']) {
      const text = await fs.readFile(dockerfile, 'utf8');
      expect(text, `${dockerfile} sets TZ=UTC`).toMatch(/^\s*TZ=UTC\s*$/m);
    }
  });
});
