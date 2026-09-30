<?php

namespace Tests\Feature\Mcp;

use App\Mcp\EditorBridge;
use App\Mcp\Headless\BrowserLauncher;
use App\Mcp\Headless\BrowserLocator;
use App\Mcp\Headless\ProcessBrowserLauncher;
use App\Mcp\HeadlessEditor;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\ToolError;
use App\Mcp\Tools\CloseEditor;
use App\Mcp\Tools\GetEditorState;
use App\Mcp\Tools\GetProjectOverview;
use App\Mcp\Tools\OpenEditor;
use App\Models\AgentCommand;
use App\Models\AgentSession;
use App\Models\HeadlessBrowser;
use App\Models\Map;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use Tests\TestCase;

class HeadlessEditorTest extends TestCase
{
    use RefreshDatabase;

    private string $dir;

    protected function setUp(): void
    {
        parent::setUp();

        $this->dir = sys_get_temp_dir().'/waterways-headless-test-'.uniqid();
        File::ensureDirectoryExists($this->dir);
        config([
            'services.mcp.headless.browser' => $this->executable('chrome'),
            'services.mcp.headless.flags' => '--use-angle=swiftshader  --enable-unsafe-webgpu',
            'services.mcp.headless.url' => null,
            'services.mcp.headless.idle_minutes' => 15,
            'services.mcp.headless.start_timeout' => 1,
            'services.mcp.headless.auto' => false,
        ]);
    }

    protected function tearDown(): void
    {
        File::deleteDirectory($this->dir);

        parent::tearDown();
    }

    private function executable(string $name, ?string $dir = null): string
    {
        $path = ($dir ?? $this->dir).'/'.$name;
        File::ensureDirectoryExists(dirname($path));
        file_put_contents($path, "#!/bin/sh\n");
        chmod($path, 0755);

        return $path;
    }

    private function launcher(?Map $boots = null): FakeBrowserLauncher
    {
        $launcher = new FakeBrowserLauncher($boots);
        $this->app->instance(BrowserLauncher::class, $launcher);

        return $launcher;
    }

    /** One poll of an editor tab: the user's (headless false) or the hidden one. */
    private function poll(Map $map, string $session, bool $headless, array $unsaved = []): array
    {
        return app(EditorBridge::class)->poll($map, $session, 'edit', ['headless' => $headless, 'unsaved' => $unsaved]);
    }

    public function test_open_editor_starts_a_hidden_editor_and_waits_until_it_polls(): void
    {
        $map = Map::factory()->create();
        $launcher = $this->launcher(boots: $map);

        WaterwaysServer::tool(OpenEditor::class, ['map' => $map->slug])
            ->assertOk()
            ->assertSee(['"status": "open"', '"headless": true']);

        $this->assertCount(1, $launcher->launched);
        $args = $launcher->launched[0]['arguments'];
        $this->assertSame(config('services.mcp.headless.browser'), $launcher->launched[0]['binary']);
        $this->assertContains('--headless=new', $args);
        $this->assertContains('--window-size=1600,900', $args);
        $this->assertContains('--user-data-dir='.storage_path("app/headless/profile-{$map->id}"), $args);
        // Extra flags from WATERWAYS_BROWSER_FLAGS, then the game page in edit mode with the agent flag last.
        $this->assertContains('--use-angle=swiftshader', $args);
        $this->assertContains('--enable-unsafe-webgpu', $args);
        $this->assertSame(route('game.show', $map).'?agent=1', end($args));
        $this->assertSame(1, HeadlessBrowser::query()->where('map_id', $map->id)->count());

        WaterwaysServer::tool(GetProjectOverview::class)->assertOk()->assertSee('"headless": true');
    }

    public function test_open_editor_reuses_a_running_hidden_editor(): void
    {
        $map = Map::factory()->create();
        $launcher = $this->launcher(boots: $map);

        WaterwaysServer::tool(OpenEditor::class, ['map' => $map->slug])->assertOk();
        WaterwaysServer::tool(OpenEditor::class, ['map' => $map->slug])
            ->assertOk()
            ->assertSee(['"status": "already_open"', '"headless": true']);

        $this->assertCount(1, $launcher->launched);
    }

    public function test_open_editor_uses_the_users_editor_instead_of_starting_a_second_one(): void
    {
        $map = Map::factory()->create();
        $launcher = $this->launcher();
        $this->poll($map, 'user-tab', false);

        WaterwaysServer::tool(OpenEditor::class, ['map' => $map->slug])
            ->assertOk()
            ->assertSee(['"status": "already_open"', '"headless": false']);

        $this->assertSame([], $launcher->launched);
    }

    public function test_open_editor_without_wait_returns_while_loading_and_a_timeout_keeps_it_loading(): void
    {
        $map = Map::factory()->create();
        $launcher = $this->launcher();

        WaterwaysServer::tool(OpenEditor::class, ['map' => $map->slug, 'wait' => false])
            ->assertOk()
            ->assertSee(['"status": "loading"', '"headless": true']);

        WaterwaysServer::tool(OpenEditor::class, ['map' => $map->slug])
            ->assertHasErrors(['did not finish loading within 1 s', 'call open_editor again']);

        $this->assertCount(1, $launcher->launched);
        $this->assertSame(1, HeadlessBrowser::query()->count());
    }

