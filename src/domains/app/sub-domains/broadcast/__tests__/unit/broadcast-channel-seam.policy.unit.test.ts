import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Broadcasts are shared by every channel (feat-instagram-dm-sending routes-final § 7 BC18, BCC10 —
 * P48): the `broadcast/` folder reaches a channel only through the app kernel's
 * `ChannelSendingPort` and the channel account's feature check, so no source file under it imports
 * a channel's own folder (`instagram-*`). Its tests may (they run a channel's real port).
 */
describe('broadcast channel seam policy (BC18)', () => {
  const root = join(process.cwd(), 'src/domains/app/sub-domains/broadcast');

  /** Every non-test `.ts` file under the folder. */
  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
      return entry.name.endsWith('.ts') ? [path] : [];
    });
  }

  it('imports no instagram-* folder from any source file under broadcast/', () => {
    const files = sourceFiles(root);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((file) =>
      /from '[^']*\/sub-domains\/instagram-[^']*'/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => relative(root, file))).toEqual([]);
  });
});
