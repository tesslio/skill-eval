import * as core from '@actions/core';
import { join } from 'node:path';
import { extractJson } from './skill-review.ts';

export let POLL_INTERVAL_MS = 30_000;
export let GENERATE_RETRY_INTERVAL_MS = 30_000;
export let GENERATE_RETRY_TIMEOUT_MS = 15 * 60_000;

/** Override intervals for testing. */
export function setTimings(poll: number, retryInterval: number, retryTimeout: number): void {
  POLL_INTERVAL_MS = poll;
  GENERATE_RETRY_INTERVAL_MS = retryInterval;
  GENERATE_RETRY_TIMEOUT_MS = retryTimeout;
}

export interface ScenarioGenerateResult {
  tilePath: string;
  generationId: string;
  success: boolean;
  error?: string;
}

/**
 * Extract the tile name from a tile path (last directory component).
 * e.g. "discovery" from "discovery" or "tiles/discovery" from "tiles/discovery"
 */
function tileNameFromPath(tilePath: string): string {
  return tilePath.replace(/\/+$/, '').split('/').pop() ?? tilePath;
}

/**
 * Check `tessl scenario list --mine --json` for an in-progress generation
 * that matches this tile. Returns the generation ID if found, null otherwise.
 */
async function findInProgressGeneration(tileName: string): Promise<string | null> {
  const proc = Bun.spawn(
    ['tessl', 'scenario', 'list', '--mine', '--json'],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  // The list response is JSON:API: { data: [{ id, attributes: { status, source } }] }
  const jsonStr = extractJson(stdout);
  if (!jsonStr) return null;

  let parsed: { data?: Array<{ id: string; attributes?: { status?: string; source?: { uploadsS3Key?: string } } }> };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  const runs = parsed.data ?? [];
  for (const run of runs) {
    const attrs = run.attributes;
    if (attrs?.status !== 'in_progress') continue;

    // Match by checking if the S3 key contains the tile name
    const s3Key = attrs.source?.uploadsS3Key ?? '';
    if (s3Key.includes(`-${tileName}.tar.gz`)) {
      return run.id;
    }
  }

  return null;
}

/**
 * Attempt to start scenario generation. If the server returns an error
 * (e.g. 500 due to a concurrent generation), check for an in-progress
 * generation for this tile and adopt it. Retries for up to 15 minutes.
 */
async function startOrAdoptGeneration(
  tilePath: string,
  count: number,
): Promise<{ generationId: string } | { error: string }> {
  const tileName = tileNameFromPath(tilePath);
  const deadline = Date.now() + GENERATE_RETRY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // Try to start a new generation
    const genProc = Bun.spawn(
      ['tessl', 'scenario', 'generate', tilePath, '-n', String(count), '--json'],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const [genStdout, genStderr] = await Promise.all([
      new Response(genProc.stdout).text(),
      new Response(genProc.stderr).text(),
    ]);

    const genExit = await genProc.exited;

    if (genExit === 0) {
      // Success — parse the generation ID
      const genJson = extractJson(genStdout);
      if (!genJson) return { error: 'Could not parse tessl scenario generate output' };

      let genParsed: Record<string, unknown>;
      try {
        genParsed = JSON.parse(genJson);
      } catch {
        return { error: 'Invalid JSON from tessl scenario generate' };
      }

      const generationId = (genParsed.generationId ?? genParsed.id) as string | undefined;
      if (!generationId) return { error: 'No generation id returned from tessl scenario generate' };

      return { generationId };
    }

    // Generate failed — log the error, then check for an in-progress generation to adopt
    const stderrTrimmed = genStderr.trim().replace(/\n/g, ' | ');
    core.info(`tessl scenario generate failed (exit ${genExit}): ${stderrTrimmed}`);
    core.info(`stdout was: ${genStdout.trim().slice(0, 200) || '(empty)'}`);

    const existingId = await findInProgressGeneration(tileName);
    if (existingId) {
      core.info(`Found in-progress generation ${existingId} for tile "${tileName}" — adopting it`);
      return { generationId: existingId };
    }

    // No in-progress generation found — wait and retry
    core.info(`No in-progress generation found for "${tileName}". Retrying in ${GENERATE_RETRY_INTERVAL_MS / 1000}s...`);
    await Bun.sleep(GENERATE_RETRY_INTERVAL_MS);
  }

  return { error: `Could not start scenario generation after ${GENERATE_RETRY_TIMEOUT_MS / 60_000} minutes of retries` };
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

  // 1. Start generation (or adopt an existing in-progress one)
  const startResult = await startOrAdoptGeneration(tilePath, count);
  if ('error' in startResult) {
    return errorResult(startResult.error);
  }

  const { generationId } = startResult;
  core.info(`Scenario generation active: ${generationId}`);

  // 2. Poll until completed or timeout
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let completed = false;

  while (Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);

    const viewProc = Bun.spawn(
      ['tessl', 'scenario', 'view', generationId, '--json'],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const [viewStdout, viewStderr] = await Promise.all([
      new Response(viewProc.stdout).text(),
      new Response(viewProc.stderr).text(),
    ]);

    const viewExit = await viewProc.exited;
    if (viewExit !== 0) {
      return errorResult(`tessl scenario view failed (exit ${viewExit}): ${viewStderr}`);
    }

    const viewJson = extractJson(viewStdout);
    if (!viewJson) {
      core.info(`Scenario ${generationId}: waiting (could not parse status)...`);
      continue;
    }

    let viewParsed: { data?: { attributes?: { status?: string } }; status?: string };
    try {
      viewParsed = JSON.parse(viewJson);
    } catch {
      core.info(`Scenario ${generationId}: waiting (invalid JSON)...`);
      continue;
    }

    const status = viewParsed.data?.attributes?.status ?? viewParsed.status;

    if (status === 'completed') {
      completed = true;
      break;
    }

    if (status === 'failed') {
      return errorResult(`Scenario generation ${generationId} failed`);
    }

    core.info(`Scenario ${generationId}: ${status ?? 'unknown'}... waiting`);
  }

  if (!completed) {
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
