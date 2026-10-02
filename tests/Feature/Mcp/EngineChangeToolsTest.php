<?php

namespace Tests\Feature\Mcp;

use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\EngineChangeStatus;
use App\Mcp\Tools\RequestEngineChange;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Process\PendingProcess;
use Illuminate\Support\Facades\Process;
use Tests\TestCase;

class EngineChangeToolsTest extends TestCase
{
    use RefreshDatabase;

    /** @param array<string, mixed> $extra */
    private function fakeGh(bool $loggedIn, array $extra = []): void
    {
        Process::preventStrayProcesses();
        Process::fake([
            ...$extra,
            'git remote get-url origin' => Process::result("git@github.com:acme/waterways.git\n"),
            'gh auth status' => $loggedIn ? Process::result('Logged in') : Process::result(errorOutput: 'not logged in', exitCode: 1),
        ]);
    }

    public function test_it_creates_an_issue_mentioning_claude_with_gh(): void
    {
        $this->fakeGh(true, ['gh issue create*' => Process::result("Creating issue\nhttps://github.com/acme/waterways/issues/42\n")]);

        WaterwaysServer::tool(RequestEngineChange::class, [
            'goal' => 'edit_water should accept a depth for lakes',
            'context' => 'Lakes come out too shallow; tried flooding twice.',
            'acceptance' => ['edit_water lake accepts `depth` (m)', 'tests cover it'],
            'references' => ['map alpine-lake at (120, -40)'],
            'priority' => 'high',
        ])->assertOk()->assertSee(['"created"', 'issues/42', '"number": 42']);

        Process::assertRan(function (PendingProcess $p) {
            return str_starts_with((string) $p->command, 'gh issue create --title ')
                && str_contains((string) $p->input, '@claude')
                && str_contains((string) $p->input, '## Acceptance criteria')
                && str_contains((string) $p->input, '- edit_water lake accepts `depth` (m)')
                && str_contains((string) $p->input, 'map alpine-lake at (120, -40)')
                && str_contains((string) $p->input, "## Priority\nhigh");
        });
    }

    public function test_without_gh_it_returns_the_draft_and_a_new_issue_url(): void
    {
        $this->fakeGh(false);

        WaterwaysServer::tool(RequestEngineChange::class, ['goal' => 'Roads should support bridges'])
            ->assertOk()
            ->assertSee(['"draft"', 'https://github.com/acme/waterways/issues/new?title=Engine%20change%3A%20Roads%20should%20support%20bridges', 'gh auth login']);

        Process::assertDidntRun(fn (PendingProcess $p) => str_starts_with((string) $p->command, 'gh issue create'));
    }

    public function test_a_goal_is_required(): void
    {
        $this->fakeGh(true);

        WaterwaysServer::tool(RequestEngineChange::class, ['goal' => '  '])->assertHasErrors(['goal']);
    }

    public function test_status_reports_the_issue_and_its_merged_pr(): void
    {
        $this->fakeGh(true, [
            'gh issue view 42 *' => Process::result(json_encode([
                'number' => 42, 'title' => 'Engine change: lake depth', 'state' => 'OPEN', 'url' => 'https://github.com/acme/waterways/issues/42',
                'comments' => [['author' => ['login' => 'claude'], 'body' => 'Opened a PR.']],
            ])),
            'gh pr list --state all *' => Process::result(json_encode([
                ['number' => 7, 'title' => 'Lake depth', 'state' => 'MERGED', 'url' => 'u7', 'isDraft' => false, 'mergedAt' => '2026-10-02T10:00:00Z', 'headRefName' => 'claude/issue-42-20261002', 'reviewDecision' => 'APPROVED', 'statusCheckRollup' => [['conclusion' => 'SUCCESS']], 'body' => ''],
                ['number' => 8, 'title' => 'Other', 'state' => 'OPEN', 'url' => 'u8', 'isDraft' => false, 'mergedAt' => null, 'headRefName' => 'claude/issue-420-x', 'reviewDecision' => null, 'statusCheckRollup' => [], 'body' => 'Closes #420'],
            ])),
        ]);

        WaterwaysServer::tool(EngineChangeStatus::class, ['issue' => 42])
            ->assertOk()
            ->assertSee(['"number": 7', '"state": "MERGED"', '"checks": "passing"', 'run update_engine', 'Opened a PR.'])
            ->assertDontSee('"number": 8');
    }

    public function test_status_of_a_pr_with_failing_checks(): void
    {
        $this->fakeGh(true, [
            'gh pr view 9 *' => Process::result(json_encode(['number' => 9, 'title' => 'X', 'state' => 'OPEN', 'url' => 'u9', 'isDraft' => false, 'mergedAt' => null, 'headRefName' => 'claude/issue-1-a', 'reviewDecision' => null, 'statusCheckRollup' => [['conclusion' => 'SUCCESS'], ['conclusion' => 'FAILURE']]])),
        ]);

        WaterwaysServer::tool(EngineChangeStatus::class, ['pull_request' => 9])->assertOk()->assertSee(['"checks": "failing"', '"state": "OPEN"']);
    }

    public function test_status_without_gh_points_to_github(): void
    {
        $this->fakeGh(false);

        WaterwaysServer::tool(EngineChangeStatus::class, ['issue' => 42])->assertHasErrors(['gh auth login', 'https://github.com/acme/waterways/issues/42']);
    }
}
