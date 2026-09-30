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
    - Colour, absorption, refraction and soft shorelines follow the water thickness, which the water reads per
      pixel from the scene depth of the same render pass (no extra refraction pass).
    - Planar reflection of the water level nearest to the focus point (`water_quality` high: 60 % resolution;
      medium: 40 %, redrawn every other frame; low: sky reflection only).
    - Shorelines and rapids get foam.
    - An ocean ring extends to the horizon, and the view tints when the camera goes underwater.
- **Atmosphere & weather.** Physical sky with lit clouds, stars and a moon; valley (height) fog; rain, snow,
  lightning with thunder, gusting wind and wet or snowy ground (see [Weather & sky](#weather--sky)). The sun
  position is driven by time of day. Lighting comes from the
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
| Paint   | Paint/erase any of the 8 layers; _Auto paint_ re-applies the layer rules to the whole map; _Ground cover_ per layer (grows live)           |
| Foliage | Paint (density-aware, rule-aware), Erase, Single placement, _Scatter_ (procedural forests, meadows, shoreline reeds), Clear                |
| Water   | Lake (level picked from terrain or Ctrl+click, optional carving), River (follows terrain downhill), Erase                                  |
| Place   | Player start (position + facing)                                                                                                           |

- **Brush:** size, strength and falloff, with four falloff types (smooth, linear, spherical, tip). The brush
  is previewed on the terrain.
- **Undo:** tile-based copy-on-write undo/redo covers heights, splat, water and foliage.
- **Viewport:** Unreal-style camera controls and an optional 100 m grid.
- **View modes** (like Unreal's viewport _View Mode_ menu): the eye button at the top right (next to the
  graphics button) or V / Shift+V switch how the viewport draws the world, to see why something looks or
  performs the way it does. A legend under the button explains the colours.

    | View mode       | Shows                                                                                                                  |
    | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
    | Lit             | The final rendering (default)                                                                                          |
    | Lighting only   | Terrain and foliage with a neutral grey albedo: judge sun, sky light, shadows and AO without the materials             |
    | Layers          | Each terrain layer in its own colour (legend with the layer names), blended by paint weight so transitions show        |
    | Slope           | Steepness: green (flat) → yellow (30°) → red (45°) → purple (60°+); handy with the foliage slope rules                 |
    | Height          | Hypsometric bands with contour lines; the interval follows the map's height range (1, 2 or 5 × 10ⁿ m, bold every 5th)  |
    | Foliage density | Heat map of instances per 100 m² (8 m cells, log scale) of placed foliage and the ground cover grown around the camera |
    | Wireframe       | The terrain triangles at their current LOD (drawn in the shader from each chunk's vertex spacing)                      |

    The visualisations are unlit (readable at night) and skip fog, exposure, colour grading, bloom and the
    screen-space lighting (AO, contact shadows, SSR, light shafts), so the colours match the legend; foliage
    and water stay visible and lit. Every mode is built into the terrain shader behind a uniform, so switching
    is instant (no shader compile). View modes are an editor tool: Play always renders lit (the mode comes back
    in Build mode) and nothing is saved with the map. The density grid is refreshed at most twice a second
    while foliage changes (painting, ground cover growing as the camera moves).

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
thumbnails of the procedural mesh rendered in-game. Below the tiles, **Type settings** edits the last-clicked type
without leaving the editor: density, size, slope, altitude, visible distance, shadows, alignment and underwater.
Changes apply live and are saved to the studio library after a short pause (`PATCH /api/foliage-types/{id}`).
Visibility and shadows update at once; density, size and placement rules apply to new painting, and
_Re-scatter_ regenerates a type.

**Ground cover** (like Unreal's landscape grass and procedural foliage): foliage that grows by itself
wherever a terrain layer is painted, from grass and flowers to rocks and whole forests, so you never have to
place, erase and repaint plants to try out a setting.

- Each terrain layer lists foliage types, each with a density multiplier, **Groves** (0 = an even spread;
  higher values gather plants into groves and clearings, trees in larger groves than grass, and each type
  in its own patches) and **Min spacing** (metres between instances, e.g. for trees). Set them in the
  editor's Paint tool (_Ground cover_ under the layer tiles) or on the studio's Terrain layers page.
- Placement is stratified: one candidate per grid cell sized for the density, so plants are spread evenly
  but naturally instead of clumping by chance. Every candidate comes from a stateless hash of its cell.
- Near the camera, tiles grow instances in proportion to the layer's paint weight (a half-painted border
  gets half the grass). They follow each type's slope, altitude and underwater rules.
- Nothing is stored. Each tile is seeded, so it always grows the same plants, and tiles the camera leaves
  far behind are dropped. Painting the layer, sculpting, editing water, a type's density, size or rules, or
  the layer's density regrows the affected tiles at once, in place. The old plants stay until the new ones
  are ready, so nothing flickers.
- Ground cover uses the same renderer as painted foliage: wind, LODs, the distance density falloff, GPU
  culling on WebGPU and CPU cells on WebGL 2. The F10 foliage table lists it as "‹type› · ground cover".
- On WebGPU the tiles grow on the GPU (like Unreal's GPU grass): a compute pass, one thread per candidate,
  packs each tile's plants straight into the foliage instance buffer. It reads the heights, water and splat
  map from GPU copies that terrain, water and paint edits keep up to date. The CPU only picks the tiles to
  grow and drop and sizes their slot ranges from the paint, so ground cover costs it next to nothing. WebGL 2
  grows the tiles on the CPU (a few milliseconds per frame while new tiles appear). Placement is hash-based,
  so both backends grow the same plants.
- Hand-painted instances of the same type are unaffected, and ground cover is never written to `foliage.json`.
- Editor changes are saved after a short pause (`PATCH /api/maps/{map}/layers/{layer}/ground-cover`).

**Biomes** turn painting a layer into painting a whole landscape. A biome is a ground material (or
procedural colours) plus everything that grows on it. The library starts with seven starter biomes: Meadow,
Temperate forest, Conifer forest, Alpine pasture, Beach, Wetland and Rocky slope. Their plants are picked
from your foliage library by kind, and their ground from the starter materials.

- **Apply** a biome to a terrain layer in the editor's Paint tool (_Biome_, above the ground cover) or on
  the studio's Terrain layers page. The layer takes the biome's name, look and ground cover; its slot,
  paint and auto-paint rules stay. Painting the layer then paints the biome: ground, grass, flowers,
  shrubs, rocks and trees.
- **Save as biome** stores the selected layer's look and ground cover in the library, for use on any map.
- The _Biome library_ on the Terrain layers page lists what each biome grows. You can delete biomes there,
  and _Add starter biomes_ brings back missing starters, which is also how to get them on an existing
  install.

**Roots take the terrain's colour** (what Unreal does with runtime virtual texturing). Grass fades into the
ground at its base instead of standing on it like a carpet, whether it is ground cover or painted. The terrain
keeps one average colour per layer: the material's mean albedo × tint, or the procedural colour pair
(`TerrainMaterial.groundColor`). Each foliage vertex reads the splat map at its instance's root and blends those
colours, darkened on wet shores and after rain and whitened by snow cover. Near the ground the blade also
turns as rough as soil and gets less sky light, as if the blades around it shaded it. Without that, the
roots would come out paler and bluer than the ground next to them. The blade's own colour takes over
towards ~40% of its height. Grass takes the most, then flowers, reeds, bushes and a hint at the foot of rocks;
trees are left alone. It costs three texture samples per vertex on both backends and both foliage paths. It
never runs in the shadow pass, and layer, material and weather changes apply without rebuilding a shader.

**AI foliage palette** (✨ _AI palette_ on the foliage page):

1. Pick a map and/or describe a region.
2. Choose a look from realistic to stylized.
3. The text model proposes keep / change / remove for every type and suggests types to add. Each proposal comes
   with a model: library asset → Meshy 3D → AI card → procedural mesh.

Sizes are planned as real heights in metres. You approve every row and can switch its model (Meshy, card,
procedural, keep current) before anything changes.

**LODs and culling.** Every foliage type ends up with a full LOD chain, whatever its source. Procedural
kinds have 2–3 mesh LODs. Baked assets have LOD0, LOD1 and an impostor, and bakes cap LOD0 at a budget per
kind (`world/FoliageLod.ts`, e.g. trees 10k triangles). Older bakes and single-LOD uploads are completed
when they load: over-budget meshes are simplified with meshoptimizer, and a mid LOD and a camera-facing
impostor are generated. LOD nodes nested anywhere in an uploaded glTF are recognised. For trees and rocks,
the switch from LOD0 to LOD1 happens per instance, not per 128 m cell, so full-detail meshes stop at their
LOD distance. The F10 menu lists per-type instances drawn, triangles per LOD and LOD distances, and warns
about missing or over-budget LODs.

**GPU-driven foliage (WebGPU).** Like Unreal's GPU scene, the GPU decides what to draw
(`world/foliage/FoliageGpu.ts`):

- Every instance of a type lives in one GPU storage buffer. Painting, erasing, re-scattering and type edits
  update only the changed ranges.
- Each frame one compute pass per type tests every instance: cull distance × foliage distance, density falloff,
  per-instance LOD with the LOD bias, the view frustum, and **Hi-Z occlusion**
  (`world/foliage/HiZ.ts`). Hi-Z builds a depth pyramid from the previous frame's depth and skips plants
  hidden behind terrain or other trees. It is conservative: anything uncertain counts as visible, and it is
  off for a frame after camera cuts.
- The survivors are compacted into per-LOD lists, and each LOD draws with **one indirect draw call**. The CPU
  does no per-instance work, however much foliage a map has.
- Shadow casters get their own lists, within the foliage shadow distance: all of them for the cached far
  sun cascade, and the ones that reach into the near cascade for its every-frame pass (see
  [Sun shadows](#sun-shadows)).
- The water's planar reflection gets its own cull against the mirrored camera (coarser LODs, no Hi-Z), so
  trees behind or beside the viewer still show in lakes and the sea.
- Leaves and blades are translucent: sky light passes through the canopy and they glow when backlit, so
  foliage keeps its colour under overcast skies.
- The F10 foliage table shows the instances drawn per LOD and the occluded count; "Foliage culling" in the pass
  table is the compute cost.

On the WebGL 2 backend (no compute shaders), foliage uses CPU culling of 32–128 m cells with instanced meshes;
sparse cells are merged into 256 m batches and distant terrain is drawn by quadtree nodes, so the fallback
needs about as many draw calls as the pre-WebGPU renderer.

## Player characters

**Characters** (Studio → Characters) are playable, rigged and animated models:

- **Generate with Meshy.** Text → 3D (or an OpenRouter concept image → 3D) in an A-pose, then Meshy rigging,
  which includes walk and run clips. Idle, jump and swim come from Meshy's animation library. A character costs
  about 44 Meshy credits and takes 5–10 minutes; the job polls Meshy in the background.
- **Upload** a rigged `.glb` whose clips are named idle / walk / run / jump / swim.

The studio preview plays each clip with the game's own character code. _Use as player_ sets the player for every
map: the manifest's `character` carries the model and per-clip GLBs. Missing clips fall back to the closest one.

## Graphics quality

Graphics work like Unreal Engine's scalability settings. **Settings → Graphics** in the studio sets the
project defaults; players can override them per device in the game.

**Quality presets.** _Low_, _Medium_, _High_ (the default), _Epic_ and _Cinematic_ each fill every
quality field. If you change any value by hand, the preset shows as _Custom_. The presets are defined in
`resources/game/shared/graphicsPresets.ts`, which both the studio page and the in-game menu use. Presets
leave these values alone:

- artistic values: bloom intensity, saturation, contrast, vignette
- frame-rate values: dynamic resolution, target FPS, FPS limit

| Preset    | Draw dist. | Shadows (dist.) | AA   | AO          | Terrain tex. / aniso | Foliage density / dist. / shadow | Render scale / Retina cap |
| --------- | ---------- | --------------- | ---- | ----------- | -------------------- | -------------------------------- | ------------------------- |
| Low       | 4 km       | low (90 m)      | FXAA | off         | 512 / 2×             | 0.4 / 0.5× / off                 | 0.7 (FSR 1) / 1×          |
| Medium    | 7 km       | medium (150 m)  | FXAA | off         | 1K / 4×              | 0.7 / 0.75× / 60 m               | 0.85 (FSR 1) / 1.25×      |
| High      | 12 km      | high (220 m)    | TAA  | off         | 1K / 8×              | 1 / 1× / 120 m                   | 1 / 1.5×                  |
| Epic      | 20 km      | ultra (400 m)   | TAA  | GTAO medium | 2K / 16×             | 1 / 1.5× / 250 m                 | 1 / 2×                    |
| Cinematic | 30 km      | ultra (700 m)   | TAA  | GTAO high   | 2K / 16×             | 1 / 2× / 350 m                   | 1.25 (supersampled) / 3×  |

**Retina / HiDPI resolution cap.** `max_pixel_ratio` caps the device pixel ratio of the output (the
canvas); the browser upsamples the canvas to the screen. A MacBook's 2× Retina screen at native resolution
has four times the pixels of the same window on a 1× screen, and every full-screen pass (TAA, light shafts,
bloom, grading …) pays for each of them. At High, the cap of 1.5× outputs 56 % of the native pixels. Epic
outputs native Retina (2×). 1× screens are not affected.

**Render scale (TSR-style upscaling).** The render scale applies on top of the capped resolution, like
Unreal's screen percentage:

- Below 1× the canvas stays at the capped resolution and only the scene (and the screen-space lighting
  passes: GTAO, contact shadows, SSR, light shafts) renders at the lower resolution. With TAA, TAAU
  (temporal upsampling, like UE's TSR) reconstructs the output resolution from the jittered frames; the post
  effects after it (depth of field, motion blur, eye adaptation, bloom, grading) run at the output
  resolution. With FXAA, SMAA or no AA, AMD FSR 1 (edge-adaptive upscaling + RCAS sharpening, strength set by
  `sharpen`) upscales the finished image as the last step.
- Above 1× (Cinematic's 1.25) the canvas itself is supersampled and the browser downsamples it.

**Scalability groups.** Like UE's `sg.*` groups, you can set each group to Low, Medium, High or Epic on its
own:

- View distance
- Anti-aliasing
- Post-processing
- Shadows
- Textures
- Effects
- Foliage
- Shading
- Resolution

### Sun shadows

The sun (or moon) shadow is split into two cascades around the focus point (the player, or the editor's
cursor / view target), like UE's cascaded and virtual shadow maps (`resources/game/world/SunShadows.ts`):

- **Near cascade**: a quarter of the shadow distance (at least 20 m) at twice the texel density, re-rendered
  every frame with every caster. The character, swaying grass and trees near the camera keep live
  shadows. With GPU-driven foliage, its pass draws only the plants that reach into it.
- **Far cascade**: the whole shadow distance, **cached**. It is only re-rendered when the focus has moved 6 %
  of the shadow distance, when the sun has turned by more than 0.1° (scrubbing the time of day, weather
  changes, day to night), or when terrain or shadow-casting foliage is edited (at most every 0.2 s while
  edits keep coming). Standing still costs nothing; walking re-renders it every few seconds. The character
  is left out of it, and wind sway is frozen in it, which cannot be seen at that distance.
- The shader uses the near map inside the near square and cross-fades to the far map at its edge. Both
  cascades are snapped to their texels in light space, so shadows do not shimmer as you move.

The Shadows setting picks the far map size (Low 1K … Epic 8K) and the distance. The near map is half that
size. Because the far pass is so rarely drawn, a longer shadow distance now costs little per frame.

**Render pipeline** (`resources/game/core/PostFx.ts`): three.js' node-based `RenderPipeline`, written in
TSL, the same on WebGPU and WebGL 2. The full pass order is under
[Post-processing and photo mode](#post-processing-and-photo-mode). GTAO's `ao_quality` sets its resolution
scale, sample count and radius. Grading, FXAA, SMAA and FSR 1 run after tone mapping because they need
display-referred input. MSAA instead uses a 4× multisampled scene target.

Passes that would do nothing are skipped. For example, the grading terms are left out when every grading
value is neutral, and the light-shaft passes are skipped while the sun is off-screen. The effect graph is
rebuilt only when that set of passes changes; other changes only update uniforms. Every change applies
live, without a reload.

**Depth precision.** On WebGPU the depth buffer is reversed-Z floating point, which keeps distant
geometry, water and occlusion culling stable out to the far plane. WebGL 2 keeps a standard 24-bit depth
buffer: three.js r186's view-position reconstruction doesn't support reversed depth there yet. The game's
own depth code handles both.

**Graphics API.** `renderer_backend` picks WebGPU (Metal / D3D12 / Vulkan; compute shaders, GPU-driven
foliage culling), WebGL 2, or Automatic (WebGPU when the browser supports it). It applies after a reload;
the in-game menu has a Reload button and shows the backend the game is running on.

**Resolution and frame rate:**

- **Dynamic resolution** keeps the canvas at the output resolution and lowers the scene's render scale
  (down to 0.5×); TAAU (or FSR 1 without TAA) upscales it, so the image stays stable while the scale moves.
    - The controller uses the profiler's GPU time (WebGPU timestamp queries, or
      `EXT_disjoint_timer_query_webgl2` on WebGL 2) when the browser supports them.
    - Otherwise it uses the smoothed frame interval. With vsync on, it steps up after a stable period and waits
      longer after each step up that fails.
    - The stats overlay shows the current scale.
- **`max_fps`** limits the frame rate by skipping animation frames. The simulation delta still covers the
  full interval.
- **Anisotropic filtering** applies to every mipmapped texture in the scene and is capped at the GPU's
  limit. This includes the terrain texture arrays.

**In-game menu:** press **F10** or click the monitor button.

- Choose a preset, set each scalability group, or change render scale, the Retina resolution cap, dynamic
  resolution, target FPS and the FPS limit.
- A live readout shows FPS, frame time (CPU and GPU), the graphics API, draw calls, triangles, the internal
  render resolution in pixels (and the output resolution when upscaling) and the active pass chain.
- **Per-pass profiler** (like UE's `stat gpu`): while the menu is open, every pass is timed on the GPU with
  timestamp queries and the CPU sections are timed too. The pipeline's passes all run inside one
  `RenderPipeline.render()`, so each draw is attributed by the name of its pass or render target: the table
  lists the update, water reflection, shadows, scene, GTAO, SSR, light shafts, TAA / TAAU, DoF, eye
  adaptation, bloom, output and so on. The heaviest GPU pass is highlighted. GPU times need WebGPU's
  `timestamp-query` feature or `EXT_disjoint_timer_query_webgl2` on WebGL 2 (Chrome and Edge on desktop).
- Your changes are stored in `localStorage` (`waterways.graphics.overrides.v1`) and applied on top of the
  project settings.
- **Reset to project defaults** removes your changes.

## Post-processing and photo mode

The render pipeline (`resources/game/core/PostFx.ts`, one TSL module per effect in `core/postfx/`, three's
TSL nodes for GTAO, SSR, TAA / TAAU, bloom, FXAA, SMAA and FSR 1) runs in this order. Every stage exists
only when it is enabled.

1. HDR scene with depth. Extra render targets (MRT) only when an effect needs them: motion vectors (TAA,
   motion blur; the skinned player and instanced foliage included), view normals (GTAO, SSR) and
   metalness / roughness (SSR).
2. GTAO and contact shadows (sun or moon direction, ray-marched through the depth buffer).
3. Screen-space reflections where the material is glossy (wet ground: the terrain's roughness).
4. Light shafts (radial blur of the bright sky around the sun or moon).
5. HDR lighting composite of 2-4 at the scene resolution.
6. TAA (un-jittered reconstruction, closest-depth reprojection, Catmull-Rom history, YCoCg variance
   clipping), or TAAU below 1× render scale (see Graphics quality). Everything after this runs at the output
   resolution.
7. Depth of field (physical circle of confusion, autofocus or click-to-focus).
8. Motion blur (skipped for stills and on camera cuts).
9. Auto exposure (GPU histogram without read-backs: a log-luminance image reduced to 16×16 block means and
   a 1×1 feedback pass, identical on WebGPU and WebGL 2).
10. Bloom and lens flare.
11. Output: chromatic aberration, tone mapping, sharpening, LUT colour grade, saturation and contrast,
    vignette; then FXAA / SMAA and FSR 1 when selected; film grain, dither and letterbox.

**Quality switches** live in Game settings → Graphics → Cinematic effects and are set by the presets:

- High: TAA, auto exposure, medium light shafts.
- Epic: adds contact shadows, low SSR, DoF and motion blur, and lens effects.
- Cinematic: everything at full quality.

**How it looks** is set per map in Environment → Camera & look:

- ten film looks (grade + lens bundles);
- exposure and adaptation range, white balance;
- light-shaft strength, bloom threshold;
- focus, aperture and max blur;
- motion blur, lens flare, chromatic aberration, grain, letterbox.

The same film looks are in the editor's Environment sheet for live preview.

**Photo mode (F9)** hides the UI and switches to Cinematic quality. It previews look changes and restores
them on exit. Keys and controls:

- Click to focus, and adjust aperture and field of view.
- `H` hides the panel.
- `Enter` saves a PNG; _2× capture_ renders at twice the resolution.

## Weather & sky

Every map has a weather setup in its **Environment** page (and in the studio editor's live Environment panel).
One-click presets (Clear, Cloudy, Overcast, Foggy, Rain, Storm, Snow, Autumn) set a matching bundle of sky, fog,
precipitation, wind, wetness and exposure values, which you can then fine-tune. The game blends to a new
look over a few seconds, so changes preview smoothly.

| Setting                          | What it does                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `weather`                        | Weather type (for presets); `snow` turns precipitation into snowfall                              |
| `precipitation`                  | Rain / snow amount (0-1): particles, rain ripples on water, rain sound, reduced visibility        |
| `falling_leaves`                 | Autumn leaves blowing through the air around the camera (0-1); combines with any weather          |
| `lightning_frequency`            | Strikes per minute: sky flash, light pulse, branching bolt, thunder delayed by distance (343 m/s) |
| `thunder_volume`                 | Thunder loudness                                                                                  |
| `wind_strength` / `_direction`   | Foliage sway, cloud drift, rain slant, water chop; storms add gusts                               |
| `height_fog_height` / `_density` | Valley fog up to this height above the lowest point of the map (sea level with an ocean); 0 = off |
| `wetness`                        | Darker, glossier ground with puddles on flat ground; rain also soaks the ground over time         |

How it works (`resources/game/world/`):

- **Sky** (`SkyDome.ts`): Preetham scattering plus an fBm cloud layer with self-shadowing towards the sun
  (octaves and light steps follow the `cloud_quality` graphics setting). Overcast skies turn into a grey
  cloud deck and storms darken it. Nights have stars, a moon and moonlight. Lightning lights the clouds
  from inside.
- **Fog** (`HeightFog.ts`): three's fog shader chunks are patched once, so every material (terrain, water,
  foliage, characters) gets exponential distance fog, analytic height fog and sun in-scattering. The fog
  colour follows the sky's horizon, so distant terrain melts into the sky.
- **Precipitation** (`Precipitation.ts`): rain streaks and snowflakes are instanced quads that are animated
  and wrapped around the camera entirely on the GPU. `effects_quality` sets the particle budget, and the
  active count scales with the amount.
- **Storms** (`Lightning.ts`, `WeatherAudio.ts`): procedural branching bolts, a flash light and synthesised
  WebAudio (rain and wind noise loops, thunder claps). Browsers only allow sound after a click or key
  press. Set `localStorage['waterways.muted'] = '1'` to mute.
- **Ground** (`TerrainMaterial.ts`): global wetness and snow cover. Snow settles on flatter ground first.

## AI agents (MCP server)

Claude (Desktop or Code) or any MCP client can connect to the project and build with it. It can set up maps,
layers, biomes, foliage, weather and settings, and shape the world: sculpt landforms, dig lakes and rivers,
paint layers and biomes, scatter or clear foliage and place props, all live in the editor you have open. With
the editor's **Request** tool you outline an area, describe what you want and add reference images; Claude
picks the request up, builds it and reports back with a screenshot. It sees the
world through screenshots and top-down map images with coordinate grids. It can also bring in assets: import
GLB models (e.g. built with Blender MCP) as props or foliage, and generate images, terrain materials and Meshy
models with the project's AI keys. Setup, safety (automatic snapshots, local only) and the tool list are in [docs/MCP.md](docs/MCP.md).
In short: `claude mcp add waterways -- php artisan mcp:start waterways` in the project folder (or add that
command to Claude Desktop), then open the map in the studio.
Without an open editor, agents can start a hidden one (`open_editor`, needs Chrome, Chromium, Edge or Brave) and work unattended.

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
| V / Shift+V                    | Next / previous view mode (Lit, Lighting only, Layers, …)   |
| P / Alt+P                      | Play from the camera / from the player start                |
| F10                            | Graphics menu (presets, scalability, frame rate)            |

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
resources/game/            The game (TypeScript + Three.js WebGPURenderer with TSL node materials; WebGPU with a
                           WebGL 2 fallback; separate Vite entry)
  shared/                  Contracts shared with the studio: manifest types + postMessage protocol
  core/                    Game loop, renderer setup, API client, iframe bridge, input, GPU profiler,
                           PostFx (RenderPipeline) + postfx/ (one TSL module per effect)
  world/                   Heightfield, Terrain (LOD chunks), TerrainMaterial, SplatMap, Water,
                           Atmosphere, SkyDome, HeightFog (scene fog node), Weather,
                           Foliage (+ procedural FoliageGeometry, baked GLB LODs, foliage/: TSL material,
                           GPU culling, Hi-Z, impostors)
  tools/FoliageBaker.ts    In-browser foliage asset optimiser (LODs, impostor, cards, thumbnail)
  player/                  Character controller, third-person camera, procedural / glTF character
  editor/                  Editor (tools, strokes), Brush, History (undo), FlyCamera, terrainOps, UI panel,
                           ViewModes (view modes; their shader side is world/TerrainDebugView)
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

Looks:

- Stronger large-scale colour variation for PBR terrain materials (procedural layers have it; the
  layer blend is already height-based, with triplanar cliffs and far-distance detail blending).
- Smooth (dithered) crossfades between foliage LODs instead of hard switches.
- Visible wind gusts travelling across grass fields and tree canopies.
- Grass that bends around the player.
- Cloud shadows moving over the landscape, and light shafts through trees in fog.
- Bounce light: a coarse irradiance grid (green light under a canopy, warm light off sand).
- Water: shoreline foam, rivers flowing along their course, caustics on shallow beds.
- Weather traces: footprints in snow, puddles collecting in hollows during rain.

Performance:

- Two-phase occlusion culling (no one-frame-late reveal when turning quickly past obstacles).
- Dynamic resolution that holds the display's refresh rate instead of fixed presets.
- Compressed textures (KTX2 / Basis) and compressed models: less video memory, faster loading.
- Octahedral impostors for distant trees (correct from every angle, so the far LOD can start closer).
- Editor work in web workers on the WebGL fallback (erosion, scatter, ground cover).

Building:

- A path / road tool (flattens, paints a layer, clears foliage, blends edges); rivers editable after creation.
- Landscape stamps (mountain, crater, dune and ridge shapes).
- Prop placement: individual models (huts, bridges, rocks) with snapping, rotation and scale.
- All layer, material and weather settings editable in the editor instead of the studio.
- An undo history panel, and automatic map snapshots.
- A walk mode inside the editor to judge scale without switching to Play.
- Map templates ("coastal village", "alpine lake") and AI-described starting maps.

Further out:

- Streaming and multi-tile worlds beyond 1025².
- Terrain holes, and foliage collision for the player.
- Gameplay entities: NPCs, boats, quests.
- A build/publish pipeline that exports a standalone game bundle from the studio.