    public function test_open_editor_reports_a_browser_that_exits(): void
    {
        $map = Map::factory()->create();
        $launcher = new class extends FakeBrowserLauncher
        {
            public function running(int $pid, string $marker): bool
            {
                return false;
            }
        };
        $this->app->instance(BrowserLauncher::class, $launcher);
        file_put_contents(storage_path("logs/headless-{$map->slug}.log"), "GPU process crashed\n");

        WaterwaysServer::tool(OpenEditor::class, ['map' => $map->slug])
            ->assertHasErrors(['browser exited while loading', 'GPU process crashed']);

        $this->assertSame(0, HeadlessBrowser::query()->count());
        File::delete(storage_path("logs/headless-{$map->slug}.log"));
    }

    public function test_open_editor_explains_a_missing_browser(): void
    {
        $map = Map::factory()->create();
        $this->launcher();
        config(['services.mcp.headless.browser' => $this->dir.'/missing']);

        WaterwaysServer::tool(OpenEditor::class, ['map' => $map->slug])
            ->assertHasErrors(['WATERWAYS_BROWSER_PATH']);
    }

    public function test_close_editor_stops_only_the_hidden_editor(): void
    {
        $map = Map::factory()->create();
        $launcher = $this->launcher(boots: $map);
        WaterwaysServer::tool(OpenEditor::class, ['map' => $map->slug])->assertOk();
        $pid = HeadlessBrowser::query()->value('pid');

        WaterwaysServer::tool(CloseEditor::class, ['map' => $map->slug])->assertOk()->assertSee('"status": "closed"');

        $this->assertSame([$pid], $launcher->stopped);
        $this->assertSame(0, HeadlessBrowser::query()->count());
        $this->assertNull(app(EditorBridge::class)->session($map));

        WaterwaysServer::tool(CloseEditor::class, ['map' => $map->slug])->assertHasErrors(['No hidden editor']);

        $this->poll($map, 'user-tab', false);
        WaterwaysServer::tool(CloseEditor::class, ['map' => $map->slug])->assertHasErrors(["the user's own editor"]);
        $this->assertNotNull(app(EditorBridge::class)->session($map));
    }

    public function test_close_editor_refuses_unsaved_changes_unless_discarded(): void
    {
        $map = Map::factory()->create();
        $launcher = $this->launcher(boots: $map);
        WaterwaysServer::tool(OpenEditor::class, ['map' => $map->slug])->assertOk();
        AgentSession::query()->update(['state' => ['headless' => true, 'unsaved' => ['terrain']]]);

        WaterwaysServer::tool(CloseEditor::class, ['map' => $map->slug])->assertHasErrors(['unsaved changes (terrain)']);
        $this->assertSame([], $launcher->stopped);

        WaterwaysServer::tool(CloseEditor::class, ['map' => $map->slug, 'discard_unsaved' => true])->assertOk();
        $this->assertCount(1, $launcher->stopped);
    }

    public function test_the_hidden_editor_hands_over_to_the_user_saving_first(): void
    {
        $map = Map::factory()->create();
        $launcher = $this->launcher();
        $headless = app(HeadlessEditor::class);
        $headless->open($map, wait: false);
        $this->poll($map, 'hidden', true, ['terrain']);

        // The user opens the same map; an agent command is queued.
        $this->poll($map, 'user-tab', false);
        $command = AgentCommand::query()->create(['map_id' => $map->id, 'type' => 'state', 'status' => 'pending']);

        // The hidden editor gets only its own save, not the agent's command.
        $claimed = $this->poll($map, 'hidden', true, ['terrain']);
        $this->assertSame(['save'], array_column($claimed, 'type'));
        $this->assertSame('pending', $command->fresh()->status);
        $this->assertSame([], $launcher->stopped);

        // The agent's command goes to the user's tab.
        $this->assertSame([$command->id], array_column($this->poll($map, 'user-tab', false), 'id'));

        // Once saved, the hidden editor closes.
        app(EditorBridge::class)->complete(AgentCommand::query()->findOrFail($claimed[0]['id']), true, ['saved' => ['terrain']], null);
        $this->assertSame([], $this->poll($map, 'hidden', true));
        $this->assertCount(1, $launcher->stopped);
        $this->assertSame(0, HeadlessBrowser::query()->count());
        $this->assertSame(['user-tab'], AgentSession::query()->pluck('id')->all());
    }

