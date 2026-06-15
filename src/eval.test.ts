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

describe('resolveRequestedPluginDir', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `eval-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    mkdirSync(join(tmp, 'tile', '.tessl-plugin'), { recursive: true });
    writeFileSync(join(tmp, 'tile', '.tessl-plugin', 'plugin.json'), '{}');
    mkdirSync(join(tmp, 'tile', 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'tile', 'skills', 'foo', 'SKILL.md'), '');
    mkdirSync(join(tmp, 'tile', 'evals', 'scenario-a'), { recursive: true });
    writeFileSync(join(tmp, 'tile', 'evals', 'scenario-a', 'scenario.json'), '{}');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('resolves plugin root directory', async () => {
    const { resolveRequestedPluginDir } = await import('./find-plugins.ts');
    expect(resolveRequestedPluginDir('tile', tmp)).toBe(join(tmp, 'tile'));
  });

  test('resolves skill directory', async () => {
    const { resolveRequestedPluginDir } = await import('./find-plugins.ts');
    expect(resolveRequestedPluginDir('tile/skills/foo', tmp)).toBe(join(tmp, 'tile'));
  });

  test('resolves SKILL.md file', async () => {
    const { resolveRequestedPluginDir } = await import('./find-plugins.ts');
    expect(resolveRequestedPluginDir('tile/skills/foo/SKILL.md', tmp)).toBe(join(tmp, 'tile'));
  });

  test('resolves evals file', async () => {
    const { resolveRequestedPluginDir } = await import('./find-plugins.ts');
    expect(resolveRequestedPluginDir('tile/evals/scenario-a/scenario.json', tmp)).toBe(join(tmp, 'tile'));
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

function makeMockSpawnSequence(responses: Array<{ stdout: string; stderr: string; exitCode: number }>) {
  let index = 0;
  return mock((..._args: unknown[]) => {
    const response = responses[Math.min(index, responses.length - 1)]!;
    index++;
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(response.stdout));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(response.stderr));
          controller.close();
        },
      }),
      exited: Promise.resolve(response.exitCode),
    };
  });
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
    await runEval('/some/tile', 'my-ws', 'claude:claude-sonnet-4-6', 1, 1);

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
      '--runs',
      '1',
      '--json',
    ]);
  });

  test('falls back to PATH when TESSL_BIN is blank', async () => {
    process.env.TESSL_BIN = '   ';

    const { tesslBin } = await import('./tessl-bin.ts');
    expect(tesslBin()).toBe('tessl');
  });

  test('links project and omits --workspace when target is a plugin directory', async () => {
    const pluginDir = join(tmpdir(), `eval-run-plugin-${Date.now()}`);
    mkdirSync(join(pluginDir, '.tessl-plugin'), { recursive: true });
    writeFileSync(join(pluginDir, '.tessl-plugin', 'plugin.json'), '{}');

    try {
      const spawnMock = makeMockSpawnSequence([
        { stdout: 'linked', stderr: '', exitCode: 0 },
        { stdout: '', stderr: 'auth failed', exitCode: 1 },
      ]);
      // @ts-expect-error mock assignment
      Bun.spawn = spawnMock;

      const { runEval } = await import('./eval-run.ts');
      await runEval(pluginDir, 'my-ws', 'claude:claude-sonnet-4-6', 1, 1);

      const firstCall = spawnMock.mock.calls[0] as unknown[];
      expect(firstCall[0]).toEqual([
        'tessl',
        'project',
        'link',
        '--workspace',
        'my-ws',
      ]);
      expect(firstCall[1]).toEqual(expect.objectContaining({ cwd: pluginDir }));

      const secondCall = spawnMock.mock.calls[1] as unknown[];
      expect(secondCall[0]).not.toContain('--workspace');
      expect(secondCall[0]).not.toContain('my-ws');
      expect(secondCall[0]).toEqual([
        'tessl',
        'eval',
        'run',
        '.',
        '--agent',
        'claude:claude-sonnet-4-6',
        '--runs',
        '1',
        '--json',
      ]);
      expect(secondCall[1]).toEqual(expect.objectContaining({ cwd: pluginDir }));
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  test('uses committed tessl.json instead of linking plugin project', async () => {
    const pluginDir = join(tmpdir(), `eval-run-plugin-linked-${Date.now()}`);
    mkdirSync(join(pluginDir, '.tessl-plugin'), { recursive: true });
    writeFileSync(join(pluginDir, '.tessl-plugin', 'plugin.json'), '{}');
    writeFileSync(join(pluginDir, 'tessl.json'), '{"name":"my-ws/my-plugin"}');

    try {
      const spawnMock = makeMockSpawn('', 'auth failed', 1);
      // @ts-expect-error mock assignment
      Bun.spawn = spawnMock;

      const { runEval } = await import('./eval-run.ts');
      await runEval(pluginDir, 'my-ws', 'claude:claude-sonnet-4-6', 1, 1);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const evalCall = spawnMock.mock.calls[0] as unknown[];
      expect(evalCall[0]).toEqual([
        'tessl',
        'eval',
        'run',
        '.',
        '--agent',
        'claude:claude-sonnet-4-6',
        '--runs',
        '1',
        '--json',
      ]);
      expect(evalCall[1]).toEqual(expect.objectContaining({ cwd: pluginDir }));
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  test('returns setup guidance instead of creating a project when plugin target has no existing project', async () => {
    const pluginDir = join(tmpdir(), `eval-run-plugin-setup-${Date.now()}`);
    mkdirSync(join(pluginDir, '.tessl-plugin'), { recursive: true });
    writeFileSync(join(pluginDir, '.tessl-plugin', 'plugin.json'), '{}');

    try {
      const spawnMock = makeMockSpawnSequence([
        { stdout: '', stderr: 'No Tessl project found. Run this command from a directory inside a project with tessl.json.', exitCode: 1 },
      ]);
      // @ts-expect-error mock assignment
      Bun.spawn = spawnMock;

      const { runEval } = await import('./eval-run.ts');
      const result = await runEval(pluginDir, 'my-ws', 'claude:claude-sonnet-4-6', 1, 1);

      expect(result.error).toContain('not linked to a Tessl project yet');
      expect(result.error).toContain('tessl project create --workspace my-ws');
      expect(result.error).toContain('git add tessl.json');
      expect(spawnMock).toHaveBeenCalledTimes(1);

      const linkCall = spawnMock.mock.calls[0] as unknown[];
      expect(linkCall[0]).toEqual([
        'tessl',
        'project',
        'link',
        '--workspace',
        'my-ws',
      ]);
      expect(linkCall[1]).toEqual(expect.objectContaining({ cwd: pluginDir }));
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  test('links project and omits --workspace when target is a legacy tile directory', async () => {
    const tileDir = join(tmpdir(), `eval-run-tile-${Date.now()}`);
    mkdirSync(tileDir, { recursive: true });
    writeFileSync(join(tileDir, 'tile.json'), '{}');

    try {
      const spawnMock = makeMockSpawnSequence([
        { stdout: 'linked', stderr: '', exitCode: 0 },
        { stdout: '', stderr: 'auth failed', exitCode: 1 },
      ]);
      // @ts-expect-error mock assignment
      Bun.spawn = spawnMock;

      const { runEval } = await import('./eval-run.ts');
      await runEval(tileDir, 'my-ws', 'claude:claude-sonnet-4-6', 1, 1);

      const evalCall = spawnMock.mock.calls[1] as unknown[];
      expect(evalCall[0]).not.toContain('--workspace');
      expect(evalCall[0]).toEqual([
        'tessl',
        'eval',
        'run',
        '.',
        '--agent',
        'claude:claude-sonnet-4-6',
        '--runs',
        '1',
        '--json',
      ]);
      expect(evalCall[1]).toEqual(expect.objectContaining({ cwd: tileDir }));
    } finally {
      rmSync(tileDir, { recursive: true, force: true });
    }
  });

  test('returns error when tessl eval run fails', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('', 'auth failed', 1);

    const { runEval } = await import('./eval-run.ts');
    const result = await runEval('/some/tile', 'my-ws', 'claude:claude-sonnet-4-6', 1, 1);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('auth failed');
  });

  test('returns error when no JSON in run output', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('no json here', '', 0);

    const { runEval } = await import('./eval-run.ts');
    const result = await runEval('/some/tile', 'my-ws', 'claude:claude-sonnet-4-6', 1, 1);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('parse');
  });

  test('returns error when run output has no id', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('{"status": "pending"}', '', 0);

    const { runEval } = await import('./eval-run.ts');
    const result = await runEval('/some/tile', 'my-ws', 'claude:claude-sonnet-4-6', 1, 1);
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

  test('formats first-run guidance with scenario and eval commands', async () => {
    const { formatEvalGuideComment } = await import('./eval-comment.ts');
    const body = formatEvalGuideComment(['plugins/my-plugin']);

    expect(body).toContain('/tessl scenarios plugins/my-plugin');
    expect(body).toContain('/tessl eval plugins/my-plugin');
    expect(body).toContain('evals/');
    expect(body).toContain('TESSL_TOKEN');
    expect(body).toContain('eval-workspace');
    expect(body).toContain('setup-tessl');
    expect(body).toContain('tessl.json');
    expect(body).toContain('tessl project create');
  });

  test('formats re-run guidance with both options and scenario file structure', async () => {
    const { formatEvalRerunGuideComment } = await import('./eval-comment.ts');
    const body = formatEvalRerunGuideComment(['plugins/my-plugin']);

    expect(body).toContain('<!-- tessl-skill-eval-rerun -->');
    expect(body).toContain('change detected');
    expect(body).toContain('Option 1');
    expect(body).toContain('Option 2');
    expect(body).toContain('/tessl eval plugins/my-plugin');
    expect(body).toContain('scenario.json');
    expect(body).toContain('criteria.json');
    expect(body).toContain('task.md');
    expect(body).toContain('inputs/');
    expect(body).toContain('plugins/my-plugin');
  });

  test('re-run guidance lists every plugin with committed evals', async () => {
    const { formatEvalRerunGuideComment } = await import('./eval-comment.ts');
    const body = formatEvalRerunGuideComment(['plugins/a', 'plugins/b']);

    expect(body).toContain('/tessl eval plugins/a');
    expect(body).toContain('/tessl eval plugins/b');
    expect(body).toContain('- `plugins/a`');
    expect(body).toContain('- `plugins/b`');
  });

  test('formats scenario command acknowledgement', async () => {
    const { formatCommandStatusComment } = await import('./eval-comment.ts');
    const body = formatCommandStatusComment({
      kind: 'scenarios',
      pluginDir: 'plugins/my-plugin',
      status: 'running',
    });

    expect(body).toContain('Tessl command received');
    expect(body).toContain('/tessl scenarios plugins/my-plugin');
    expect(body).toContain('plugins/my-plugin/evals/');
    expect(body).toContain('TESSL_TOKEN');
  });

  test('formats no-op scenario generation when evals already match', async () => {
    const { formatCommandStatusComment } = await import('./eval-comment.ts');
    const body = formatCommandStatusComment({
      kind: 'scenarios',
      pluginDir: 'plugins/my-plugin',
      status: 'succeeded',
      generationId: 'gen-1',
      commitSha: 'abc1234',
      committed: false,
    });

    expect(body).toContain('Tessl scenarios already up to date');
    expect(body).toContain('no new commit was needed');
    expect(body).toContain('/tessl eval plugins/my-plugin');
  });

  test('formats setup guidance as markdown for failed commands', async () => {
    const { formatCommandStatusComment } = await import('./eval-comment.ts');
    const body = formatCommandStatusComment({
      kind: 'scenarios',
      pluginDir: 'plugins/my-plugin',
      status: 'failed',
      detail: [
        'This plugin is not linked to a Tessl project yet.',
        '```bash',
        'tessl project create --workspace my-ws my-plugin',
        '```',
      ].join('\n'),
      detailMarkdown: true,
    });

    expect(body).toContain('This plugin is not linked');
    expect(body).toContain('```bash');
    expect(body).toContain('tessl project create --workspace my-ws my-plugin');
    expect(body).not.toContain('\\`\\`\\`bash');
  });
});

