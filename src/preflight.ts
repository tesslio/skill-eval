import * as core from '@actions/core';
import * as github from '@actions/github';
import { parseTesslCommentCommand, isTrustedAuthorAssociation } from './comment-command.ts';
import { getPayloadLabels, getPullRequestNumber } from './github-context.ts';

export function shouldRunPreflight(): boolean {
  const enabled = process.env.INPUT_ENABLED !== 'false';
  if (!enabled) {
    console.log('Eval is disabled (enabled: false). Skipping.');
    return false;
  }

  const skipLabel = process.env.INPUT_SKIP_LABEL || 'skip-eval';
  if (skipLabel && getPayloadLabels().some((label) => label.name === skipLabel)) {
    console.log(`Eval skipped — PR has "${skipLabel}" label.`);
    return false;
  }

  if (github.context.eventName !== 'issue_comment') {
    return true;
  }

  const command = parseTesslCommentCommand(github.context.payload.comment?.body as string | undefined);
  if (!command) {
    console.log('No /tessl eval or /tessl scenarios command found. Skipping.');
    return false;
  }

  if (getPullRequestNumber() === null) {
    core.setFailed('Comment commands only work on pull requests.');
    return false;
  }

  const association = github.context.payload.comment?.author_association as string | undefined;
  if (!isTrustedAuthorAssociation(association)) {
    core.setFailed(
      `Comment command is restricted to repo collaborators (got author_association ${association ?? 'NONE'}).`,
    );
    return false;
  }

  return true;
}

export async function acknowledgeCommentCommand(): Promise<void> {
  if (github.context.eventName !== 'issue_comment') {
    return;
  }

  const comment = github.context.payload.comment as { id?: unknown; body?: unknown } | undefined;
  const command = parseTesslCommentCommand(typeof comment?.body === 'string' ? comment.body : undefined);
  if (!command) {
    return;
  }

  if (typeof comment?.id !== 'number') {
    core.warning('Could not add eyes reaction: issue comment id was missing.');
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    core.warning('Could not add eyes reaction: GITHUB_TOKEN is missing.');
    return;
  }

  try {
    const octokit = github.getOctokit(token);
    await octokit.rest.reactions.createForIssueComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      comment_id: comment.id,
      content: 'eyes',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`Could not add eyes reaction to Tessl command comment: ${msg}`);
  }
}

if (import.meta.main) {
  const shouldRun = shouldRunPreflight();
  core.setOutput('should-run', shouldRun ? 'true' : 'false');
  if (shouldRun) {
    await acknowledgeCommentCommand();
  }
}
