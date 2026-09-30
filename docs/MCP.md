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

## Hidden editors (unattended work)

When nobody has the map open, an agent can start its own hidden editor with `open_editor`: the server runs a
headless Chrome-family browser on this machine that shows the map's editor (the game page in edit mode with
`?agent=1`). Agents can then build and take screenshots unattended, for example overnight. `close_editor` stops it.

- **Browser:** Google Chrome, Chromium, Microsoft Edge or Brave. The server finds it by itself (macOS apps in
  `/Applications`, then `google-chrome`, `chromium`, … on the PATH). Set `WATERWAYS_BROWSER_PATH` in `.env` to use
  another binary. On a Mac, headless Chrome renders with Metal and WebGPU works as in a normal window. If the editor
  falls back to WebGL or shows no WebGPU, add `WATERWAYS_BROWSER_FLAGS="--enable-unsafe-webgpu"`.
- **The studio must be reachable** at `APP_URL` (for example `http://waterways-game.test` with Herd, or the
  `composer dev` address), because the hidden browser loads the game page from there. `WATERWAYS_HEADLESS_URL`
  overrides the page (`{map}` is replaced by the map slug).
- **One editor per map.** `open_editor` uses an editor that is already open (yours or a hidden one) and never
  starts a second one. If you open a map while a hidden editor works on it, the hidden one hands over: agent
  commands go to your tab, the hidden editor saves its unsaved edits and closes. Reload your tab if it was opened
  before that save, so you see the agent's last edits.
- **Idle shutdown:** a hidden editor that ran no command for `WATERWAYS_HEADLESS_IDLE_MINUTES` (default 15) saves
  and closes. This is checked on the hidden editor's own polls, on every tool call and, if the Laravel scheduler
  runs (`php artisan schedule:work`), every minute.
- `php artisan waterways:headless` lists hidden editors; `waterways:headless stop [--map=slug]` stops them (unsaved
  edits in them are lost), `stop --idle` closes only idle ones like the scheduler.
- The browser runs detached (it keeps running when the MCP server exits), with its own profile in
  `storage/app/headless/` and a log in `storage/logs/headless-<map>.log`.

| Variable                           | Default         | Meaning                                                                                 |
| ---------------------------------- | --------------- | --------------------------------------------------------------------------------------- |
| `WATERWAYS_BROWSER_PATH`           | found by itself | Browser binary                                                                          |
| `WATERWAYS_BROWSER_FLAGS`          | none            | Extra browser flags, space separated (e.g. SwiftShader flags on machines without a GPU) |
| `WATERWAYS_HEADLESS_URL`           | game page       | Page to open, `{map}` = map slug                                                        |
| `WATERWAYS_HEADLESS_WINDOW`        | `1600,900`      | Window size (screenshots)                                                               |
| `WATERWAYS_HEADLESS_START_TIMEOUT` | `120`           | Seconds `open_editor` waits for the editor to load                                      |
| `WATERWAYS_HEADLESS_IDLE_MINUTES`  | `15`            | Idle minutes before a hidden editor closes                                              |
| `WATERWAYS_AUTO_HEADLESS`          | `false`         | Live tools start a hidden editor by themselves when the map is not open                 |

**If it does not work**, check in this order:

1. `php artisan waterways:headless` — is a hidden editor listed for the map, and is its browser running?
2. `storage/logs/headless-<map>.log` — browser errors (a page that cannot be reached, GPU problems).
3. `APP_URL` — open that address with `/game/<map>` in your own browser: the game must load there.
4. The game build must be current (`npm run build`, or `npm run dev` running), like for your own editor.

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