    public function test_idle_hidden_editors_are_closed(): void
    {
        $map = Map::factory()->create();
        $other = Map::factory()->create();
        $launcher = $this->launcher();
        $headless = app(HeadlessEditor::class);
        $headless->open($map, wait: false);
        $headless->open($other, wait: false);

        $this->travel(10)->minutes();
        $headless->touch($other);
        $this->assertSame([], $headless->sweep());

        $this->travel(6)->minutes();
        $this->artisan('waterways:headless', ['action' => 'stop', '--idle' => true])
            ->expectsOutputToContain("Closed {$map->slug}: idle for more than 15 min")
            ->assertSuccessful();

        $this->assertSame([$other->id], HeadlessBrowser::query()->pluck('map_id')->all());
        $this->assertCount(1, $launcher->stopped);

        // Its own poll closes it too.
        $this->travel(16)->minutes();
        $this->assertSame([], $this->poll($other, 'hidden', true));
        $this->assertSame(0, HeadlessBrowser::query()->count());
    }

    public function test_tool_calls_forget_browsers_that_exited(): void
    {
        $map = Map::factory()->create();
        $launcher = $this->launcher();
        app(HeadlessEditor::class)->open($map, wait: false);
        $launcher->alive = [];

        WaterwaysServer::tool(GetProjectOverview::class)->assertOk();

        $this->assertSame(0, HeadlessBrowser::query()->count());
    }

    public function test_the_artisan_command_lists_and_stops_hidden_editors(): void
    {
        $map = Map::factory()->create();
        $launcher = $this->launcher();
        app(HeadlessEditor::class)->open($map, wait: false);

        $this->artisan('waterways:headless')->expectsOutputToContain($map->slug)->assertSuccessful();
        $this->artisan('waterways:headless', ['action' => 'stop', '--map' => $map->slug])
            ->expectsOutputToContain("Stopped the hidden editor of {$map->slug}")
            ->assertSuccessful();

        $this->assertCount(1, $launcher->stopped);
        $this->artisan('waterways:headless')->expectsOutputToContain('No hidden editors')->assertSuccessful();
    }

    public function test_live_tools_mention_open_editor_or_start_one_when_auto_headless_is_on(): void
    {
        $map = Map::factory()->create();
        $launcher = $this->launcher(boots: $map);

        WaterwaysServer::tool(GetEditorState::class, ['map' => $map->slug])
            ->assertHasErrors(['is not open in an editor', 'open_editor']);
        $this->assertSame([], $launcher->launched);

        config(['services.mcp.headless.auto' => true]);
        // The hidden editor answers commands like an open tab.
        $this->app->instance(EditorBridge::class, new class extends EditorBridge
        {
            protected function sleep(): void
            {
                foreach (AgentSession::query()->get() as $session) {
                    foreach ($this->poll($session->map, $session->id, 'edit', $session->state) as $command) {
                        $this->complete(AgentCommand::query()->findOrFail($command['id']), true, ['mode' => 'edit', 'headless' => true], null);
                    }
                }
            }
        });

        WaterwaysServer::tool(GetEditorState::class, ['map' => $map->slug])->assertOk()->assertSee('"headless": true');
        $this->assertCount(1, $launcher->launched);
    }

    public function test_the_url_can_be_overridden(): void
    {
        $map = Map::factory()->create();
        config(['services.mcp.headless.url' => 'http://127.0.0.1:9000/play/{map}?mode=edit']);

        $this->assertSame("http://127.0.0.1:9000/play/{$map->slug}?mode=edit&agent=1", app(HeadlessEditor::class)->url($map));
    }

    public function test_browser_discovery_prefers_the_configured_path_then_the_candidates_in_order(): void
    {
        $first = $this->executable('a/chrome');
        $second = $this->executable('b/chrome');
        $onPath = $this->executable('fake-chromium-for-test', $this->dir.'/bin');

        $this->assertSame($first, (new BrowserLocator(null, [$this->dir.'/missing', $first, $second]))->find());
        $this->assertSame($second, (new BrowserLocator($second, [$first]))->find());

        $path = getenv('PATH');
        putenv('PATH='.$this->dir.'/bin'.PATH_SEPARATOR.$path);
        try {
            $this->assertSame($onPath, (new BrowserLocator(null, ['fake-chromium-for-test', $first]))->find());
        } finally {
            putenv("PATH={$path}");
        }

        // Installed macOS apps come first, Playwright's Chromium last.
        $this->assertSame('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', BrowserLocator::CANDIDATES[0]);
        $this->assertSame('/opt/pw-browsers/chromium', BrowserLocator::CANDIDATES[array_key_last(BrowserLocator::CANDIDATES)]);

        $this->expectException(ToolError::class);
        (new BrowserLocator(null, [$this->dir.'/missing']))->find();
    }

    public function test_the_process_launcher_detaches_and_stops_a_process(): void
    {
        $launcher = new ProcessBrowserLauncher;
        $marker = 'waterways-headless-test-'.uniqid();
        $log = $this->dir.'/launch.log';

        // `; true` keeps the shell (and the marker in its command line) around instead of exec'ing sleep.
        $pid = $launcher->launch('/bin/sh', ['-c', 'sleep 30; true', $marker], $log);

        $this->assertGreaterThan(0, $pid);
        $this->assertTrue($launcher->running($pid, $marker));
        $this->assertFalse($launcher->running($pid, 'another-profile'));

        $launcher->stop($pid, $marker);
        $this->assertFalse($launcher->running($pid, $marker));
    }
}
