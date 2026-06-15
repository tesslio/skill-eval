import * as github from '@actions/github';
import type { EvalResult } from './eval-types.ts';
import { getPullRequestNumber } from './github-context.ts';

const EVAL_COMMENT_MARKER = '<!-- tessl-skill-eval -->';
const GUIDE_COMMENT_MARKER = '<!-- tessl-skill-eval-guide -->';
const COMMAND_COMMENT_MARKER = '<!-- tessl-skill-eval-command -->';
const RERUN_GUIDE_COMMENT_MARKER = '<!-- tessl-skill-eval-rerun -->';

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>~]/g, '\\$&');
}

/** Sanitize text for use inside a markdown table cell. */
function sanitizeTableCell(text: string): string {
  return text
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '<br>')
    .replace(/@/g, '@<!-- -->')
    .replace(/`/g, '\\`');
}

function deltaIndicator(delta: number): string {
  if (delta > 0) return `🔺 +${delta}%`;
  if (delta < 0) return `🔻 ${delta}%`;
  return '➡️ 0%';
}

function evalScoreBadge(score: number): string {
  const color =
    score >= 80 ? 'brightgreen' : score >= 60 ? 'yellow' : score >= 40 ? 'orange' : 'red';
  return `![eval score](https://img.shields.io/badge/eval_score-${score}%25-${color})`;
}

function displayPath(path: string): string {
  return path.replace(/^\.\//, '');
}

function actionRunUrl(): string | null {
  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!repository || !runId) return null;
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

async function postOrUpdateMarkedComment(
  marker: string,
  body: string,
  prNumber: number | null,
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to post PR comments');
  }

  if (prNumber === null) {
    throw new Error('No pull request context found');
  }

  const octokit = github.getOctokit(token);
  let existing: { id: number; body?: string | null } | undefined;
  let commentPage = 1;

  while (!existing) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: prNumber,
      per_page: 100,
      page: commentPage,
    });

    existing = comments.find((c) => c.body?.includes(marker));
    if (comments.length < 100) break;
    commentPage++;
  }

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: prNumber,
      body,
    });
  }
}

export function formatEvalComment(results: EvalResult[], failOnRegression: boolean): string {
  const sections = results.map((result) => {
    const resultPath = displayPath(result.tilePath);

    if (result.error) {
      return `### \`${resultPath}\`\n\n> ⚠️ **Error:** ${escapeMarkdown(result.error)}\n`;
    }

    const hasRegression = result.scenarios.some((s) => s.delta < 0);
    const regressionEmoji = failOnRegression && hasRegression ? ' ❌ regression' : '';
    const badge = result.overallScore >= 0 ? ` ${evalScoreBadge(result.overallScore)}${regressionEmoji}` : '';

    const evalLink = result.runId ? `\n[View eval run on Tessl](https://tessl.io/eval-runs/${result.runId})\n` : '';

    let body = `### \`${resultPath}\`\n${badge}\n${evalLink}`;

    if (result.scenarios.length > 0) {
      body += '\n| Scenario | Baseline | With Context | Delta |\n';
      body += '|----------|----------|--------------|-------|\n';
      for (const s of result.scenarios) {
        body += `| ${s.name} | ${s.baselineScore}% | ${s.withContextScore}% | ${deltaIndicator(s.delta)} |\n`;
      }

      const scenariosWithCriteria = result.scenarios.filter((s) => s.criteria.length > 0);
      if (scenariosWithCriteria.length > 0) {
        body += '\n<details>\n<summary>Criterion breakdown</summary>\n\n';
        for (const s of scenariosWithCriteria) {
          body += `#### ${s.name}\n\n`;
          body += '| Criterion | Score | Detail |\n';
          body += '|-----------|-------|--------|\n';
          for (const c of s.criteria) {
            body += `| ${sanitizeTableCell(c.name)} | ${c.score}/${c.maxScore} | ${sanitizeTableCell(c.reasoning)} |\n`;
          }
          body += '\n';
        }
        body += '</details>\n';
      }
    }

    return body;
  });

  const footer = [
    '---',
    '',
    'To improve your eval scores, run `tessl eval compare` locally for a detailed breakdown. Need help? Jump on our [Discord](https://discord.gg/jbb2vHnHZQ).',
    '',
    '<details>',
    '<summary>Feedback</summary>',
    '',
    'Report issues at [tesslio/skill-eval](https://github.com/tesslio/skill-eval/issues), or send private feedback with `tessl feedback`.',
    '',
    '</details>',
  ].join('\n');

  return `${EVAL_COMMENT_MARKER}\n## 🧪 Tessl Eval Results\n\n${sections.join('\n---\n\n')}\n${footer}`;
}

