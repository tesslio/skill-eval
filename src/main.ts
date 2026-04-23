import * as core from '@actions/core';
import { getChangedSkillFiles } from './changed-files.ts';
import { postOrUpdateEvalComment } from './eval-comment.ts';
import { runEval } from './eval-run.ts';
import { findTileDirs, findTileDirsWithEvals } from './find-tiles.ts';
import type { EvalResult } from './eval-types.ts';
import { generateAndDownloadScenarios } from './scenario-generate.ts';

async function main(): Promise<void> {
  const rootPath = process.env.INPUT_PATH || '.';
  const shouldComment = process.env.INPUT_COMMENT !== 'false';
  const evalWorkspace = process.env.INPUT_EVAL_WORKSPACE || '';
  const evalAgent = process.env.INPUT_EVAL_AGENT || 'claude:claude-sonnet-4-6';
  const evalTimeout = parsePositiveInt(process.env.INPUT_EVAL_TIMEOUT, 'eval-timeout', 45);
  const failOnRegression = process.env.INPUT_EVAL_FAIL_ON_REGRESSION !== 'false';
  const generateScenarios = process.env.INPUT_EVAL_GENERATE_SCENARIOS === 'true';
  const scenarioCount = parsePositiveInt(process.env.INPUT_EVAL_SCENARIO_COUNT, 'eval-scenario-count', 3);

  if (!process.env.TESSL_TOKEN) {
    core.setFailed('tessl-token is required. Pass your Tessl API token via secrets.');
    return;
  }

  // 1. Detect changed SKILL.md files
  const changedFiles = await getChangedSkillFiles(rootPath);

  if (changedFiles.length === 0) {
    console.log('No SKILL.md files changed in this PR. Nothing to eval.');
    return;
  }

  console.log(
    `Found ${changedFiles.length} changed SKILL.md file(s): ${changedFiles.join(', ')}`,
  );

  // 2. Find all tile directories
  const allTileDirs = findTileDirs(changedFiles);
  if (allTileDirs.length === 0) {
    console.log('No tile directories found. Skipping eval.');
    return;
  }

  // 3. Split into tiles with existing evals and tiles that need generation
  const tilesWithEvals = findTileDirsWithEvals(changedFiles);
  const tilesWithEvalsSet = new Set(tilesWithEvals);
  const tilesNeedingGeneration = allTileDirs.filter((d) => !tilesWithEvalsSet.has(d));

  if (tilesWithEvals.length > 0) {
    console.log(`Found ${tilesWithEvals.length} tile(s) with existing evals: ${tilesWithEvals.join(', ')}`);
  }

  if (tilesNeedingGeneration.length > 0) {
    if (!generateScenarios) {
      console.log(
        `${tilesNeedingGeneration.length} tile(s) have no evals/ directory: ${tilesNeedingGeneration.join(', ')}. ` +
        `Set eval-generate-scenarios: true to auto-generate scenarios for these tiles.`,
      );
    } else {
      console.log(`Generating scenarios for ${tilesNeedingGeneration.length} tile(s) without evals/...`);

      const genFailures: string[] = [];

      for (const tileDir of tilesNeedingGeneration) {
        console.log(`  Generating ${scenarioCount} scenario(s) for ${tileDir}...`);
        const genResult = await generateAndDownloadScenarios(tileDir, scenarioCount, evalTimeout);
        if (!genResult.success) {
          genFailures.push(`  ${tileDir}: ${genResult.error}`);
        } else {
          console.log(`    Scenarios ready (generation ${genResult.generationId})`);
          tilesWithEvals.push(tileDir);
        }
      }

      if (genFailures.length > 0) {
        core.setFailed(
          `Scenario generation failed for ${genFailures.length} tile(s):\n${genFailures.join('\n')}`,
        );
        return;
      }
    }
  }

  const tileDirs = tilesWithEvals;
  if (tileDirs.length === 0) {
    console.log('No tiles with eval scenarios to run. Skipping eval.');
    return;
  }

  // 4. Run evals
  const evalResults: EvalResult[] = [];
  for (const tileDir of tileDirs) {
    console.log(`Running eval for ${tileDir}...`);
    const result = await runEval(tileDir, evalWorkspace, evalAgent, evalTimeout);
    const status = result.error ? `ERROR: ${result.error}` : `score: ${result.overallScore}%`;
    console.log(`  ${tileDir}: ${result.status} (${status})`);
    evalResults.push(result);
  }

  // 5. Post eval PR comment
  if (shouldComment) {
    try {
      await postOrUpdateEvalComment(evalResults, failOnRegression);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Could not post eval PR comment: ${msg}`);
    }
  }

  // 6. Check for regressions (with-context scored worse than baseline)
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

  console.log('Eval completed.');
}

export function parsePositiveInt(
  value: string | undefined,
  inputName: string,
  defaultValue: number,
): number {
  if (value === undefined || value === '') return defaultValue;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 1 || !Number.isInteger(num)) {
    throw new Error(
      `Invalid ${inputName}: ${value}. Must be a positive integer.`,
    );
  }
  return num;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
