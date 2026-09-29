<?php

namespace Database\Seeders;

use App\Enums\MapSource;
use App\Enums\TerrainStatus;
use App\Jobs\GenerateMapTerrain;
use App\Models\Map;
use App\Support\EnvironmentDefaults;
use App\Support\StarterBiomes;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Log;
use Throwable;

class DatabaseSeeder extends Seeder
{
    /**
     * Seed the starter foliage library and the first map.
     */
    public function run(): void
    {
        $this->call(FoliageTypeSeeder::class);

        if (! Map::query()->exists()) {
            $this->createStarterMap();
        }

        // Starter PBR materials (Poly Haven, CC0). Needs network; the studio works without them.
        try {
            Artisan::call('waterways:starter-materials', ['--resolution' => '1k'], $this->command?->getOutput());
        } catch (Throwable $e) {
            Log::warning('Starter materials could not be imported: '.$e->getMessage());
            $this->command?->warn('Starter materials skipped: '.$e->getMessage());
        }

        // After the foliage types and materials they are made of.
        StarterBiomes::install();
    }

    private function createStarterMap(): void
    {
        $map = Map::query()->create([
            'name' => 'Waterways Valley',
            'slug' => 'waterways-valley',
            'description' => 'The starter world: rolling hills, a river valley and a lake.',
            'source' => MapSource::Procedural,
            'resolution' => 513,
            'size' => 2048,
            'seed' => 1337,
            'environment' => EnvironmentDefaults::group()->defaults(),
            'terrain_status' => TerrainStatus::Queued,
            'is_default' => true,
        ]);

        GenerateMapTerrain::dispatchSync($map);
    }
}
