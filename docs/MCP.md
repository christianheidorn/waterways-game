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
- `regenerate_terrain`, `delete_terrain_layer`, `remove_props` and `delete_library_item` are marked as destructive, so
  clients ask before using them. Deleting a map also needs its slug as `confirm` and no editor open on it.

## Tools

| Tool                                                                | What it does                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_project_overview`                                              | Maps, libraries, graphics preset, configured AI services, which map is open in an editor                                                                                                                                                                                                                                      |
| `get_map`                                                           | Map settings, coordinate system, environment, the 8 layer slots (materials, auto-paint rules, ground cover), terrain statistics (height range, layer coverage, water), saved foliage counts, editor state                                                                                                                     |
| `get_settings`                                                      | Fields (type, range, options, description) and current values of `environment` (per map), `player`, `graphics` or `editor`                                                                                                                                                                                                    |
| `list_foliage_types`, `list_biomes`, `list_materials`               | The libraries                                                                                                                                                                                                                                                                                                                 |
| `open_editor`, `close_editor`                                       | Start a hidden (headless) editor for a map when none is open, and close it again. See [Hidden editors](#hidden-editors-unattended-work)                                                                                                                                                                                       |
| `get_editor_state`                                                  | Live: mode, camera, view mode, selected tool, unsaved changes, undo/redo, fps and draw calls                                                                                                                                                                                                                                  |
| `take_screenshot`                                                   | Live: renders the map from the current view, an `overview`, a `top_down` view (north up), the player start, or any position and target, optionally in an analysis view (layers, slope, height, foliage density, lighting only, wireframe, collision). Returns the image and puts your camera back afterwards                  |
| `set_camera`                                                        | Live: moves your editor camera, for example to show you something                                                                                                                                                                                                                                                             |
| `control_editor`                                                    | Live: save, undo / redo, view mode, edit / play, auto paint                                                                                                                                                                                                                                                                   |
| `create_map`, `regenerate_terrain`, `update_map`                    | New maps (procedural or real-world), terrain regeneration, name, description, player start, default map                                                                                                                                                                                                                       |
| `update_environment`, `update_game_settings`                        | Weather, time of day, fog, …; player, graphics and editor settings                                                                                                                                                                                                                                                            |
| `update_terrain_layer`, `add_terrain_layer`, `delete_terrain_layer` | Layer look, materials, auto-paint rules, ground cover                                                                                                                                                                                                                                                                         |
| `apply_biome`, `save_layer_as_biome`                                | Biomes on layer slots, and new biomes from layers                                                                                                                                                                                                                                                                             |
| `save_foliage_type`                                                 | Create or update foliage types (including `collision` and `collision_radius`)                                                                                                                                                                                                                                                 |
| `map_snapshots`                                                     | List, create and restore snapshots                                                                                                                                                                                                                                                                                            |
| `get_map_image`                                                     | Top-down image of the saved map (north up) with a labelled coordinate grid in metres and the player start. Kinds: `map` (layer colours, hill shading, water, contours), `height`, `slope`, `layers` (legend), `water`; `area` crops to zoom in. No editor needed                                                              |
| `sample_terrain`                                                    | Exact ground height, slope, water level and layers at points, or at even steps along a path (height profiles). No editor needed                                                                                                                                                                                               |
| `sample_collision`                                                  | Live: what blocks the player at points, or along a straight walk from A to B (a capsule stepping up ledges like the player): blockers with source (foliage, ground cover, prop), foliage type or prop model / prop id, collision mode, position and distance along the path. See [Collision](#collision)                      |
| `sculpt_terrain`                                                    | Live: raise / lower, set height, flatten, smooth, noise, terrace, landforms (`hill`: hills, massifs following an outline, ridges along paths; negative for basins, valleys, craters; profiles dome / peak / plateau with natural roughness), erosion (hydraulic, thermal), `grade` (road beds along a path)                   |
| `paint_terrain`                                                     | Live: paint or erase a layer (slot or name) in a shape, optionally only on matching slope / height, with natural `breakup`. Painted layers grow their ground cover, so this plants biomes                                                                                                                                     |
| `edit_water`                                                        | Live: `lake` floods a basin to a level (or `fill_to_rim`); if it would spill, it reports how high the basin holds and where it overflows. `river` carves a channel along a path, downhill from its first point. `erase` removes water                                                                                         |
| `edit_foliage`                                                      | Live: `scatter` types in a shape (their rules, density, groves) or `clear` placed foliage (e.g. for clearings or roads)                                                                                                                                                                                                       |
| `list_requests`, `get_request`, `update_request`                    | Build requests made in the editor (see below): the note, the outline in world coordinates with its bounds, the user's screenshot and reference images, a map crop with the outline. `update_request` sets the status (`in_progress`, `needs_input`, `done`), leaves a message and attaches a result screenshot                |
| `place_props`, `remove_props`, `list_props`                         | Live: place props from the prop library at exact positions (rotation, scale, height offset) or scatter them in a shape (spacing, slope, water); remove by id or shape; list what is placed (no editor needed)                                                                                                                 |
| `list_prop_models`                                                  | The prop model library (placeable objects) with status, size and tags                                                                                                                                                                                                                                                         |
| `import_model`                                                      | Imports a glTF model from a local `path` (e.g. exported by Blender MCP), a `url` or `base64` (≤ 100 MB) as a **prop** (`props/{id}/model.glb`, size measured, ready at once) or a **foliage** asset (optionally with a foliage type; baked in the open editor right away)                                                     |
| `update_prop_model`                                                 | Edit a prop model: name, category, target height, tags and `collision` (`auto`, `box`, `mesh`, `none`)                                                                                                                                                                                                                        |
| `bake_foliage_asset`                                                | Live: optimises a foliage asset waiting for its bake (LODs, impostor, thumbnail) in the open editor, as the studio's Foliage page does. Any open map works                                                                                                                                                                    |
| `generate_image`                                                    | An image from the project's OpenRouter image model (purposes `reference`, `texture`, `sprite` or free), optionally guided by earlier images. Returns it and stores it under `agent-images/` with its local file path, for reuse (references, materials, Blender)                                                              |
| `generate_material`                                                 | A PBR terrain material from a prompt (queued AI generation, like the studio) or from an image (processed right away); assign it with `update_terrain_layer`                                                                                                                                                                   |
| `generate_model`                                                    | Meshy text / image to 3D in the background: props (stored as ready props), or foliage assets (also as OpenRouter plant cards)                                                                                                                                                                                                 |
| `get_asset_status`                                                  | Status, message and preview URLs of a prop model, foliage asset or material                                                                                                                                                                                                                                                   |
| `profile_performance`                                               | Live: fps, CPU / GPU ms, GPU time per pass, draw calls, triangles and resolution from the current view (or a camera); what each system draws; the cost in ms of props, foliage, ground cover, water and shadows (each switched off for a few frames, then restored); findings in plain words. See [Performance](#performance) |
| `update_props`                                                      | Live: edit placed props, by id (exact x, z, rotation, scale, offset) or for every prop in a shape / of some models (move, turn, resize, raise, re-roll rotation and size)                                                                                                                                                     |
| `take_photo`                                                        | Live: photo mode. A cinematic still (optionally 2×) with a temporary look (grade, exposure, depth of field and focus point, lens, letterbox, time of day) and field of view; stored under `agent-images/`, nothing saved to the map                                                                                           |
| `set_device_graphics`                                               | Live: the F10 graphics menu. Preset, scalability group levels and single settings as overrides of the editor's browser, or reset to the project defaults                                                                                                                                                                      |
| `control_player`                                                    | Live: play mode. Teleport, turn the camera, walk or run to a point with the real movement (reports reached / stuck / timeout), jump                                                                                                                                                                                           |
| `set_map_thumbnail`                                                 | Live: renders a view and stores it as the map's card image                                                                                                                                                                                                                                                                    |
| `list_characters`, `manage_character`                               | The character library: activate / deactivate the player character, rename / resize, import a rigged .glb, generate with Meshy, retry                                                                                                                                                                                          |
| `update_library_item`                                               | Materials (tile size, tint, roughness, normals, height contrast, category, tags; duplicate), foliage assets (name, kind, style, height, license, author; re-bake; create a foliage type), starter biomes                                                                                                                      |
| `delete_library_item`                                               | Destructive: delete a foliage type, foliage asset, material, biome, character, request or map (a map needs `confirm` = its slug and no open editor)                                                                                                                                                                           |
| `create_request`                                                    | A request from the agent: an outline (polygon or circle) with a note and a question for the user, optionally with a screenshot; shown in the editor's Request tool                                                                                                                                                            |

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

## UI ↔ MCP parity

Every control of the editor and the studio, and how an agent does the same. "UI only" marks what agents
deliberately do not get, with the reason. New UI ships with its MCP tool in the same change
([roadmap](ROADMAP.md)).

### Editor (game page, edit mode)

| Area                | UI control                                                                                                                                                                 | MCP                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Toolbar             | Build / Play (P, Alt+P from the player start)                                                                                                                              | `control_editor` `set_mode`; `control_player`                                                                                    |
| Toolbar             | Undo / Redo (Ctrl+Z / Ctrl+Y)                                                                                                                                              | `control_editor` `undo` / `redo`                                                                                                 |
| Toolbar             | Save (Ctrl+S)                                                                                                                                                              | `control_editor` `save` (world edits save by default)                                                                            |
| Camera              | Fly camera, F to focus the cursor                                                                                                                                          | `set_camera`; the `take_screenshot` camera options                                                                               |
| Sculpt (1)          | Sculpt raise / lower, Smooth, Flatten, Ramp, Slump, Rain, Noise, Terrace; size, strength, falloff, curve                                                                   | `sculpt_terrain` (raise_lower, smooth, flatten, grade, erode thermal / hydraulic, noise, terrace, hill) on shapes with `falloff` |
| Paint (2)           | Paint / Erase a layer, slope and height limits                                                                                                                             | `paint_terrain`                                                                                                                  |
| Paint (2)           | Auto paint                                                                                                                                                                 | `control_editor` `auto_paint`                                                                                                    |
| Paint (2)           | Layer look, material, ground cover, Apply biome, Save as biome                                                                                                             | `update_terrain_layer`, `apply_biome`, `save_layer_as_biome`                                                                     |
| Foliage (3)         | Paint / Erase / Single, groves, min spacing, Re-scatter a type                                                                                                             | `edit_foliage` `scatter` / `clear` (a small circle for single plants)                                                            |
| Foliage (3)         | Type settings (density, size, slope, altitude, distance, shadows, rotation, under water)                                                                                   | `save_foliage_type`                                                                                                              |
| Water (4)           | Lake, River, Erase, water level, carve depth                                                                                                                               | `edit_water`                                                                                                                     |
| Place (5)           | Player start (click, facing the camera direction)                                                                                                                          | `update_map` `spawn` (`yaw`, `facing` or `look_at`)                                                                              |
| Place (5)           | Props: Place (model, rotation, random rotation, size), Shift+click remove                                                                                                  | `place_props`, `remove_props`                                                                                                    |
| Place (5)           | Props: Select & edit (drag, R / Shift+R, rotation, size, height above ground), Duplicate (Ctrl+D), Delete                                                                  | `update_props`; `place_props` with the same values; `remove_props`                                                               |
| Request (6)         | Outline, note, reference images, Send                                                                                                                                      | Made by the user; agents read them (`list_requests`, `get_request`) and ask their own (`create_request`)                         |
| Request (6)         | Dismiss / reopen / delete a request                                                                                                                                        | `update_request` status `dismissed` / `open`; `delete_library_item` kind `request`                                               |
| View modes          | Lit, Lighting only, Layers, Slope, Height, Foliage density, Wireframe (V / Shift+V)                                                                                        | `control_editor` `set_view_mode`; `take_screenshot` `view_mode`                                                                  |
| Graphics menu (F10) | Preset, scalability groups, render scale, resolution cap, target / max frame rate, dynamic resolution, graphics API, reset to project defaults                             | `set_device_graphics` (this device); project defaults: `update_game_settings` `graphics`                                         |
| Graphics menu (F10) | Performance readout, GPU passes, foliage LOD table                                                                                                                         | `profile_performance`, `get_editor_state`                                                                                        |
| Photo mode (F9)     | Capture / 2× capture, cinematic quality, grade, exposure, white balance, light shafts, time of day, depth of field, click to focus, field of view, lens effects, letterbox | `take_photo`                                                                                                                     |
| Play mode           | Walk / run (WASD, Shift), jump, swim, mouse look                                                                                                                           | `control_player`                                                                                                                 |
| Editor              | Show 100 m grid (G)                                                                                                                                                        | UI only — a drawing aid; agents use the grid of `get_map_image`                                                                  |
| Editor              | Brush preview, cursor readout, status hints                                                                                                                                | UI only — agents read exact values with `sample_terrain`                                                                         |
| Photo mode          | Hide panel (H)                                                                                                                                                             | UI only — the photo never shows UI                                                                                               |

### Studio

| Area                  | UI control                                                                                         | MCP                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Dashboard             | Overview                                                                                           | `get_project_overview`                                                                                  |
| Maps                  | Create (procedural / real world)                                                                   | `create_map`                                                                                            |
| Maps                  | Rename, description, make default                                                                  | `update_map`                                                                                            |
| Maps                  | Regenerate terrain                                                                                 | `regenerate_terrain`                                                                                    |
| Maps                  | Delete                                                                                             | `delete_library_item` kind `map`                                                                        |
| Maps                  | Card thumbnail (taken on every editor save)                                                        | `set_map_thumbnail`                                                                                     |
| Maps                  | Open Studio (editor)                                                                               | `open_editor` (hidden editor), or the user opens it                                                     |
| Maps → Environment    | Weather, time, sun, clouds, fog, wind, water, camera & look                                        | `update_environment`                                                                                    |
| Maps → Layers         | Add, edit, delete a layer; material; biome                                                         | `add_terrain_layer`, `update_terrain_layer`, `delete_terrain_layer`, `apply_biome`                      |
| Maps → Layers         | Upload / remove a custom layer texture                                                             | `generate_material` from an image, then `update_terrain_layer` `material_id`                            |
| Maps → Layers         | Reset layers to the defaults                                                                       | UI only for now — rebuild with the layer tools; a one-step reset is a small follow-up                   |
| Maps → Land cover     | Re-paint from ESA land cover, class → slot mapping (real-world maps)                               | UI only for now — agents paint with `paint_terrain`; a land-cover tool is a follow-up                   |
| Maps → AI             | Suggest materials, AI review and apply changes                                                     | UI only — the studio's own assistant; an agent does the same with its own judgement and the layer tools |
| Materials             | Generate from a prompt; upload maps / an image                                                     | `generate_material` (prompt or image)                                                                   |
| Materials             | Import from Poly Haven / ambientCG                                                                 | UI only for now — browsing an external catalogue; a follow-up                                           |
| Materials             | AI edit, retry a failed generation                                                                 | UI only for now — `generate_material` makes a new one                                                   |
| Materials             | Edit name, category, tile size, tint, roughness, normal strength, height contrast, tags; duplicate | `update_library_item` kind `material`                                                                   |
| Materials             | Delete                                                                                             | `delete_library_item` kind `material`                                                                   |
| Foliage               | Types: create, edit                                                                                | `save_foliage_type`, `list_foliage_types`                                                               |
| Foliage               | Types: upload / remove a model                                                                     | `import_model` kind `foliage` (with a type)                                                             |
| Foliage               | Types: delete                                                                                      | `delete_library_item` kind `foliage_type`                                                               |
| Foliage               | Assets: upload, generate (plant cards / Meshy), retry                                              | `import_model`, `generate_model`, `get_asset_status`                                                    |
| Foliage               | Assets: edit (name, kind, style, height, license, author), re-bake, create a type                  | `update_library_item` kind `foliage_asset`; `bake_foliage_asset`                                        |
| Foliage               | Assets: delete                                                                                     | `delete_library_item` kind `foliage_asset`                                                              |
| Foliage               | AI plan (types for a region)                                                                       | UI only — the studio's own assistant; agents create types with `save_foliage_type`                      |
| Biomes                | Add starter biomes                                                                                 | `update_library_item` kind `biome` `install_starters`                                                   |
| Biomes                | Delete                                                                                             | `delete_library_item` kind `biome`                                                                      |
| Characters            | List, activate, use the default                                                                    | `list_characters`, `manage_character` `activate` / `deactivate`                                         |
| Characters            | Upload, generate with Meshy, retry, rename / height                                                | `manage_character` `import` / `generate` / `retry` / `update`                                           |
| Characters            | Delete                                                                                             | `delete_library_item` kind `character`                                                                  |
| Settings → Game       | Player, graphics, editor fields; reset a group                                                     | `get_settings`, `update_game_settings` (`reset: true`)                                                  |
| Settings → AI         | API keys, models, test connection                                                                  | UI only — keys never reach agents; `get_project_overview` shows what is configured                      |
| Settings → Appearance | Light / dark theme                                                                                 | UI only — the studio's own look                                                                         |
| Props                 | Prop model library                                                                                 | `list_prop_models`, `import_model` kind `prop`, `generate_model` (the studio has no prop page yet)      |

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

## Collision

Placed foliage, ground cover and props block the player (a capsule: it slides along obstacles, steps up ledges
up to 0.4 m and stands on rocks and props) and the third-person camera (it pulls in in front of them).

- **Foliage types** (`save_foliage_type` `collision`): `auto` (default: trees `trunk`, rocks `bounds`, bushes,
  grass, flowers and reeds `none`), `trunk` (a cylinder around the trunk, its radius measured from the model's
  lowest part), `bounds` (the model's footprint box) or `none`; `collision_radius` (m at scale 1) overrides the
  measured radius. Ground cover collides like placed foliage of its type.
- **Prop models** (`import_model` / `update_prop_model` `collision`): `auto` (default: a few boxes fitted to the
  model's surface on a coarse voxel grid, so doorways, arches and rooms stay open), `box` (one box), `mesh` (the
  exact triangles: walk-in buildings, bridges, stairs) or `none`. Colliders follow each prop's position,
  rotation, scale and ground height.
- **Checking:** `sample_collision` (points or a walk from A to B) and `take_screenshot` / `control_editor`
  `view_mode: "collision"` (outlines of the colliders within 40 m of the camera: foliage green, ground cover
  yellow, prop boxes orange, prop meshes blue). In the editor, **Walk** (J) drops the character at the cursor
  to try it out; Esc returns to the fly camera.
- **Engine:** `resources/game/world/collision/` — `CollisionWorld` queries providers that keep their own grids
  (props: a 16 m grid updated on add / move / remove; foliage: an 8 m bucket index per foliage cell, rebuilt
  when the cell's data changes — brush, scatter, undo), so lookups only touch what is nearby.

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
- **Menus and play mode** (`editor/agent/liveControls.ts`): `graphics` applies graphics-menu overrides like F10, `photo`
  captures like photo mode (look preview, cinematic quality, restored afterwards), `player` drives play mode by holding
  keys through `Input.hold`, so walking uses the real movement; props edits are the `props` world edit action `update`.
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
