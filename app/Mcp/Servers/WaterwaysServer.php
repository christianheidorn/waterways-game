<?php

namespace App\Mcp\Servers;

use App\Mcp\Tools\AddTerrainLayer;
use App\Mcp\Tools\ApplyBiome;
use App\Mcp\Tools\ControlEditor;
use App\Mcp\Tools\CreateMap;
use App\Mcp\Tools\DeleteTerrainLayer;
use App\Mcp\Tools\GetEditorState;
use App\Mcp\Tools\GetMap;
use App\Mcp\Tools\GetProjectOverview;
use App\Mcp\Tools\GetSettings;
use App\Mcp\Tools\ListBiomes;
use App\Mcp\Tools\ListFoliageTypes;
use App\Mcp\Tools\ListMaterials;
use App\Mcp\Tools\ManageSnapshots;
use App\Mcp\Tools\RegenerateTerrain;
use App\Mcp\Tools\SaveFoliageType;
use App\Mcp\Tools\SaveLayerAsBiome;
use App\Mcp\Tools\SetCamera;
use App\Mcp\Tools\TakeScreenshot;
use App\Mcp\Tools\UpdateEnvironment;
use App\Mcp\Tools\UpdateGameSettings;
use App\Mcp\Tools\UpdateMap;
use App\Mcp\Tools\UpdateTerrainLayer;
use Laravel\Mcp\Server;
use Laravel\Mcp\Server\Attributes\Instructions;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Attributes\Version;

#[Name('Waterways')]
#[Version('0.1.0')]
#[Instructions(<<<'MD'
Waterways is an open-world game with a map editor (Three.js in the browser, Laravel studio). This server lets you build and tune worlds.

Concepts
- Maps: square terrains (size in metres, resolution = height samples per edge), procedural or real-world. World coordinates are metres with y up; x runs west → east, z north → south, the map centre is (0, 0).
- Terrain layers: up to 8 slots per map, each a ground material (PBR material or procedural colours) that is painted onto the terrain, with auto-paint rules (height / slope ranges) and ground cover (foliage types that grow by themselves wherever the layer is painted: grass, flowers, rocks, even forests with groves and spacing).
- Biomes: reusable layers (look + ground cover). apply_biome on a slot makes that painted area grow the whole biome.
- Foliage types: the shared plant / rock library (kind, model, size, density, placement rules, visible distance).
- Environment (per map): weather, time of day, sun, clouds, fog, wind, water look. Game settings (global): player, graphics, editor.

Working live
- World edits, screenshots and editor control need the map open in the user's editor (Studio → Maps → map → Open Studio). get_project_overview shows which map is open. If none is, ask the user to open it; settings and library changes work without it and appear live when it is open.
- Edits made inside the editor stay unsaved until control_editor action "save". Server-side changes (layers, environment, biomes, foliage types, settings) are saved immediately.
- Look before and after you change things: take_screenshot (views overview / top_down / a position, and analysis view modes: layers, slope, height, density, lighting, wireframe).

Safety
- Before an agent tool changes a map, a snapshot is taken automatically (at most every 10 minutes); map_snapshots lists, creates and restores them. regenerate_terrain discards the user's terrain work: confirm with them first.
- Prefer small, verifiable steps; tell the user what you changed.
MD)]
class WaterwaysServer extends Server
{
    /** Every tool in one tools/list page (clients then see the whole tool set at once). */
    public int $defaultPaginationLength = 50;

    protected array $tools = [
        GetProjectOverview::class,
        GetMap::class,
        GetSettings::class,
        ListFoliageTypes::class,
        ListBiomes::class,
        ListMaterials::class,
        GetEditorState::class,
        TakeScreenshot::class,
        SetCamera::class,
        ControlEditor::class,
        CreateMap::class,
        UpdateMap::class,
        RegenerateTerrain::class,
        UpdateEnvironment::class,
        UpdateGameSettings::class,
        UpdateTerrainLayer::class,
        AddTerrainLayer::class,
        DeleteTerrainLayer::class,
        ApplyBiome::class,
        SaveLayerAsBiome::class,
        SaveFoliageType::class,
        ManageSnapshots::class,
    ];
}
