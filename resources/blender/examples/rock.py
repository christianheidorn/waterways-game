# Rock: a noisy, flattened icosphere with a flat base, about 1.6 × 1.2 m and 0.9 m high.
# Rocks scattered in numbers belong in foliage (kind "rock": LODs, impostors, GPU culling):
# export with lods, e.g. blender_export_prop kind "foliage", lods [1, 0.4, 0.15].
#
# Blender is Z-up. The base sits at z = 0.

stone = wb.textured_material("Rock", "stone", "#5d5a55", "#a29d93", tile=1.5, roughness=0.95, seed=7)

rock = wb.sphere(radius=0.7, subdivisions=3, at=(0, 0, 0.35), name="Rock")
wb.subdivide(rock, 1)
rock.scale = (1.15, 0.9, 0.7)
wb.apply_transforms(rock)
wb.jitter(rock, amount=0.22, scale=0.9, seed=3)     # large lumps
wb.jitter(rock, amount=0.05, scale=0.2, seed=8)     # small chips
wb.flatten_bottom(rock, 0.0)
wb.decimate_to(1500)
wb.shade(rock, smooth=True, angle=45)
wb.assign(rock, stone)

print(wb.stats())
