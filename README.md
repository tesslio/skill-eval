# Tessl Skill Eval Action

A GitHub Action that runs Tessl evals against tiles when `SKILL.md` files change in a pull request, and posts the results as a PR comment with per-scenario scoring.

Requires a `TESSL_TOKEN` to authenticate with the Tessl API. The GitHub-provided `GITHUB_TOKEN` is used for posting PR comments.

## Usage

Add this workflow to your repository at `.github/workflows/skill-eval.yml`:

```yaml
name: Tessl Skill Eval
on:
  pull_request:
    paths: ['**/SKILL.md', '**/evals/**']

jobs:
  eval:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: tesslio/skill-eval@main
        with:
          tessl-token: ${{ secrets.TESSL_TOKEN }}
```

Any PR that modifies a `SKILL.md` file in a tile with eval scenarios will trigger an eval run and post results as a PR comment.

## Inputs

| Input | Description | Default |
|---|---|---|
| `path` | Root path to search for SKILL.md files | `.` |
| `comment` | Whether to post results as a PR comment | `true` |
| `eval-workspace` | Tessl workspace name. Optional when tiles set workspace in `tile.json`. | `''` |
| `eval-agent` | Agent:model pair for evals | `claude:claude-sonnet-4-6` |
| `eval-timeout` | Max minutes to wait for each eval run to complete | `45` |
| `eval-fail-on-regression` | Fail the check if any scenario scores worse with context than baseline | `true` |
| `eval-generate-scenarios` | Generate fresh scenarios for tiles without `evals/` | `false` |
| `eval-scenario-count` | Number of scenarios to generate per tile | `3` |
| `tessl-token` | Tessl API token. Pass via secrets. | **(required)** |

## How it works

1. Detects which `SKILL.md` files were changed in the PR
2. Installs the [Tessl CLI](https://tessl.io) and authenticates with your token
3. Finds parent tile directories (containing `tile.json`) with eval scenarios
4. Runs `tessl eval run` for each tile and polls for results
5. Posts (or updates) an eval comment on the PR with per-scenario scores

## Comment behavior

The action posts a single eval comment per PR. On subsequent pushes, it updates the existing comment rather than creating a new one.

### Generating scenarios on-the-fly

Instead of relying on pre-existing scenarios in `evals/`, you can generate fresh scenarios from your tile before running evals:

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

This is useful for tiles that don't have checked-in scenarios, or when you want to evaluate against fresh scenarios generated from the current tile state.

### How eval detection works

When evals are enabled, the action walks up from each changed `SKILL.md` file to find the parent tile directory (a directory containing `tile.json`). The search checks up to **5 parent directories** — if your `SKILL.md` is nested deeper than that relative to `tile.json`, the tile won't be detected (a warning is logged). If that tile directory also contains an `evals/` subdirectory with scenario files, the tile is included in the eval run. Tiles without an `evals/` directory are skipped.

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
