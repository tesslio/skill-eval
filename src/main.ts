import * as core from '@actions/core';
import * as github from '@actions/github';
import { getChangedSkillFiles } from './changed-files.ts';
import { postOrUpdateEvalComment } from './eval-comment.ts';
import { runEval } from './eval-run.ts';
import { findPluginDirs, findPluginDirsWithEvals } from './find-plugins.ts';
import type { EvalResult } from './eval-types.ts';
import { generateAndDownloadScenarios } from './scenario-generate.ts';

async function main(): Promise<void> {
  // Opt-in/opt-out: check enabled input, then check for skip label
  const enabled = process.env.INPUT_ENABLED !== 'false';
  if (!enabled) {
    console.log('Eval is disabled (enabled: false). Skipping.');
    return;
  }

  const skipLabel = process.env.INPUT_SKIP_LABEL || 'skip-eval';
  if (skipLabel) {
    const labels: Array<{ name: string }> =
      github.context.payload.pull_request?.labels ?? [];
    if (labels.some((l) => l.name === skipLabel)) {
      console.log(`Eval skipped — PR has "${skipLabel}" label.`);
      return;
    }
  }

  const rootPath = process.env.INPUT_PATH || '.';
  const shouldComment = process.env.INPUT_COMMENT !== 'false';
  const evalWorkspace = process.env.INPUT_EVAL_WORKSPACE || '';
  const evalAgent = process.env.INPUT_EVAL_AGENT || 'claude:claude-sonnet-4-6';
  const evalTimeout = parsePositiveInt(process.env.INPUT_EVAL_TIMEOUT, 'eval-timeout', 45);
  const failOnRegression = process.env.INPUT_EVAL_FAIL_ON_REGRESSION !== 'false';
  const generateScenarios = process.env.INPUT_EVAL_GENERATE_SCENARIOS === 'true';
  const scenarioCount = parsePositiveInt(process.env.INPUT_EVAL_SCENARIO_COUNT, 'eval-scenario-count', 3);
  const commitScenarios = process.env.INPUT_EVAL_COMMIT_SCENARIOS === 'true';

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
  const allPluginDirs = findPluginDirs(changedFiles);
  if (allPluginDirs.length === 0) {
    console.log('No plugin directories found. Skipping eval.');
    return;
  }

  // 3. Split into plugins with existing evals and plugins that need generation
  const pluginsWithEvals = findPluginDirsWithEvals(changedFiles);
  const pluginsWithEvalsSet = new Set(pluginsWithEvals);
  const pluginsNeedingGeneration = allPluginDirs.filter((d) => !pluginsWithEvalsSet.has(d));

  if (pluginsWithEvals.length > 0) {
    console.log(`Found ${pluginsWithEvals.length} plugin(s) with existing evals: ${pluginsWithEvals.join(', ')}`);
  }

  if (pluginsNeedingGeneration.length > 0) {
    if (!generateScenarios) {
      console.log(
        `${pluginsNeedingGeneration.length} plugin(s) have no evals/ directory: ${pluginsNeedingGeneration.join(', ')}. ` +
        `Set eval-generate-scenarios: true to auto-generate scenarios for these plugins.`,
      );
    } else {
      console.log(`Generating scenarios for ${pluginsNeedingGeneration.length} plugin(s) without evals/...`);

      const genFailures: string[] = [];

      for (const pluginDir of pluginsNeedingGeneration) {
        console.log(`  Generating ${scenarioCount} scenario(s) for ${pluginDir}...`);
        const genResult = await generateAndDownloadScenarios(pluginDir, scenarioCount, evalTimeout);
        if (!genResult.success) {
          genFailures.push(`  ${pluginDir}: ${genResult.error}`);
        } else {
          console.log(`    Scenarios ready (generation ${genResult.generationId})`);
          pluginsWithEvals.push(pluginDir);
        }
      }

      if (genFailures.length > 0) {
        core.setFailed(
          `Scenario generation failed for ${genFailures.length} plugin(s):\n${genFailures.join('\n')}`,
        );
        return;
      }

      // Commit generated scenarios back to the PR branch
      if (commitScenarios) {
        const evalsDirs = pluginsNeedingGeneration.map((d) => `${d}/evals`);
        console.log(`Committing generated scenarios: ${evalsDirs.join(', ')}`);
        try {
          await commitGeneratedScenarios(evalsDirs);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          core.warning(`Could not commit scenarios (fork PR or insufficient permissions): ${msg}`);
        }
      }
    }
  }

  const pluginDirs = pluginsWithEvals;
  if (pluginDirs.length === 0) {
    console.log('No plugins with eval scenarios to run. Skipping eval.');
    return;
  }

  // 4. Run evals (concurrently — each is mostly polling, not CPU-bound)
  console.log(`Running evals for ${pluginDirs.length} plugin(s) concurrently...`);
  const evalResults = await Promise.all(
    pluginDirs.map(async (pluginDir) => {
      console.log(`  Starting eval for ${pluginDir}...`);
      const result = await runEval(pluginDir, evalWorkspace, evalAgent, evalTimeout);
      const status = result.error ? `ERROR: ${result.error}` : `score: ${result.overallScore}%`;
      console.log(`  ${pluginDir}: ${result.status} (${status})`);
      return result;
    }),
  );

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

async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderr}`);
  }
  return stdout.trim();
}

async function commitGeneratedScenarios(evalsDirs: string[]): Promise<void> {
  await git('config', 'user.name', 'github-actions[bot]');
  await git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  await git('add', ...evalsDirs);
  await git('commit', '-m', 'chore: add generated eval scenarios');
  await git('push');
  const hash = await git('rev-parse', '--short', 'HEAD');
  console.log(`Committed generated scenarios (${hash})`);
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
