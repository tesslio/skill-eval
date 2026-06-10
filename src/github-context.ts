import * as github from '@actions/github';

type Octokit = ReturnType<typeof github.getOctokit>;
type PayloadLabel = string | { name?: unknown };

export interface PullRequestHead {
  ref: string;
  repoFullName: string;
}

export function getPullRequestNumber(): number | null {
  const payload = github.context.payload;
  const pullNumber = payload.pull_request?.number;
  if (typeof pullNumber === 'number') return pullNumber;

  const issueNumber = payload.issue?.number;
  if (typeof issueNumber === 'number' && payload.issue?.pull_request) {
    return issueNumber;
  }

  return null;
}

export function getPayloadLabels(): Array<{ name: string }> {
  const labels = (github.context.payload.pull_request?.labels ??
    github.context.payload.issue?.labels ??
    []) as PayloadLabel[];

  return labels
    .map((label) => {
      if (typeof label === 'string') return { name: label };
      return typeof label.name === 'string' ? { name: label.name } : null;
    })
    .filter((label): label is { name: string } => label !== null);
}

export async function getPullRequestHead(
  octokit: Octokit,
  prNumber: number,
): Promise<PullRequestHead> {
  const payloadPr = github.context.payload.pull_request;
  const payloadHead = payloadPr?.head;
  const payloadRepo = payloadHead?.repo;

  if (
    typeof payloadHead?.ref === 'string' &&
    typeof payloadRepo?.full_name === 'string'
  ) {
    return {
      ref: payloadHead.ref,
      repoFullName: payloadRepo.full_name,
    };
  }

  const { data } = await octokit.rest.pulls.get({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber,
  });

  if (!data.head.repo?.full_name) {
    throw new Error(`Pull request #${prNumber} has no head repository`);
  }

  return {
    ref: data.head.ref,
    repoFullName: data.head.repo.full_name,
  };
}