// ---------------------------------------------------------------------------
// 4. scenario-generate: generateAndDownloadScenarios
// ---------------------------------------------------------------------------

describe('generateAndDownloadScenarios', () => {
  let originalSpawn: typeof Bun.spawn;
  let originalTesslBin: string | undefined;
  let tmp: string;

  beforeEach(async () => {
    originalSpawn = Bun.spawn;
    originalTesslBin = process.env.TESSL_BIN;
    tmp = join(tmpdir(), `eval-scenario-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
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
    rmSync(tmp, { recursive: true, force: true });
    // Restore real timings
    const { setTimings } = await import('./scenario-generate.ts');
    setTimings(30_000, 30_000, 15 * 60_000);
  });

  test('passes count for plugin-based scenario generation', async () => {
    const spawnMock = makeMockSpawn('no json', '', 0);
    process.env.TESSL_BIN = '/runner/tool-cache/tessl/0.73.0/linux-x64/tessl';
    const pluginDir = join(tmp, 'plugin');
    mkdirSync(join(pluginDir, '.tessl-plugin'), { recursive: true });
    writeFileSync(join(pluginDir, '.tessl-plugin', 'plugin.json'), '{}');
    // @ts-expect-error mock assignment
    Bun.spawn = spawnMock;

    const { generateAndDownloadScenarios } = await import('./scenario-generate.ts');
    await generateAndDownloadScenarios(pluginDir, 1, 1);

    const firstCall = spawnMock.mock.calls[0] as unknown[];
    expect(firstCall[0]).toEqual([
      '/runner/tool-cache/tessl/0.73.0/linux-x64/tessl',
      'scenario',
      'generate',
      pluginDir,
      '-n',
      '1',
      '--json',
    ]);
  });

  test('allows plugin generation without workspace because local plugin is the source', async () => {
    const spawnMock = makeMockSpawn('no json', '', 0);
    const pluginDir = join(tmp, 'plugin-no-workspace');
    mkdirSync(join(pluginDir, '.tessl-plugin'), { recursive: true });
    writeFileSync(join(pluginDir, '.tessl-plugin', 'plugin.json'), '{}');
    // @ts-expect-error mock assignment
    Bun.spawn = spawnMock;

    const { generateAndDownloadScenarios } = await import('./scenario-generate.ts');
    const result = await generateAndDownloadScenarios(pluginDir, 3, 1, { prNumber: 42 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('parse');
    expect(spawnMock).toHaveBeenCalled();
  });

  test('allows plugin generation without PR because local plugin is the source', async () => {
    const spawnMock = makeMockSpawn('no json', '', 0);
    const pluginDir = join(tmp, 'plugin-no-source');
    mkdirSync(join(pluginDir, '.tessl-plugin'), { recursive: true });
    writeFileSync(join(pluginDir, '.tessl-plugin', 'plugin.json'), '{}');
    // @ts-expect-error mock assignment
    Bun.spawn = spawnMock;

    const { generateAndDownloadScenarios } = await import('./scenario-generate.ts');
    const result = await generateAndDownloadScenarios(pluginDir, 3, 1, {
      workspace: 'bapfernandez',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('parse');
    expect(spawnMock).toHaveBeenCalled();
  });

  test('keeps count flag for legacy tile-based scenario generation', async () => {
    const spawnMock = makeMockSpawn('no json', '', 0);
    process.env.TESSL_BIN = '/runner/tool-cache/tessl/0.73.0/linux-x64/tessl';
    const tileDir = join(tmp, 'tile');
    mkdirSync(tileDir, { recursive: true });
    writeFileSync(join(tileDir, 'tile.json'), '{}');
    // @ts-expect-error mock assignment
    Bun.spawn = spawnMock;

    const { generateAndDownloadScenarios } = await import('./scenario-generate.ts');
    await generateAndDownloadScenarios(tileDir, 3, 1);

    const firstCall = spawnMock.mock.calls[0] as unknown[];
    expect(firstCall[0]).toEqual([
      '/runner/tool-cache/tessl/0.73.0/linux-x64/tessl',
      'scenario',
      'generate',
      tileDir,
      '-n',
      '3',
      '--json',
    ]);
  });

  test('returns error when generate keeps failing and no in-progress found', async () => {
    // All spawn calls return exit 1 — generate fails, list also fails
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('', 'server error', 1);
    const tileDir = join(tmp, 'failing-tile');
    mkdirSync(tileDir, { recursive: true });
    writeFileSync(join(tileDir, 'tile.json'), '{}');

    const { generateAndDownloadScenarios } = await import('./scenario-generate.ts');
    const result = await generateAndDownloadScenarios(tileDir, 3, 1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('retries');
  });

  test('fails fast with workspace guidance when upload is forbidden', async () => {
    const spawnMock = makeMockSpawn(
      '',
      '✖ Failed to generate scenarios\n✘ Failed to get upload URL: 403 Forbidden',
      1,
    );
    // @ts-expect-error mock assignment
    Bun.spawn = spawnMock;
    const pluginDir = join(tmp, 'forbidden-plugin');
    mkdirSync(join(pluginDir, '.tessl-plugin'), { recursive: true });
    writeFileSync(join(pluginDir, '.tessl-plugin', 'plugin.json'), '{}');

    const { generateAndDownloadScenarios } = await import('./scenario-generate.ts');
    const result = await generateAndDownloadScenarios(pluginDir, 1, 1, {
      workspace: 'bapfernandez',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('403 Forbidden');
    expect(result.error).toContain('TESSL_TOKEN');
    expect(result.error).toContain('bapfernandez');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test('returns actionable error when generation has no downloadable scenarios', async () => {
    const spawnMock = makeMockSpawnSequence([
      { stdout: '{"generationId": "gen-empty"}', stderr: '', exitCode: 0 },
      { stdout: '{"status": "completed"}', stderr: '', exitCode: 0 },
      {
        stdout: '',
        stderr: '\u001B[31m✖\u001B[39m No scenarios found\n✘ No scenarios found for generation gen-empty.',
        exitCode: 1,
      },
    ]);
    // @ts-expect-error mock assignment
    Bun.spawn = spawnMock;
    const pluginDir = join(tmp, 'empty-plugin');
    mkdirSync(join(pluginDir, '.tessl-plugin'), { recursive: true });
    writeFileSync(join(pluginDir, '.tessl-plugin', 'plugin.json'), '{}');

    const { generateAndDownloadScenarios } = await import('./scenario-generate.ts');
    const result = await generateAndDownloadScenarios(pluginDir, 1, 1);

    expect(result.success).toBe(false);
    expect(result.error).toContain('returned no downloadable scenarios');
    expect(result.error).toContain('/tessl scenarios');
    expect(result.error).toContain('gen-empty');
    expect(result.error).not.toContain('\u001B');
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
    const tileDir = join(tmp, 'no-json-tile');
    mkdirSync(tileDir, { recursive: true });
    writeFileSync(join(tileDir, 'tile.json'), '{}');

    const { generateAndDownloadScenarios } = await import('./scenario-generate.ts');
    const result = await generateAndDownloadScenarios(tileDir, 3, 1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('parse');
  });
});
