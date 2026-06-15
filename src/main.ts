import * as core from '@actions/core';
import * as github from '@actions/github';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getChangedEvalTargetFiles } from './changed-files.ts';
import { parseTesslCommentCommand, isTrustedAuthorAssociation } from './comment-command.ts';
import {
  postGeneratedScenariosComment,
  postOrUpdateCommandStatusComment,
  postOrUpdateEvalComment,
  postOrUpdateEvalGuideComment,
  postOrUpdateEvalRerunGuideComment,
} from './eval-comment.ts';
import { runEval } from './eval-run.ts';
import { findPluginDirs, findPluginDirsWithEvals, resolveRequestedPluginDir } from './find-plugins.ts';
import { commitGeneratedScenarios } from './git-utils.ts';
import {
  getPayloadLabels,
  getPullRequestHead,
  getPullRequestNumber,
} from './github-context.ts';
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
    const labels = getPayloadLabels();
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
  const evalRuns = parsePositiveInt(process.env.INPUT_EVAL_RUNS, 'eval-runs', 1);
  const failOnRegression = process.env.INPUT_EVAL_FAIL_ON_REGRESSION !== 'false';
  const generateScenarios = process.env.INPUT_EVAL_GENERATE_SCENARIOS === 'true';
  const scenarioCount = parsePositiveInt(process.env.INPUT_EVAL_SCENARIO_COUNT, 'eval-scenario-count', 3);
  const commitScenarios = process.env.INPUT_EVAL_COMMIT_SCENARIOS === 'true';
  const testMode = process.env.INPUT_TEST_MODE === 'true';

  const isIssueComment = github.context.eventName === 'issue_comment';
  const prNumber = getPullRequestNumber();

  if (isIssueComment) {
    const command = parseTesslCommentCommand(github.context.payload.comment?.body as string | undefined);
    if (!command) {
      console.log('No /tessl eval or /tessl scenarios command found. Skipping.');
      return;
    }

    if (prNumber === null) {
      core.setFailed('Comment commands only work on pull requests.');
      return;
    }

    const association = github.context.payload.comment?.author_association as string | undefined;
    if (!isTrustedAuthorAssociation(association)) {
      core.setFailed(
        `Comment command is restricted to repo collaborators (got author_association ${association ?? 'NONE'}).`,
      );
      return;
    }

    if (!testMode && !process.env.TESSL_TOKEN) {
      core.setFailed('tessl-token is required. Pass your Tessl API token via secrets.');
      return;
    }

    const pluginDir = resolveRequestedPluginDir(command.requestedPath, rootPath);
    if (!pluginDir) {
      await postCommandStatusSafely({
        kind: command.kind,
        pluginDir: command.requestedPath,
        status: 'failed',
        detail:
          `Could not resolve "${command.requestedPath}" to a Tessl plugin or tile. ` +
          'Pass a plugin directory, skill directory, SKILL.md file, or evals/ path.',
      }, prNumber);
      core.setFailed(
        `Could not resolve "${command.requestedPath}" to a Tessl plugin or tile. ` +
        'Pass a plugin directory, skill directory, SKILL.md file, or evals/ path.',
      );
      return;
    }

    if (command.kind === 'scenarios') {
      await postCommandStatusSafely({
        kind: 'scenarios',
        pluginDir,
        status: 'running',
      }, prNumber);
      if (testMode) {
        await generateCommitAndReportMockScenarios(pluginDir, scenarioCount, prNumber);
      } else {
        await generateCommitAndReportScenarios(pluginDir, scenarioCount, evalTimeout, evalWorkspace, prNumber);
      }
      return;
    }

    if (!hasEvalsDir(pluginDir)) {
      await postCommandStatusSafely({
        kind: 'eval',
        pluginDir,
        status: 'failed',
        detail:
          `No eval scenarios found. Comment \`/tessl scenarios ${pluginDir.replace(/^\.\//, '')}\` ` +
          'to generate editable scenarios first.',
      }, prNumber);
      core.setFailed(
        `No eval scenarios found for ${pluginDir}. ` +
        `Comment \`/tessl scenarios ${pluginDir.replace(/^\.\//, '')}\` to generate editable scenarios first.`,
      );
      return;
    }

    await postCommandStatusSafely({
      kind: 'eval',
      pluginDir,
      status: 'running',
    }, prNumber);
    const evalResults = testMode
      ? await runMockEvalAndReport([pluginDir], shouldComment, failOnRegression, prNumber)
      : await runEvalAndReport([pluginDir], evalWorkspace, evalAgent, evalTimeout, evalRuns, shouldComment, failOnRegression, prNumber);
    const evalErrors = evalResults
      .filter((result) => result.error)
      .map((result) => `${result.tilePath}: ${result.error}`);
    await postCommandStatusSafely({
      kind: 'eval',
      pluginDir,
      status: evalErrors.length > 0 ? 'failed' : 'succeeded',
      detail: evalErrors.join('\n'),
    }, prNumber);
    failForRegressions(evalResults, failOnRegression);
    return;
  }

  if (!testMode && !process.env.TESSL_TOKEN) {
    core.setFailed('tessl-token is required. Pass your Tessl API token via secrets.');
    return;
  }

  // 1. Detect changed SKILL.md or eval scenario files
  const changedFiles = await getChangedEvalTargetFiles(rootPath);

  if (changedFiles.length === 0) {
    console.log('No SKILL.md or eval scenario files changed in this PR. Nothing to eval.');
    return;
  }

  console.log(
    `Found ${changedFiles.length} changed eval target file(s): ${changedFiles.join(', ')}`,
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
      if (shouldComment && prNumber !== null) {
        try {
          await postOrUpdateEvalGuideComment(pluginsNeedingGeneration, prNumber);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          core.warning(`Could not post eval guide PR comment: ${msg}`);
        }
      }
    } else {
      console.log(`Generating scenarios for ${pluginsNeedingGeneration.length} plugin(s) without evals/...`);

      const genFailures: string[] = [];

      for (const pluginDir of pluginsNeedingGeneration) {
        console.log(`  Generating ${scenarioCount} scenario(s) for ${pluginDir}...`);
        const genResult = testMode
          ? generateMockScenarios(pluginDir, scenarioCount)
          : await generateAndDownloadScenarios(
            pluginDir,
            scenarioCount,
            evalTimeout,
            {
              ...(prNumber ? { prNumber } : {}),
              ...(evalWorkspace ? { workspace: evalWorkspace } : {}),
            },
          );
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
        const evalsDirs = pluginsNeedingGeneration.map((d) => join(d, 'evals'));
        console.log(`Committing generated scenarios: ${evalsDirs.join(', ')}`);
        try {
          const token = process.env.GITHUB_TOKEN;
          if (!token) throw new Error('GITHUB_TOKEN is required to commit generated scenarios');
          const octokit = github.getOctokit(token);
          const number = prNumber ?? github.context.payload.pull_request?.number;
          if (!number) throw new Error('No pull request context found');
          const prHead = await getPullRequestHead(octokit, number);
          await commitGeneratedScenarios(evalsDirs, prHead);
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

  // Re-run gate: when SKILL.md or evals/** are edited on a PR that already has
  // committed scenarios, we ask the human to choose between re-running with the
  // existing scenarios (/tessl eval ...) or amending the scenarios on the PR
  // first. The action's own scenario-commit pushes are exempt so the immediate
  // chain after /tessl scenarios keeps working.
  const pluginsAlreadyHadEvals = pluginsWithEvals.filter(
    (d) => !pluginsNeedingGeneration.includes(d),
  );
  if (pluginsAlreadyHadEvals.length > 0 && !isBotActor()) {
    console.log(
      `Plugins already have committed evals; skipping auto-eval and asking the reviewer ` +
      `to choose between re-running and amending scenarios: ${pluginsAlreadyHadEvals.join(', ')}`,
    );
    if (shouldComment && prNumber !== null) {
      try {
        await postOrUpdateEvalRerunGuideComment(pluginsAlreadyHadEvals, prNumber);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        core.warning(`Could not post eval re-run guide PR comment: ${msg}`);
      }
    }
    return;
  }

  const evalResults = testMode
    ? await runMockEvalAndReport(pluginDirs, shouldComment, failOnRegression, prNumber)
    : await runEvalAndReport(pluginDirs, evalWorkspace, evalAgent, evalTimeout, evalRuns, shouldComment, failOnRegression, prNumber);
  failForRegressions(evalResults, failOnRegression);

  console.log('Eval completed.');
}

/**
 * Returns true when the actor that triggered this workflow run is the
 * github-actions bot (e.g. a scenario commit pushed by this action). Used
 * to keep the /tessl scenarios → eval chain auto-running, while still
 * asking a human reviewer to confirm a re-run on subsequent edits.
 */
export function isBotActor(): boolean {
  const actor = github.context.actor ?? '';
  if (actor === 'github-actions[bot]' || actor === 'github-actions') return true;
  const sender = (github.context.payload?.sender as { login?: string; type?: string } | undefined);
  if (sender?.type === 'Bot') return true;
  if (sender?.login === 'github-actions[bot]' || sender?.login === 'github-actions') return true;
  return false;
}

function hasEvalsDir(pluginDir: string): boolean {
  const evalsDir = join(pluginDir, 'evals');
  return existsSync(evalsDir) && statSync(evalsDir).isDirectory();
}

function generateMockScenarios(pluginDir: string, scenarioCount: number): {
  success: boolean;
  generationId: string;
  error?: string;
} {
  const evalsDir = join(pluginDir, 'evals');
  mkdirSync(evalsDir, { recursive: true });

  for (let i = 1; i <= scenarioCount; i++) {
    const scenarioPath = join(evalsDir, `test-mode-scenario-${i}.json`);
    writeFileSync(
      scenarioPath,
      `${JSON.stringify({
        name: `Test mode scenario ${i}`,
        prompt:
          'This scenario was generated by skill-eval test-mode to validate GitHub Actions wiring. ' +
          'Replace it with a real Tessl-generated scenario before using production evals.',
        expected: 'Reviewers can see, edit, and delete generated scenario files in the PR.',
        testMode: true,
      }, null, 2)}\n`,
    );
  }

  return {
    success: true,
    generationId: `test-mode-${Date.now()}`,
  };
}

async function generateCommitAndReportMockScenarios(
  pluginDir: string,
  scenarioCount: number,
  prNumber: number,
): Promise<void> {
  console.log(`Test mode: generating ${scenarioCount} mock scenario(s) for ${pluginDir}...`);
  const genResult = generateMockScenarios(pluginDir, scenarioCount);

  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN is required to commit generated scenarios');
    const octokit = github.getOctokit(token);
    const prHead = await getPullRequestHead(octokit, prNumber);
    const commit = await commitGeneratedScenarios([join(pluginDir, 'evals')], prHead);
    await postGeneratedScenariosComment(pluginDir, genResult.generationId, commit, prNumber);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await postCommandStatusSafely({
      kind: 'scenarios',
      pluginDir,
      status: 'failed',
      detail: `Generated mock scenarios, but could not commit them to the PR branch: ${msg}`,
    }, prNumber);
    core.setFailed(`Generated mock scenarios, but could not commit them to the PR branch: ${msg}`);
  }
}

async function generateCommitAndReportScenarios(
  pluginDir: string,
  scenarioCount: number,
  evalTimeout: number,
  evalWorkspace: string,
  prNumber: number,
): Promise<void> {
  console.log(`Generating ${scenarioCount} scenario(s) for ${pluginDir}...`);
  const genResult = await generateAndDownloadScenarios(
    pluginDir,
    scenarioCount,
    evalTimeout,
    {
      prNumber,
      ...(evalWorkspace ? { workspace: evalWorkspace } : {}),
    },
  );
  if (!genResult.success) {
    await postCommandStatusSafely({
      kind: 'scenarios',
      pluginDir,
      status: 'failed',
      detail: genResult.error,
    }, prNumber);
    core.setFailed(`Scenario generation failed for ${pluginDir}: ${genResult.error}`);
    return;
  }

  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN is required to commit generated scenarios');
    const octokit = github.getOctokit(token);
    const prHead = await getPullRequestHead(octokit, prNumber);
    const commit = await commitGeneratedScenarios([join(pluginDir, 'evals')], prHead);
    await postGeneratedScenariosComment(pluginDir, genResult.generationId, commit, prNumber);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await postCommandStatusSafely({
      kind: 'scenarios',
      pluginDir,
      status: 'failed',
      detail: `Generated scenarios, but could not commit them to the PR branch: ${msg}`,
    }, prNumber);
    core.setFailed(`Generated scenarios, but could not commit them to the PR branch: ${msg}`);
  }
}

