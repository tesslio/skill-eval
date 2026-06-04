import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

mock.module('@actions/core', () => ({
  setFailed: mock(() => {}),
  getInput: mock(() => ''),
  info: mock(() => {}),
  warning: mock(() => {}),
  error: mock(() => {}),
  ExitCode: { Success: 0, Failure: 1 },
}));

mock.module('@actions/github', () => ({
  context: {
    payload: { pull_request: { number: 42 } },
    repo: { owner: 'test-owner', repo: 'test-repo' },
  },
  getOctokit: () => ({
    rest: {
      issues: {
        listComments: mock(() => Promise.resolve({ data: [] })),
        createComment: mock(() => Promise.resolve()),
        updateComment: mock(() => Promise.resolve()),
      },
    },
  }),
}));

// ---------------------------------------------------------------------------
// 1. findPluginDir / findPluginDirsWithEvals
// ---------------------------------------------------------------------------

describe('findPluginDir', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `eval-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('finds .tessl-plugin/plugin.json in immediate parent', async () => {
    mkdirSync(join(tmp, '.tessl-plugin'), { recursive: true });
    writeFileSync(join(tmp, '.tessl-plugin', 'plugin.json'), '{}');
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findPluginDir } = await import('./find-plugins.ts');
    expect(findPluginDir(join(tmp, 'skills', 'foo', 'SKILL.md'))).toBe(tmp);
  });

  test('finds legacy tile.json in immediate parent', async () => {
    writeFileSync(join(tmp, 'tile.json'), '{}');
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findPluginDir } = await import('./find-plugins.ts');
    expect(findPluginDir(join(tmp, 'skills', 'foo', 'SKILL.md'))).toBe(tmp);
  });

  test('finds root when both .tessl-plugin/plugin.json and tile.json are present', async () => {
    mkdirSync(join(tmp, '.tessl-plugin'), { recursive: true });
    writeFileSync(join(tmp, '.tessl-plugin', 'plugin.json'), '{}');
    writeFileSync(join(tmp, 'tile.json'), '{}');
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findPluginDir } = await import('./find-plugins.ts');
    expect(findPluginDir(join(tmp, 'skills', 'foo', 'SKILL.md'))).toBe(tmp);
  });

  test('returns null when no plugin root exists', async () => {
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findPluginDir } = await import('./find-plugins.ts');
    expect(findPluginDir(join(tmp, 'skills', 'foo', 'SKILL.md'))).toBeNull();
  });
});

describe('findPluginDirsWithEvals', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `eval-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('returns plugin dir when evals/ exists', async () => {
    mkdirSync(join(tmp, '.tessl-plugin'), { recursive: true });
    writeFileSync(join(tmp, '.tessl-plugin', 'plugin.json'), '{}');
    mkdirSync(join(tmp, 'evals', 'scenario-a'), { recursive: true });
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findPluginDirsWithEvals } = await import('./find-plugins.ts');
    const dirs = findPluginDirsWithEvals([join(tmp, 'skills', 'foo', 'SKILL.md')]);
    expect(dirs).toEqual([tmp]);
  });

  test('skips plugin dir when no evals/ exists', async () => {
    mkdirSync(join(tmp, '.tessl-plugin'), { recursive: true });
    writeFileSync(join(tmp, '.tessl-plugin', 'plugin.json'), '{}');
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findPluginDirsWithEvals } = await import('./find-plugins.ts');
    const dirs = findPluginDirsWithEvals([join(tmp, 'skills', 'foo', 'SKILL.md')]);
    expect(dirs).toEqual([]);
  });

  test('deduplicates when multiple skills share a plugin', async () => {
    mkdirSync(join(tmp, '.tessl-plugin'), { recursive: true });
    writeFileSync(join(tmp, '.tessl-plugin', 'plugin.json'), '{}');
    mkdirSync(join(tmp, 'evals', 'scenario-a'), { recursive: true });
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    mkdirSync(join(tmp, 'skills', 'bar'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');
    writeFileSync(join(tmp, 'skills', 'bar', 'SKILL.md'), '');

    const { findPluginDirsWithEvals } = await import('./find-plugins.ts');
    const dirs = findPluginDirsWithEvals([
      join(tmp, 'skills', 'foo', 'SKILL.md'),
      join(tmp, 'skills', 'bar', 'SKILL.md'),
    ]);
    expect(dirs).toEqual([tmp]);
  });

  test('returns dir when both .tessl-plugin/plugin.json and tile.json are present and evals/ exists', async () => {
    mkdirSync(join(tmp, '.tessl-plugin'), { recursive: true });
    writeFileSync(join(tmp, '.tessl-plugin', 'plugin.json'), '{}');
    writeFileSync(join(tmp, 'tile.json'), '{}');
    mkdirSync(join(tmp, 'evals', 'scenario-a'), { recursive: true });
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findPluginDirsWithEvals } = await import('./find-plugins.ts');
    const dirs = findPluginDirsWithEvals([join(tmp, 'skills', 'foo', 'SKILL.md')]);
    expect(dirs).toEqual([tmp]);
  });

  test('returns legacy tile dir when evals/ exists', async () => {
    writeFileSync(join(tmp, 'tile.json'), '{}');
    mkdirSync(join(tmp, 'evals', 'scenario-a'), { recursive: true });
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findPluginDirsWithEvals } = await import('./find-plugins.ts');
    const dirs = findPluginDirsWithEvals([join(tmp, 'skills', 'foo', 'SKILL.md')]);
    expect(dirs).toEqual([tmp]);
  });

  test('skips legacy tile dir when no evals/ exists', async () => {
    writeFileSync(join(tmp, 'tile.json'), '{}');
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findPluginDirsWithEvals } = await import('./find-plugins.ts');
    const dirs = findPluginDirsWithEvals([join(tmp, 'skills', 'foo', 'SKILL.md')]);
    expect(dirs).toEqual([]);
  });

  test('deduplicates when multiple skills share a legacy tile', async () => {
    writeFileSync(join(tmp, 'tile.json'), '{}');
    mkdirSync(join(tmp, 'evals', 'scenario-a'), { recursive: true });
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    mkdirSync(join(tmp, 'skills', 'bar'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');
    writeFileSync(join(tmp, 'skills', 'bar', 'SKILL.md'), '');

    const { findPluginDirsWithEvals } = await import('./find-plugins.ts');
    const dirs = findPluginDirsWithEvals([
      join(tmp, 'skills', 'foo', 'SKILL.md'),
      join(tmp, 'skills', 'bar', 'SKILL.md'),
    ]);
    expect(dirs).toEqual([tmp]);
  });
});