export function formatEvalGuideComment(pluginDirs: string[]): string {
  const paths = pluginDirs.map(displayPath);
  const primaryPath = paths[0] ?? 'path/to/plugin';
  const detectedPaths = paths.map((path) => `- \`${path}\``).join('\n');

  return [
    GUIDE_COMMENT_MARKER,
    '## Tessl Skill Eval',
    '',
    'I found changed skill content, but no committed eval scenarios yet.',
    '',
    'Suggested flow:',
    '',
    `- Comment \`/tessl scenarios ${primaryPath}\` to generate editable scenarios.`,
    '- Review, edit, or delete the generated `evals/` files directly in this PR.',
    `- Comment \`/tessl eval ${primaryPath}\` to run evals against the reviewed scenarios.`,
    '',
    'Setup note:',
    '',
    '- `TESSL_TOKEN` must be a Tessl API key with access to the configured `eval-workspace`.',
    '- Scenario generation uploads the checked-out plugin before committing `evals/` files back to this PR.',
    '',
    'Detected plugin paths:',
    detectedPaths || `- \`${primaryPath}\``,
  ].join('\n');
}

export function formatEvalRerunGuideComment(pluginDirs: string[]): string {
  const paths = pluginDirs.map(displayPath);
  const primaryPath = paths[0] ?? 'path/to/plugin';
  const evalCommands = paths.length > 0
    ? paths.map((path) => `- \`/tessl eval ${path}\``).join('\n')
    : `- \`/tessl eval ${primaryPath}\``;
  const detectedPaths = paths.length > 0
    ? paths.map((path) => `- \`${path}\``).join('\n')
    : `- \`${primaryPath}\``;

  return [
    RERUN_GUIDE_COMMENT_MARKER,
    '## Tessl Skill Eval — change detected',
    '',
    'Hey — you have changed `SKILL.md` or files under `evals/` again, and committed eval scenarios already exist on this PR. I have not re-run evals automatically. Pick one of the two options below:',
    '',
    '### Option 1 — Re-run evals with the existing scenarios',
    '',
    'Comment the matching command on this PR:',
    '',
    evalCommands,
    '',
    '### Option 2 — Amend the scenarios first, then re-run',
    '',
    'Edit the scenario files directly on this PR branch and commit them, then run Option 1. Each scenario lives in its own directory under `<plugin>/evals/`:',
    '',
    '```',
    '<plugin>/evals/<scenario-name>/',
    '├── scenario.json   # scenario metadata (description, references to inputs)',
    '├── criteria.json   # weighted checklist used to grade the agent\'s output',
    '├── task.md         # the task description handed to the agent',
    '└── inputs/         # files the agent receives as input (optional)',
    '```',
    '',
    'Tip: tighten `criteria.json` if the grader is too lenient, edit `task.md` to test a different agent task, or drop entire scenario directories you no longer want to grade against.',
    '',
    'Plugins with committed evals:',
    detectedPaths,
  ].join('\n');
}

export type CommandStatus = 'running' | 'succeeded' | 'failed';

export interface CommandStatusCommentOptions {
  kind: 'scenarios' | 'eval';
  pluginDir: string;
  status: CommandStatus;
  detail?: string;
  generationId?: string;
  commitSha?: string;
  committed?: boolean;
}

