# Tessl Skill Eval Action

A GitHub Action that generates reviewable Tessl scenarios and runs skill evals from pull requests.

Use it to:

- Comment `/tessl scenarios path/to/skill` to generate editable scenarios.
- Review or edit the generated `evals/` files directly in the PR.
- Comment `/tessl eval path/to/skill` to run evals against the current PR head.

Requires a `TESSL_TOKEN` to authenticate with the Tessl API. The GitHub-provided `GITHUB_TOKEN` is used for PR comments and, when allowed, committing generated scenarios back to the PR branch.

## Usage

Add this workflow to your repository at `.github/workflows/skill-eval.yml`:

```yaml
name: Tessl Skill Eval

on:
  pull_request:
    paths:
      - "**/SKILL.md"
      - "**/evals/**"
  issue_comment:
    types: [created]

jobs:
  eval:
    if: github.event_name == 'pull_request' || github.event.issue.pull_request
    runs-on: ubuntu-latest
    timeout-minutes: 120
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event_name == 'issue_comment' && format('refs/pull/{0}/head', github.event.issue.number) || github.ref }}
          fetch-depth: 0

      - uses: tesslio/skill-eval@main
        with:
          tessl-token: ${{ secrets.TESSL_TOKEN }}
```

Any PR that modifies `SKILL.md` or `evals/**` files in a tile with scenarios will trigger an eval run and post results as a PR comment.

PR comments also support:

- `/tessl scenarios path/to/skill` generates scenarios, commits them under `evals/`, and posts a short follow-up comment.
- `/tessl eval path/to/skill` runs evals against the current PR head and posts or updates the eval result comment.
- `<path>` can point to a tile/plugin directory, skill directory, `SKILL.md`, or a file under `evals/`.

Comment commands only run for trusted repo participants: `OWNER`, `MEMBER`, or `COLLABORATOR`.

To pin the Tessl CLI version used for eval runs, add `cli-version`:

```yaml
- uses: tesslio/skill-eval@main
  with:
    cli-version: 0.73.0
    tessl-token: ${{ secrets.TESSL_TOKEN }}
```

Omit `cli-version` to keep using the latest Tessl CLI. Set it to a specific version when you need reproducible runs or a short rollout delay for new CLI releases.

## Inputs

| Input | Description | Default |
|---|---|---|
| `enabled` | Enable eval runs. Set to `false` to disable entirely. | `true` |
| `skip-label` | PR label that skips eval even when enabled. Set empty to disable. | `skip-eval` |
| `path` | Root path to search for SKILL.md files | `.` |
| `comment` | Whether to post results as a PR comment | `true` |
| `cli-version` | Tessl CLI version to install, for example `0.73.0` or `latest` | `latest` |
| `eval-workspace` | Tessl workspace name. Optional when tiles set workspace in `tile.json`. | `''` |
| `eval-agent` | Agent:model pair for evals | `claude:claude-sonnet-4-6` |
| `eval-timeout` | Max minutes to wait for each eval run to complete | `45` |
| `eval-fail-on-regression` | Fail the check if any scenario scores worse with context than baseline | `true` |
| `eval-generate-scenarios` | Generate fresh scenarios for tiles without `evals/` | `false` |
| `eval-scenario-count` | Number of scenarios to generate per tile | `3` |
| `eval-commit-scenarios` | Commit generated scenarios back to the PR branch (requires `contents: write`) | `false` |
| `tessl-token` | Tessl API token. Pass via secrets. | **(required)** |

## How it works

1. Detects changed `SKILL.md` or `evals/**` files in the PR
2. Installs the [Tessl CLI](https://tessl.io) and authenticates with your token
3. Finds parent plugin/tile directories containing `.tessl-plugin/plugin.json` or `tile.json`
4. Runs `tessl eval run` for each tile and polls for results
5. Posts (or updates) an eval comment on the PR with per-scenario scores

## Skipping evals

Evals run by default. Two ways to skip them:

**Disable in workflow YAML** (all PRs):
```yaml
- uses: tesslio/skill-eval@main
  with:
    enabled: false
```

**Skip per-PR with a label:** add the `skip-eval` label to any PR. To use a custom label name:
```yaml
- uses: tesslio/skill-eval@main
  with:
    skip-label: no-eval
```

Set `skip-label: ''` to disable the label check entirely.

## Comment behavior

The action posts a single eval comment per PR. On subsequent pushes, it updates the existing comment rather than creating a new one.

### Generating scenarios

The recommended PR loop is comment-driven:

1. Comment `/tessl scenarios path/to/skill`.
2. Review or edit the generated `evals/` files in the PR.
3. Comment `/tessl eval path/to/skill`.

Generated scenarios are committed as real PR files so reviewers can use normal GitHub review, suggestions, and diffs.

You can also generate scenarios automatically during pull request runs:

```yaml
- uses: tesslio/skill-eval@main
  with:
    eval-workspace: my-workspace
    eval-generate-scenarios: true
    eval-scenario-count: 3
    tessl-token: ${{ secrets.TESSL_TOKEN }}
```

When `eval-generate-scenarios` is enabled, the action will:

1. Find all tile directories (not just those with existing `evals/`)
2. Run `tessl scenario generate` to create fresh scenarios for each tile
3. Download the generated scenarios to the tile's `evals/` directory
4. Run evals against the newly generated scenarios

Set `eval-commit-scenarios: true` to commit those generated files back to same-repo PR branches. Fork PRs may not allow scenario commits; in that case the action warns clearly instead of hiding the permission problem.

### How eval detection works

When evals are enabled, the action walks up from each changed `SKILL.md` or `evals/**` file to find the parent plugin or tile directory. A root contains `.tessl-plugin/plugin.json` or `tile.json`. The search checks up to **5 parent directories**. If that root has an `evals/` directory, it is included in the eval run. Roots without `evals/` are skipped unless scenario generation is enabled.

### Timeouts and long-running jobs

Scenario generation and eval execution each apply the `eval-timeout` independently. With `eval-generate-scenarios` enabled, the total wall time can be up to **2x** the timeout value — for example, with the default 45 minutes, generation could take up to 45 minutes and eval execution another 45 minutes, for a possible total of ~90 minutes per tile.

Scenario generation polls every 15 seconds; eval execution polls every 30 seconds. Plan your GitHub Actions [job timeout](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idtimeout-minutes) accordingly:

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 120  # allow headroom for generation + eval
```

For tiles with pre-existing scenarios (no generation), the total time is just the eval timeout.

### Setting up the TESSL_TOKEN secret

Evals require a Tessl API key. To add it as a GitHub repository secret:

1. Go to your repository on GitHub
2. Navigate to **Settings** > **Secrets and variables** > **Actions**
3. Click **New repository secret**
4. Set the name to `TESSL_TOKEN` and paste your API key as the value
5. Click **Add secret**

Then reference it in your workflow as `${{ secrets.TESSL_TOKEN }}`.

## Local development

```bash
bun install
bun run lint
```

## License

MIT