// ---------------------------------------------------------------------------
// 2. eval-run: runEval, parseEvalViewOutput
// ---------------------------------------------------------------------------

function makeMockSpawn(stdout: string, stderr: string, exitCode: number) {
  return mock((..._args: unknown[]) => ({
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stderr));
        controller.close();
      },
    }),
    exited: Promise.resolve(exitCode),
  }));
}

describe('runEval', () => {
  let originalSpawn: typeof Bun.spawn;
  let originalTesslBin: string | undefined;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    originalTesslBin = process.env.TESSL_BIN;
  });

  afterEach(() => {
    // @ts-ignore restoring original
    Bun.spawn = originalSpawn;
    if (originalTesslBin !== undefined) {
      process.env.TESSL_BIN = originalTesslBin;
    } else {
      delete process.env.TESSL_BIN;
    }
  });

  test('uses TESSL_BIN from setup-tessl when starting evals', async () => {
    const spawnMock = makeMockSpawn('', 'auth failed', 1);
    process.env.TESSL_BIN = '/runner/tool-cache/tessl/0.73.0/linux-x64/tessl';
    // @ts-expect-error mock assignment
    Bun.spawn = spawnMock;

    const { runEval } = await import('./eval-run.ts');
    await runEval('/some/tile', 'my-ws', 'claude:claude-sonnet-4-6', 1);

    const firstCall = spawnMock.mock.calls[0] as unknown[];
    expect(firstCall[0]).toEqual([
      '/runner/tool-cache/tessl/0.73.0/linux-x64/tessl',
      'eval',
      'run',
      '/some/tile',
      '--workspace',
      'my-ws',
      '--agent',
      'claude:claude-sonnet-4-6',
      '--json',
    ]);
  });

  test('falls back to PATH when TESSL_BIN is blank', async () => {
    process.env.TESSL_BIN = '   ';

    const { tesslBin } = await import('./tessl-bin.ts');
    expect(tesslBin()).toBe('tessl');
  });

  test('returns error when tessl eval run fails', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('', 'auth failed', 1);

    const { runEval } = await import('./eval-run.ts');
    const result = await runEval('/some/tile', 'my-ws', 'claude:claude-sonnet-4-6', 1);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('auth failed');
  });

  test('returns error when no JSON in run output', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('no json here', '', 0);

    const { runEval } = await import('./eval-run.ts');
    const result = await runEval('/some/tile', 'my-ws', 'claude:claude-sonnet-4-6', 1);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('parse');
  });

  test('returns error when run output has no id', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('{"status": "pending"}', '', 0);

    const { runEval } = await import('./eval-run.ts');
    const result = await runEval('/some/tile', 'my-ws', 'claude:claude-sonnet-4-6', 1);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('id');
  });
});

