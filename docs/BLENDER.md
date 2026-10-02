# Modelling with headless Blender

AI agents connected to the Waterways MCP server can model 3D assets in Blender without its UI and without
Blender MCP: the server runs `blender --background` on this computer with a Python script, renders previews
the agent can look at, and imports the result as a prop or foliage model.

| Tool                  | What it does                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blender_status`      | Is Blender found? Version, path, time limit, helper library, examples; install help when missing                                                                  |
| `blender_run`         | Runs a Python script with the helper library (`wb`); returns stats, printed output, the traceback on errors and a turntable contact sheet (`preview`, default on) |
| `blender_preview`     | Renders a job's scene or a `.blend` / `.glb` from 1–8 views (contact sheet or separate images), with a 1.8 m figure for scale; `lod`, `elevation` (90 = top view) |
| `blender_export_prop` | Exports a job as a game-ready GLB (joined, pivot at the base, +Y up, optional `max_triangles` / `lods`) and imports it like `import_model` (prop or foliage)      |

## Setup

- **macOS:** `brew install --cask blender` (or the download from blender.org in `/Applications`). Found
  automatically at `/Applications/Blender.app/Contents/MacOS/Blender`.
- **Linux:** the official tarball from blender.org, the distribution package or `snap install blender --classic`;
  `blender` on `PATH` and common locations (`/usr/bin`, `/usr/local/bin`, `/snap/bin`, `/opt/blender`) are found.
- Elsewhere: `WATERWAYS_BLENDER_PATH=/path/to/blender` in `.env`. Blender 4.2 LTS or newer.
- `WATERWAYS_BLENDER_TIMEOUT` (seconds, default 300) stops runaway jobs.
  `WATERWAYS_BLENDER_PREVIEW_ENGINE` is `eevee` (default: materials and shadows), `workbench` (fast) or `cycles`
  (CPU only, for machines without a GPU / OpenGL).
- Restart the MCP server after changing `.env`; `blender_status` checks the result.

## Workflow

1. **Plan.** Decide the parts and their real sizes in metres before writing code: a door is 2 m high and about
   0.9 m wide, a table 0.75 m, a chair seat 0.45 m, a step 0.18 m, a fence 1–1.2 m, a rowing boat 3–4 m. The
   preview's figure is 1.8 m tall: compare against it.
2. **Script.** One `blender_run` builds the model with the helper library. Print `wb.stats()` at the end.
3. **Preview.** Each run returns a contact sheet of 4 views (front three-quarter first). Check proportions, gaps,
   floating parts and scale. `blender_preview` gives more views, bigger images, a top view (`elevation: 90`) or
   another engine.
4. **Iterate.** Small fixes: `blender_run` with `continue_job` runs a script on top of the saved scene
   (`bpy.data.objects["Roof"]` …). Big changes: edit and rerun the whole script (it is the source of truth).
5. **Export.** `blender_export_prop` with `job_id`, `name`, `category`, `collision` (`mesh` for walk-in
   buildings), `buoyancy` for boats, then `place_props`. Rocks and plants: `kind: "foliage"` with `lods`.

Jobs live in `storage/app/blender/jobs/{job_id}` (`script.py`, `scene.blend`, `preview/`, `model.glb`) for 7 days.

## Coordinates and conventions

- Blender is **Z-up**: x = width, y = depth, z = height. Metres. The ground is z = 0. The front faces **-y**.
- Build around the origin. The export joins all parts, applies modifiers and transforms, centres the model on
  x / y with its lowest point at z = 0 (the game's pivot) and writes glTF with **+Y up**.
- `wb.box(size, at)` and `wb.cylinder(..., at)` take `at` as the **bottom centre** (`base=False`: the centre),
  so stacking is easy: a wall of height 2.3 on a 0.25 m footing goes `at=(x, y, 0.25)`.
- Rotations are degrees `(x, y, z)`.

## Budgets

- Props draw their whole model for every copy in every pass. Aim for **hundreds to a few thousand triangles**
  (a hut ≈ 400–3000, a fence segment ≈ 250, a boat ≈ 600–2000). The hard warning is 20k triangles.
- **Materials ≤ 8**, better 1–4: each material is one draw call per copy. Reuse materials across parts
  (`wb.material("Wood", …)` returns the same material for the same name).
- Low-poly cylinders: 6–12 segments. Bevels: 1 segment, only where light catches edges.
- `wb.decimate_to(n)` or `max_triangles` on export reduce heavy meshes (booleans and jitter add triangles).
- Foliage (rocks, plants) gets LODs: `lods: [1, 0.4, 0.15]` writes `<name>_LOD0…2` (the naming the game's
  foliage loader reads); the bake adds the impostor.

## Helper library (`wb`)

Scene: `wb.reset()`, `wb.open_model(path)`, `wb.out("file.png")` (path in the job folder), `wb.job_dir()`.

Materials (glTF metallic-roughness; colours as `"#rrggbb"` or 0–1 / 0–255 tuples):

- `wb.material(name, color, roughness=0.8, metallic=0, emission=None, alpha=None, vertex_colors=False)`
- `wb.textured_material(name, pattern, color, color2=None, tile=1.0, roughness=0.85, size=256, seed=1)`:
  procedural tileable texture baked into an image (`noise`, `wood`, `planks`, `stone`, `bricks`, `thatch`,
  `metal`); `tile` = metres per repeat. Objects get box-projected UVs in metres when it is assigned.
- `wb.assign(obj, mat)`, `wb.uv_box(obj, tile)`, `wb.vertex_gradient(obj, bottom, top)` (cheap dirt / shading
  with `vertex_colors=True`).

Parts (all real-size meshes, no object scale; `name`, `mat`, `rotate` on each):

- `wb.box(size, at, bevel=0)`, `wb.cylinder(radius, height, at, segments=8, radius_top=None)`, `wb.cone(...)`,
  `wb.sphere(radius, at, subdivisions=2)`, `wb.plane(size, at)`
- `wb.beam(start, end, size=0.1, round=False)`: posts, rails, rafters, ropes between two points
- `wb.prism(points, thickness, at, plane="XZ")`: a 2D outline extruded (gable ends, signs, floor plans)
- `wb.gable_roof(width, depth, rise, at, thickness, overhang)`: two roof slabs, ridge along y
- `wb.mesh(name, bmesh)`: your own bmesh (hulls, lofts; see the boat example)
- `wb.duplicate(obj, at, rotate)`, `wb.join(objs, name)`, `wb.delete(obj)`

Modifiers and edits: `wb.bevel(obj, width, segments=1)`, `wb.array(obj, count, offset)`, `wb.mirror(obj, "X")`
(across the world origin), `wb.solidify(obj, thickness)`, `wb.boolean(obj, cutter, "DIFFERENCE")` (doors,
windows; applied at once), `wb.decimate(obj, ratio)`, `wb.subdivide(obj, cuts)`, `wb.jitter(obj, amount,
scale, seed)` (organic lumps), `wb.flatten_bottom(obj)`, `wb.shade(obj, smooth=True, angle=35)`,
`wb.apply_modifiers(obj)`, `wb.apply_transforms(obj)`.

Whole model: `wb.stats()` (triangles, vertices, meshes, materials, dimensions, base, LODs, budget warnings),
`wb.triangles()`, `wb.bounds()`, `wb.decimate_to(n)`, `wb.finalize(name)`, `wb.make_lods(obj, ratios)`,
`wb.export_glb(path, name, max_triangles, lods)`, `wb.preview(views, size, engine, figure, elevation, lod)`.

Plain `bpy` works everywhere too; the helpers just make the common game-asset steps short and safe.

## Examples

End-to-end scripts in `resources/blender/examples/` (pass the file's text as `script`):

- `wooden_hut.py`: plank walls with door and windows cut by booleans, corner posts, gable ends (`prism`), a
  pitched roof; 4 materials, ≈ 400 triangles. Export with `category: "building"`, `collision: "mesh"`.
- `fence_segment.py`: posts with caps, rails and arrayed pickets, 2.4 m between post centres so copies line up
  along `place_props` paths; 1 material, ≈ 260 triangles.
- `rowing_boat.py`: a hull lofted from cross-sections with bmesh and solidified, gunwales, keel, thwarts, oars;
  3 materials, ≈ 600 triangles. Export with `buoyancy: {"mode": "float", "density": 0.2}`.
- `rock.py`: a jittered, flattened icosphere with a stone texture; ≈ 1.3k triangles. Export as foliage
  (`foliage_kind: "rock"`, `lods: [1, 0.4, 0.15]`).

A small script, for reference:

```python
wood = wb.textured_material("Crate wood", "planks", "#7a5a3a", "#b48a5c", tile=0.6)
iron = wb.material("Crate iron", "#3a3a3c", roughness=0.5, metallic=0.8)
crate = wb.box((0.8, 0.8, 0.8), mat=wood, bevel=0.02)
for z in (0.08, 0.72):
    wb.box((0.82, 0.82, 0.06), at=(0, 0, z - 0.03), mat=iron)
print(wb.stats())
```

## Tips

- Read the traceback: line numbers point into `script.py` (your script).
- Booleans need overlapping, closed meshes: make cutters a little thicker than the wall.
- Keep parts slightly overlapping instead of touching edge to edge: no light leaks or gaps.
- Thin parts (< 2 cm) flicker at a distance; game props read best with chunky, slightly exaggerated details.
- Darker, less saturated colours look right in the game's lighting; textures at 256 px are plenty for props.
- Previews take a few seconds per view on a Mac with Eevee. On machines without a GPU use `workbench` or
  `cycles`.
