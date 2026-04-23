import * as core from '@actions/core';
import { extractJson } from './skill-review.ts';
import type {
  EvalResult,
  EvalScenario,
  EvalCriterion,
  EvalRunResponse,
  RawSolution,
} from './eval-types.ts';

const POLL_INTERVAL_MS = 30_000;

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

  let parsed: { id?: string; status?: string; results?: RawSolution[] };
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

  if (parsed.status === 'failed') {
    return {
      tilePath,
      runId,
      status: 'failed',
      overallScore: -1,
      scenarios: [],
      error: 'Eval run failed',
    };
  }

  const results = parsed.results ?? [];

  const byScenario = new Map<string, { baseline?: RawSolution; withContext?: RawSolution }>();
  for (const sol of results) {
    const key = sol.scenario_fingerprint;
    const entry = byScenario.get(key) ?? {};
    if (sol.variant === 'baseline') {
      entry.baseline = sol;
    } else {
      entry.withContext = sol;
    }
    byScenario.set(key, entry);
  }

  const scenarios: EvalScenario[] = [];
  for (const [fingerprint, { baseline, withContext }] of byScenario) {
    const baselineScore = baseline?.score ?? 0;
    const withContextScore = withContext?.score ?? 0;
    const criteria: EvalCriterion[] = (withContext?.assessment_results ?? []).map((r) => ({
      name: r.name,
      score: r.score,
      maxScore: r.max_score,
      reasoning: r.reasoning,
    }));

    scenarios.push({
      name: fingerprint.slice(0, 8),
      baselineScore,
      withContextScore,
      delta: withContextScore - baselineScore,
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

  let startParsed: EvalRunResponse;
  try {
    startParsed = JSON.parse(startJson);
  } catch {
    return errorResult('Invalid JSON from tessl eval run');
  }

  if (!startParsed.id) {
    return errorResult('No run id returned from tessl eval run');
  }

  const runId = startParsed.id;
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

    const viewJson = extractJson(viewStdout);
    if (!viewJson) {
      core.info(`Eval ${runId}: waiting (could not parse status)...`);
      continue;
    }

    let viewParsed: { status?: string };
    try {
      viewParsed = JSON.parse(viewJson);
    } catch {
      core.info(`Eval ${runId}: waiting (invalid JSON)...`);
      continue;
    }

    if (viewParsed.status === 'completed' || viewParsed.status === 'failed') {
      return parseEvalViewOutput(viewStdout, tilePath, runId);
    }

    core.info(`Eval ${runId}: ${viewParsed.status ?? 'unknown'}... waiting`);
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
