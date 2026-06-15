import * as core from '@actions/core';
import { basename } from 'node:path';
import { extractJson } from './skill-review.ts';
import type {
  EvalResult,
  EvalScenario,
  EvalCriterion,
  EvalViewResponse,
  RawScenario,
  RawSolution,
} from './eval-types.ts';
import { isPluginRoot } from './find-plugins.ts';
import { tesslBin } from './tessl-bin.ts';

const POLL_INTERVAL_MS = 30_000;

function cleanCliOutput(output: string): string {
  return output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').trim();
}

/** Compute a solution's total score as percentage of max possible. */
function solutionScore(solution: RawSolution): number {
  const results = solution.assessmentResults ?? [];
  if (results.length === 0) return 0;
  const earned = results.reduce((sum, r) => sum + r.score, 0);
  const max = results.reduce((sum, r) => sum + r.max_score, 0);
  return max > 0 ? Math.round((earned / max) * 100) : 0;
}

/**
 * Parse the JSON:API output of `tessl eval view <id> --json` into an EvalResult.
 *
 * Response shape:
 *   { data: { id, attributes: { status, scenarios: [{ fingerprint, solutions: [{ variant, assessmentResults }] }] } } }
 */
export function parseEvalViewOutput(
  rawOutput: string,
  tilePath: string,
  runId: string,
): EvalResult {
  const jsonStr = extractJson(rawOutput);
  if (!jsonStr) {
    return {
      tilePath,
      runId,
      status: 'failed',
      overallScore: -1,
      scenarios: [],
      error: 'Could not parse eval view output',
    };
  }

  let parsed: EvalViewResponse;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return {
      tilePath,
      runId,
      status: 'failed',
      overallScore: -1,
      scenarios: [],
      error: 'Invalid JSON in eval view output',
    };
  }

  const attrs = parsed.data?.attributes;
  if (!attrs) {
    return {
      tilePath,
      runId,
      status: 'failed',
      overallScore: -1,
      scenarios: [],
      error: 'Unexpected eval view response structure',
    };
  }

  if (attrs.status === 'failed') {
    return {
      tilePath,
      runId,
      status: 'failed',
      overallScore: -1,
      scenarios: [],
      error: 'Eval run failed',
    };
  }

  const rawScenarios: RawScenario[] = attrs.scenarios ?? [];
  const scenarios: EvalScenario[] = [];

  for (const raw of rawScenarios) {
    const solutions = raw.solutions ?? [];
    const baseline = solutions.find((s) => s.variant === 'baseline');
    const withContext = solutions.find((s) => s.variant !== 'baseline');

    const baselineScoreVal = baseline ? solutionScore(baseline) : 0;
    const withContextScoreVal = withContext ? solutionScore(withContext) : 0;

    const criteria: EvalCriterion[] = (withContext?.assessmentResults ?? []).map((r) => ({
      name: r.name,
      score: r.score,
      maxScore: r.max_score,
      reasoning: r.reasoning,
    }));

    scenarios.push({
      name: raw.fingerprint.slice(0, 8),
      baselineScore: baselineScoreVal,
      withContextScore: withContextScoreVal,
      delta: withContextScoreVal - baselineScoreVal,
      criteria,
    });
  }

  const withContextScores = scenarios.map((s) => s.withContextScore);
  const overallScore =
    withContextScores.length > 0
      ? Math.round(withContextScores.reduce((a, b) => a + b, 0) / withContextScores.length)
      : 0;

  return {
    tilePath,
    runId,
    status: 'completed',
    overallScore,
    scenarios,
  };
}

/** Extract status from the JSON:API eval view response. */
function extractStatus(rawOutput: string): string | undefined {
  const jsonStr = extractJson(rawOutput);
  if (!jsonStr) return undefined;
  try {
    const parsed = JSON.parse(jsonStr) as EvalViewResponse;
    return parsed.data?.attributes?.status;
  } catch {
    return undefined;
  }
}

async function runTesslCommand(args: string[], cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return {
    exitCode: await proc.exited,
    stdout,
    stderr,
  };
}

