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

if (import.meta.main) {
  core.setOutput('should-run', shouldRunPreflight() ? 'true' : 'false');
}
