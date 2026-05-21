import * as github from '@actions/github';

/**
 * Resolves the PR number from, in order of precedence:
 * 1. INPUT_PR_NUMBER env var — required for issue_comment events; pass via the pr-number action input.
 * 2. pull_request payload — available on pull_request events.
 * 3. issue payload — available on issue_comment events (GitHub uses the same number for PRs and issues).
 */
export function resolvePrNumber(): number {
  const inputPr = process.env.INPUT_PR_NUMBER?.trim();
  if (inputPr) {
    const n = parseInt(inputPr, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const { context } = github;

  if (context.payload.pull_request?.number) {
    return context.payload.pull_request.number as number;
  }

  if (context.eventName === 'issue_comment' && context.payload.issue?.number) {
    return context.payload.issue.number as number;
  }

  throw new Error(
    'Could not determine PR number. ' +
      'On issue_comment events, pass the PR number via the pr-number input.',
  );
}

/**
 * Builds the HTML comment marker used to identify and update the eval comment.
 * The marker is scoped to the eval agent so that multiple agents running in a
 * matrix each own a distinct comment and don't overwrite each other.
 *
 * Examples:
 *   agent "claude:claude-haiku-4-5" → <!-- tessl-skill-eval:claude:claude-haiku-4-5 -->
 *   agent "codex:gpt-5.4-mini"      → <!-- tessl-skill-eval:codex:gpt-5.4-mini -->
 */
export function buildCommentMarker(): string {
  const agent = process.env.INPUT_EVAL_AGENT?.trim();
  return agent ? `<!-- tessl-skill-eval:${agent} -->` : '<!-- tessl-skill-eval -->';
}
