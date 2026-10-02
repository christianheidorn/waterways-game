<?php

namespace App\Support\Updates;

use App\Mcp\ToolError;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Str;

/**
 * Engine / editor change requests for the cloud (docs/AUTONOMY.md): drafts a GitHub issue that
 * mentions @claude (the Claude GitHub Action picks it up, works on a branch and opens a PR) and
 * reports the state of such issues and their PRs. Uses the `gh` CLI when it is installed and logged in;
 * without it, request() returns the text and a prefilled "new issue" URL to open by hand.
 *
 * Commands run through the Process facade (tests fake them).
 */
class EngineChanges
{
    /**
     * @param  array{goal: string, context?: string|null, acceptance?: list<string>, references?: list<string>, priority?: string|null, title?: string|null}  $request
     * @return array<string, mixed>
     */
    public function request(array $request, bool $create = true): array
    {
        $title = trim((string) ($request['title'] ?? '')) ?: 'Engine change: '.Str::limit(trim($request['goal']), 70);
        $body = $this->body($request);
        $repo = $this->repository();

        if ($create && $this->ghReady()) {
            $result = $this->run('gh issue create --title '.escapeshellarg($title).' --body-file -', $body);

            if ($result['ok']) {
                $url = trim(collect(explode("\n", $result['output']))->last(fn ($l) => str_starts_with(trim($l), 'http')) ?? $result['output']);

                return [
                    'status' => 'created',
                    'issue' => $url,
                    'number' => (int) Str::afterLast($url, '/'),
                    'title' => $title,
                    'next' => 'The Claude GitHub Action now works on it and opens a PR. Poll engine_change_status with this issue number (every few minutes). After the PR is merged, run update_engine.',
                ];
            }

            $error = $result['output'];
        }

        return [
            'status' => 'draft',
            'title' => $title,
            'body' => $body,
            'open_url' => $repo === null ? null : "https://github.com/{$repo}/issues/new?".http_build_query(['title' => $title, 'body' => $body], '', '&', PHP_QUERY_RFC3986),
            'reason' => isset($error) ? "gh issue create failed: {$error}" : ($create ? 'The gh CLI is not installed or not logged in (gh auth login), so the issue was not created.' : 'Draft only (create: false).'),
            'next' => 'Show the user the draft; they (or you, once gh is set up) file it. It must mention @claude for the GitHub Action to pick it up.',
        ];
    }

    /**
     * State of an issue and the PRs that belong to it, or (without a number) the open @claude work.
     *
     * @return array<string, mixed>
     */
    public function status(?int $issue = null, ?int $pr = null): array
    {
        if (! $this->ghReady()) {
            $repo = $this->repository();

            throw new ToolError('The gh CLI is not installed or not logged in (run `gh auth login`), so the status cannot be read here.'
                .($repo !== null ? " Look at https://github.com/{$repo}/".($pr ? "pull/{$pr}" : ($issue ? "issues/{$issue}" : 'pulls')).' instead.' : ''));
        }

        $prFields = 'number,title,state,url,isDraft,mergedAt,headRefName,reviewDecision,statusCheckRollup';

        if ($pr !== null) {
            return ['pull_request' => $this->summarizePr($this->json("gh pr view {$pr} --json {$prFields}"))];
        }

        if ($issue !== null) {
            $data = $this->json("gh issue view {$issue} --json number,title,state,url,comments");
            // The action names its branches claude/issue-<n>-…; PRs it opens reference the issue.
            $all = collect($this->json("gh pr list --state all --limit 40 --json {$prFields},body"))
                ->filter(fn (array $p) => str_starts_with((string) ($p['headRefName'] ?? ''), "claude/issue-{$issue}-")
                    || ($p['headRefName'] ?? '') === "claude/issue-{$issue}"
                    || preg_match('/#'.$issue.'\b/', (string) ($p['body'] ?? '')) === 1)
                ->values();
            $last = collect($data['comments'] ?? [])->last();

            return [
                'issue' => [
                    'number' => $data['number'] ?? $issue,
                    'title' => $data['title'] ?? null,
                    'state' => $data['state'] ?? null,
                    'url' => $data['url'] ?? null,
                    'comments' => count($data['comments'] ?? []),
                    'last_comment' => $last === null ? null : [
                        'author' => $last['author']['login'] ?? null,
                        'excerpt' => Str::limit((string) ($last['body'] ?? ''), 600),
                    ],
                ],
                'pull_requests' => $all->map(fn (array $p) => $this->summarizePr($p))->all(),
                'next' => $this->next($all->all()),
            ];
        }

        $open = $this->json("gh pr list --state open --limit 20 --json {$prFields}");

        return ['open_pull_requests' => collect($open)->map(fn (array $p) => $this->summarizePr($p))->values()->all()];
    }

