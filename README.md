# Waterways

An open-world game built with **Three.js**, plus the **Creator Studio** you use to build it: a Laravel 13 +
React (Inertia) + shadcn/ui web app that configures maps, materials, foliage and gameplay and hosts the game
itself in an embedded viewport. You switch between **Build** and **Play** without leaving the page.

> The studio has no authentication on purpose. Run it locally or behind your own access control.

## Features

**Creator Studio (Laravel + React + shadcn/ui)**

- Dashboard, map library and per-map pages: overview, environment and terrain layers.
- **Real-world maps.** Pan, zoom and search (OpenStreetMap, satellite and topo base layers) to pick a square
  area. Real elevation comes from AWS Terrain Tiles. Lakes, rivers, canals and streams come from OpenStreetMap
  (Overpass) and are rasterised into water. The ocean is detected automatically from coastline elevation.
  Water levels come from the elevation data (lakes: a low percentile inside the outline; rivers: a profile
  that never rises downstream). Per-map settings control lake/river depth, how quickly water deepens, the
  steepest allowed bank (removes cliffs where outlines and elevation disagree) and terrain smoothing
  (removes the stair steps of whole-metre elevation data).
- **Procedural maps** (hills, ridged mountains, a meandering river and a lake) and **flat** maps.
- Terrain generation runs as a queued job with live progress.
- **Terrain layers.** Up to 8 splat materials per map, each with colours, roughness, bump, noise scale, an
  optional albedo texture upload, and height/slope rules for automatic painting.
- **Foliage library.** Conifer, broadleaf, palm, bush, grass, flower, reed and rock types. Each has density,
  scale, slope and height rules, underwater placement, shadows and cull distance. You can upload a `.glb` model
  to replace the procedural mesh.
- **Game settings.** These are schema-driven, so a setting added on the PHP side shows up in every form
  automatically:
    - **Player:** movement, physics and camera, plus an optional rigged GLB character.
    - **Graphics:** shadows, render scale, draw and foliage distance, MSAA, bloom and GTAO.
    - **Editor:** autosave, undo depth, fly speed.
- **Studio workspace.** The game runs in an iframe, with Build/Play switch, tool groups, undo/redo and save
  state in the shell. Environment and game-settings panels preview **live** in the running game before you
  save.

**Game (Three.js, `resources/game`)**

- **Terrain.** Chunked terrain with geomipmapping LOD and crack-hiding skirts. The PBR material blends 8
  height-aware splat layers, adds procedural detail and bump, and optionally uses texture arrays.
- **Water.**
    - Rivers and lakes are built from a water-surface grid. Flow-mapped normals make rivers visibly flow
      downhill.
    - Colour depends on depth, which is computed per pixel from the terrain heightmap.
    - Shorelines and rapids get foam.
    - An ocean ring extends to the horizon, and the view tints when the camera goes underwater.
- **Atmosphere.** Physical sky with clouds and a sun position driven by time of day. Lighting comes from the
  sky (IBL), with fog and a shadow that follows the camera or player. Post-processing covers MSAA, bloom, GTAO
  and ACES tone mapping.
- **Foliage.** Instanced and bucketed into 128 m cells, with 2 LODs, wind sway, a grass distance fade and
  density scaling.
- **Player.** Third-person explorer with procedural walk, run, jump and swim animation (or your own GLB). Moves
  over terrain with a slope limit, jumps (with coyote time), and swims or dives in deep water.

