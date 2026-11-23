#!/usr/bin/env bash
# The steps of action.yml. Every input arrives as an environment variable (BMR_*), never
# interpolated into the script, so input text can't become shell code.
# Usage: steps.sh build|check|guard|install|init|run|readme
set -euo pipefail

ACTION_DIR="${GITHUB_ACTION_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BMR=(node "$ACTION_DIR/bin/benchmyrepo.js")
ACT=(node "$ACTION_DIR/dist/src/action.js")

out() { if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"; else printf '%s=%s\n' "$1" "$2"; fi; }

# The repo being benchmarked: the top of the git checkout that holds the working directory.
to_repo() {
  cd "${BMR_WORKING_DIRECTORY:-.}"
  cd "$(git rev-parse --show-toplevel)"
}

step="${1:?step name}"
case "$step" in
  build)
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "$major" -lt 20 ]; then
      echo "::error::benchmyrepo needs Node 20 or newer (found $(node --version)). Add actions/setup-node before this step."
      exit 1
    fi
    if [ ! -f "$ACTION_DIR/dist/src/cli.js" ]; then
      (cd "$ACTION_DIR" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && npm run --silent build)
    fi
    ;;

  check)
    to_repo
    "${ACT[@]}" check --agents "$BMR_AGENTS" --state "$BMR_STATE_FILE"
    ;;

  guard)
    "${ACT[@]}" guard --agents "$BMR_AGENTS" --tasks "$BMR_TASKS" --max-attempts "$BMR_MAX_ATTEMPTS"
    ;;

  install)
    specs="$("${ACT[@]}" install --agents "$BMR_AGENTS" --versions "${BMR_AGENT_VERSIONS:-}")"
    if [ -n "$specs" ]; then
      prefix="${RUNNER_TEMP:?}/benchmyrepo-agents"
      echo "Installing $specs"
      # shellcheck disable=SC2086 # specs is a space-separated list of name@version
      npm install --prefix "$prefix" --no-save --no-audit --no-fund --loglevel=error $specs
      echo "$prefix/node_modules/.bin" >>"${GITHUB_PATH:?}"
    fi
    ;;

  init)
    to_repo
    args=(init --tasks "$BMR_TASKS" --scan "$BMR_SCAN")
    [ -n "${BMR_SINCE:-}" ] && args+=(--since "$BMR_SINCE")
    [ -n "${BMR_SOURCE:-}" ] && args+=(--source "$BMR_SOURCE")
    [ -n "${BMR_TEST_CMD:-}" ] && args+=(--test-cmd "$BMR_TEST_CMD")
    "${BMR[@]}" "${args[@]}"
    ;;

  run)
    to_repo
    # An empty input arrives as an empty variable; don't let it shadow a sign-in.
    for v in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CODEX_API_KEY GEMINI_API_KEY; do
      if [ -z "${!v:-}" ]; then unset "$v"; fi
    done
    latest_run() { find .benchmyrepo/runs -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null | sort | tail -n 1; }
    before="$(latest_run || true)"
    # Never --yolo: in CI the agents edit files only.
    "${BMR[@]}" run --agents "$BMR_AGENTS" --tasks "$BMR_TASKS" --concurrency "$BMR_CONCURRENCY" --timeout "$BMR_TIMEOUT"
    run_id="$(latest_run)"
    if [ -z "$run_id" ] || [ "$run_id" = "$before" ]; then
      echo "::error::benchmyrepo run finished without a new run directory"
      exit 1
    fi
    run_dir="$PWD/.benchmyrepo/runs/$run_id"
    "${ACT[@]}" verify --run-dir "$run_dir"
    out run-id "$run_id"
    out run-dir "$run_dir"
    ;;

  readme)
    # run-dir is relative to where the step starts (the workspace), like other actions' paths.
    run_dir="$(cd "${BMR_RUN_DIR:?run-dir is required in readme mode}" && pwd)"
    to_repo
    "${BMR[@]}" readme --run-dir "$run_dir" --file "$BMR_README" --card "$BMR_CARD"
    if [ -n "${BMR_AGENT_VERSIONS:-}" ]; then
      "${ACT[@]}" save --versions "$BMR_AGENT_VERSIONS" --state "$BMR_STATE_FILE"
    fi
    paths=("$BMR_README" "$BMR_CARD")
    [ -f "$BMR_STATE_FILE" ] && paths+=("$BMR_STATE_FILE")
    if [ -z "$(git status --porcelain -- "${paths[@]}")" ]; then
      echo "Leaderboard unchanged; nothing to commit."
      out changed false
      exit 0
    fi
    out changed true
    if [ "${BMR_COMMIT:-false}" != "true" ]; then
      git --no-pager diff --stat -- "${paths[@]}" || true
      exit 0
    fi
    branch="${BMR_BRANCH:?branch}"
    # The runner has no git identity; the rebase below needs one too.
    export GIT_AUTHOR_NAME="github-actions[bot]" GIT_COMMITTER_NAME="github-actions[bot]"
    export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com" GIT_COMMITTER_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
    git add -- "${paths[@]}"
    git commit --quiet -m "Update benchmyrepo leaderboard [skip ci]" -- "${paths[@]}"
    # Never force. If the branch moved while the benchmark ran, replay once on top of it.
    if ! git push --quiet origin "HEAD:refs/heads/$branch"; then
      git pull --quiet --rebase origin "$branch"
      git push --quiet origin "HEAD:refs/heads/$branch"
    fi
    out commit "$(git rev-parse HEAD)"
    ;;

  *)
    echo "unknown step: $step" >&2
    exit 2
    ;;
esac
