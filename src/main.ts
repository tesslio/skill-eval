import * as core from '@actions/core';
import { getChangedSkillFiles } from './changed-files.ts';
import { postOrUpdateComment } from './comment.ts';
import { postOrUpdateEvalComment } from './eval-comment.ts';
import { runEval } from './eval-run.ts';
import { findTileDirsWithEvals } from './find-tiles.ts';
import type { SkillReviewResult } from './skill-review.ts';
import { runSkillReview } from './skill-review.ts';
import type { EvalResult } from './eval-types.ts';

const CONCURRENCY_LIMIT = 5;

async function main(): Promise<void> {
  const rootPath = process.env.INPUT_PATH || '.';
  const shouldComment = process.env.INPUT_COMMENT !== 'false';
  const threshold = parseThreshold(process.env.INPUT_FAIL_THRESHOLD);

  // Eval config
  const evalEnabled = process.env.INPUT_EVAL === 'true';
  const evalWorkspace = process.env.INPUT_EVAL_WORKSPACE || '';
  const evalAgent = process.env.INPUT_EVAL_AGENT || 'claude:claude-sonnet-4-6';
  const evalTimeout = Number(process.env.INPUT_EVAL_TIMEOUT || '45');
  const evalThreshold = parseThreshold(process.env.INPUT_EVAL_FAIL_THRESHOLD);

  // 1. Detect changed SKILL.md files
  const changedFiles = await getChangedSkillFiles(rootPath);

  if (changedFiles.length === 0) {
    console.log('No SKILL.md files changed in this PR. Nothing to review.');
    return;
  }

  console.log(
    `Found ${changedFiles.length} changed SKILL.md file(s): ${changedFiles.join(', ')}`,
  );

  // 2. Run reviews with concurrency limit
  const results: SkillReviewResult[] = [];
  for (let i = 0; i < changedFiles.length; i += CONCURRENCY_LIMIT) {
    const batch = changedFiles.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.all(
      batch.map(async (filePath) => {
        console.log(`Reviewing ${filePath}...`);
        const result = await runSkillReview(filePath, threshold);
        const status = result.error
          ? 'ERROR'
          : result.passed
            ? 'PASSED'
            : 'FAILED';
        console.log(`  ${filePath}: ${status} (score: ${result.score})`);
        return result;
      }),
    );
    results.push(...batchResults);
  }

  // 3. Post review PR comment
  if (shouldComment) {
    try {
      await postOrUpdateComment(results, threshold);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Could not post PR comment (expected for fork PRs): ${msg}`);
    }
  }

  // 4. Check review threshold
  if (threshold > 0) {
    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      const summary = failed
        .map((r) => `  ${r.skillPath}: ${r.score >= 0 ? `${r.score}%` : 'error'}`)
        .join('\n');
      core.setFailed(
        `${failed.length} skill(s) below threshold of ${threshold}%:\n${summary}`,
      );
    }
  }

  console.log('Skill review completed successfully.');

  // 5. Run evals if enabled
  if (!evalEnabled) return;

  if (!evalWorkspace) {
    core.setFailed('eval-workspace is required when eval is enabled');
    return;
  }

  if (!process.env.TESSL_API_KEY) {
    core.setFailed('TESSL_API_KEY environment variable is required for evals');
    return;
  }

  const tileDirs = findTileDirsWithEvals(changedFiles);
  if (tileDirs.length === 0) {
    console.log('No tile directories with evals/ found. Skipping eval phase.');
    return;
  }

  console.log(`Found ${tileDirs.length} tile(s) with evals: ${tileDirs.join(', ')}`);

  const evalResults: EvalResult[] = [];
  for (const tileDir of tileDirs) {
    console.log(`Running eval for ${tileDir}...`);
    const result = await runEval(tileDir, evalWorkspace, evalAgent, evalTimeout);
    const status = result.error ? `ERROR: ${result.error}` : `score: ${result.overallScore}%`;
    console.log(`  ${tileDir}: ${result.status} (${status})`);
    evalResults.push(result);
  }

  // 6. Post eval PR comment
  if (shouldComment) {
    try {
      await postOrUpdateEvalComment(evalResults, evalThreshold);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Could not post eval PR comment: ${msg}`);
    }
  }

  // 7. Check eval threshold
  if (evalThreshold > 0) {
    const failed = evalResults.filter(
      (r) => r.status !== 'completed' || r.overallScore < evalThreshold,
    );
    if (failed.length > 0) {
      const summary = failed
        .map((r) => `  ${r.tilePath}: ${r.overallScore >= 0 ? `${r.overallScore}%` : r.error ?? 'error'}`)
        .join('\n');
      core.setFailed(
        `${failed.length} eval(s) below threshold of ${evalThreshold}%:\n${summary}`,
      );
    }
  }

  console.log('Eval phase completed.');
}

export function parseThreshold(value: string | undefined): number {
  const num = Number(value ?? '0');
  if (Number.isNaN(num) || num < 0 || num > 100) {
    throw new Error(
      `Invalid fail-threshold: ${value}. Must be a number between 0 and 100.`,
    );
  }
  return num;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
