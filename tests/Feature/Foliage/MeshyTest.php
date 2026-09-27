<?php

namespace Tests\Feature\Foliage;

use App\Jobs\GenerateMeshyAsset;
use App\Models\FoliageAsset;
use App\Models\GameSetting;
use App\Support\AiSettings;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Sleep;
use Tests\Concerns\FakesOpenRouter;
use Tests\TestCase;

class MeshyTest extends TestCase
{
    use FakesOpenRouter;
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
        Http::preventStrayRequests();
        Sleep::fake();
        app(AiSettings::class)->update(['meshy_api_key' => 'msy_secret_key_9876']);
    }

    private function glb(): string
    {
        return 'glTF'.pack('V', 2).pack('V', 12);
    }

    public function test_text_route_runs_preview_then_refine_and_downloads_the_glb(): void
    {
        $polls = ['preview' => 0, 'refine' => 0];
        Http::fake([
            'api.meshy.ai/openapi/v2/text-to-3d/prev-1' => function () use (&$polls) {
                return Http::response(++$polls['preview'] < 2
                    ? ['id' => 'prev-1', 'status' => 'IN_PROGRESS', 'progress' => 40]
                    : ['id' => 'prev-1', 'status' => 'SUCCEEDED', 'progress' => 100, 'consumed_credits' => 20]);
            },
            'api.meshy.ai/openapi/v2/text-to-3d/ref-1' => fn () => Http::response(['id' => 'ref-1', 'status' => 'SUCCEEDED', 'progress' => 100, 'consumed_credits' => 10, 'face_count' => 28000,
                'model_urls' => ['glb' => 'https://assets.meshy.ai/tasks/ref-1/model.glb']]),
            'api.meshy.ai/openapi/v2/text-to-3d' => function (Request $r) {
                return Http::response(['result' => $r['mode'] === 'preview' ? 'prev-1' : 'ref-1']);
            },
            'assets.meshy.ai/*' => Http::response($this->glb()),
        ]);

        $asset = FoliageAsset::query()->create(['name' => 'Scots pine', 'kind' => 'conifer', 'source' => 'ai', 'status' => 'queued', 'target_height' => 22]);
        dispatch_sync(new GenerateMeshyAsset($asset, ['route' => 'text', 'prompt' => 'Scots pine with orange upper bark', 'style' => 10]));

        $asset->refresh();
        $this->assertSame('awaiting_bake', $asset->status, (string) $asset->status_message);
        $this->assertSame('model', $asset->source_type);
        $this->assertSame("foliage/{$asset->id}/source/model.glb", $asset->source_path);
        Storage::disk('public')->assertExists($asset->source_path);
        $this->assertSame(30, $asset->meta['meshy_credits']);
        $this->assertSame(28000, $asset->meta['source_polycount']);
        $this->assertStringContainsString('meshy-6', $asset->ai_model);

        Http::assertSent(fn (Request $r) => $r->url() === 'https://api.meshy.ai/openapi/v2/text-to-3d' && $r['mode'] === 'preview'
            && $r['target_polycount'] === 30000 && $r['origin_at'] === 'bottom' && $r['ai_model'] === 'meshy-6'
            && $r->hasHeader('Authorization', 'Bearer msy_secret_key_9876') && str_contains($r['prompt'], 'Scots pine'));
        Http::assertSent(fn (Request $r) => $r->url() === 'https://api.meshy.ai/openapi/v2/text-to-3d' && $r['mode'] === 'refine'
            && $r['preview_task_id'] === 'prev-1' && $r['enable_pbr'] === true);
    }

    public function test_image_route_uses_an_openrouter_concept_and_failures_are_reported(): void
    {
        $this->configureAi();
        $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
        $this->fakeOpenRouter(png: $png, extra: [
            'api.meshy.ai/openapi/v1/image-to-3d/img-1' => Http::response(['id' => 'img-1', 'status' => 'FAILED', 'task_error' => ['message' => 'Image rejected']]),
            'api.meshy.ai/openapi/v1/image-to-3d' => Http::response(['result' => 'img-1']),
        ]);

        $asset = FoliageAsset::query()->create(['name' => 'Boulder', 'kind' => 'rock', 'source' => 'ai', 'status' => 'queued']);
        $job = new GenerateMeshyAsset($asset, ['route' => 'image', 'prompt' => 'granite boulder', 'model' => 'latest']);
        try {
            dispatch_sync($job);
        } catch (\Throwable) {
            $job->failed(new \RuntimeException('Meshy task failed: Image rejected'));
        }

        $asset->refresh();
        $this->assertSame('failed', $asset->status);
        $this->assertStringContainsString('Image rejected', $asset->status_message);
        Storage::disk('public')->assertExists("foliage/{$asset->id}/source/concept.png");
        Http::assertSent(fn (Request $r) => $r->url() === 'https://api.meshy.ai/openapi/v1/image-to-3d'
            && str_starts_with($r['image_url'], 'data:image/png;base64,') && $r['should_texture'] === true && $r['ai_model'] === 'latest');
    }

    public function test_credits_endpoint_reports_both_providers_without_leaking_keys(): void
    {
        $this->configureAi();
        $this->fakeOpenRouter(extra: [
            'openrouter.ai/api/v1/credits' => Http::response(['data' => ['total_credits' => 25, 'total_usage' => 7.5]]),
            'api.meshy.ai/openapi/v1/balance' => Http::response(['balance' => 1234]),
        ]);

        $json = $this->getJson('/api/ai/credits?fresh=1')->assertOk()
            ->assertJsonPath('openrouter.configured', true)
            ->assertJsonPath('openrouter.remaining', 17.5)
            ->assertJsonPath('openrouter.key_limit_remaining', 12.5)
            ->assertJsonPath('meshy.balance', 1234)
            ->getContent();

        $this->assertStringNotContainsString('msy_secret', $json);
        $this->assertStringNotContainsString('sk-or-v1', $json);
    }

    public function test_meshy_key_is_stored_encrypted_and_only_hinted(): void
    {
        $this->put('/settings/ai', ['meshy_api_key' => 'msy_another_key_5555'])->assertRedirect();

        $settings = app(AiSettings::class);
        $this->assertSame('msy_another_key_5555', $settings->meshyKey());
        $this->assertSame('msy_…5555', $settings->toFrontend()['meshy']['key_hint']);
        $this->assertStringNotContainsString('msy_another', json_encode(GameSetting::query()->where('group', 'ai')->value('values')));

        $this->get('/settings/ai')->assertOk()->assertDontSee('msy_another_key_5555');

        $this->put('/settings/ai', ['clear_meshy_key' => true])->assertRedirect();
        $this->assertFalse(app(AiSettings::class)->meshyConfigured());
    }
}
