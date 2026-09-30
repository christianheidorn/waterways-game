<?php

namespace Tests\Feature\Mcp;

use App\Mcp\EditorBridge;
use App\Mcp\Servers\WaterwaysServer;
use App\Mcp\Tools\GetRequest;
use App\Mcp\Tools\ListRequests;
use App\Mcp\Tools\UpdateRequest;
use App\Models\AgentCommand;
use App\Models\AgentRequest;
use App\Models\Map;
use App\Services\Terrain\TerrainStorage;
use App\Support\DefaultTerrainLayers;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

class AgentRequestTest extends TestCase
{
    use RefreshDatabase;

    private Map $map;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        Storage::fake('public');
        $this->map = Map::factory()->create(['resolution' => 65, 'size' => 256]);
        DefaultTerrainLayers::createFor($this->map);
        app(TerrainStorage::class)->write($this->map, 'heightmap', TerrainStorage::packFloats(array_fill(0, 65 * 65, 10.0)));
    }

    private function send(array $overrides = []): TestResponse
    {
        return $this->post("/api/maps/{$this->map->slug}/agent-requests", [
            'note' => "A fishing village\nFive huts facing the lake.",
            'area' => json_encode([['x' => -50, 'z' => -50], ['x' => 50, 'z' => -50], ['x' => 50, 'z' => 50], ['x' => -50, 'z' => 50]]),
            'camera' => json_encode(['position' => ['x' => 0, 'y' => 80, 'z' => 120], 'direction' => ['x' => 0, 'y' => -0.5, 'z' => -0.8]]),
            'screenshot' => UploadedFile::fake()->image('view.jpg', 640, 360),
            'references' => [UploadedFile::fake()->image('hut.png', 200, 200)],
            ...$overrides,
        ], ['Accept' => 'application/json']);
    }

    public function test_the_editor_creates_lists_dismisses_and_deletes_requests(): void
    {
        $this->send()->assertCreated()
            ->assertJsonPath('status', 'open')
            ->assertJsonCount(1, 'reference_urls');

        $request = AgentRequest::query()->sole();
        Storage::disk('public')->assertExists([$request->screenshot_path, ...$request->reference_paths]);
        $this->assertSame(['x' => -50, 'z' => -50], $request->area[0]);

        $this->getJson("/api/maps/{$this->map->slug}/agent-requests")->assertOk()->assertJsonPath('0.note', $request->note);
        $this->patchJson("/api/maps/{$this->map->slug}/agent-requests/{$request->id}", ['status' => 'dismissed'])->assertJsonPath('status', 'dismissed');
        $this->patchJson("/api/maps/{$this->map->slug}/agent-requests/{$request->id}", ['status' => 'done'])->assertStatus(422);

        $this->deleteJson("/api/maps/{$this->map->slug}/agent-requests/{$request->id}")->assertNoContent();
        Storage::disk('public')->assertMissing($request->screenshot_path);

        $this->send(['area' => json_encode([['x' => 0, 'z' => 0], ['x' => 1, 'z' => 1]])])->assertStatus(422);
        $this->send(['area' => json_encode([['x' => 0, 'z' => 0], ['x' => 1, 'z' => 1], ['x' => 9000, 'z' => 1]])])->assertStatus(422);
        $this->send(['note' => ''])->assertStatus(422);
    }

    public function test_agents_list_read_and_report_on_requests(): void
    {
        $this->send()->assertCreated();
        $request = AgentRequest::query()->sole();

        WaterwaysServer::tool(ListRequests::class)->assertOk()->assertSee(['"title": "A fishing village"', '"area_m2": 10000']);
        WaterwaysServer::tool(ListRequests::class, ['status' => 'all', 'map' => $this->map->slug])->assertOk()->assertSee('A fishing village');

        $response = WaterwaysServer::tool(GetRequest::class, ['id' => $request->id])->assertOk()
            ->assertSee(['"type": "polygon"', 'Five huts facing the lake', 'reference image 1', 'top-down map of the area']);

        // Text + screenshot + reference + map crop.
        $this->assertCount(4, $this->contentOf($response));

        WaterwaysServer::tool(GetRequest::class, ['id' => 999])->assertHasErrors(['No such request']);
    }

    public function test_updates_store_the_result_screenshot_and_reach_the_editor(): void
    {
        $this->send()->assertCreated();
        $request = AgentRequest::query()->sole();
        $editor = new FakeEditor($this->map, fn (string $type) => $type === 'screenshot' ? ['image' => base64_encode('JPEG')] : []);
        $this->app->instance(EditorBridge::class, $editor);

        WaterwaysServer::tool(UpdateRequest::class, ['id' => $request->id, 'status' => 'done', 'message' => 'Built five huts and a jetty.', 'attach_screenshot' => true])
            ->assertOk()->assertSee('"result_images": 1');

        $request->refresh();
        $this->assertSame(['done', 'Built five huts and a jetty.'], [$request->status, $request->agent_message]);
        Storage::disk('public')->assertExists($request->result_paths[0]);
        // The screenshot used the camera the user had when making the request.
        $this->assertSame(['x' => 0, 'y' => 80, 'z' => 120], $editor->ran[0]['payload']['position']);
        // The editor refreshes its list.
        $this->assertSame(['type' => 'refresh', 'payload' => ['parts' => ['requests']]], AgentCommand::query()->latest('id')->first()->only('type', 'payload'));

        WaterwaysServer::tool(UpdateRequest::class, ['id' => $request->id, 'status' => 'finished'])->assertHasErrors();
    }

    /** @return list<mixed> */
    private function contentOf(\Laravel\Mcp\Server\Testing\TestResponse $response): array
    {
        $property = new \ReflectionProperty($response, 'response');

        return $property->getValue($response)->toArray()['result']['content'];
    }
}