describe('parseEvalViewOutput', () => {
  test('parses completed eval with baseline and with-context solutions', async () => {
    const viewOutput = JSON.stringify({
      data: {
        id: 'run-123',
        attributes: {
          status: 'completed',
          scenarios: [
            {
              id: 's1',
              fingerprint: 'abc12345deadbeef',
              solutions: [
                {
                  id: 'sol1',
                  variant: 'baseline',
                  assessmentResults: [
                    { name: 'correctness', score: 10, max_score: 25, reasoning: 'Partial' },
                  ],
                },
                {
                  id: 'sol2',
                  variant: 'with-context',
                  assessmentResults: [
                    { name: 'correctness', score: 20, max_score: 25, reasoning: 'Good' },
                  ],
                },
              ],
            },
          ],
        },
      },
    });

    const { parseEvalViewOutput } = await import('./eval-run.ts');
    const result = parseEvalViewOutput(viewOutput, '/tile', 'run-123');
    expect(result.status).toBe('completed');
    expect(result.overallScore).toBe(80); // 20/25 = 80%
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]!.baselineScore).toBe(40); // 10/25 = 40%
    expect(result.scenarios[0]!.withContextScore).toBe(80);
    expect(result.scenarios[0]!.delta).toBe(40);
  });

  test('handles multiple scenarios', async () => {
    const viewOutput = JSON.stringify({
      data: {
        id: 'run-456',
        attributes: {
          status: 'completed',
          scenarios: [
            {
              id: 's1', fingerprint: 'aaaa1111',
              solutions: [
                { id: 'a', variant: 'baseline', assessmentResults: [{ name: 'q', score: 3, max_score: 10, reasoning: '' }] },
                { id: 'b', variant: 'with-context', assessmentResults: [{ name: 'q', score: 6, max_score: 10, reasoning: '' }] },
              ],
            },
            {
              id: 's2', fingerprint: 'bbbb2222',
              solutions: [
                { id: 'c', variant: 'baseline', assessmentResults: [{ name: 'q', score: 5, max_score: 10, reasoning: '' }] },
                { id: 'd', variant: 'with-context', assessmentResults: [{ name: 'q', score: 8, max_score: 10, reasoning: '' }] },
              ],
            },
          ],
        },
      },
    });

    const { parseEvalViewOutput } = await import('./eval-run.ts');
    const result = parseEvalViewOutput(viewOutput, '/tile', 'run-456');
    expect(result.scenarios).toHaveLength(2);
    expect(result.overallScore).toBe(70); // avg of 60% and 80%
  });

  test('returns failed result for failed status', async () => {
    const viewOutput = JSON.stringify({
      data: {
        id: 'run-789',
        attributes: {
          status: 'failed',
          scenarios: [],
        },
      },
    });

    const { parseEvalViewOutput } = await import('./eval-run.ts');
    const result = parseEvalViewOutput(viewOutput, '/tile', 'run-789');
    expect(result.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 3. Eval comment formatting
// ---------------------------------------------------------------------------

describe('formatEvalComment', () => {
  test('includes eval marker', async () => {
    const { formatEvalComment } = await import('./eval-comment.ts');
    const body = formatEvalComment(
      [{ tilePath: '/tiles/my-tile', runId: 'run-123', status: 'completed', overallScore: 72, scenarios: [] }],
      false,
    );
    expect(body).toContain('<!-- tessl-skill-eval -->');
  });

  test('includes scenario table with delta indicators', async () => {
    const { formatEvalComment } = await import('./eval-comment.ts');
    const body = formatEvalComment(
      [{
        tilePath: '/tiles/my-tile', runId: 'run-123', status: 'completed', overallScore: 75,
        scenarios: [{ name: 'abc12345', baselineScore: 40, withContextScore: 75, delta: 35, criteria: [] }],
      }],
      false,
    );
    expect(body).toContain('Baseline');
    expect(body).toContain('With Context');
    expect(body).toContain('40%');
    expect(body).toContain('75%');
    expect(body).toContain('🔺');
  });

  test('shows down arrow for negative delta', async () => {
    const { formatEvalComment } = await import('./eval-comment.ts');
    const body = formatEvalComment(
      [{
        tilePath: '/tiles/my-tile', runId: 'run-123', status: 'completed', overallScore: 30,
        scenarios: [{ name: 'abc12345', baselineScore: 50, withContextScore: 30, delta: -20, criteria: [] }],
      }],
      false,
    );
    expect(body).toContain('🔻');
  });

  test('shows regression label when failOnRegression is true and delta is negative', async () => {
    const { formatEvalComment } = await import('./eval-comment.ts');
    const body = formatEvalComment(
      [{
        tilePath: '/tiles/regressed', runId: 'run-1', status: 'completed', overallScore: 30,
        scenarios: [{ name: 'abc12345', baselineScore: 50, withContextScore: 30, delta: -20, criteria: [] }],
      }],
      true,
    );
    expect(body).toContain('❌');
    expect(body).toContain('regression');
  });

  test('no regression label when failOnRegression is false', async () => {
    const { formatEvalComment } = await import('./eval-comment.ts');
    const body = formatEvalComment(
      [{
        tilePath: '/tiles/regressed', runId: 'run-1', status: 'completed', overallScore: 30,
        scenarios: [{ name: 'abc12345', baselineScore: 50, withContextScore: 30, delta: -20, criteria: [] }],
      }],
      false,
    );
    expect(body).not.toContain('❌');
    expect(body).not.toContain('regression');
  });

  test('sanitizes pipes, newlines, and mentions in criterion table cells', async () => {
    const { formatEvalComment } = await import('./eval-comment.ts');
    const body = formatEvalComment(
      [{
        tilePath: '/tiles/t', runId: 'run-1', status: 'completed', overallScore: 60,
        scenarios: [{
          name: 'scenario1', baselineScore: 40, withContextScore: 60, delta: 20,
          criteria: [{
            name: 'test|name',
            score: 15,
            maxScore: 25,
            reasoning: 'line1\nline2 @user `code`',
          }],
        }],
      }],
      false,
    );
    expect(body).not.toContain('| test|name |');
    expect(body).toContain('test\\|name');
    expect(body).toContain('<br>');
    expect(body).toContain('@<!-- -->');
    expect(body).toContain('\\`');
  });

  test('shows error for failed eval', async () => {
    const { formatEvalComment } = await import('./eval-comment.ts');
    const body = formatEvalComment(
      [{ tilePath: '/tiles/broken', runId: 'run-1', status: 'failed', overallScore: -1, scenarios: [], error: 'Auth failed' }],
      false,
    );
    expect(body).toContain('⚠️');
    expect(body).toContain('Auth failed');
  });
});

// ---------------------------------------------------------------------------
// 4. scenario-generate: generateAndDownloadScenarios
// ---------------------------------------------------------------------------

describe('generateAndDownloadScenarios', () => {
  let originalSpawn: typeof Bun.spawn;
  let originalTesslBin: string | undefined;

  beforeEach(async () => {
    originalSpawn = Bun.spawn;
    originalTesslBin = process.env.TESSL_BIN;
    // Use fast timings for tests
    const { setTimings } = await import('./scenario-generate.ts');
    setTimings(10, 10, 100); // 10ms poll, 10ms retry, 100ms retry timeout
  });

  afterEach(async () => {
    // @ts-ignore restoring original
    Bun.spawn = originalSpawn;
    if (originalTesslBin !== undefined) {
      process.env.TESSL_BIN = originalTesslBin;
    } else {
      delete process.env.TESSL_BIN;
    }
    // Restore real timings
    const { setTimings } = await import('./scenario-generate.ts');
    setTimings(30_000, 30_000, 15 * 60_000);
  });

  test('uses TESSL_BIN from setup-tessl when generating scenarios', async () => {
    const spawnMock = makeMockSpawn('no json', '', 0);
    process.env.TESSL_BIN = '/runner/tool-cache/tessl/0.73.0/linux-x64/tessl';
    // @ts-expect-error mock assignment
    Bun.spawn = spawnMock;

    const { generateAndDownloadScenarios } = await import('./scenario-generate.ts');
    await generateAndDownloadScenarios('/tile', 3, 1);

    const firstCall = spawnMock.mock.calls[0] as unknown[];
    expect(firstCall[0]).toEqual([
      '/runner/tool-cache/tessl/0.73.0/linux-x64/tessl',
      'scenario',
      'generate',
      '/tile',
      '-n',
      '3',
      '--json',
    ]);
  });

  test('returns error when generate keeps failing and no in-progress found', async () => {
    // All spawn calls return exit 1 — generate fails, list also fails
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('', 'server error', 1);

    const { generateAndDownloadScenarios } = await import('./scenario-generate.ts');
    const result = await generateAndDownloadScenarios('/tile', 3, 1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('retries');
  });

  test('returns error when generate output has no id', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('{"status": "pending"}', '', 0);

    const { generateAndDownloadScenarios } = await import('./scenario-generate.ts');
    const result = await generateAndDownloadScenarios('/tile', 3, 1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('id');
  });

  test('returns error when generate output has no JSON', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('no json', '', 0);

    const { generateAndDownloadScenarios } = await import('./scenario-generate.ts');
    const result = await generateAndDownloadScenarios('/tile', 3, 1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('parse');
  });
});
