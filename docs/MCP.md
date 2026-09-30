# Waterways MCP server: let Claude build your world

Waterways includes an [MCP](https://modelcontextprotocol.io) server. AI agents such as Claude Desktop or Claude Code
can connect to it and do most of what you can do in the studio and the editor:

- set up and tune maps, terrain layers, biomes, foliage, weather and game settings;
- look at the world through screenshots;
- work live in the editor you have open, while you watch.

## Setup

The server runs on your machine as a local process started by the AI client:
`php artisan mcp:start waterways`. It uses the same database and storage as the studio. The studio must be
running as usual (for example `composer dev`), because the live editor talks to it.

**Claude Code:** in the project folder, run once:

```bash
claude mcp add waterways -- php artisan mcp:start waterways
```

Then start `claude` in the project folder. Add `--scope user` and the absolute path to `artisan` to use the server
from anywhere.

**Claude Desktop:** Settings → Developer → Edit Config, then add:

```json
{
    "mcpServers": {
        "waterways": {
            "command": "php",
            "args": [
                "/path/to/waterways-game/artisan",
                "mcp:start",
                "waterways"
            ]
        }
    }
}
```

Use absolute paths. If `php` is not on the PATH of desktop apps (for example with Herd), use the full path to the
PHP binary. Restart Claude Desktop afterwards.

**Other clients (HTTP):** set `WATERWAYS_MCP_TOKEN` in `.env`. The server is then also available at
`http://<studio-host>/mcp`, and requests must send `Authorization: Bearer <token>`. Without a token, the HTTP
endpoint does not exist.

You can connect other MCP servers at the same time, for example Blender MCP for modelling assets.

## Working live in the editor

Terrain edits, screenshots and editor control need the game engine, which runs in your browser. **Open the map in
the studio** (Maps → map → Open Studio) and keep the tab visible; browsers pause background tabs. The editor
checks the server about once a second for commands from agents, runs them in front of you and reports the result.
Changes to settings and libraries work without an open editor, and appear live when one is open.

- The agent sees which map is open (`get_project_overview`). Map tools default to that map.
- Edits made inside the editor stay unsaved until they are saved, by you or by the agent
  (`control_editor` action `save`), just like your own edits.
- If two tabs have the same map open, each command runs in exactly one of them.

## Safety

- **Local only.** The stdio server is a process on your machine. The HTTP endpoint needs a token.
- **API keys never leave the server.** Agents use the project's configured services; tools never return keys.
- **Snapshots.** Before an agent tool changes a map, the server takes an automatic snapshot (at most every
  10 minutes; the last 15 are kept). A snapshot holds the saved terrain, paint, water and foliage, plus the layers
  and environment. `map_snapshots` lists, creates and restores snapshots, and a restore first snapshots the
  current state, so it can be undone too.
- **Unsaved work is protected.** Restoring a snapshot or regenerating terrain reloads the open editor. If the
  editor has unsaved changes, the tool refuses until the agent saves them or you agree to drop them.
- `regenerate_terrain` and `delete_terrain_layer` are marked as destructive, so clients ask before using them.

## Tools

| Tool                                                                | What it does                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_project_overview`                                              | Maps, libraries, graphics preset, configured AI services, which map is open in an editor                                                                                                                                                                                                                    |
| `get_map`                                                           | Map settings, coordinate system, environment, the 8 layer slots (materials, auto-paint rules, ground cover), terrain statistics (height range, layer coverage, water), saved foliage counts, editor state                                                                                                   |
| `get_settings`                                                      | Fields (type, range, options, description) and current values of `environment` (per map), `player`, `graphics` or `editor`                                                                                                                                                                                  |
| `list_foliage_types`, `list_biomes`, `list_materials`               | The libraries                                                                                                                                                                                                                                                                                               |
| `get_editor_state`                                                  | Live: mode, camera, view mode, selected tool, unsaved changes, undo/redo, fps and draw calls                                                                                                                                                                                                                |
| `take_screenshot`                                                   | Live: renders the map from the current view, an `overview`, a `top_down` view (north up), the player start, or any position and target, optionally in an analysis view (layers, slope, height, foliage density, lighting only, wireframe). Returns the image and puts your camera back afterwards           |
| `set_camera`                                                        | Live: moves your editor camera, for example to show you something                                                                                                                                                                                                                                           |
| `control_editor`                                                    | Live: save, undo / redo, view mode, edit / play, auto paint                                                                                                                                                                                                                                                 |
| `create_map`, `regenerate_terrain`, `update_map`                    | New maps (procedural or real-world), terrain regeneration, name, description, player start, default map                                                                                                                                                                                                     |
| `update_environment`, `update_game_settings`                        | Weather, time of day, fog, …; player, graphics and editor settings                                                                                                                                                                                                                                          |
| `update_terrain_layer`, `add_terrain_layer`, `delete_terrain_layer` | Layer look, materials, auto-paint rules, ground cover                                                                                                                                                                                                                                                       |
| `apply_biome`, `save_layer_as_biome`                                | Biomes on layer slots, and new biomes from layers                                                                                                                                                                                                                                                           |
| `save_foliage_type`                                                 | Create or update foliage types                                                                                                                                                                                                                                                                              |
| `map_snapshots`                                                     | List, create and restore snapshots                                                                                                                                                                                                                                                                          |
| `get_map_image`                                                     | Top-down image of the saved map (north up) with a labelled coordinate grid in metres and the player start. Kinds: `map` (layer colours, hill shading, water, contours), `height`, `slope`, `layers` (legend), `water`; `area` crops to zoom in. No editor needed                                            |
| `sample_terrain`                                                    | Exact ground height, slope, water level and layers at points, or at even steps along a path (height profiles). No editor needed                                                                                                                                                                             |
| `sculpt_terrain`                                                    | Live: raise / lower, set height, flatten, smooth, noise, terrace, landforms (`hill`: hills, massifs following an outline, ridges along paths; negative for basins, valleys, craters; profiles dome / peak / plateau with natural roughness), erosion (hydraulic, thermal), `grade` (road beds along a path) |
| `paint_terrain`                                                     | Live: paint or erase a layer (slot or name) in a shape, optionally only on matching slope / height, with natural `breakup`. Painted layers grow their ground cover, so this plants biomes                                                                                                                   |
| `edit_water`                                                        | Live: `lake` floods a basin to a level (or `fill_to_rim`); if it would spill, it reports how high the basin holds and where it overflows. `river` carves a channel along a path, downhill from its first point. `erase` removes water                                                                       |
| `edit_foliage`                                                      | Live: `scatter` types in a shape (their rules, density, groves) or `clear` placed foliage (e.g. for clearings or roads)                                                                                                                                                                                     |
| `list_prop_models`                                                  | The prop model library (placeable objects) with status, size and tags                                                                                                                                                                                                                                       |
| `import_model`                                                      | Imports a glTF model from a local `path` (e.g. exported by Blender MCP), a `url` or `base64` (≤ 100 MB) as a **prop** (`props/{id}/model.glb`, size measured, ready at once) or a **foliage** asset (optionally with a foliage type; baked in the open editor right away)                                   |
| `bake_foliage_asset`                                                | Live: optimises a foliage asset waiting for its bake (LODs, impostor, thumbnail) in the open editor, as the studio's Foliage page does. Any open map works                                                                                                                                                  |
| `generate_image`                                                    | An image from the project's OpenRouter image model (purposes `reference`, `texture`, `sprite` or free), optionally guided by earlier images. Returns it and stores it under `agent-images/` with its local file path, for reuse (references, materials, Blender)                                            |
| `generate_material`                                                 | A PBR terrain material from a prompt (queued AI generation, like the studio) or from an image (processed right away); assign it with `update_terrain_layer`                                                                                                                                                 |
| `generate_model`                                                    | Meshy text / image to 3D in the background: props (stored as ready props), or foliage assets (also as OpenRouter plant cards)                                                                                                                                                                               |
| `get_asset_status`                                                  | Status, message and preview URLs of a prop model, foliage asset or material                                                                                                                                                                                                                                 |

### Shapes

World-editing tools take a `shape` in world metres (x west → east, z north → south, map centre 0, 0):
`circle` {center, radius}, `rect` {min, max}, `polygon` {points}, `path` {points, width} or `map`. The edit
has full effect inside the shape and fades out over `falloff` metres outside it, so edits blend into the
landscape.

Each world edit is one step in the editor's undo history. It is saved right away unless `save: false` is
passed, so map images and samples always show the result, and an automatic snapshot comes first.

A typical session goes like this:

1. **Plan:** look at `get_map_image` (kinds `height` and `slope`) and check lines with `sample_terrain`.
2. **Landforms:** hills, basins and valleys.
3. **Water:** lakes and rivers.
4. **Layers:** apply biomes to slots and paint them, and paint rock on steep ground.
5. **Details:** roads, clearings and scattered rocks.
6. **Check:** after each step, look with `take_screenshot` or `get_map_image`.

### Assets

Agents can make the assets they need and bring them into the game:

- **Blender:** with Blender MCP connected too, the agent models an object, exports it as `.glb` (metres, +Y up,
  pivot at the base) to a file, and imports it with `import_model` `path`. The MCP server runs on your machine, so it
  reads the file directly.
- **Images:** `generate_image` draws references (for modelling), textures or sprites with the project's OpenRouter
  key. Images are stored under `storage/app/public/agent-images/`; the result includes the local file path.
- **Materials:** `generate_material` from a prompt or from an image, then `update_terrain_layer` `material_id`.
- **Meshy:** `generate_model` creates props or foliage models with the project's Meshy key.
- **Foliage bake:** foliage models are optimised in a browser. The studio's Foliage page does this by itself;
  for agents, the open editor does it too (`bake_foliage_asset`, and `import_model` when an editor is open).

Generation runs in the queue worker (`composer dev` starts it); agents poll `get_asset_status`. API keys never
reach the agent; without a key, the tools say which one to add under Settings → AI.

## How it works

- `routes/ai.php` registers the server: `App\Mcp\Servers\WaterwaysServer`, with tools in `app/Mcp/Tools`.
- **Live bridge** (`App\Mcp\EditorBridge`): a tool that needs the engine queues a command in `agent_commands`
  and waits for the result.
    - The open editor (`resources/game/core/AgentBridge.ts`) polls `POST /api/maps/{map}/agent/poll` and claims
      pending commands.
    - It runs them (`resources/game/core/AgentCommands.ts`) and posts results to `/agent/commands/{id}`.
    - Each poll also records the session and a little state in `agent_sessions`.
    - The MCP process and the web server share only the database, so no websockets or extra services are needed.
- **Snapshots** (`App\Mcp\MapSnapshots`, table `map_snapshots`): stored assets are copied to
  `storage/app/private/maps/{id}/snapshots/{snapshot}`, and layers and settings are kept as JSON.
- **World edits:** the engine side is in `resources/game/editor/agent`.
    - `shapes.ts` rasterises shapes into weights on the height grid, with relief and distance-along-path
      values.
    - `worldEdits.ts` holds the operations, including lake flooding with spill-point detection and river
      carving.
    - `runWorldEdit.ts` runs each edit as one undo step (`Editor.scriptedEdit`).
- **Map images and samples** (`App\Mcp\TerrainData`, `App\Mcp\MapImageRenderer`) read the saved grids and
  are drawn with PHP's GD extension.
- **Assets** (`App\Mcp\Assets`): `ModelSource` checks and loads models (extension, size, glTF magic and JSON),
  `GltfInspector` measures them from the POSITION accessor bounds through the node hierarchy, `EditorBakes` runs
  the foliage bake in an editor (`bake_foliage_asset` command → `editor/agent/bakeFoliageAsset.ts`, which runs
  `tools/FoliageBaker.ts` and uploads to `/api/foliage/assets/{id}/bake`), and `AgentImages` stores generated
  images. Meshy props are made by `App\Jobs\GenerateMeshyProp`; everything else reuses the studio's services and
  jobs.
- **Tests:** `tests/Feature/Mcp` drives every tool through the MCP test client. A fake editor answers
  bridge commands.

## Roadmap

| Phase                    | Scope                                                                                                                                                                                                                                                       | Status   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **1. Server core**       | Project, map, layer, biome, foliage type and settings tools, the live editor bridge, screenshots and analysis views, snapshots, setup for Claude Desktop / Code                                                                                             | **Done** |
| **2. World building**    | Terrain, water, paint and foliage operations on shapes (circles, rectangles, outlines, paths), top-down map images with coordinate grids, terrain sampling                                                                                                  | **Done** |
| **3. Claude requests**   | An editor tool to outline an area, attach a reference image and a note. Agents list open requests with world coordinates and a screenshot, build them, and mark them done with before / after images for review                                             | Next     |
| **4. Props and assets**  | A props system in the game (placing models with snapping and rotation, later collision), GLB import (e.g. from Blender MCP) as props or foliage types, image and texture generation through the project's OpenRouter key, Meshy generation, placement tools | Planned  |
| **5. Headless sessions** | The server starts its own hidden editor when none is open, so agents can build and render unattended                                                                                                                                                        | Planned  |

Phase 4, assets: done (model import as props or foliage, foliage baking in the editor, image, material and Meshy model generation, asset status).