    /**
     * @param  array<string, mixed>  $request
     */
    public function body(array $request): string
    {
        $list = fn (array $items) => implode("\n", array_map(fn ($i) => '- '.trim((string) $i), $items));
        $sections = [
            '## Goal'."\n".trim($request['goal']),
            '## Context'."\n".(trim((string) ($request['context'] ?? '')) ?: '_None given._'),
            '## Acceptance criteria'."\n".(($request['acceptance'] ?? []) !== [] ? $list($request['acceptance']) : '- The goal above works in the editor and in play mode.'),
        ];

        if (($request['references'] ?? []) !== []) {
            $sections[] = '## Maps and screenshots'."\n".$list($request['references']);
        }

        $sections[] = '## Priority'."\n".(trim((string) ($request['priority'] ?? '')) ?: 'normal');
        $sections[] = "---\n@claude please implement this. Branch from main, follow CLAUDE.md (keep MCP tools in parity with the UI, add tests, update docs/MCP.md), run the checks listed there and open a pull request that closes this issue.\n\n_Filed by the local Waterways agent (request_engine_change)._";

        return implode("\n\n", $sections);
    }

    /** owner/repo of the origin remote, or null. */
    public function repository(): ?string
    {
        $url = trim($this->run('git remote get-url origin')['output']);

        if (preg_match('~github\.com[:/]([^/\s]+/[^/\s]+?)(?:\.git)?/?$~', $url, $m) === 1) {
            return $m[1];
        }

        return null;
    }

    public function ghReady(): bool
    {
        return $this->run('gh auth status')['ok'];
    }

    /**
     * @param  list<array<string, mixed>>  $prs
     */
    private function next(array $prs): string
    {
        $merged = collect($prs)->first(fn ($p) => ! empty($p['mergedAt']));

        if ($merged !== null) {
            return "PR #{$merged['number']} is merged: run update_engine, then continue the map work.";
        }

        if (collect($prs)->contains(fn ($p) => ($p['state'] ?? '') === 'OPEN')) {
            return 'A PR is open and waits for checks / the user\'s review. Poll again in a few minutes; keep working on other things meanwhile.';
        }

        return 'No PR yet: the action is still working (or it asked a question in the issue comments). Poll again in a few minutes.';
    }

    /**
     * @param  array<string, mixed>  $pr
     * @return array<string, mixed>
     */
    private function summarizePr(array $pr): array
    {
        $checks = collect($pr['statusCheckRollup'] ?? []);
        $states = $checks->map(fn ($c) => strtoupper((string) ($c['conclusion'] ?? $c['state'] ?? $c['status'] ?? '')));

        return [
            'number' => $pr['number'] ?? null,
            'title' => $pr['title'] ?? null,
            'state' => ! empty($pr['mergedAt']) ? 'MERGED' : ($pr['state'] ?? null),
            'draft' => $pr['isDraft'] ?? false,
            'branch' => $pr['headRefName'] ?? null,
            'review' => $pr['reviewDecision'] ?? null,
            'checks' => $checks->isEmpty() ? 'none' : ($states->contains(fn ($s) => in_array($s, ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'], true))
                ? 'failing'
                : ($states->every(fn ($s) => in_array($s, ['SUCCESS', 'NEUTRAL', 'SKIPPED'], true)) ? 'passing' : 'pending')),
            'url' => $pr['url'] ?? null,
        ];
    }

    /** @return array<mixed> */
    private function json(string $command): array
    {
        $result = $this->run($command);

        if (! $result['ok']) {
            throw new ToolError("`{$command}` failed: ".Str::limit($result['output'], 1000));
        }

        $data = json_decode($result['output'], true);

        return is_array($data) ? $data : [];
    }

    /** @return array{ok: bool, output: string} */
    private function run(string $command, ?string $input = null): array
    {
        $pending = Process::path(base_path())->timeout(60);

        if ($input !== null) {
            $pending = $pending->input($input);
        }

        $result = $pending->run($command);

        return ['ok' => $result->successful(), 'output' => trim($result->output() ?: $result->errorOutput())];
    }
}
