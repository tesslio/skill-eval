# Tessl Skill Review & Eval Action

A GitHub Action that automatically reviews `SKILL.md` files changed in a pull request and posts the results as a PR comment. Optionally runs evals against tiles with eval scenarios to measure real agent performance.

**Skill review requires no authentication.** It runs `tessl skill review` locally -- no Tessl account or API token needed. The only token used is the GitHub-provided `GITHUB_TOKEN` for posting PR comments.

**Evals are opt-in** and require a `TESSL_API_KEY` to run `tessl eval run` against your workspace.

## Usage

Add this workflow to your repository at `.github/workflows/skill-review.yml`:

```yaml
name: Tessl Skill Review
on:
  pull_request:
    paths: ['**/SKILL.md']

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: tesslio/skill-eval@main
```

That's it. Any PR that modifies a `SKILL.md` file will get an automated review comment.

## Inputs

| Input | Description | Default |
|---|---|---|
| `path` | Root path to search for SKILL.md files | `.` |
| `comment` | Whether to post results as a PR comment | `true` |
| `fail-threshold` | Minimum score (0-100) to pass. Set to `0` to never fail. | `0` |

### Setting a quality gate

To enforce a minimum skill quality score, set `fail-threshold`:

```yaml
- uses: tesslio/skill-eval@main
  with:
    fail-threshold: 70
```

PRs with any skill scoring below 70% will fail the check.

## How it works

1. Detects which `SKILL.md` files were changed in the PR
2. Installs the [Tessl CLI](https://tessl.io)
3. Runs `tessl skill review` on each changed skill
4. Posts (or updates) a review comment on the PR with scores and detailed feedback
5. Optionally fails the check if any score is below the threshold

## Comment behavior

The action posts a single comment per PR. On subsequent pushes, it updates the existing comment rather than creating a new one.

## Eval (opt-in)

The eval feature runs `tessl eval run` against tiles that contain eval scenarios, polls for async results, and posts a separate PR comment with detailed scoring. This lets you measure real agent performance against your skills as part of your CI pipeline.

### Eval inputs

| Input | Description | Default |
|---|---|---|
| `eval` | Enable eval runs against tiles with scenarios (requires `TESSL_API_KEY`) | `false` |
| `eval-workspace` | Tessl workspace name for eval runs | (required when `eval` is `true`) |
| `eval-agent` | Agent:model pair for evals | `claude:claude-sonnet-4-6` |
| `eval-timeout` | Max minutes to wait for each eval run to complete | `45` |
| `eval-fail-threshold` | Minimum eval score (0-100) to pass. Set to `0` to never fail. | `0` |
| `tessl-api-key` | Tessl API key. Pass via secrets. | (required when `eval` is `true`) |

### Usage with evals

```yaml
name: Tessl Skill Review + Eval
on:
  pull_request:
    paths: ['**/SKILL.md', '**/evals/**']

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: tesslio/skill-eval@main
        with:
          fail-threshold: 70
          eval: true
          eval-workspace: my-workspace
          eval-agent: claude:claude-sonnet-4-6
          eval-timeout: 45
          eval-fail-threshold: 60
          tessl-api-key: ${{ secrets.TESSL_API_KEY }}
```

### How eval detection works

When evals are enabled, the action walks up from each changed `SKILL.md` file to find the parent tile directory (a directory containing `tile.json`). If that tile directory also contains an `evals/` subdirectory with scenario files, the tile is included in the eval run. Tiles without an `evals/` directory are skipped.

### Async polling

Eval runs are asynchronous. After triggering `tessl eval run`, the action polls the Tessl API every 30 seconds until the run completes or the timeout is reached. The default timeout is 45 minutes per tile, configurable via `eval-timeout`.

### Setting up the TESSL_API_KEY secret

Evals require a Tessl API key. To add it as a GitHub repository secret:

1. Go to your repository on GitHub
2. Navigate to **Settings** > **Secrets and variables** > **Actions**
3. Click **New repository secret**
4. Set the name to `TESSL_API_KEY` and paste your API key as the value
5. Click **Add secret**

Then reference it in your workflow as `${{ secrets.TESSL_API_KEY }}`.

## Local development

```bash
bun install
bun run lint
```

## License

MIT
