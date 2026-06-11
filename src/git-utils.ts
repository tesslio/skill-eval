import * as github from '@actions/github';
import type { PullRequestHead } from './github-context.ts';

export interface CommitGeneratedScenariosResult {
  commitSha: string;
  committed: boolean;
}

async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderr || stdout}`);
  }
  return stdout.trim();
}

export async function commitGeneratedScenarios(
  evalsDirs: string[],
  prHead: PullRequestHead,
): Promise<CommitGeneratedScenariosResult> {
  const baseRepo = `${github.context.repo.owner}/${github.context.repo.repo}`;
  if (prHead.repoFullName !== baseRepo) {
    throw new Error(
      `Cannot push generated scenarios to fork PR head ${prHead.repoFullName}:${prHead.ref}. ` +
      'Commit the generated scenarios manually or run the command from a same-repo branch.',
    );
  }

  await git('config', 'user.name', 'github-actions[bot]');
  await git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  await git('add', ...evalsDirs);

  try {
    await git('commit', '-m', 'chore: add generated eval scenarios');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('nothing to commit')) {
      return {
        commitSha: await git('rev-parse', '--short', 'HEAD'),
        committed: false,
      };
    }
    throw err;
  }

  await git('push', 'origin', `HEAD:${prHead.ref}`);
  return {
    commitSha: await git('rev-parse', '--short', 'HEAD'),
    committed: true,
  };
}