export function formatCommandStatusComment(options: CommandStatusCommentOptions): string {
  const path = displayPath(options.pluginDir);
  const command = `/tessl ${options.kind} ${path}`;
  const runUrl = actionRunUrl();
  const runLine = runUrl ? `\nAction run: [${process.env.GITHUB_RUN_ID}](${runUrl})\n` : '';

  if (options.status === 'running' && options.kind === 'scenarios') {
    return [
      COMMAND_COMMENT_MARKER,
      '## Tessl command received',
      '',
      `Running \`${command}\`.`,
      runLine,
      'I am generating scenarios now. If generation succeeds, I will commit editable files under:',
      '',
      `\`${path}/evals/\``,
      '',
      'This uses the configured Tessl workspace and the `TESSL_TOKEN` secret for upload/generation.',
      '',
      'Then you can review, edit, or delete them directly in this PR before running evals.',
    ].join('\n');
  }

  if (options.status === 'running') {
    return [
      COMMAND_COMMENT_MARKER,
      '## Tessl command received',
      '',
      `Running \`${command}\`.`,
      runLine,
      'I will update the eval result comment when the run finishes.',
    ].join('\n');
  }

  if (options.status === 'succeeded' && options.kind === 'scenarios') {
    const committed = options.committed !== false;
    const heading = committed
      ? '## Tessl scenarios generated'
      : '## Tessl scenarios already up to date';
    const detail = committed
      ? `Generated editable scenarios in \`${path}/evals/\` and committed them to this PR (${options.commitSha ?? 'commit created'}).`
      : `Generated scenarios matched the existing files in \`${path}/evals/\`, so no new commit was needed.`;

    return [
      COMMAND_COMMENT_MARKER,
      heading,
      '',
      detail,
      '',
      'Next steps:',
      '',
      `- Review, edit, or delete the generated files in \`${path}/evals/\`.`,
      `- Comment \`/tessl eval ${path}\` when you are ready to run evals.`,
      '',
      options.generationId ? `<sub>Scenario generation: ${options.generationId}</sub>` : '',
    ].filter(Boolean).join('\n');
  }

  if (options.status === 'succeeded') {
    return [
      COMMAND_COMMENT_MARKER,
      '## Tessl eval complete',
      '',
      `Finished \`${command}\`.`,
      '',
      'I updated the Tessl eval result comment on this PR.',
    ].join('\n');
  }

  return [
    COMMAND_COMMENT_MARKER,
    '## Tessl command failed',
    '',
    `Command: \`${command}\``,
    '',
    options.detail ? `Reason: ${escapeMarkdown(options.detail)}` : 'Reason: unknown failure',
    runLine,
  ].join('\n');
}

export async function postOrUpdateEvalComment(
  results: EvalResult[],
  failOnRegression: boolean,
  prNumber = getPullRequestNumber(),
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to post eval comments');
  }

  if (prNumber === null) {
    throw new Error('No pull request context found');
  }

  const octokit = github.getOctokit(token);
  const body = formatEvalComment(results, failOnRegression);

  let existing: { id: number; body?: string | null } | undefined;
  let commentPage = 1;

  while (!existing) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: prNumber,
      per_page: 100,
      page: commentPage,
    });

    existing = comments.find((c) => c.body?.includes(EVAL_COMMENT_MARKER));
    if (comments.length < 100) break;
    commentPage++;
  }

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      comment_id: existing.id,
      body,
    });
    console.log(`Updated existing eval comment (id: ${existing.id})`);
  } else {
    await octokit.rest.issues.createComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: prNumber,
      body,
    });
    console.log('Posted new eval comment');
  }
}

export async function postOrUpdateEvalGuideComment(
  pluginDirs: string[],
  prNumber = getPullRequestNumber(),
): Promise<void> {
  await postOrUpdateMarkedComment(
    GUIDE_COMMENT_MARKER,
    formatEvalGuideComment(pluginDirs),
    prNumber,
  );
}

export async function postOrUpdateEvalRerunGuideComment(
  pluginDirs: string[],
  prNumber = getPullRequestNumber(),
): Promise<void> {
  await postOrUpdateMarkedComment(
    RERUN_GUIDE_COMMENT_MARKER,
    formatEvalRerunGuideComment(pluginDirs),
    prNumber,
  );
}

export async function postOrUpdateCommandStatusComment(
  options: CommandStatusCommentOptions,
  prNumber = getPullRequestNumber(),
): Promise<void> {
  await postOrUpdateMarkedComment(
    COMMAND_COMMENT_MARKER,
    formatCommandStatusComment(options),
    prNumber,
  );
}

export async function postGeneratedScenariosComment(
  pluginDir: string,
  generationId: string,
  commit: { commitSha: string; committed: boolean },
  prNumber = getPullRequestNumber(),
): Promise<void> {
  await postOrUpdateCommandStatusComment({
    kind: 'scenarios',
    pluginDir,
    status: 'succeeded',
    generationId,
    commitSha: commit.commitSha,
    committed: commit.committed,
  }, prNumber);
}
