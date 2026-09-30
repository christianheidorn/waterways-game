<?php

namespace App\Mcp\Tools;

use App\Mcp\EditorBridge;
use App\Models\AgentSession;
use App\Models\Biome;
use App\Models\Character;
use App\Models\FoliageType;
use App\Models\Map;
use App\Models\Material;
use App\Support\AiSettings;
use App\Support\GameSettingsRepository;
use Illuminate\Support\Carbon;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('get_project_overview')]
#[Description('Start here. Lists the maps (with generation status), the libraries (foliage types, biomes, materials, characters), the graphics preset, which AI services are configured, and which map is open in an editor (needed for live editing and screenshots).')]
#[IsReadOnly]
class GetProjectOverview extends WaterwaysTool
{
    protected function run(Request $request): Response
    {
        $ai = app(AiSettings::class);

        return $this->json([
            'maps' => Map::query()->orderByDesc('is_default')->orderBy('name')->get()->map(fn (Map $m) => [
                'id' => $m->id,
                'slug' => $m->slug,
                'name' => $m->name,
                'source' => $m->source->value,
                'size_m' => $m->size,
                'resolution' => $m->resolution,
                'terrain_status' => $m->terrain_status->value,
                'is_default' => $m->is_default,
                'layers' => $m->layers()->count(),
            ])->values(),
            'open_editors' => AgentSession::query()
                ->with('map:id,slug,name')
                ->where('last_seen_at', '>=', Carbon::now()->subSeconds(EditorBridge::SESSION_TIMEOUT))
                ->get()
                ->map(fn (AgentSession $s) => ['map' => $s->map?->slug, 'mode' => $s->mode])
                ->values(),
            'libraries' => [
                'foliage_types' => FoliageType::query()->count(),
                'biomes' => Biome::query()->count(),
                'materials' => Material::query()->where('status', 'ready')->count(),
                'characters' => Character::query()->count(),
            ],
            'graphics_preset' => app(GameSettingsRepository::class)->get('graphics')['quality_preset'] ?? null,
            'ai_services' => ['openrouter' => $ai->configured(), 'meshy' => $ai->meshyConfigured()],
        ]);
    }
}
