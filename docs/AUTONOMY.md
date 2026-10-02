# Autonomy: the local ↔ cloud loop

How a Claude session on your Mac keeps building worlds for hours and gets engine changes made when it needs
them, with you approving what goes into the code.

## The loop

1. **Map work happens locally.** Claude Code runs in the project folder with the Waterways MCP server
   (`php artisan mcp:start waterways`). It builds maps with the MCP tools, in your open editor or in a hidden
   one (`open_editor` / `close_editor`). 3D models come from Blender, run headless (`blender --background`).
2. **When the tools cannot do something**, the local Claude files an engine change: `request_engine_change`
   creates a GitHub issue that mentions `@claude`.
3. **The cloud implements it.** The Claude GitHub Action (`.github/workflows/claude.yml`) reads the issue,
   branches from main, changes the code, runs the checks (CLAUDE.md) and opens a pull request. CI
   (`.github/workflows/ci.yml`) runs the checks again on the PR.
4. **You review and merge** (default). The local Claude never merges.
5. **The local Claude updates**: `engine_change_status` shows the PR merged → `update_engine` (or
   `php artisan waterways:update`) snapshots every map, pulls, installs, migrates, builds and reloads the
   editors. If the MCP server's own code changed, it reconnects the server (`/mcp` in Claude Code).
6. **It continues** the map work with the new feature.

```
 local (your Mac)                                   cloud (GitHub)
 map work ─► needs engine change ─► issue @claude ─► Action: branch, code, checks, PR
     ▲                                                          │
     └── continue ◄── update_engine ◄── merged ◄── you review ◄─┘
```

## File an issue or work around it?

File an issue when **all** hold:

- The result really needs it (not just nicer to have), and no combination of existing tools gets close
  (e.g. shape it with `sculpt_terrain` paths instead of asking for a new landform).
- It is an engine / editor / tool change, not map content. Content is always done locally.
- It is a clear, testable change. Bugs count: a tool that errors or renders wrongly, with steps to reproduce.

Otherwise work around it and note the limitation in your report to the user. Never file the same change
twice: check open issues first (`engine_change_status` without arguments lists open PRs; `gh issue list`).
At most a few open requests at a time; keep working on other parts of the map while one is in progress.

## Writing a good issue

The cloud agent has never seen your map. Give it:

- **Goal:** one or two sentences of what should become possible ("`edit_water` lakes take a `depth`").
- **Context:** what you tried, tool names, arguments and the exact error.
- **Acceptance criteria:** checkable, one per line ("covered by a feature test", "parameter documented in
  docs/MCP.md").
- **References:** map slug, coordinates, screenshot paths (`take_screenshot` saves them).
- **Priority:** `blocking` only when the map work cannot continue.

## Waiting

- Poll `engine_change_status` with the issue number every 5–10 minutes at most (or `gh pr list`,
  `gh pr checks <n>`; the GitHub MCP server works too). Meanwhile work on other things.
- `checks: failing` on the PR: comment on the PR with `@claude` and the failure; the Action fixes it.
- A question from the Action in the issue comments: answer it there (mention `@claude`) or ask the user.
- Merged: run `update_engine` (`check: true` first to see the plan). When it returns `mcp_server_changed`,
  reconnect the MCP server before calling more tools.
- Failed update: it rolled back to the previous commit. Report the error on the PR / a new issue; do not retry
  the same update in a loop.

## Safety rules

- Never merge PRs, push to main, force-push or delete branches. The user merges.
- `update_engine` refuses when the checkout has uncommitted changes; do not pass `force` without asking.
- Every map is snapshotted before an update (`map_snapshots` restores them).
- No secrets in issues: no `.env` contents, API keys or personal paths beyond the project.
- Destructive tools (`regenerate_terrain`, `delete_library_item`, …) still need the user's OK.
- `.claude/settings.json` allows only routine commands (git read / pull, artisan `waterways:*` and `mcp:*`,
  installs, builds, tests, headless Blender, `gh` reads) and denies destructive ones.

## Setup (once)

1. **Claude GitHub App:** install it on the repository (`/install-github-app` in Claude Code does it, or
   <https://github.com/apps/claude>).
2. **Secret:** add `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` for a Claude
   subscription) under Settings → Secrets and variables → Actions.
3. **Actions permissions:** Settings → Actions → General → Workflow permissions: allow GitHub Actions to create
   pull requests.
4. **Branch protection (recommended):** require the `ci` check and a review on main.
5. **Locally:** `brew install gh && gh auth login` so `request_engine_change` can file issues itself (without
   it, it returns the text and a link to open). The checkout must track its upstream (`git branch -u origin/main`).
