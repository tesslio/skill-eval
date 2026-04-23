import * as core from '@actions/core';
import { extractJson } from './skill-review.ts';
import type {
  EvalResult,
  EvalScenario,
  EvalCriterion,
  EvalViewResponse,
  RawScenario,
  RawSolution,
} from './eval-types.ts';

const POLL_INTERVAL_MS = 30_000;

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

export async function runEval(
  tilePath: string,
  workspace: string,
  agent: string,
  timeoutMinutes: number,
): Promise<EvalResult> {
  const errorResult = (error: string): EvalResult => ({
    tilePath,
    runId: '',
    status: 'failed',
    overallScore: -1,
    scenarios: [],
    error,
  });

  const args = ['tessl', 'eval', 'run', tilePath, '--agent', agent, '--json'];
  if (workspace) {
    args.splice(4, 0, '--workspace', workspace);
  }

  const startProc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });

  const [startStdout, startStderr] = await Promise.all([
    new Response(startProc.stdout).text(),
    new Response(startProc.stderr).text(),
  ]);

  const startExit = await startProc.exited;
  if (startExit !== 0) {
    return errorResult(`tessl eval run failed (exit ${startExit}): ${startStderr}`);
  }

  const startJson = extractJson(startStdout);
  if (!startJson) {
    return errorResult('Could not parse tessl eval run output');
  }

  let startParsed: Record<string, unknown>;
  try {
    startParsed = JSON.parse(startJson);
  } catch {
    return errorResult('Invalid JSON from tessl eval run');
  }

  // The CLI returns [{ evalRunId }] — extractJson grabs the first object
  const runId = (startParsed.evalRunId ?? startParsed.id) as string | undefined;
  if (!runId) {
    return errorResult('No run id returned from tessl eval run');
  }
  core.info(`Eval run started: ${runId}`);

  const deadline = Date.now() + timeoutMinutes * 60_000;

  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);

    const viewProc = Bun.spawn(['tessl', 'eval', 'view', runId, '--json'], {
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
