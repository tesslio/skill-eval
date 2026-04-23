import * as github from '@actions/github';
import type { EvalResult } from './eval-types.ts';

const EVAL_COMMENT_MARKER = '<!-- tessl-skill-eval -->';

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>~]/g, '\\$&');
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

export function formatEvalComment(results: EvalResult[], threshold: number): string {
  const sections = results.map((result) => {
    const displayPath = result.tilePath.replace(/^\.\//, '');

    if (result.error) {
      return `### \`${displayPath}\`\n\n> ⚠️ **Error:** ${escapeMarkdown(result.error)}\n`;
    }

    const passEmoji =
      threshold > 0 ? (result.overallScore >= threshold ? ' ✅' : ' ❌') : '';
    const badge = result.overallScore >= 0 ? ` ${evalScoreBadge(result.overallScore)}${passEmoji}` : '';

    let body = `### \`${displayPath}\`\n${badge}\n`;

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
            body += `| ${c.name} | ${c.score}/${c.maxScore} | ${c.reasoning} |\n`;
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

export async function postOrUpdateEvalComment(
  results: EvalResult[],
  threshold: number,
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to post eval comments');
  }

  const context = github.context;
  if (!context.payload.pull_request) {
    throw new Error('No pull request context found');
  }

  const octokit = github.getOctokit(token);
  const prNumber = context.payload.pull_request.number;
  const body = formatEvalComment(results, threshold);

  let existing: { id: number; body?: string | null } | undefined;
  let commentPage = 1;

  while (!existing) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
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
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existing.id,
      body,
    });
    console.log(`Updated existing eval comment (id: ${existing.id})`);
  } else {
    await octokit.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
      body,
    });
    console.log('Posted new eval comment');
  }
}
