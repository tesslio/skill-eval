import * as core from '@actions/core';
import { join } from 'node:path';
import { extractJson } from './skill-review.ts';

const POLL_INTERVAL_MS = 15_000;

export interface ScenarioGenerateResult {
  tilePath: string;
  generationId: string;
  success: boolean;
  error?: string;
}

/**
 * Generate eval scenarios for a tile, poll until complete, then download them.
 */
export async function generateAndDownloadScenarios(
  tilePath: string,
  count: number,
  timeoutMinutes: number,
): Promise<ScenarioGenerateResult> {
  const errorResult = (error: string): ScenarioGenerateResult => ({
    tilePath,
    generationId: '',
    success: false,
    error,
  });

  // 1. Start scenario generation
  const genProc = Bun.spawn(
    ['tessl', 'scenario', 'generate', tilePath, '-n', String(count), '--json'],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  const [genStdout, genStderr] = await Promise.all([
    new Response(genProc.stdout).text(),
    new Response(genProc.stderr).text(),
  ]);

  const genExit = await genProc.exited;
  if (genExit !== 0) {
    return errorResult(`tessl scenario generate failed (exit ${genExit}): ${genStderr}`);
  }

  const genJson = extractJson(genStdout);
  if (!genJson) {
    return errorResult('Could not parse tessl scenario generate output');
  }

  let genParsed: { id?: string };
  try {
    genParsed = JSON.parse(genJson);
  } catch {
    return errorResult('Invalid JSON from tessl scenario generate');
  }

  if (!genParsed.id) {
    return errorResult('No generation id returned from tessl scenario generate');
  }

  const generationId = genParsed.id;
  core.info(`Scenario generation started: ${generationId}`);

  // 2. Poll until completed or timeout
  const deadline = Date.now() + timeoutMinutes * 60_000;

  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);

    const viewProc = Bun.spawn(
      ['tessl', 'scenario', 'view', generationId, '--json'],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const viewStdout = await new Response(viewProc.stdout).text();
    await viewProc.exited;

    const viewJson = extractJson(viewStdout);
    if (!viewJson) {
      core.info(`Scenario ${generationId}: waiting (could not parse status)...`);
      continue;
    }

    let viewParsed: { status?: string };
    try {
      viewParsed = JSON.parse(viewJson);
    } catch {
      core.info(`Scenario ${generationId}: waiting (invalid JSON)...`);
      continue;
    }

    if (viewParsed.status === 'completed') {
      break;
    }

    if (viewParsed.status === 'failed') {
      return errorResult(`Scenario generation ${generationId} failed`);
    }

    core.info(`Scenario ${generationId}: ${viewParsed.status ?? 'unknown'}... waiting`);
  }

  if (Date.now() >= deadline) {
    return errorResult(`Scenario generation timed out after ${timeoutMinutes} minutes`);
  }

  // 3. Download scenarios
  const evalsDir = join(tilePath, 'evals');
  const dlProc = Bun.spawn(
    ['tessl', 'scenario', 'download', generationId, '-o', evalsDir, '--json'],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  const [dlStdout, dlStderr] = await Promise.all([
    new Response(dlProc.stdout).text(),
    new Response(dlProc.stderr).text(),
  ]);

  const dlExit = await dlProc.exited;
  if (dlExit !== 0) {
    return errorResult(`tessl scenario download failed (exit ${dlExit}): ${dlStderr}`);
  }

  core.info(`Scenarios downloaded to ${evalsDir}`);

  return {
    tilePath,
    generationId,
    success: true,
  };
}
