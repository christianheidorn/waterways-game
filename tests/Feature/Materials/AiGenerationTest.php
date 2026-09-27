<?php

namespace Tests\Feature\Materials;

use App\Models\GameSetting;
use App\Models\Material;
use App\Services\Ai\AiNotConfiguredException;
use App\Services\Ai\OpenRouterClient;
use App\Services\Materials\MaterialLibrary;
use App\Services\Materials\Sources\UploadSource;
use App\Support\AiSettings;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Sleep;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Concerns\CreatesTestImages;
use Tests\Concerns\FakesOpenRouter;
use Tests\TestCase;

class AiGenerationTest extends TestCase
{
    use CreatesTestImages;
    use FakesOpenRouter;
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
        Sleep::fake();
    }

    public function test_ai_settings_store_the_key_encrypted_and_never_expose_it(): void
    {
        $secret = 'sk-or-v1-0123456789secretabcd';

        $this->get('/settings/ai')->assertOk()->assertInertia(fn (Assert $page) => $page
            ->component('settings/ai')
            ->where('settings.configured', false)
            ->where('settings.key_hint', null)
            ->where('settings.image_model', AiSettings::DEFAULT_IMAGE_MODEL)
            ->where('settings.text_model', AiSettings::DEFAULT_TEXT_MODEL)
            ->where('settings.image_resolution', '1K'));

        $this->put('/settings/ai', [
            'openrouter_api_key' => $secret, 'image_model' => 'acme/basic-image', 'text_model' => 'openai/gpt-json', 'image_resolution' => '2K',
        ])->assertSessionHasNoErrors();

        $stored = json_encode(GameSetting::query()->where('group', 'ai')->value('values'));
        $this->assertStringNotContainsString($secret, (string) $stored, 'The key is stored encrypted.');

        foreach (['/settings/ai', '/materials', '/settings/game/player'] as $url) {
            $response = $this->get($url)->assertOk();
            $this->assertStringNotContainsString('secretabcd', $response->getContent(), $url);
            $this->assertStringNotContainsString('0123456789', $response->getContent(), $url);
        }

        $this->get('/settings/ai')->assertInertia(fn (Assert $page) => $page
            ->where('settings.configured', true)
            ->where('settings.key_hint', 'sk-or-…abcd')
            ->where('settings.key_source', 'studio')
            ->where('settings.image_model', 'acme/basic-image')
            ->where('settings.image_resolution', '2K'));

        // Saving without a key keeps it; bad model ids are rejected.
        $this->put('/settings/ai', ['openrouter_api_key' => '', 'image_model' => 'Not a model!'])->assertSessionHasErrors('image_model');
        $this->put('/settings/ai', ['openrouter_api_key' => null, 'text_model' => 'anthropic/claude-sonnet-5:beta'])->assertSessionHasNoErrors();
        $this->assertSame($secret, app(AiSettings::class)->apiKey());

        $this->fakeOpenRouter();
        $this->post('/settings/ai/test')->assertSessionHas('inertia.flash_data.toast', fn ($t) => $t['type'] === 'success' && str_contains($t['message'], 'Connected'));
        Http::assertSent(fn (Request $r) => $r->url() === 'https://openrouter.ai/api/v1/key'
            && $r->hasHeader('Authorization', 'Bearer '.$secret) && $r->hasHeader('X-Title', 'Waterways'));

        $this->put('/settings/ai', ['clear_key' => true])->assertSessionHasNoErrors();
        $this->assertFalse(app(AiSettings::class)->configured());

        config(['services.openrouter.key' => 'sk-or-v1-fromenv9999']);
        $this->assertSame(['configured' => true, 'source' => 'env', 'hint' => 'sk-or-…9999'], [
            'configured' => app(AiSettings::class)->configured(),
            'source' => app(AiSettings::class)->keySource(),
            'hint' => app(AiSettings::class)->keyHint(),
        ]);
    }

    public function test_generation_is_refused_without_a_key(): void
    {
        Http::fake();

        $this->post('/materials/generate', ['prompt' => 'mossy rocks', 'category' => 'rock', 'tile_size' => 2, 'variants' => 2])
            ->assertSessionHasErrors('ai');

        $this->assertSame(0, Material::query()->count());
        Http::assertNothingSent();

        $this->getJson('/api/ai/models')->assertOk()->assertExactJson(['configured' => false, 'image' => [], 'text' => []]);
        $this->postJson('/api/ai/enhance-prompt', ['prompt' => 'grass'])->assertStatus(422)->assertJsonPath('configured', false);

        $this->expectException(AiNotConfiguredException::class);
        app(OpenRouterClient::class)->generateImage('x/y', 'test');
    }

    public function test_generating_variants_sends_only_supported_parameters(): void
    {
        $this->configureAi();
        $this->fakeOpenRouter($this->png($this->noiseImage(64, 64)));

        $this->post('/materials/generate', [
            'prompt' => 'Alpine meadow with small wildflowers', 'category' => 'grass', 'tile_size' => 3, 'variants' => 2,
        ])->assertSessionHasNoErrors();

        $materials = Material::query()->orderBy('id')->get();
        $this->assertCount(2, $materials);
        $this->assertSame(['Alpine meadow with small wildflowers #1', 'Alpine meadow with small wildflowers #2'], $materials->pluck('name')->all());

        foreach ($materials as $material) {
            $this->assertSame('ready', $material->status, (string) $material->status_message);
            $this->assertSame(['ai', 'grass', 3.0, 1024, 'google/gemini-3.1-flash-image'], [
                $material->source, $material->category, $material->tile_size, $material->resolution, $material->ai_model,
            ]);
            $this->assertStringStartsWith('seamless tileable PBR albedo texture, orthographic top-down, flat even diffuse lighting, no shadows', $material->ai_prompt);
            $this->assertStringEndsWith('Alpine meadow with small wildflowers', $material->ai_prompt);
            foreach (Material::MAPS as $map) {
                Storage::disk('public')->assertExists($material->{$map.'_path'});
            }
        }

        $sent = Http::recorded(fn (Request $r) => $r->url() === 'https://openrouter.ai/api/v1/images')->values();
        $this->assertCount(2, $sent);
        $payload = $sent[0][0]->data();
        $this->assertSame('google/gemini-3.1-flash-image', $payload['model']);
        $this->assertSame('1K', $payload['resolution']);
        $this->assertSame('1:1', $payload['aspect_ratio']);
        $this->assertArrayNotHasKey('seed', $payload, 'Unsupported parameters are not sent.');
        $this->assertArrayNotHasKey('output_format', $payload);
        $this->assertArrayNotHasKey('n', $payload);
        $this->assertArrayNotHasKey('input_references', $payload);
    }

    public function test_model_and_resolution_overrides_and_prompt_enhancement(): void
    {
        $this->configureAi();
        $this->fakeOpenRouter($this->png($this->noiseImage(64, 64)), "Sure! Here you go:\n```json\n{\"prompt\": \"Wet dark river mud with glistening puddles\"}\n```");

        $this->post('/materials/generate', [
            'prompt' => 'mud', 'category' => 'mud', 'tile_size' => 2, 'variants' => 1,
            'model' => 'acme/basic-image', 'resolution' => '2K', 'enhance' => true,
        ])->assertSessionHasNoErrors();

        $material = Material::query()->sole();
        $this->assertSame('ready', $material->status, (string) $material->status_message);
        $this->assertSame(2048, $material->resolution);
        $this->assertStringEndsWith('Wet dark river mud with glistening puddles', $material->ai_prompt);

        $payload = Http::recorded(fn (Request $r) => $r->url() === 'https://openrouter.ai/api/v1/images')->first()[0]->data();
        $this->assertSame('acme/basic-image', $payload['model']);
        $this->assertArrayHasKey('seed', $payload);
        $this->assertSame(1, $payload['n']);
        $this->assertArrayNotHasKey('resolution', $payload);
        $this->assertArrayNotHasKey('aspect_ratio', $payload);

        $chat = Http::recorded(fn (Request $r) => str_ends_with($r->url(), '/chat/completions'))->first()[0]->data();
        $this->assertSame(AiSettings::DEFAULT_TEXT_MODEL, $chat['model']);
        $this->assertArrayNotHasKey('response_format', $chat, 'Only sent to models that support it.');
    }

    public function test_ai_edit_sends_the_parent_albedo_as_reference(): void
    {
        $parent = app(MaterialLibrary::class)->create(['name' => 'Sand', 'category' => 'sand', 'tile_size' => 1.5, 'status' => 'processing']);
        app(UploadSource::class)->import($parent, [['name' => 'sand.jpg', 'bytes' => $this->jpeg($this->noiseImage(256, 256, 2, 0xC8B080))]]);

        $this->configureAi();
        $this->fakeOpenRouter($this->png($this->noiseImage(64, 64, 9)));

        $this->post("/materials/{$parent->id}/ai-edit", ['prompt' => 'add scattered shells', 'variants' => 1])->assertSessionHasNoErrors();

        $child = Material::query()->where('parent_id', $parent->id)->sole();
        $this->assertSame('ready', $child->status, (string) $child->status_message);
        $this->assertSame(['sand', 1.5, 'ai'], [$child->category, $child->tile_size, $child->source]);
        $this->assertStringStartsWith('Edit the attached ground texture: add scattered shells.', $child->ai_prompt);

        $payload = Http::recorded(fn (Request $r) => $r->url() === 'https://openrouter.ai/api/v1/images')->first()[0]->data();
        $this->assertCount(1, $payload['input_references']);
        $this->assertSame('image_url', $payload['input_references'][0]['type']);
        $this->assertStringStartsWith('data:image/jpeg;base64,', $payload['input_references'][0]['image_url']['url']);
    }

    public function test_openrouter_errors_fail_the_material_with_a_clear_message_and_429_is_retried(): void
    {
        $this->configureAi();
        $errors = Http::sequence()
            ->push(['error' => ['message' => 'Rate limited']], 429)
            ->push(['error' => ['message' => 'Insufficient credits', 'code' => 402]], 402);
        $this->fakeOpenRouter($this->png($this->noiseImage(64, 64)), extra: [
            'openrouter.ai/api/v1/images' => fn (Request $request) => $errors->isEmpty() ? Http::response($this->imageResponse($this->png($this->noiseImage(64, 64)))) : $errors($request),
        ]);

        $this->post('/materials/generate', ['prompt' => 'gravel', 'category' => 'gravel', 'tile_size' => 1, 'variants' => 1])->assertRedirect();

        $material = Material::query()->sole();
        $this->assertSame('failed', $material->status);
        $this->assertStringContainsString('HTTP 402', (string) $material->status_message);
        $this->assertStringContainsString('Insufficient credits', (string) $material->status_message);
        Http::assertSentCount(3); // model list + 429 + 402

        // Retry from the library (the fake now answers with an image).
        $this->post("/materials/{$material->id}/retry")->assertRedirect();
        $material->refresh();
        $this->assertSame('ready', $material->status, (string) $material->status_message);
        $this->assertStringEndsWith(', gravel', $material->ai_prompt);
    }

    public function test_model_lists_are_summarised_and_cached(): void
    {
        $this->configureAi();
        $this->fakeOpenRouter();

        $this->getJson('/api/ai/models')
            ->assertOk()
            ->assertJsonPath('configured', true)
            ->assertJsonPath('image.0.id', 'google/gemini-3.1-flash-image')
            ->assertJsonPath('image.0.resolutions', ['512', '1K', '2K', '4K'])
            ->assertJsonPath('image.0.supports_references', true)
            ->assertJsonPath('image.0.max_references', 3)
            ->assertJsonPath('image.0.vision', true)
            ->assertJsonPath('image.0.pricing', '$0.039 per image')
            ->assertJsonPath('image.1.supports_references', false)
            ->assertJsonPath('text.0.id', 'anthropic/claude-sonnet-5')
            ->assertJsonPath('text.0.vision', true)
            ->assertJsonPath('text.0.pricing', '$3.00 / $15.00 per M tokens')
            ->assertJsonPath('text.1.vision', false);

        $this->getJson('/api/ai/models')->assertOk();
        Http::assertSentCount(2);

        $this->postJson('/api/ai/enhance-prompt', ['prompt' => 'grass', 'category' => 'grass'])->assertOk()->assertExactJson(['prompt' => 'enhanced']);
    }

    public function test_json_is_extracted_robustly(): void
    {
        $this->assertSame(['a' => 1], OpenRouterClient::extractJson('{"a":1}'));
        $this->assertSame(['a' => ['b' => '}{']], OpenRouterClient::extractJson("Here:\n```json\n{\"a\": {\"b\": \"}{\"}}\n```\nThanks"));
        $this->assertSame(['ok' => true], OpenRouterClient::extractJson('{broken {"ok": true} trailing'));
        $this->assertNull(OpenRouterClient::extractJson('no json here'));
    }
}
