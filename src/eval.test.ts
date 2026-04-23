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
// 1. findTileDir / findTileDirsWithEvals
// ---------------------------------------------------------------------------

describe('findTileDir', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `eval-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('finds tile.json in immediate parent', async () => {
    writeFileSync(join(tmp, 'tile.json'), '{}');
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findTileDir } = await import('./find-tiles.ts');
    expect(findTileDir(join(tmp, 'skills', 'foo', 'SKILL.md'))).toBe(tmp);
  });

  test('returns null when no tile.json exists', async () => {
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findTileDir } = await import('./find-tiles.ts');
    expect(findTileDir(join(tmp, 'skills', 'foo', 'SKILL.md'))).toBeNull();
  });
});

describe('findTileDirsWithEvals', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `eval-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('returns tile dir when evals/ exists', async () => {
    writeFileSync(join(tmp, 'tile.json'), '{}');
    mkdirSync(join(tmp, 'evals', 'scenario-a'), { recursive: true });
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findTileDirsWithEvals } = await import('./find-tiles.ts');
    const dirs = findTileDirsWithEvals([join(tmp, 'skills', 'foo', 'SKILL.md')]);
    expect(dirs).toEqual([tmp]);
  });

  test('skips tile dir when no evals/ exists', async () => {
    writeFileSync(join(tmp, 'tile.json'), '{}');
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');

    const { findTileDirsWithEvals } = await import('./find-tiles.ts');
    const dirs = findTileDirsWithEvals([join(tmp, 'skills', 'foo', 'SKILL.md')]);
    expect(dirs).toEqual([]);
  });

  test('deduplicates when multiple skills share a tile', async () => {
    writeFileSync(join(tmp, 'tile.json'), '{}');
    mkdirSync(join(tmp, 'evals', 'scenario-a'), { recursive: true });
    mkdirSync(join(tmp, 'skills', 'foo'), { recursive: true });
    mkdirSync(join(tmp, 'skills', 'bar'), { recursive: true });
    writeFileSync(join(tmp, 'skills', 'foo', 'SKILL.md'), '');
    writeFileSync(join(tmp, 'skills', 'bar', 'SKILL.md'), '');

    const { findTileDirsWithEvals } = await import('./find-tiles.ts');
    const dirs = findTileDirsWithEvals([
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
  return (..._args: unknown[]) => ({
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
  });
}

describe('runEval', () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    // @ts-ignore restoring original
    Bun.spawn = originalSpawn;
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
      id: 'run-123',
      status: 'completed',
      results: [
        {
          scenario_fingerprint: 'abc123',
          variant: 'baseline',
          score: 40,
          assessment_results: [
            { name: 'correctness', score: 10, max_score: 25, reasoning: 'Partial' },
          ],
        },
        {
          scenario_fingerprint: 'abc123',
          variant: 'usage-spec',
          score: 75,
          assessment_results: [
            { name: 'correctness', score: 20, max_score: 25, reasoning: 'Good' },
          ],
        },
      ],
    });

    const { parseEvalViewOutput } = await import('./eval-run.ts');
    const result = parseEvalViewOutput(viewOutput, '/tile', 'run-123');
    expect(result.status).toBe('completed');
    expect(result.overallScore).toBe(75);
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]!.baselineScore).toBe(40);
    expect(result.scenarios[0]!.withContextScore).toBe(75);
    expect(result.scenarios[0]!.delta).toBe(35);
  });

  test('handles multiple scenarios', async () => {
    const viewOutput = JSON.stringify({
      id: 'run-456',
      status: 'completed',
      results: [
        { scenario_fingerprint: 'aaa', variant: 'baseline', score: 30, assessment_results: [] },
        { scenario_fingerprint: 'aaa', variant: 'usage-spec', score: 60, assessment_results: [] },
        { scenario_fingerprint: 'bbb', variant: 'baseline', score: 50, assessment_results: [] },
        { scenario_fingerprint: 'bbb', variant: 'usage-spec', score: 80, assessment_results: [] },
      ],
    });

    const { parseEvalViewOutput } = await import('./eval-run.ts');
    const result = parseEvalViewOutput(viewOutput, '/tile', 'run-456');
    expect(result.scenarios).toHaveLength(2);
    expect(result.overallScore).toBe(70);
  });

  test('returns failed result for failed status', async () => {
    const viewOutput = JSON.stringify({
      id: 'run-789',
      status: 'failed',
      results: [],
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

  beforeEach(() => {
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    // @ts-ignore restoring original
    Bun.spawn = originalSpawn;
  });

  test('returns error when generate command fails', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('', 'not authenticated', 1);

    const { generateAndDownloadScenarios } = await import('./scenario-generate.ts');
    const result = await generateAndDownloadScenarios('/tile', 3, 1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not authenticated');
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
