import { describe, expect, it } from 'vitest';
import { parseLaneArguments, resolveTestLane } from '@tooling/vitest/run-in-lane.js';

describe('test:lane — the lane a worktree tests in', () => {
  const worktreePaths = ['/work/project', '/work/project-lane-b', '/work/project-lane-c'];

  it('runs the main checkout with the plain names', () => {
    expect(resolveTestLane({ topLevel: '/work/project', worktreePaths, environment: {} })).toEqual({
      databaseNameSuffix: undefined,
      redisDatabase: undefined,
    });
  });

  it('gives each extra worktree its folder name as the suffix and its position as the Redis database', () => {
    expect(
      resolveTestLane({ topLevel: '/work/project-lane-b', worktreePaths, environment: {} }),
    ).toEqual({ databaseNameSuffix: 'project_lane_b', redisDatabase: 1 });
    expect(
      resolveTestLane({ topLevel: '/work/project-lane-c', worktreePaths, environment: {} }),
    ).toEqual({ databaseNameSuffix: 'project_lane_c', redisDatabase: 2 });
  });

  it('keeps a suffix and Redis database already set in the environment', () => {
    expect(
      resolveTestLane({
        topLevel: '/work/project-lane-b',
        worktreePaths,
        environment: { TEST_DATABASE_NAME_SUFFIX: 'lane_b', TEST_REDIS_DATABASE: '7' },
      }),
    ).toEqual({ databaseNameSuffix: 'lane_b', redisDatabase: 7 });
  });

  it('keeps a long folder name to the 32 characters the harness accepts', () => {
    const topLevel = `/work/${'x'.repeat(40)}`;
    const lane = resolveTestLane({
      topLevel,
      worktreePaths: ['/work/main', topLevel],
      environment: {},
    });
    expect(lane.databaseNameSuffix).toMatch(/^[a-z0-9_]{1,32}$/);
  });

  it('refuses a sixteenth extra worktree — Redis has databases 1–15 for lanes', () => {
    const paths = [
      '/work/main',
      ...Array.from({ length: 16 }, (_, index) => `/work/lane${'b'.repeat(index + 1)}`),
    ];
    expect(() =>
      resolveTestLane({ topLevel: paths[16] ?? '', worktreePaths: paths, environment: {} }),
    ).toThrow(/No free test lane/);
  });
});

describe('test:lane — its command line', () => {
  it('takes --serial, then the command after --', () => {
    expect(
      parseLaneArguments(['--serial', '--', 'pnpm', 'vitest', 'run', '--project', 'unit']),
    ).toEqual({
      serial: true,
      command: ['pnpm', 'vitest', 'run', '--project', 'unit'],
    });
  });

  it('hands the command its own options after a single --', () => {
    expect(parseLaneArguments(['--', 'node', '-e', 'x']).command).toEqual(['node', '-e', 'x']);
  });

  it('accepts the separator pnpm forwards', () => {
    expect(parseLaneArguments(['--', '--', 'git', 'commit']).command).toEqual(['git', 'commit']);
  });

  it('refuses an unknown option and a missing command', () => {
    expect(() => parseLaneArguments(['--not-an-option'])).toThrow(/--not-an-option/);
    expect(() => parseLaneArguments(['--serial'])).toThrow(/No command to run/);
  });
});