async function postCommandStatusSafely(
  options: Parameters<typeof postOrUpdateCommandStatusComment>[0],
  prNumber: number,
): Promise<void> {
  try {
    await postOrUpdateCommandStatusComment(options, prNumber);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`Could not post Tessl command status comment: ${msg}`);
  }
}

async function runEvalAndReport(
  pluginDirs: string[],
  evalWorkspace: string,
  evalAgent: string,
  evalTimeout: number,
  evalRuns: number,
  shouldComment: boolean,
  failOnRegression: boolean,
  prNumber: number | null,
): Promise<EvalResult[]> {
  // Run evals (concurrently — each is mostly polling, not CPU-bound)
  console.log(`Running evals for ${pluginDirs.length} plugin(s) concurrently...`);
  const evalResults = await Promise.all(
    pluginDirs.map(async (pluginDir) => {
      console.log(`  Starting eval for ${pluginDir}...`);
      const result = await runEval(pluginDir, evalWorkspace, evalAgent, evalTimeout, evalRuns);
      const status = result.error ? `ERROR: ${result.error}` : `score: ${result.overallScore}%`;
      console.log(`  ${pluginDir}: ${result.status} (${status})`);
      return result;
    }),
  );

  // 5. Post eval PR comment
  if (shouldComment) {
    try {
      await postOrUpdateEvalComment(evalResults, failOnRegression, prNumber);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Could not post eval PR comment: ${msg}`);
    }
  }

  return evalResults;
}

async function runMockEvalAndReport(
  pluginDirs: string[],
  shouldComment: boolean,
  failOnRegression: boolean,
  prNumber: number | null,
): Promise<EvalResult[]> {
  const evalResults = pluginDirs.map((pluginDir) => ({
    tilePath: pluginDir,
    runId: 'test-mode',
    status: 'completed' as const,
    overallScore: 100,
    scenarios: [
      {
        name: 'test-mode-scenario',
        baselineScore: 60,
        withContextScore: 100,
        delta: 40,
        criteria: [
          {
            name: 'github-action-wiring',
            score: 1,
            maxScore: 1,
            reasoning:
              'Mock result generated by skill-eval test-mode. This validates PR comments and workflow wiring only.',
          },
        ],
      },
    ],
  }));

  if (shouldComment) {
    try {
      await postOrUpdateEvalComment(evalResults, failOnRegression, prNumber);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Could not post mock eval PR comment: ${msg}`);
    }
  }

  return evalResults;
}

function failForRegressions(evalResults: EvalResult[], failOnRegression: boolean): void {
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