async function ensureProjectLinked(tilePath: string, workspace: string): Promise<string | null> {
  if (!workspace || !isPluginRoot(tilePath)) {
    return null;
  }

  const linkArgs = [tesslBin(), 'project', 'link', '--workspace', workspace];
  const link = await runTesslCommand(linkArgs, tilePath);
  if (link.exitCode === 0) {
    core.info(`Tessl project link confirmed for ${tilePath}`);
    return null;
  }

  const linkOutput = cleanCliOutput(`${link.stderr}\n${link.stdout}`);
  if (!/No matching project/i.test(linkOutput)) {
    return `tessl project link failed (exit ${link.exitCode}): ${linkOutput || 'unknown error'}`;
  }

  const projectName = basename(tilePath.replace(/\/+$/, '')) || 'skill-eval';
  core.info(`No Tessl project found for ${tilePath}; creating "${projectName}" in workspace "${workspace}".`);

  const createArgs = [tesslBin(), 'project', 'create', projectName, '--workspace', workspace];
  const create = await runTesslCommand(createArgs, tilePath);
  if (create.exitCode === 0) {
    core.info(`Created Tessl project "${projectName}" for ${tilePath}`);
    return null;
  }

  const createOutput = cleanCliOutput(`${create.stderr}\n${create.stdout}`);
  return `tessl project create failed (exit ${create.exitCode}): ${createOutput || 'unknown error'}`;
}

export async function runEval(
  tilePath: string,
  workspace: string,
  agent: string,
  timeoutMinutes: number,
  runs: number,
): Promise<EvalResult> {
  const errorResult = (error: string): EvalResult => ({
    tilePath,
    runId: '',
    status: 'failed',
    overallScore: -1,
    scenarios: [],
    error,
  });

  const localPluginOrTile = isPluginRoot(tilePath);
  const projectError = await ensureProjectLinked(tilePath, workspace);
  if (projectError) {
    return errorResult(projectError);
  }

  const evalSource = localPluginOrTile ? '.' : tilePath;
  const evalCwd = localPluginOrTile ? tilePath : undefined;
  const args = [
    tesslBin(),
    'eval',
    'run',
    evalSource,
    '--agent',
    agent,
    '--runs',
    String(runs),
    '--json',
  ];
  // The Tessl CLI rejects --workspace when the target is a plugin or legacy
  // tile root, because the workspace is already declared in plugin.json/tile.json.
  if (workspace && !localPluginOrTile) {
    args.splice(4, 0, '--workspace', workspace);
  }

  const start = await runTesslCommand(args, evalCwd);
  if (start.exitCode !== 0) {
    return errorResult(`tessl eval run failed (exit ${start.exitCode}): ${start.stderr}`);
  }

  const startJson = extractJson(start.stdout);
  if (!startJson) {
    return errorResult('Could not parse tessl eval run output');
  }

  let startParsed: Record<string, unknown>;
  try {
    startParsed = JSON.parse(startJson);
  } catch {
    return errorResult('Invalid JSON from tessl eval run');
  }

  // The CLI returns [{ evalRunId }] (an array). extractJson finds the first '{',
  // which skips the outer '[' and grabs the first object. This works for single-agent
  // runs but would only return the first entry if multiple agents were specified.
  const runId = (startParsed.evalRunId ?? startParsed.id) as string | undefined;
  if (!runId) {
    return errorResult('No run id returned from tessl eval run');
  }
  core.info(`Eval run started: ${runId}`);

  const deadline = Date.now() + timeoutMinutes * 60_000;

  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);

    const viewProc = Bun.spawn([tesslBin(), 'eval', 'view', runId, '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [viewStdout, viewStderr] = await Promise.all([
      new Response(viewProc.stdout).text(),
      new Response(viewProc.stderr).text(),
    ]);

    const viewExit = await viewProc.exited;
    if (viewExit !== 0) {
      return errorResult(`tessl eval view failed (exit ${viewExit}): ${viewStderr}`);
    }

    const status = extractStatus(viewStdout);
    if (!status) {
      core.info(`Eval ${runId}: waiting (could not parse status)...`);
      continue;
    }

    if (status === 'completed' || status === 'failed') {
      return parseEvalViewOutput(viewStdout, tilePath, runId);
    }

    core.info(`Eval ${runId}: ${status}... waiting`);
  }

  return {
    tilePath,
    runId,
    status: 'timeout',
    overallScore: -1,
    scenarios: [],
    error: `Eval timed out after ${timeoutMinutes} minutes`,
  };
}
