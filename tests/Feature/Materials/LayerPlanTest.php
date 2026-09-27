<?php

namespace Tests\Feature\Materials;

use App\Jobs\ApplyLandCover;
use App\Jobs\GenerateMaterial;
use App\Jobs\ImportMaterial;
use App\Models\Map;
use App\Models\Material;
use App\Models\TerrainLayer;
use App\Services\Ai\MaterialCandidates;
use App\Services\Ai\TerrainAnalysis;
use App\Services\Materials\MaterialLibrary;
use App\Services\Terrain\TerrainStorage;
use App\Support\DefaultTerrainLayers;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Tests\Concerns\FakesOpenRouter;
use Tests\TestCase;

class LayerPlanTest extends TestCase
{
    use FakesOpenRouter;
    use RefreshDatabase;

    private Map $map;

    private Material $grass;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
        Storage::fake('local');
        Http::preventStrayRequests();

        $this->map = Map::factory()->realWorld(46.36, 14.09)->create([
            'min_height' => 100, 'max_height' => 900, 'resolution' => 257, 'size' => 1024,
            // LandCoverService memoises stats per "id:revision".
            'revision' => random_int(1000, 999_999),
        ]);
        DefaultTerrainLayers::createFor($this->map);
        $this->grass = app(MaterialLibrary::class)->create(['name' => 'Lush grass', 'category' => 'grass', 'tile_size' => 2.5, 'status' => 'ready', 'albedo_path' => 'materials/x/albedo.jpg']);
    }

    private function fakeCatalogues(bool $ambientCgDown = false, bool $polyHavenDown = false): void
    {
        Http::fake([
            'api.polyhaven.com/assets*' => $polyHavenDown ? Http::response('down', 503) : Http::response([
                'forest_leaves_02' => ['name' => 'Forest Leaves 02', 'categories' => ['terrain', 'outdoor'], 'tags' => ['leaves', 'autumn', 'forest', 'ground', 'brown', 'dry', 'litter'], 'dimensions' => [2700, 2700], 'download_count' => 900],
                'aerial_rocks_01' => ['name' => 'Aerial Rocks 01', 'categories' => ['rock', 'aerial', 'outdoor'], 'tags' => ['rocky'], 'dimensions' => [40000, 40000], 'download_count' => 500],
                'tiny_gravel' => ['name' => 'Tiny Gravel', 'categories' => ['terrain'], 'tags' => ['gravel'], 'dimensions' => [100, 100], 'download_count' => 50],
                'rock_face_03' => ['name' => 'Rock Face 03', 'categories' => ['rock', 'terrain'], 'tags' => ['cliff'], 'dimensions' => [2700, 2700], 'download_count' => 400],
                'brick_wall' => ['name' => 'Brick Wall', 'categories' => ['man made', 'wall'], 'tags' => ['ground'], 'dimensions' => [3000, 3000], 'download_count' => 5000],
                'fabric_pattern' => ['name' => 'Fabric Pattern', 'categories' => ['fabric'], 'tags' => ['cloth'], 'download_count' => 9000],
            ]),
            'ambientcg.com/api/*' => $ambientCgDown ? Http::response('down', 500) : function (Request $request) {
                $q = $request->data()['q'] ?? '';

                return Http::response(['foundAssets' => $q === 'grass' ? [
                    ['assetId' => 'Grass005', 'displayName' => 'Grass 005', 'displayCategory' => 'Grass', 'tags' => ['5', 'grass', 'green', 'lawn'], 'previewImage' => ['256-PNG' => 'https://acg-media.example/Grass005.png']],
                    ['assetId' => 'bad id!', 'displayName' => 'Nope'],
                ] : ($q === 'moss' ? [
                    ['assetId' => 'Moss002', 'displayName' => 'Moss 002', 'displayCategory' => 'Moss', 'tags' => ['moss']],
                    ['assetId' => 'Grass005', 'displayName' => 'Grass 005 (duplicate)', 'tags' => []],
                ] : [])]);
            },
        ]);
    }

    /**
     * splat.u8 with the given share of texels fully painted per slot.
     *
     * @param  array<int, float>  $shares  slot → fraction
     */
    private function writeSplat(Map $map, array $shares): void
    {
        $texels = $map->resolution ** 2;
        $bytes = '';
        $done = 0;
        foreach ($shares as $slot => $share) {
            $n = $slot === array_key_last($shares) ? $texels - $done : (int) round($texels * $share);
            $texel = str_repeat("\0", $slot).chr(255).str_repeat("\0", 7 - $slot);
            $bytes .= str_repeat($texel, $n);
            $done += $n;
        }
        app(TerrainStorage::class)->write($map, 'splatmap', $bytes);
    }

    private function writeTerrain(Map $map): void
    {
        $res = $map->resolution;
        $cell = $map->size / ($res - 1);
        $heights = [];
        for ($row = 0; $row < $res; $row++) {
            for ($col = 0; $col < $res; $col++) {
                // Constant 30° slope along x.
                $heights[] = 100 + $col * $cell * tan(deg2rad(30));
            }
        }
        app(TerrainStorage::class)->write($map, 'heightmap', TerrainStorage::packFloats($heights));
        // 60 % grassland, 40 % tree cover
        $n = $res * $res;
        $grass = (int) round($n * 0.6);
        app(TerrainStorage::class)->write($map, 'landcover', str_repeat(chr(30), $grass).str_repeat(chr(10), $n - $grass));
    }

    public function test_plan_covers_every_used_slot_and_is_validated_and_clamped(): void
    {
        $this->configureAi();
        $this->fakeCatalogues();
        $this->writeTerrain($this->map);
        $this->writeSplat($this->map, [0 => 0.7, 3 => 0.2, 7 => 0.1]);
        $this->map->layers()->whereIn('slot', [5, 6])->delete();

        $this->fakeOpenRouter(chat: "```json\n".json_encode([
            'summary' => 'Julian Alps valley: meadows, beech forest, limestone.',
            'notes' => ['Consider fewer layers on low-end GPUs.', ['nested' => 'dropped']],
            'hacker' => 'ignored',
            'layers' => [
                ['slot' => 0, 'action' => 'change', 'name' => 'Valley grass', 'reason' => 'Base', 'evil' => true,
                    'material' => ['type' => 'library', 'material_id' => $this->grass->id],
                    'settings' => ['texture_scale' => 999, 'tint' => '#AABBCC', 'roughness_scale' => -3, 'normal_strength' => 1.25,
                        'auto_min_height' => -99999, 'auto_max_height' => 99999, 'auto_min_slope' => 50, 'auto_max_slope' => 10, 'auto_priority' => 99, 'bogus' => 1]],
                ['slot' => 0, 'action' => 'remove'],
                ['slot' => 1, 'action' => 'remove', 'reason' => 'Redundant with grass'],
                ['slot' => 2, 'action' => 'change', 'name' => 'Beech litter', 'material' => ['type' => 'import', 'source' => 'polyhaven', 'ref' => 'forest_leaves_02', 'resolution' => '8k']],
                ['slot' => 3, 'action' => 'change', 'name' => 'Limestone', 'material' => ['type' => 'import', 'source' => 'polyhaven', 'ref' => 'aerial_rocks_01'],
                    'settings' => ['auto_min_slope' => '35', 'auto_priority' => '7']],
                ['slot' => 4, 'action' => 'change', 'material' => ['type' => 'import', 'source' => 'polyhaven', 'ref' => 'not_offered']],
                ['slot' => 5, 'action' => 'remove'],
                ['slot' => 6, 'action' => 'add', 'name' => 'Moss', 'material' => ['type' => 'import', 'source' => 'ambientcg', 'ref' => 'Moss002', 'resolution' => '1k'],
                    'settings' => ['texture_scale' => 2]],
                ['slot' => 7, 'action' => 'add', 'name' => 'Karst rock', 'reason' => 'Nothing fits', 'material' => ['type' => 'generate', 'prompt' => 'pale karst limestone with cracks', 'category' => 'lava']],
                ['slot' => 9, 'action' => 'add', 'name' => 'Out of range'],
                'not an array',
            ],
            'landcover_mapping' => ['10' => 2, '30' => 0, '40' => 1, '999' => 3],
        ])."\n```");

        $response = $this->postJson("/api/maps/{$this->map->slug}/ai/suggest-materials", ['direction' => 'Autumn look, fewer layers'])
            ->assertOk()
            ->assertJsonPath('summary', 'Julian Alps valley: meadows, beech forest, limestone.')
            ->assertJsonPath('notes', ['Consider fewer layers on low-end GPUs.'])
            ->assertJsonMissingPath('hacker')
            ->assertJsonPath('layers.*.slot', [0, 1, 2, 3, 4, 6, 7])
            ->assertJsonPath('layers.*.action', ['change', 'remove', 'change', 'change', 'keep', 'add', 'change'])
            ->assertJsonPath('layers.0.name', 'Valley grass')
            ->assertJsonPath('layers.0.material.type', 'library')
            ->assertJsonPath('layers.0.material.name', 'Lush grass')
            ->assertJsonPath('layers.0.settings', [
                'texture_scale' => 200, 'tint' => '#aabbcc', 'roughness_scale' => 0, 'normal_strength' => 1.25,
                'auto_min_height' => -900, 'auto_max_height' => 1900, 'auto_min_slope' => 10, 'auto_max_slope' => 50, 'auto_priority' => 10,
            ])
            ->assertJsonPath('layers.0.current.coverage', 70)
            ->assertJsonPath('layers.0.current.material.type', 'procedural')
            ->assertJsonPath('layers.1.material', null)
            ->assertJsonPath('layers.1.current.coverage', 0)
            ->assertJsonPath('layers.2.material.type', 'import')
            ->assertJsonPath('layers.2.material.resolution', '2k')
            ->assertJsonPath('layers.2.material.thumbnail_url', 'https://cdn.polyhaven.com/asset_img/thumbs/forest_leaves_02.png?width=256&height=256')
            // Measured scan size.
            ->assertJsonPath('layers.2.settings.texture_scale', 2.7)
            // Aerial scan → ground-level size for its category, not 40 m.
            ->assertJsonPath('layers.3.material.aerial', true)
            ->assertJsonPath('layers.3.settings.texture_scale', 5)
            ->assertJsonPath('layers.3.settings.auto_min_slope', 35)
            ->assertJsonPath('layers.3.settings.auto_priority', 7)
            ->assertJsonPath('layers.3.current.coverage', 20)
            // Import of a ref that was not offered → current material; nothing changes → keep.
            ->assertJsonPath('layers.4.material.type', 'procedural')
            ->assertJsonPath('layers.5.current', null)
            ->assertJsonPath('layers.5.material.source', 'ambientcg')
            ->assertJsonPath('layers.5.material.tile_size', null)
            ->assertJsonPath('layers.5.settings.texture_scale', 2)
            // "add" on an occupied slot → change; invalid category guessed from the prompt.
            ->assertJsonPath('layers.6.material', ['type' => 'generate', 'prompt' => 'pale karst limestone with cracks', 'category' => 'rock'])
            ->assertJsonPath('layers.6.settings.texture_scale', 5)
            ->assertJsonPath('layers.6.current.coverage', 10)
            ->assertJsonPath('estimate', ['imports' => 3, 'generations' => 1, 'generation_note' => 'charged to your OpenRouter credits'])
            ->assertJsonPath('unavailable_sources', []);

        // Land cover: removed slot 1 and unknown classes ignored, the rest from name defaults.
        $mapping = $response->json('landcover_mapping');
        $this->assertSame(2, $mapping['10']);
        $this->assertSame(0, $mapping['30']);
        $this->assertNotSame(1, $mapping['40']);
        $this->assertArrayNotHasKey('999', $mapping);
        $this->assertNotContains(1, $mapping);

        $prompt = Http::recorded(fn (Request $r) => str_ends_with($r->url(), '/chat/completions'))->first()[0]->data()['messages'][1]['content'][0]['text'];
        $this->assertStringContainsString('"lat": 46.36', $prompt);
        $this->assertStringContainsString('"30 grassland": 60', $prompt);
        $this->assertStringContainsString('"p50": 30', $prompt);
        $this->assertStringContainsString('"painted_percent": 70', $prompt);
        $this->assertStringContainsString('id='.$this->grass->id.' | Lush grass | grass | 2.5m', $prompt);
        $this->assertStringContainsString('polyhaven:forest_leaves_02 | Forest Leaves 02 | forest | 2.7m', $prompt);
        $this->assertStringContainsString('polyhaven:aerial_rocks_01 | Aerial Rocks 01 | rock | 30m | AERIAL', $prompt);
        $this->assertStringContainsString('polyhaven:tiny_gravel | Tiny Gravel | gravel | 0.5m', $prompt);
        $this->assertStringContainsString('ambientcg:Grass005 | Grass 005 | grass | size unknown', $prompt);
        $this->assertStringNotContainsString('brick_wall', $prompt);
        $this->assertStringNotContainsString('fabric_pattern', $prompt);
        $this->assertStringContainsString('Autumn look, fewer layers', $prompt);
    }

    public function test_plan_keeps_unmentioned_layers_and_never_removes_every_layer(): void
    {
        $this->configureAi();
        $this->fakeCatalogues();
        $this->writeSplat($this->map, [0 => 0.3, 4 => 0.7]);

        $this->fakeOpenRouter(extra: ['openrouter.ai/api/v1/chat/completions' => Http::sequence()
            ->push($this->chatResponse(['summary' => 'Remove everything', 'layers' => array_map(fn ($slot) => ['slot' => $slot, 'action' => 'remove'], range(0, 7))]))
            ->push($this->chatResponse(['summary' => 'Only slot 0', 'layers' => [['slot' => 0, 'action' => 'change', 'name' => 'Grass']]])),
        ]);

        $this->postJson("/api/maps/{$this->map->slug}/ai/suggest-materials")
            ->assertOk()
            ->assertJsonCount(8, 'layers')
            ->assertJsonPath('layers.4.action', 'keep')
            ->assertJsonPath('layers.0.action', 'remove')
            ->assertJsonPath('estimate.imports', 0);

        $this->postJson("/api/maps/{$this->map->slug}/ai/suggest-materials")
            ->assertOk()
            ->assertJsonPath('layers.*.action', array_fill(0, 8, 'keep'))
            ->assertJsonPath('layers.3.reason', 'Not part of the plan — left as it is.');
    }

    public function test_plan_reports_unreachable_sources_and_validates_direction(): void
    {
        $this->configureAi();
        $this->fakeCatalogues(ambientCgDown: true, polyHavenDown: true);
        $this->fakeOpenRouter(chat: ['summary' => 'x', 'layers' => [
            ['slot' => 1, 'action' => 'change', 'material' => ['type' => 'import', 'source' => 'polyhaven', 'ref' => 'forest_leaves_02']],
        ]]);

        $this->postJson("/api/maps/{$this->map->slug}/ai/suggest-materials")
            ->assertOk()
            ->assertJsonPath('unavailable_sources', ['Poly Haven', 'ambientCG'])
            // Not offered (catalogue unavailable) → current material, nothing changes → keep.
            ->assertJsonPath('layers.1.action', 'keep');

        $this->postJson("/api/maps/{$this->map->slug}/ai/suggest-materials", ['direction' => str_repeat('x', 501)])->assertStatus(422);
    }

    public function test_candidate_catalogue_filters_dedupes_and_caps(): void
    {
        $this->fakeCatalogues();
        app(MaterialLibrary::class)->create(['name' => 'Rock Face 03', 'category' => 'rock', 'source' => 'polyhaven', 'source_ref' => 'rock_face_03', 'status' => 'ready', 'albedo_path' => 'a.jpg']);
        app(MaterialLibrary::class)->create(['name' => 'Broken', 'category' => 'rock', 'status' => 'failed']);

        $catalogue = app(MaterialCandidates::class)->catalogue();

        $this->assertSame(['Lush grass', 'Rock Face 03'], array_column($catalogue['library'], 'name'));
        $refs = array_map(fn ($c) => $c['source'].':'.$c['ref'], $catalogue['import']);
        // Sorted by popularity, terrain only, already imported refs are library entries.
        $this->assertSame(['polyhaven:forest_leaves_02', 'polyhaven:aerial_rocks_01', 'polyhaven:tiny_gravel', 'ambientcg:Grass005', 'ambientcg:Moss002'], $refs);
        $leaves = $catalogue['import'][0];
        $this->assertSame(['leaves', 'autumn', 'forest', 'ground', 'brown', 'dry'], $leaves['tags']);
        $this->assertSame([2.7, false, 'forest'], [$leaves['tile_size'], $leaves['aerial'], $leaves['category']]);
        $this->assertSame([30.0, true], [$catalogue['import'][1]['tile_size'], $catalogue['import'][1]['aerial']]);
        $this->assertSame(0.5, $catalogue['import'][2]['tile_size']);
        $this->assertSame(['grass', 'green', 'lawn'], $catalogue['import'][3]['tags']);
        $this->assertNull($catalogue['import'][3]['tile_size']);
        $this->assertSame([], $catalogue['unavailable']);

        // ambientCG searches are cached for a day.
        $count = count(Http::recorded(fn (Request $r) => str_contains($r->url(), 'ambientcg.com')));
        $this->assertSame(count(MaterialCandidates::AMBIENTCG_QUERIES), $count);
        app()->forgetInstance(MaterialCandidates::class);
        app(MaterialCandidates::class)->catalogue();
        $this->assertSame($count, count(Http::recorded(fn (Request $r) => str_contains($r->url(), 'ambientcg.com'))));
    }

    public function test_terrain_analysis_computes_coverage_and_slopes(): void
    {
        $map = Map::factory()->create(['resolution' => 5, 'size' => 8]);
        $storage = app(TerrainStorage::class);
        $analysis = app(TerrainAnalysis::class);

        $this->assertNull($analysis->coverage($map));
        $this->assertNull($analysis->relief($map));

        $texel = fn (array $w) => pack('C8', ...array_pad($w, 8, 0));
        // 25 texels: 20 × slot 0, 3 × half slot 1 / half slot 2, 2 × slot 7
        $storage->write($map, 'splatmap', str_repeat($texel([255]), 20).str_repeat($texel([0, 128, 127]), 3).str_repeat($texel([0, 0, 0, 0, 0, 0, 0, 255]), 2));
        $coverage = $analysis->coverage($map);
        $this->assertSame([80.0, 6.0, 6.0, 0.0, 0.0, 0.0, 0.0, 8.0], array_map(fn ($v) => round($v), $coverage));
        $this->assertEqualsWithDelta(100, array_sum($coverage), 0.2);

        // 2 m cells, height rising 2 m per cell → 45°.
        $heights = [];
        for ($i = 0; $i < 25; $i++) {
            $heights[] = ($i % 5) * 2.0;
        }
        $storage->write($map, 'heightmap', TerrainStorage::packFloats($heights));
        $relief = $analysis->relief($map);
        $this->assertEqualsWithDelta(45, $relief['slope_deg']['p50'], 0.01);
        $this->assertSame(100.0, $relief['steep_percent']['over_30']);
        $this->assertSame(0.0, $relief['steep_percent']['over_45']);
    }

    public function test_applying_a_plan_updates_removes_imports_and_generates(): void
    {
        Queue::fake();
        $this->configureAi();
        $this->map->layers()->where('slot', 6)->delete();
        $rock = app(MaterialLibrary::class)->create(['name' => 'Rock Face 03', 'category' => 'rock', 'source' => 'polyhaven', 'source_ref' => 'rock_face_03', 'tile_size' => 2.7, 'status' => 'ready', 'albedo_path' => 'a.jpg']);
        $kept = $this->map->layers()->where('slot', 4)->sole()->only(['name', 'texture_scale', 'tint']);

        $leaves = ['type' => 'import', 'source' => 'polyhaven', 'ref' => 'forest_leaves_02', 'resolution' => '2k', 'name' => 'Forest Leaves 02', 'category' => 'forest', 'tile_size' => 2.7];

        $this->post("/maps/{$this->map->slug}/ai/apply-suggestion", [
            'layers' => [
                ['slot' => 0, 'action' => 'change', 'name' => 'Valley grass', 'material' => ['type' => 'library', 'material_id' => $this->grass->id],
                    'settings' => ['texture_scale' => 999, 'tint' => '#EEFFEE', 'roughness_scale' => 1.1, 'normal_strength' => 0.9, 'auto_priority' => 0, 'auto_min_slope' => null]],
                ['slot' => 1, 'action' => 'remove'],
                ['slot' => 2, 'action' => 'change', 'name' => 'Forest floor', 'material' => $leaves, 'settings' => ['texture_scale' => 2.7]],
                ['slot' => 3, 'action' => 'change', 'name' => 'Rock', 'material' => ['type' => 'import', 'source' => 'polyhaven', 'ref' => 'rock_face_03']],
                ['slot' => 4, 'action' => 'keep', 'name' => 'Ignored', 'settings' => ['texture_scale' => 50]],
                ['slot' => 5, 'action' => 'change', 'name' => 'Bog', 'material' => $leaves],
                ['slot' => 6, 'action' => 'add', 'name' => 'Peat', 'material' => ['type' => 'generate', 'prompt' => 'dark wet peat with sphagnum moss', 'category' => 'mud'],
                    'settings' => ['auto_min_height' => 50, 'auto_max_height' => 300, 'auto_priority' => 3]],
                ['slot' => 7, 'action' => 'change', 'name' => 'Plain snow', 'material' => ['type' => 'procedural']],
            ],
            'repaint' => 'none',
        ])->assertRedirect()->assertSessionHasNoErrors()
            ->assertInertiaFlash('toast.message', 'Updated 5 layers, added 1, removed 1, importing 1 material, generating 1. New materials appear in the game when ready.');

        $layers = $this->map->layers()->get()->keyBy('slot');
        $this->assertSame([0, 2, 3, 4, 5, 6, 7], $layers->keys()->all());
        $this->assertSame(['Valley grass', $this->grass->id, '#eeffee', 200.0, 1.1, 0.9, null], [
            $layers[0]->name, $layers[0]->material_id, $layers[0]->tint, $layers[0]->texture_scale, $layers[0]->roughness_scale, $layers[0]->normal_strength, $layers[0]->auto_min_slope,
        ]);

        // Import dedupe: rock_face_03 is already in the library, forest_leaves_02 is imported once for two slots.
        $this->assertSame($rock->id, $layers[3]->material_id);
        $this->assertSame(2.7, $layers[3]->texture_scale);
        $imported = Material::query()->where('source_ref', 'forest_leaves_02')->sole();
        $this->assertSame(['processing', 'forest', 'CC0', 2.7], [$imported->status, $imported->category, $imported->license, $imported->tile_size]);
        $this->assertSame([$imported->id, $imported->id], [$layers[2]->material_id, $layers[5]->material_id]);
        Queue::assertPushed(ImportMaterial::class, 1);
        Queue::assertPushed(ImportMaterial::class, fn (ImportMaterial $job) => $job->material->is($imported) && $job->source === 'polyhaven' && $job->ref === 'forest_leaves_02' && $job->resolution === '2k');

        $generated = Material::query()->where('source', 'ai')->sole();
        $this->assertSame(['Peat', $generated->id, 3, 300.0, 50.0, 2.0], [
            $layers[6]->name, $layers[6]->material_id, $layers[6]->auto_priority, $layers[6]->auto_max_height, $layers[6]->auto_min_height, $layers[6]->texture_scale,
        ]);
        $this->assertNull($layers[6]->toGameArray()['material'], 'The game ignores the material until it is ready.');
        Queue::assertPushed(GenerateMaterial::class, fn (GenerateMaterial $job) => $job->material->is($generated) && $job->options['prompt'] === 'dark wet peat with sphagnum moss');

        $this->assertSame($kept, $layers[4]->only(['name', 'texture_scale', 'tint']));
        $this->assertNull($layers[7]->material_id);
        $this->assertSame('Plain snow', $layers[7]->name);

        $this->post("/maps/{$this->map->slug}/ai/apply-suggestion", ['layers' => [['slot' => 11, 'action' => 'change']]])->assertSessionHasErrors('layers.0.slot');
        $this->post("/maps/{$this->map->slug}/ai/apply-suggestion", ['layers' => [['slot' => 1, 'action' => 'explode']]])->assertSessionHasErrors('layers.0.action');
        $this->post("/maps/{$this->map->slug}/ai/apply-suggestion", ['layers' => [['slot' => 1, 'action' => 'change', 'material' => ['type' => 'import', 'source' => 'polyhaven', 'ref' => '../../etc']]]])->assertSessionHasErrors('layers.0.material.ref');
    }

    public function test_applying_never_deletes_the_last_layer(): void
    {
        $this->map->layers()->where('slot', '>', 0)->delete();

        $this->post("/maps/{$this->map->slug}/ai/apply-suggestion", ['layers' => [['slot' => 0, 'action' => 'remove']]])
            ->assertRedirect()
            ->assertInertiaFlash('toast.type', 'warning')
            ->assertInertiaFlash('toast.message', 'No layer changes. The last layer was kept — a map needs at least one.');

        $this->assertSame(1, $this->map->layers()->count());

        // Removing the old one while adding another in the same plan is fine.
        $this->post("/maps/{$this->map->slug}/ai/apply-suggestion", ['layers' => [
            ['slot' => 0, 'action' => 'remove'],
            ['slot' => 3, 'action' => 'add', 'name' => 'Rock', 'material' => ['type' => 'procedural']],
        ]])->assertRedirect();

        $this->assertSame([3], $this->map->layers()->pluck('slot')->all());
        $this->assertSame('#5c574f', TerrainLayer::query()->sole()->color, 'Added layers start from the default definition of the slot.');
    }

    public function test_applying_saves_the_landcover_mapping_and_repaints(): void
    {
        Queue::fake();
        $this->writeTerrain($this->map);
        $this->writeSplat($this->map, [0 => 1.0]);
        $revision = $this->map->revision;

        $this->post("/maps/{$this->map->slug}/ai/apply-suggestion", [
            'layers' => [['slot' => 1, 'action' => 'remove']],
            'landcover_mapping' => ['10' => 2, '30' => 1, '40' => 3],
            'repaint' => 'landcover',
        ])->assertRedirect()->assertSessionHasNoErrors()
            ->assertInertiaFlash('toast.message', 'Removed 1. Land cover mapping saved. Repainting terrain from land cover…');

        $mapping = $this->map->refresh()->landcover_mapping;
        $this->assertSame(2, $mapping[10]);
        $this->assertSame(3, $mapping[40]);
        $this->assertNotSame(1, $mapping[30], 'Removed slots are never mapped.');
        Queue::assertPushed(ApplyLandCover::class, fn (ApplyLandCover $job) => $job->map->is($this->map));

        // auto_rules: drop the splat map so the game auto-paints from the rules.
        $this->post("/maps/{$this->map->slug}/ai/apply-suggestion", ['layers' => [], 'repaint' => 'auto_rules'])
            ->assertInertiaFlash('toast.message', 'No layer changes. Terrain will be repainted from the new rules next time the studio opens.');
        $this->assertFalse(app(TerrainStorage::class)->exists($this->map, 'splatmap'));
        $this->assertSame($revision + 1, $this->map->refresh()->revision);

        // Land cover repaint on a flat map is refused (warning), nothing dispatched.
        Queue::fake();
        $flat = Map::factory()->create();
        DefaultTerrainLayers::createFor($flat);
        $this->post("/maps/{$flat->slug}/ai/apply-suggestion", ['layers' => [], 'landcover_mapping' => ['10' => 2], 'repaint' => 'landcover'])
            ->assertInertiaFlash('toast.type', 'warning');
        $this->assertNull($flat->refresh()->landcover_mapping);
        Queue::assertNothingPushed();
    }
}