**In-game landscape editor** (modelled on Unreal Engine's Landscape mode)

| Mode    | Tools                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Sculpt  | Sculpt (raise/lower), Smooth, Flatten (target pick, raise/lower-only), Ramp, Thermal erosion, Hydraulic erosion (droplets), Noise, Terrace |
| Paint   | Paint/erase any of the 8 layers; _Auto paint_ re-applies the layer rules to the whole map                                                  |
| Foliage | Paint (density-aware, rule-aware), Erase, Single placement, _Scatter_ (procedural forests, meadows, shoreline reeds), Clear                |
| Water   | Lake (level picked from terrain or Ctrl+click, optional carving), River (follows terrain downhill), Erase                                  |
| Place   | Player start (position + facing)                                                                                                           |

- **Brush:** size, strength and falloff, with four falloff types (smooth, linear, spherical, tip). The brush
  is previewed on the terrain.
- **Undo:** tile-based copy-on-write undo/redo covers heights, splat, water and foliage.
- **Viewport:** Unreal-style camera controls and an optional 100 m grid.
- **Saving:** Ctrl+S saves, with an optional autosave. Each save also stores a thumbnail for the studio.

## Terrain materials, AI and land cover

**Material library** (Studio → Materials): reusable PBR materials (albedo, normal, roughness, AO, height)
that any map's terrain layers can use. Sources:

- **Poly Haven / ambientCG** — search and import CC0 photo-scanned materials at 1K/2K/4K.
- **Upload** — drop in any PBR set (maps are detected by file name; DirectX normals are flipped automatically)
  or a single photo (the other maps are derived and it can be made seamless).
- **AI generation** via [OpenRouter](https://openrouter.ai): describe a material, pick an image model and
  variants; the result is made seamless, de-lit, and normal/roughness/AO/height maps are derived. _AI edit_
  creates variants of an existing material from a prompt.
- `php artisan waterways:starter-materials` imports a curated CC0 starter set and assigns it to default layers
  (also run by `composer setup` / the seeder; offline-safe).

**Terrain rendering** uses texture arrays with anti-tiling, triplanar projection on cliffs, height-based
blending between layers, far-distance blending, AO and wet shores. Resolution: _Game settings → Graphics →
Terrain texture resolution_.

**AI assistance** (Studio → Settings → AI): enter an OpenRouter key (stored encrypted, or set
`OPENROUTER_API_KEY`) and choose image and text models. Besides generation, the text model can
_suggest materials and paint rules_ for a map (Terrain layers page) and _review a screenshot_ of the current
view in the studio workspace (✨ button) with one-click fixes that preview live in the game.

**Land cover** (real-world maps): ESA WorldCover 2021 (10 m, © ESA, CC-BY 4.0) is read on generation and
used to paint the terrain layers (forest floor under forests, meadow on grassland, …) and to guide foliage
scattering. The class → layer mapping is editable on the map page.

Queued jobs (terrain, imports, AI generation) need a queue worker; `composer dev` runs one.

**Outbound hosts** used by the studio: `s3.amazonaws.com` (elevation), `esa-worldcover.s3.eu-central-1.amazonaws.com`,
`overpass-api.de` / `overpass.kumi.systems` / `overpass.private.coffee`, `api.polyhaven.com`, `dl.polyhaven.org`,
`cdn.polyhaven.com` (thumbnails), `ambientcg.com`, `acg-media.struffelproductions.com`,
`acg-download.struffelproductions.com`, `openrouter.ai`, `api.meshy.ai` and `assets.meshy.ai` (Meshy); in the browser also the map tile servers and
`nominatim.openstreetmap.org`.

## Foliage assets and the AI foliage palette

**Foliage library** (Studio → Foliage) has two tabs:

- _Foliage types_: the palette the brush paints. Each type sets kind, colours, size, density, slope / altitude
  rules and cull distance.
- _Asset library_: 3D models a type can use instead of its procedural mesh.

Assets come from:

- **Meshy 3D** ([meshy.ai](https://www.meshy.ai), Settings → AI → Meshy key): textured 3D trees, shrubs and
  rocks, from text (preview mesh → PBR refine) or from an OpenRouter concept image (image to 3D). A model costs
  about 30 Meshy credits (15 with Meshy 5) and takes a few minutes; the job polls Meshy in the background.
  Meshy's community library is only available through its Enterprise "showcases" API, billed per request, so it is
  not integrated.
- **AI plant cards** (OpenRouter): one plant image, cut out and baked into crossed alpha-tested cards, the classic
  technique for grass, flowers and reeds. The background is transparent when the image model supports it;
  otherwise it is a flat magenta or cyan chroma key, and colour decontamination removes fringes.
- **Uploads**: `.glb`, self-contained `.gltf`, or a `.zip` of glTF / GLB models, e.g. the free CC0 nature kits from
  [Quaternius](https://quaternius.com) or the [Kenney Nature Kit](https://kenney.nl/assets/nature-kit).

Remaining OpenRouter and Meshy credits are shown in Settings → AI, on the foliage page and in the generate
dialogs (`GET /api/ai/credits`).

Every source is **baked in the browser** (`resources/game/tools/FoliageBaker.ts`, using meshoptimizer). The bake:

- normalises the model to metres, with its pivot at the base;
- decimates to per-kind triangle budgets, dropping and enlarging leaf cards instead of collapsing them;
- builds an LOD1 and a three-card impostor;
- limits textures to 1K;
- uploads a game-ready GLB with a thumbnail.

Keep the foliage page open while assets show _Waiting to be optimised_.

**In the game editor** the Foliage tool shows your types as tiles with thumbnails: baked model thumbnails, or
thumbnails of the procedural mesh rendered in-game.

**AI foliage palette** (✨ _AI palette_ on the foliage page):

1. Pick a map and/or describe a region.
2. Choose a look from realistic to stylized.
3. The text model proposes keep / change / remove for every type and suggests types to add. Each proposal comes
   with a model: library asset → Meshy 3D → AI card → procedural mesh.

Sizes are planned as real heights in metres. You approve every row and can switch its model (Meshy, card,
procedural, keep current) before anything changes.

## Requirements

- PHP 8.3+ with `gd`, `pdo_sqlite` and `curl`, plus Composer.
- Node 22+.
- Outbound HTTPS to `s3.amazonaws.com` (elevation) and an Overpass server (water; `overpass-api.de`, falling
  back to `overpass.kumi.systems` and `overpass.private.coffee`, see `OVERPASS_URLS`) for real-world maps. The map
  picker also loads tiles from `tile.openstreetmap.org`, `server.arcgisonline.com` and `opentopomap.org`, and
  searches with `nominatim.openstreetmap.org`.

## Getting started

```bash
composer setup   # install, .env, key, sqlite, migrate + seed (generates the starter world), storage:link, npm build
composer dev     # web server, queue worker (terrain generation), logs and Vite
```

Open <http://localhost:8000>. The dashboard shows the seeded **Waterways Valley**. Click **Open in Studio**.

- The first time a map opens, the game auto-paints its materials and scatters foliage. **Save** to keep them.
- Terrain generation runs on the queue. `composer dev` already starts a worker. Otherwise run
  `php artisan queue:work --timeout=900`.
- To upload large layer textures (≤ 8 MB) and foliage models (≤ 50 MB), raise `upload_max_filesize` and
  `post_max_size` in your `php.ini`.
- Offline or sandboxed builds can skip the web-font download with `WATERWAYS_OFFLINE_FONTS=1 npm run build`.

## Controls

**Build mode**

| Input                          | Action                                                      |
| ------------------------------ | ----------------------------------------------------------- |
| LMB                            | Apply tool (Shift inverts: lower / erase)                   |
| RMB + mouse, WASD / QE         | Fly camera (wheel while flying changes speed, Shift boosts) |
| MMB drag                       | Pan                                                         |
| Alt + LMB                      | Orbit around the point under the cursor                     |
| Wheel                          | Zoom towards the cursor                                     |
| F                              | Focus the point under the cursor                            |
| 1–5                            | Sculpt / Paint / Foliage / Water / Place                    |
| `[` `]`, `-` `=`               | Brush size, strength                                        |
| Ctrl + click                   | Pick the flatten target or water level                      |
| Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) | Undo / redo                                                 |
| Ctrl+S                         | Save                                                        |
| G                              | Toggle grid                                                 |
| P / Alt+P                      | Play from the camera / from the player start                |

**Play mode:** click to capture the mouse. WASD to move, Shift to run, Space to jump or surface, C to dive,
wheel to zoom. Esc releases the mouse; press Esc again to return to building.

## Architecture

```
app/
  Http/Controllers/        Studio pages (Inertia) + Api/MapDataController (game data API)
  Jobs/GenerateMapTerrain  Queued terrain generation with progress reporting
  Services/Terrain/        Procedural generator, Terrarium elevation source, Overpass water source,
                           water surface builder (rasterise, ocean flood fill, carve), binary storage
  Support/                 Schema-driven settings (SettingField/Group), GameManifest, default layers
resources/js/              Creator Studio (React + shadcn/ui); pages/maps/editor.tsx hosts the game
resources/game/            The game (plain TypeScript + Three.js, separate Vite entry)
  shared/                  Contracts shared with the studio: manifest types + postMessage protocol
  core/                    Game loop, API client, iframe bridge, input
  world/                   Heightfield, Terrain (LOD chunks), TerrainMaterial, SplatMap, Water,
                           Atmosphere, Foliage (+ procedural FoliageGeometry, baked GLB LODs)
  tools/FoliageBaker.ts    In-browser foliage asset optimiser (LODs, impostor, cards, thumbnail)
  player/                  Character controller, third-person camera, procedural / glTF character
  editor/                  Editor (tools, strokes), Brush, History (undo), FlyCamera, terrainOps, UI panel
```

**Studio ↔ game communication**

- The game page (`/game/{map}`) loads `GET /api/maps/{map}/manifest`. The manifest holds the map info,
  environment, settings, layers, foliage types, asset URLs and save endpoints.
- The game fetches the binary assets and writes them back with `PUT /api/maps/{map}/assets/{asset}`. Uploads
  are gzip-compressed in the browser.
- The studio shell and the game talk through a typed `postMessage` protocol (`resources/game/shared/protocol.ts`).

**World data** is stored per map in `storage/app/private/maps/{id}/`:

| File            | Format                                                                       |
| --------------- | ---------------------------------------------------------------------------- |
| `heightmap.f32` | Float32 LE, `resolution²` heights in metres. Row 0 is north, +X is east.     |
| `water.f32`     | Float32 LE water-surface heights. `-100000` means dry.                       |
| `splat.u8`      | 8 bytes per sample: layer weights for two RGBA splat textures.               |
| `foliage.json`  | `{ version, instances: { typeId: [x, y, z, yaw, scale, tiltX, tiltZ, …] } }` |

Supported resolutions are 257, 513 and 1025 samples per side. For a 4 km map at 1025 that is about 4 m per
sample.

## Testing

```bash
php artisan test            # terrain pipeline (faked tiles / Overpass), materials, foliage assets, AI plans, API, pages
npm run types:check         # TypeScript (studio + game)
npm run check               # lint + format (vite-plus)
vendor/bin/pint --test      # PHP style
```

## Roadmap ideas

- A terrain texture library (PBR albedo, normal and roughness) plus triplanar mapping for cliffs.
- Screen-space reflections and refraction for water.
- Streaming and multi-tile worlds beyond 1025².
- Terrain holes, and foliage collision for the player.
- Gameplay entities: NPCs, boats, quests.
- A build/publish pipeline that exports a standalone game bundle from the studio.
