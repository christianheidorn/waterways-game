<?php

namespace Tests\Feature\Mcp;

use App\Mcp\Headless\BrowserLauncher;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\UpdateEngine;
use App\Models\AgentCommand;
use App\Models\AgentSession;
use App\Models\HeadlessBrowser;
use App\Models\Map;
use App\Models\MapSnapshot;
use App\Support\Updates\EngineUpdater;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Process\PendingProcess;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\AssertionFailedError;
use Tests\TestCase;

class EngineUpdateTest extends TestCase
{
    use RefreshDatabase;

    private const OLD = 'aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa';

    private const NEW = 'bbbbbbbb22222222bbbbbbbb22222222bbbbbbbb';

    private string $dir;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        $this->dir = sys_get_temp_dir().'/waterways-update-test-'.uniqid();
        File::ensureDirectoryExists($this->dir);
        file_put_contents($this->dir.'/chrome', "#!/bin/sh\n");
        chmod($this->dir.'/chrome', 0755);
        config([
            'services.mcp.headless.browser' => $this->dir.'/chrome',
            'services.mcp.headless.url' => null,
            'services.mcp.headless.idle_minutes' => 15,
            'services.mcp.headless.auto' => false,
        ]);
    }

    protected function tearDown(): void
    {
        File::deleteDirectory($this->dir);

        parent::tearDown();
    }

    /**
     * Fakes git and the build tools. `$overrides` replace single commands (pattern => result).
     *
     * @param  list<string>  $changed
     * @param  array<string, mixed>  $overrides
     */
    private function fakeProcesses(array $changed = [], int $behind = 0, string $status = '', array $overrides = []): void
    {
        Process::preventStrayProcesses();
        Process::fake([
            'git rev-parse --abbrev-ref HEAD' => Process::result("main\n"),
            'git rev-parse --abbrev-ref --symbolic-full-name @{u}' => Process::result("origin/main\n"),
            'git rev-parse HEAD' => Process::sequence([Process::result(self::OLD."\n"), Process::result(self::NEW."\n")])->dontFailWhenEmpty(),
            'git fetch --quiet' => Process::result(),
            'git status --porcelain' => Process::result($status),
            'git rev-list --count HEAD..@{u}' => Process::result("{$behind}\n"),
            'git rev-list --count @{u}..HEAD' => Process::result("0\n"),
            'git diff --name-only HEAD...@{u}' => Process::result(implode("\n", $changed)."\n"),
            'git pull --ff-only' => Process::result('Fast-forward'),
            'git reset --hard *' => Process::result('HEAD is now at aaaaaaa'),
            'composer install*' => Process::result(),
            '* artisan migrate --force' => Process::result(),
            'npm ci' => Process::result(),
            'npm install' => Process::result(),
            'npm run build' => Process::result(),
            ...$overrides,
        ]);
    }

    private function ran(string $command): bool
    {
        try {
            Process::assertRan(fn (PendingProcess $process) => str_ends_with((string) $process->command, $command));

            return true;
        } catch (AssertionFailedError) {
            return false;
        }
    }

    public function test_check_reports_the_branch_and_whether_updates_are_available(): void
    {
        $this->fakeProcesses(['resources/game/water.ts', 'app/Mcp/Tools/EditWater.php'], behind: 3);

        $result = app(EngineUpdater::class)->check();

        $this->assertSame('updates_available', $result['status']);
        $this->assertSame('main', $result['branch']);
        $this->assertSame('origin/main', $result['upstream']);
        $this->assertSame(3, $result['behind']);
        $this->assertTrue($result['plan']['build']);
        $this->assertTrue($result['plan']['reconnect_mcp']);
        $this->assertFalse($result['plan']['composer']);
        Process::assertRan('git fetch --quiet');
        Process::assertDidntRun('git pull --ff-only');
    }

    public function test_it_is_up_to_date_when_nothing_is_behind(): void
    {
        $this->fakeProcesses();

        $this->artisan('waterways:update')->expectsOutputToContain('Up to date')->assertSuccessful();
        Process::assertDidntRun('git pull --ff-only');
    }

    public function test_it_refuses_on_local_changes_unless_forced(): void
    {
        $this->fakeProcesses(['resources/game/a.ts'], behind: 1, status: " M app/Models/Map.php\n");

        $this->artisan('waterways:update')->expectsOutputToContain('uncommitted local changes')->assertFailed();
        Process::assertDidntRun('git pull --ff-only');

        $this->artisan('waterways:update --force')->assertSuccessful();
        Process::assertRan('git pull --ff-only');
    }

    public function test_dry_run_changes_nothing(): void
    {
        $map = Map::factory()->create();
        $this->fakeProcesses(['composer.lock', 'database/migrations/2026_x.php'], behind: 2);

        $this->artisan('waterways:update --dry-run')
            ->expectsOutputToContain('Dry run')
            ->expectsOutputToContain('composer, migrate')
            ->assertSuccessful();

        Process::assertDidntRun('git pull --ff-only');
        $this->assertSame(0, MapSnapshot::query()->where('map_id', $map->id)->count());
    }

    public function test_an_update_snapshots_maps_pulls_and_runs_only_the_needed_steps(): void
    {
        $maps = Map::factory()->count(2)->create();
        $this->fakeProcesses(['resources/game/water.ts', 'package-lock.json', 'README.md'], behind: 2);

        $result = app(EngineUpdater::class)->update();

        $this->assertSame('updated', $result['status']);
        $this->assertSame(self::OLD, $result['from']);
        $this->assertSame(self::NEW, $result['to']);
        $this->assertSame(['npm', 'build'], $result['steps']);
        $this->assertFalse($result['mcp_server_changed']);
        $this->assertCount(2, $result['snapshots']);

        foreach ($maps as $map) {
            $this->assertSame(1, MapSnapshot::query()->where('map_id', $map->id)->count());
        }

        Process::assertRan('git pull --ff-only');
        Process::assertRan('npm ci');
        Process::assertRan('npm run build');
        Process::assertDidntRun('composer install --no-interaction --prefer-dist');
        $this->assertFalse($this->ran('artisan migrate --force'));
    }

    public function test_php_changes_install_migrate_and_ask_to_reconnect_the_mcp_server(): void
    {
        $this->fakeProcesses(['composer.lock', 'database/migrations/2026_10_02_000010_x.php', 'app/Mcp/Tools/EditWater.php'], behind: 1);

        $result = app(EngineUpdater::class)->update();

        $this->assertSame('updated', $result['status']);
        $this->assertTrue($result['mcp_server_changed']);
        $this->assertStringContainsString('reconnect', $result['next']);
        Process::assertRan('composer install --no-interaction --prefer-dist');
        $this->assertTrue($this->ran('artisan migrate --force'));
        Process::assertDidntRun('npm run build');
    }

    public function test_open_editors_are_reloaded_and_hidden_ones_reopened(): void
    {
        $launcher = new FakeBrowserLauncher;
        $this->app->instance(BrowserLauncher::class, $launcher);
        [$userMap, $hiddenMap] = Map::factory()->count(2)->create();

        AgentSession::query()->create(['id' => 'user-tab', 'map_id' => $userMap->id, 'mode' => 'edit', 'state' => ['headless' => false], 'last_seen_at' => Carbon::now()]);
        $pid = $launcher->launch('chrome', ['--user-data-dir=/tmp/p'], '/tmp/log');
        HeadlessBrowser::query()->create([
            'map_id' => $hiddenMap->id, 'pid' => $pid, 'browser' => 'chrome', 'url' => 'x', 'profile_dir' => '/tmp/p',
            'started_at' => Carbon::now(), 'last_used_at' => Carbon::now(),
        ]);
        AgentSession::query()->create(['id' => 'hidden-tab', 'map_id' => $hiddenMap->id, 'mode' => 'edit', 'state' => ['headless' => true, 'unsaved' => []], 'last_seen_at' => Carbon::now()]);

        $this->fakeProcesses(['resources/game/a.ts'], behind: 1);
        $result = app(EngineUpdater::class)->update();

        $this->assertSame('updated', $result['status']);
        $this->assertContains(['map' => $userMap->slug, 'editor' => 'user', 'action' => 'reloaded'], $result['editors']);
        $this->assertContains(['map' => $hiddenMap->slug, 'editor' => 'hidden', 'action' => 'reopened'], $result['editors']);
        $this->assertTrue(AgentCommand::query()->where('map_id', $userMap->id)->where('type', 'reload')->exists());
        $this->assertContains($pid, $launcher->stopped);
        $this->assertCount(2, $launcher->launched, 'the hidden editor was started again');
        $this->assertSame(1, HeadlessBrowser::query()->where('map_id', $hiddenMap->id)->count());
    }

    public function test_a_failed_build_rolls_back_to_the_previous_commit_and_rebuilds(): void
    {
        $this->fakeProcesses(['resources/game/a.ts'], behind: 1, overrides: [
            'npm run build' => Process::sequence([
                Process::result(errorOutput: 'TS2322: Type error', exitCode: 1),
                Process::result('built'),
            ]),
        ]);

        $result = app(EngineUpdater::class)->update();

        $this->assertSame('failed', $result['status']);
        $this->assertSame('npm run build', $result['failed_step']);
        $this->assertStringContainsString('TS2322', $result['error']);
        $this->assertTrue($result['rolled_back']);
        $this->assertStringContainsString('Dependencies and build were redone', $result['rollback']);
        Process::assertRan("git reset --hard '".self::OLD."'");
        Process::assertRanTimes('npm run build', 2);
    }

    public function test_a_forced_update_over_local_changes_is_not_rolled_back(): void
    {
        $this->fakeProcesses(['composer.lock'], behind: 1, status: "?? notes.txt\n", overrides: [
            'composer install*' => Process::result(errorOutput: 'Your requirements could not be resolved', exitCode: 2),
        ]);

        $result = app(EngineUpdater::class)->update(force: true);

        $this->assertSame('failed', $result['status']);
        $this->assertFalse($result['rolled_back']);
        $this->assertStringContainsString('git reset --hard '.self::OLD, $result['hint']);
        Process::assertDidntRun("git reset --hard '".self::OLD."'");
    }

    public function test_a_pull_that_cannot_fast_forward_changes_nothing(): void
    {
        $this->fakeProcesses(['resources/game/a.ts'], behind: 1, overrides: [
            'git pull --ff-only' => Process::result(errorOutput: 'fatal: Not possible to fast-forward, aborting.', exitCode: 128),
        ]);

        $result = app(EngineUpdater::class)->update();

        $this->assertSame('failed', $result['status']);
        $this->assertSame('git pull --ff-only', $result['failed_step']);
        $this->assertFalse($result['rolled_back']);
        Process::assertDidntRun('npm run build');
        Process::assertDidntRun("git reset --hard '".self::OLD."'");
    }

    public function test_a_branch_without_upstream_is_explained(): void
    {
        $this->fakeProcesses(overrides: [
            'git rev-parse --abbrev-ref --symbolic-full-name @{u}' => Process::result(errorOutput: 'fatal: no upstream configured', exitCode: 128),
        ]);

        $this->artisan('waterways:update --check')->expectsOutputToContain('no upstream branch')->assertFailed();
    }

    public function test_the_mcp_tool_checks_dry_runs_and_reports_refusals_as_errors(): void
    {
        $this->fakeProcesses(['resources/game/a.ts'], behind: 4);

        WaterwaysServer::tool(UpdateEngine::class, ['check' => true])->assertOk()->assertSee(['"updates_available"', '"behind": 4']);
        WaterwaysServer::tool(UpdateEngine::class, ['dry_run' => true])->assertOk()->assertSee('"dry_run"');
        Process::assertDidntRun('git pull --ff-only');

        $this->fakeProcesses(['resources/game/a.ts'], behind: 4, status: " M a.php\n");
        WaterwaysServer::tool(UpdateEngine::class)->assertHasErrors(['uncommitted local changes']);
    }
}
