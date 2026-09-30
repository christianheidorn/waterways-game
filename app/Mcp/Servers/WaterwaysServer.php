<?php

namespace App\Mcp\Servers;

use App\Mcp\Tools\AddTerrainLayer;
use App\Mcp\Tools\ApplyBiome;
use App\Mcp\Tools\BakeFoliageAsset;
use App\Mcp\Tools\CloseEditor;
use App\Mcp\Tools\ControlEditor;
use App\Mcp\Tools\CreateMap;
use App\Mcp\Tools\DeleteTerrainLayer;
use App\Mcp\Tools\EditFoliage;
use App\Mcp\Tools\EditWater;
use App\Mcp\Tools\GenerateImage;
use App\Mcp\Tools\GenerateMaterial;
use App\Mcp\Tools\GenerateModel;
use App\Mcp\Tools\GetAssetStatus;
use App\Mcp\Tools\GetEditorState;
use App\Mcp\Tools\GetMap;
use App\Mcp\Tools\GetMapImage;
use App\Mcp\Tools\GetProjectOverview;
use App\Mcp\Tools\GetRequest;
use App\Mcp\Tools\GetSettings;
use App\Mcp\Tools\ImportModel;
use App\Mcp\Tools\ListBiomes;
use App\Mcp\Tools\ListFoliageTypes;
use App\Mcp\Tools\ListMaterials;
use App\Mcp\Tools\ListPropModels;
use App\Mcp\Tools\ListProps;
use App\Mcp\Tools\ListRequests;
use App\Mcp\Tools\ManageSnapshots;
use App\Mcp\Tools\OpenEditor;
use App\Mcp\Tools\PaintTerrain;
use App\Mcp\Tools\PlaceProps;
use App\Mcp\Tools\RegenerateTerrain;
use App\Mcp\Tools\RemoveProps;
use App\Mcp\Tools\SampleTerrain;
use App\Mcp\Tools\SaveFoliageType;
use App\Mcp\Tools\SaveLayerAsBiome;
use App\Mcp\Tools\SculptTerrain;
use App\Mcp\Tools\SetCamera;
use App\Mcp\Tools\TakeScreenshot;
use App\Mcp\Tools\UpdateEnvironment;
use App\Mcp\Tools\UpdateGameSettings;
use App\Mcp\Tools\UpdateMap;
use App\Mcp\Tools\UpdateRequest;
use App\Mcp\Tools\UpdateTerrainLayer;
use Laravel\Mcp\Server;
use Laravel\Mcp\Server\Attributes\Instructions;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Attributes\Version;

#[Name('Waterways')]
#[Version('0.2.0')]
#[Instructions(<<<'MD'
Waterways is an open-world game with a map editor (Three.js in the browser, Laravel studio). This server lets you build and tune worlds.

Concepts
- Maps: square terrains (size in metres, resolution = height samples per edge), procedural or real-world. World coordinates are metres with y up; x runs west → east, z north → south, the map centre is (0, 0).
- Terrain layers: up to 8 slots per map, each a ground material (PBR material or procedural colours) that is painted onto the terrain, with auto-paint rules (height / slope ranges) and ground cover (foliage types that grow by themselves wherever the layer is painted: grass, flowers, rocks, even forests with groves and spacing).
- Biomes: reusable layers (look + ground cover). apply_biome on a slot makes that painted area grow the whole biome.
- Foliage types: the shared plant / rock library (kind, model, size, density, placement rules, visible distance).
- Environment (per map): weather, time of day, sun, clouds, fog, wind, water look. Game settings (global): player, graphics, editor.

Working live
- World edits, screenshots and editor control need the map open in the user's editor (Studio → Maps → map → Open Studio). get_project_overview shows which map is open. If none is, start a hidden editor with open_editor (runs unattended; close_editor when done) or ask the user to open it; settings and library changes work without it and appear live when it is open.
- Edits made inside the editor stay unsaved until control_editor action "save". Server-side changes (layers, environment, biomes, foliage types, settings) are saved immediately.
- Look before and after you change things: take_screenshot (views overview / top_down / a position, and analysis view modes: layers, slope, height, density, lighting, wireframe).

Building the world (live in the open editor, each call one undo step, saved by default)
- Plan on get_map_image (top-down, labelled coordinate grid; kinds map, height, slope, layers, water; crop with `area`) and sample_terrain (exact heights / slopes along a line). Both read the saved map and need no editor.
- Shapes are world-metre outlines: circle, rect, polygon, path (with width) or map, with a soft `falloff` edge.
- sculpt_terrain: raise / lower, set_height, flatten, smooth, noise, terrace, hill (landforms: hills, massifs, ridges; negative = basins, valleys), erode, grade (road beds along paths).
- edit_water: lake (flood a basin to a level), river (along a path, downhill from its first point), erase.
- paint_terrain: paint layers (optionally only on matching slope / height); painted layers grow their ground cover, so apply a biome to a slot and paint it to plant forests, meadows, beaches.
- edit_foliage: scatter or clear individual plants in an area.
- A good order: landforms → water → paint layers / biomes → details; look (take_screenshot) after each step; control_editor undo reverts the last step.

Requests from the user
- The user can outline an area in the editor and ask for something to be built there (with a note, reference images and a screenshot). list_requests shows open ones; get_request gives everything (the outline works directly as a polygon shape); update_request reports in_progress / needs_input / done with a message and result screenshots.

Assets (3D models, images, materials)
- import_model brings a .glb into the project as a prop or foliage model: e.g. one you built with Blender MCP and exported to a file on this computer (metres, +Y up, pivot at the base).
- generate_image (OpenRouter), generate_material (PBR terrain materials from a prompt or an image) and generate_model (Meshy text / image to 3D) use the project's configured services and cost credits; generation runs in the background: poll get_asset_status.
- Foliage models must be baked (LODs) before use: bake_foliage_asset does it in the open editor.

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
        ListRequests::class,
        GetRequest::class,
        UpdateRequest::class,
        GetMapImage::class,
        SampleTerrain::class,
        TakeScreenshot::class,
        SetCamera::class,
        ControlEditor::class,
        SculptTerrain::class,
        PaintTerrain::class,
        EditWater::class,
        EditFoliage::class,
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
        PlaceProps::class,
        RemoveProps::class,
        ListProps::class,
        ManageSnapshots::class,
        ListPropModels::class,
        ImportModel::class,
        BakeFoliageAsset::class,
        GenerateImage::class,
        GenerateMaterial::class,
        GenerateModel::class,
        GetAssetStatus::class,
        OpenEditor::class,
        CloseEditor::class,
    ];
}
