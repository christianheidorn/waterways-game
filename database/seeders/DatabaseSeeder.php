<?php

namespace Database\Seeders;

use App\Enums\MapSource;
use App\Enums\TerrainStatus;
use App\Jobs\GenerateMapTerrain;
use App\Models\Map;
use App\Support\EnvironmentDefaults;
use Illuminate\Database\Seeder;

class DatabaseSeeder extends Seeder
{
    /**
     * Seed the starter foliage library and the first map.
     */
    public function run(): void
    {
        $this->call(FoliageTypeSeeder::class);

        if (Map::query()->exists()) {
            return;
        }

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
