import * as core from '@actions/core';
import { getChangedSkillFiles } from './changed-files.ts';
import { postOrUpdateComment } from './comment.ts';
import { postOrUpdateEvalComment } from './eval-comment.ts';
import { runEval } from './eval-run.ts';
import { findTileDirs, findTileDirsWithEvals } from './find-tiles.ts';
import type { SkillReviewResult } from './skill-review.ts';
import { runSkillReview } from './skill-review.ts';
import type { EvalResult } from './eval-types.ts';
import { generateAndDownloadScenarios } from './scenario-generate.ts';

const CONCURRENCY_LIMIT = 5;

async function main(): Promise<void> {
  const rootPath = process.env.INPUT_PATH || '.';
  const shouldComment = process.env.INPUT_COMMENT !== 'false';
  const threshold = parseThreshold(process.env.INPUT_FAIL_THRESHOLD, 'fail-threshold');

  // Eval config
  const evalEnabled = process.env.INPUT_EVAL === 'true';
  const evalWorkspace = process.env.INPUT_EVAL_WORKSPACE || '';
  const evalAgent = process.env.INPUT_EVAL_AGENT || 'claude:claude-sonnet-4-6';
  const evalTimeout = Number(process.env.INPUT_EVAL_TIMEOUT || '45');
  const failOnRegression = process.env.INPUT_EVAL_FAIL_ON_REGRESSION !== 'false';
  const generateScenarios = process.env.INPUT_EVAL_GENERATE_SCENARIOS === 'true';
  const scenarioCount = Number(process.env.INPUT_EVAL_SCENARIO_COUNT || '3');

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

  // 5a. Find tile directories
  let tileDirs: string[];

  if (generateScenarios) {
    // When generating scenarios, find all tiles (don't require existing evals/)
    tileDirs = findTileDirs(changedFiles);
    if (tileDirs.length === 0) {
      console.log('No tile directories found. Skipping eval phase.');
      return;
    }

    console.log(`Found ${tileDirs.length} tile(s): ${tileDirs.join(', ')}`);

    // 5b. Generate scenarios for each tile
    for (const tileDir of tileDirs) {
      console.log(`Generating ${scenarioCount} scenario(s) for ${tileDir}...`);
      const genResult = await generateAndDownloadScenarios(tileDir, scenarioCount, evalTimeout);
      if (!genResult.success) {
        core.warning(`Scenario generation failed for ${tileDir}: ${genResult.error}`);
      } else {
        console.log(`  Scenarios ready (generation ${genResult.generationId})`);
      }
    }
  } else {
    tileDirs = findTileDirsWithEvals(changedFiles);
    if (tileDirs.length === 0) {
      console.log('No tile directories with evals/ found. Skipping eval phase.');
      return;
    }

    console.log(`Found ${tileDirs.length} tile(s) with evals: ${tileDirs.join(', ')}`);
  }

  // 5c. Run evals
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
      await postOrUpdateEvalComment(evalResults, failOnRegression);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Could not post eval PR comment: ${msg}`);
    }
  }

  // 7. Check for regressions (with-context scored worse than baseline)
  if (failOnRegression) {
    const regressions = evalResults.flatMap((r) =>
      r.scenarios
        .filter((s) => s.delta < 0)
        .map((s) => ({ tilePath: r.tilePath, scenario: s.name, delta: s.delta })),
    );
    if (regressions.length > 0) {
      const summary = regressions
        .map((r) => `  ${r.tilePath} / ${r.scenario}: ${r.delta}%`)
        .join('\n');
      core.setFailed(
        `Skill regression: ${regressions.length} scenario(s) scored worse with context than baseline:\n${summary}`,
      );
    }
  }

  console.log('Eval phase completed.');
}

export function parseThreshold(value: string | undefined, inputName = 'fail-threshold'): number {
  const num = Number(value ?? '0');
  if (Number.isNaN(num) || num < 0 || num > 100) {
    throw new Error(
      `Invalid ${inputName}: ${value}. Must be a number between 0 and 100.`,
    );
  }
  return num;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