| Tool                                                                | What it does                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_project_overview`                                              | Maps, libraries, graphics preset, configured AI services, which map is open in an editor                                                                                                                                                                                                                                      |
| `get_map`                                                           | Map settings, coordinate system, environment, the 8 layer slots (materials, auto-paint rules, ground cover), terrain statistics (height range, layer coverage, water), saved foliage counts, editor state                                                                                                                     |
| `get_settings`                                                      | Fields (type, range, options, description) and current values of `environment` (per map), `player`, `graphics` or `editor`                                                                                                                                                                                                    |
| `list_foliage_types`, `list_biomes`, `list_materials`               | The libraries                                                                                                                                                                                                                                                                                                                 |
| `open_editor`, `close_editor`                                       | Start a hidden (headless) editor for a map when none is open, and close it again. See [Hidden editors](#hidden-editors-unattended-work)                                                                                                                                                                                       |
| `get_editor_state`                                                  | Live: mode, camera, view mode, selected tool, unsaved changes, undo/redo, fps and draw calls                                                                                                                                                                                                                                  |
| `take_screenshot`                                                   | Live: renders the map from the current view, an `overview`, a `top_down` view (north up), the player start, or any position and target, optionally in an analysis view (layers, slope, height, foliage density, lighting only, wireframe). Returns the image and puts your camera back afterwards                             |
| `set_camera`                                                        | Live: moves your editor camera, for example to show you something                                                                                                                                                                                                                                                             |
| `control_editor`                                                    | Live: save, undo / redo, view mode, edit / play, auto paint                                                                                                                                                                                                                                                                   |
| `create_map`, `regenerate_terrain`, `update_map`                    | New maps (procedural or real-world), terrain regeneration, name, description, player start, default map                                                                                                                                                                                                                       |
| `update_environment`, `update_game_settings`                        | Weather, time of day, fog, …; player, graphics and editor settings                                                                                                                                                                                                                                                            |
| `update_terrain_layer`, `add_terrain_layer`, `delete_terrain_layer` | Layer look, materials, auto-paint rules, ground cover                                                                                                                                                                                                                                                                         |
| `apply_biome`, `save_layer_as_biome`                                | Biomes on layer slots, and new biomes from layers                                                                                                                                                                                                                                                                             |
| `save_foliage_type`                                                 | Create or update foliage types                                                                                                                                                                                                                                                                                                |
| `map_snapshots`                                                     | List, create and restore snapshots                                                                                                                                                                                                                                                                                            |
| `get_map_image`                                                     | Top-down image of the saved map (north up) with a labelled coordinate grid in metres and the player start. Kinds: `map` (layer colours, hill shading, water, contours), `height`, `slope`, `layers` (legend), `water`; `area` crops to zoom in. No editor needed                                                              |
| `sample_terrain`                                                    | Exact ground height, slope, water level and layers at points, or at even steps along a path (height profiles). No editor needed                                                                                                                                                                                               |
| `sculpt_terrain`                                                    | Live: raise / lower, set height, flatten, smooth, noise, terrace, landforms (`hill`: hills, massifs following an outline, ridges along paths; negative for basins, valleys, craters; profiles dome / peak / plateau with natural roughness), erosion (hydraulic, thermal), `grade` (road beds along a path)                   |
| `paint_terrain`                                                     | Live: paint or erase a layer (slot or name) in a shape, optionally only on matching slope / height, with natural `breakup`. Painted layers grow their ground cover, so this plants biomes                                                                                                                                     |
| `edit_water`                                                        | Live: `lake` floods a basin to a level (or `fill_to_rim`); if it would spill, it reports how high the basin holds and where it overflows. `river` carves a channel along a path, downhill from its first point. `erase` removes water                                                                                         |
| `edit_foliage`                                                      | Live: `scatter` types in a shape (their rules, density, groves) or `clear` placed foliage (e.g. for clearings or roads)                                                                                                                                                                                                       |
| `list_requests`, `get_request`, `update_request`                    | Build requests made in the editor (see below): the note, the outline in world coordinates with its bounds, the user's screenshot and reference images, a map crop with the outline. `update_request` sets the status (`in_progress`, `needs_input`, `done`), leaves a message and attaches a result screenshot                |
| `place_props`, `remove_props`, `list_props`                         | Live: place props from the prop library at exact positions (rotation, scale, height offset) or scatter them in a shape (spacing, slope, water); remove by id or shape; list what is placed (no editor needed)                                                                                                                 |
| `list_prop_models`                                                  | The prop model library (placeable objects) with status, size and tags                                                                                                                                                                                                                                                         |
| `import_model`                                                      | Imports a glTF model from a local `path` (e.g. exported by Blender MCP), a `url` or `base64` (≤ 100 MB) as a **prop** (`props/{id}/model.glb`, size measured, ready at once) or a **foliage** asset (optionally with a foliage type; baked in the open editor right away)                                                     |
| `bake_foliage_asset`                                                | Live: optimises a foliage asset waiting for its bake (LODs, impostor, thumbnail) in the open editor, as the studio's Foliage page does. Any open map works                                                                                                                                                                    |
| `generate_image`                                                    | An image from the project's OpenRouter image model (purposes `reference`, `texture`, `sprite` or free), optionally guided by earlier images. Returns it and stores it under `agent-images/` with its local file path, for reuse (references, materials, Blender)                                                              |
| `generate_material`                                                 | A PBR terrain material from a prompt (queued AI generation, like the studio) or from an image (processed right away); assign it with `update_terrain_layer`                                                                                                                                                                   |
| `generate_model`                                                    | Meshy text / image to 3D in the background: props (stored as ready props), or foliage assets (also as OpenRouter plant cards)                                                                                                                                                                                                 |
| `get_asset_status`                                                  | Status, message and preview URLs of a prop model, foliage asset or material                                                                                                                                                                                                                                                   |
| `profile_performance`                                               | Live: fps, CPU / GPU ms, GPU time per pass, draw calls, triangles and resolution from the current view (or a camera); what each system draws; the cost in ms of props, foliage, ground cover, water and shadows (each switched off for a few frames, then restored); findings in plain words. See [Performance](#performance) |

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

## Requests: point at something and ask

In the editor, pick **Request** (key 6), click on the terrain to outline an area (Backspace removes the last
point), describe what you want, optionally add up to 6 reference images, and press **Send to Claude**. The
request is stored with your outline, the view you were looking at (camera and a screenshot) and the images.

Then ask Claude to work on your requests. It calls `list_requests` and `get_request`, which gives it the note,
the outline in world coordinates with its size and centre, your screenshot, the reference images and a top-down
map crop with the outline drawn in. While it works the request shows **in progress**; when it is done it
attaches a screenshot from the same view and a message, and the request shows **done** in the editor, where you
can compare. If something is unclear it sets **needs input** with a question. Saved outlines are drawn on the
terrain while the Request tool is open, coloured by status.

## Props

Props are individual models (huts, bridges, fences, rocks, …) from the prop library (`prop_models`), placed on
the map and saved with it (`props.json`). Their height follows the terrain, so sculpting afterwards keeps them
grounded. Agents use `place_props` / `remove_props` / `list_props`.

In the editor, **Place → Props**:

- **Place:** pick a model (the cards show rendered previews); a see-through preview under the cursor shows where
  and how it lands. R / Shift+R turns it by 15°, or set the rotation slider (random rotation is a toggle), and the
  size. Click to place, Shift+click removes the nearest prop.
- **Select & edit:** click a placed prop to select it, drag to move it, R / Shift+R to turn it; the panel has
  rotation, size and height above ground, Duplicate (Ctrl+D) and Delete. Esc deselects. Every change is one undo
  step.

Rendering: each model is merged per material and simplified into up to three LODs when it loads; all copies of a
model are drawn instanced (one draw per material and LOD), pick their LOD by distance relative to the model's
size and are hidden far away. Many copies of a model are cheap in draw calls, but triangles still add up:
vegetation (forests) belongs in foliage types, which also get impostors and GPU culling.

## Assets

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

## Performance

`profile_performance` measures the open editor, from your view or a camera placed like `take_screenshot`
(your camera is put back). It takes 5–20 s (`sample_frames` per state, default 40) and reports:

- **frame:** fps, CPU ms (JavaScript and command submission), GPU ms (timestamp queries, where the browser
  supports them), draw calls and triangles of all passes, render / output resolution and the dynamic
  resolution scale (held still while measuring);
- **passes:** GPU time per render pass (scene, shadows, foliage culling, water reflection, post effects), as
  in the in-game F10 menu;
- **systems:** terrain and water meshes; foliage per type (instances, drawn, triangles per LOD, instances per
  LOD); ground cover per terrain layer; props per model (copies, triangles / meshes / materials per copy, draw
  calls); shadows (cascades, map sizes, shadow casters);
- **costs:** each system is switched off for a few frames, and the difference is what it costs: props
  (hidden), placed foliage and ground cover (not drawn, their GPU culling and growth paused), water (with its
  reflection) and shadows (maps not re-rendered). Everything is restored exactly afterwards. The baseline is
  measured again at the end; `noise_ms` is how much it moved, so smaller costs are noise;
- **findings:** the result in plain words, for example "Prop model "Pine" has 180k triangles × 400 placed =
  72M triangles per pass …".

**Budgets.** Props draw their whole model for every copy in every pass (view, shadow cascades, water
reflection), without LODs. `import_model`, `generate_model` and `list_prop_models` / `get_asset_status`
report triangles, meshes (draw calls per copy) and materials of a prop, and warn above 20k triangles or
8 materials; `place_props` warns when many copies of a heavy or tree-like model add up. Meshy props are
remeshed to about 15k triangles. Vegetation belongs in **foliage types** (LODs, impostors, GPU culling, ground
cover), not props.

## How it works

- `routes/ai.php` registers the server: `App\Mcp\Servers\WaterwaysServer`, with tools in `app/Mcp/Tools`.
- **Live bridge** (`App\Mcp\EditorBridge`): a tool that needs the engine queues a command in `agent_commands`
  and waits for the result.
    - The open editor (`resources/game/core/AgentBridge.ts`) polls `POST /api/maps/{map}/agent/poll` and claims
      pending commands.
    - It runs them (`resources/game/core/AgentCommands.ts`) and posts results to `/agent/commands/{id}`.
    - Each poll also records the session and a little state in `agent_sessions`.
    - The MCP process and the web server share only the database, so no websockets or extra services are needed.
- **Hidden editors** (`App\Mcp\HeadlessEditor`, table `headless_browsers`): starts the browser through
  `App\Mcp\Headless\BrowserLauncher` (a detached background process), tracks pid, map and last use, and closes it.
  The page reports `headless: true` in its poll state; `EditorBridge::poll` then lets it step aside for the user's
  tab (it only runs commands addressed to it, i.e. its final save).
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
- **Requests** (`App\Models\AgentRequest`, table `agent_requests`, `App\Http\Controllers\Api\AgentRequestController`):
  images are stored under `storage/app/public/agent-requests/{id}`. The editor side is the Request tool
  (`resources/game/editor/RequestOverlay.ts`, `EditorPanel.requestTool`) and `Game.sendRequest`.
- **Props** (`App\Models\PropModel`, `resources/game/world/Props.ts`): glTF templates scaled to the model's
  target height with the base centre at the origin, cloned per instance. `GltfInspector::stats` measures
  triangles, meshes and materials; `App\Mcp\Assets\PropBudget` holds the budget and its warnings.
- **Performance** (`profile` command → `editor/agent/profilePerformance.ts`): the game reports each frame
  to the profile, switches systems off and on (`Game.setProfileHidden`: props group, `Foliage.setHidden`,
  water, `SunShadows.setPaused`) and forces per-pass timings (`GpuProfiler` detailed mode);
  `App\Mcp\PerformanceFindings` writes the findings.
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
| **3. Claude requests**   | An editor tool to outline an area, attach a reference image and a note. Agents list open requests with world coordinates and a screenshot, build them, and mark them done with before / after images for review                                             | **Done** |
| **4. Props and assets**  | A props system in the game (placing models with snapping and rotation, later collision), GLB import (e.g. from Blender MCP) as props or foliage types, image and texture generation through the project's OpenRouter key, Meshy generation, placement tools | **Done** |
| **5. Headless sessions** | The server starts its own hidden editor when none is open, so agents can build and render unattended                                                                                                                                                        | **Done** |

Not yet: collision for props, prop thumbnails, .gltf props (convert to .glb first).
