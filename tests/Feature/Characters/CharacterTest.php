<?php

namespace Tests\Feature\Characters;

use App\Jobs\GenerateCharacter;
use App\Models\Character;
use App\Models\Map;
use App\Support\ActiveCharacter;
use App\Support\AiSettings;
use App\Support\GameManifest;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Sleep;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\TestCase;

class CharacterTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
        Http::preventStrayRequests();
        Sleep::fake();
    }

    private function glb(): string
    {
        return 'glTF'.pack('V', 2).pack('V', 12);
    }

    public function test_meshy_pipeline_builds_rigs_and_animates_a_character(): void
    {
        app(AiSettings::class)->update(['meshy_api_key' => 'msy_key_1234']);
        $polls = 0;
        Http::fake([
            'api.meshy.ai/openapi/v2/text-to-3d/prev' => Http::response(['status' => 'SUCCEEDED', 'consumed_credits' => 20]),
            'api.meshy.ai/openapi/v2/text-to-3d/ref' => Http::response(['status' => 'SUCCEEDED', 'consumed_credits' => 10, 'thumbnail_url' => 'https://assets.meshy.ai/ref/thumb.png']),
            'api.meshy.ai/openapi/v2/text-to-3d' => fn (Request $r) => Http::response(['result' => $r['mode'] === 'preview' ? 'prev' : 'ref']),
            'api.meshy.ai/openapi/v1/rigging/rig' => function () use (&$polls) {
                return Http::response(++$polls < 2 ? ['status' => 'IN_PROGRESS', 'progress' => 50] : ['status' => 'SUCCEEDED', 'consumed_credits' => 5, 'result' => [
                    'rigged_character_glb_url' => 'https://assets.meshy.ai/rig/character.glb',
                    'basic_animations' => ['walking_glb_url' => 'https://assets.meshy.ai/rig/walk.glb', 'running_glb_url' => 'https://assets.meshy.ai/rig/run.glb'],
                ]]);
            },
            'api.meshy.ai/openapi/v1/rigging' => Http::response(['result' => 'rig']),
            'api.meshy.ai/openapi/v1/animations/anim-0' => Http::response(['status' => 'SUCCEEDED', 'consumed_credits' => 3, 'result' => ['animation_glb_url' => 'https://assets.meshy.ai/anim/idle.glb']]),
            'api.meshy.ai/openapi/v1/animations/anim-466' => Http::response(['status' => 'FAILED', 'task_error' => ['message' => 'nope']]),
            'api.meshy.ai/openapi/v1/animations/anim-569' => Http::response(['status' => 'SUCCEEDED', 'result' => ['animation_glb_url' => 'https://assets.meshy.ai/anim/swim.glb']]),
            'api.meshy.ai/openapi/v1/animations' => fn (Request $r) => Http::response(['result' => 'anim-'.$r['action_id']]),
            'assets.meshy.ai/*' => Http::response($this->glb()),
        ]);

        $this->post('/characters/generate', ['prompt' => 'A river guide in a green jacket', 'style' => 30, 'height' => 1.75, 'route' => 'text', 'model' => 'meshy-6'])
            ->assertRedirect()->assertSessionHasNoErrors();

        $character = Character::query()->sole();
        $this->assertSame('ready', $character->status, (string) $character->status_message);
        $this->assertSame("characters/{$character->id}/model.glb", $character->model_path);
        $this->assertEqualsCanonicalizing(['walk', 'run', 'idle', 'swim'], array_keys($character->animations), 'The failed jump clip is skipped');
        $this->assertSame(38, $character->meta['meshy_credits']);
        Storage::disk('public')->assertExists($character->model_path);
        Storage::disk('public')->assertExists($character->thumbnail_path);

        Http::assertSent(fn (Request $r) => $r->url() === 'https://api.meshy.ai/openapi/v2/text-to-3d' && $r['mode'] === 'preview' && $r['pose_mode'] === 'a-pose');
        Http::assertSent(fn (Request $r) => $r->url() === 'https://api.meshy.ai/openapi/v1/rigging' && $r['input_task_id'] === 'ref' && $r['height_meters'] === 1.75);
        Http::assertSent(fn (Request $r) => $r->url() === 'https://api.meshy.ai/openapi/v1/animations' && $r['rig_task_id'] === 'rig' && $r['action_id'] === 0);

        // Use it as the player: the manifest carries the model and clip URLs.
        $this->post("/characters/{$character->id}/activate")->assertRedirect();
        $manifest = app(GameManifest::class)->build(Map::factory()->create());
        $this->assertSame($character->id, $manifest['character']['id']);
        $this->assertStringContainsString("characters/{$character->id}/swim.glb", $manifest['character']['animations']->swim);
        $this->assertSame(1.75, $manifest['character']['height']);

        $this->delete('/characters/active')->assertRedirect();
        $this->assertNull(app(GameManifest::class)->build(Map::factory()->create())['character']);
    }

    public function test_generation_needs_meshy_and_uploads_need_a_glb(): void
    {
        Queue::fake();
        $this->post('/characters/generate', ['prompt' => 'knight', 'style' => 50, 'height' => 1.8, 'route' => 'text'])->assertSessionHasErrors('ai');
        Queue::assertNothingPushed();

        $this->post('/characters/upload', ['model' => UploadedFile::fake()->createWithContent('hero.glb', 'nope'), 'name' => 'Hero', 'height' => 1.8])
            ->assertSessionHasErrors('model');
        $this->post('/characters/upload', ['model' => UploadedFile::fake()->createWithContent('hero.glb', $this->glb()), 'name' => 'Hero', 'height' => 1.8])
            ->assertSessionHasNoErrors();

        $hero = Character::query()->sole();
        $this->assertTrue($hero->isReady());

        $this->post("/characters/{$hero->id}/activate");
        $this->assertSame($hero->id, app(ActiveCharacter::class)->id());
        $this->delete("/characters/{$hero->id}")->assertRedirect();
        $this->assertNull(app(ActiveCharacter::class)->id(), 'Deleting the player character resets the player');
    }

    public function test_characters_page_renders(): void
    {
        $this->withoutVite();
        Character::query()->create(['name' => 'Guide', 'status' => 'ready', 'model_path' => 'characters/1/model.glb', 'animations' => ['walk' => 'characters/1/walk.glb']]);

        $this->get('/characters')->assertOk()->assertInertia(fn (Assert $page) => $page
            ->component('characters/index')
            ->has('characters', 1)
            ->where('characters.0.clips', ['walk'])
            ->where('extraClips', array_keys(GenerateCharacter::EXTRA_CLIPS)));
    }
}
