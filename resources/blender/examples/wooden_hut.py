# Wooden hut: plank walls with a door and a window cut out, a pitched plank roof, corner posts
# and a stone footing. About 3.6 × 3 m, 3.3 m to the ridge. Walk-in → import with collision "mesh".
#
# Blender is Z-up: x = width, y = depth (the front faces -y), z = height. Ground at z = 0.

W, D, H = 3.6, 3.0, 2.3          # walls: width, depth, height (metres)
T = 0.12                         # wall thickness

planks = wb.textured_material("Hut planks", "planks", "#6b4a2f", "#a57a52", tile=1.2)
beams = wb.textured_material("Hut beams", "wood", "#4a3220", "#7a5636", tile=0.8)
roofing = wb.textured_material("Hut roof", "planks", "#4d3a2a", "#7f6650", tile=0.9, seed=4)
stone = wb.textured_material("Hut stone", "stone", "#5f5c57", "#9b968c", tile=1.0)

# Footing and floor.
wb.box((W + 0.3, D + 0.3, 0.25), at=(0, 0, 0), mat=stone, bevel=0.03, name="Footing")

# Four walls (boxes), then a door and a window cut with box cutters.
walls = [
    wb.box((W, T, H), at=(0, -D / 2 + T / 2, 0.25), mat=planks, name="Front"),
    wb.box((W, T, H), at=(0, D / 2 - T / 2, 0.25), mat=planks, name="Back"),
    wb.box((T, D - 2 * T, H), at=(-W / 2 + T / 2, 0, 0.25), mat=planks, name="Left"),
    wb.box((T, D - 2 * T, H), at=(W / 2 - T / 2, 0, 0.25), mat=planks, name="Right"),
]
front = walls[0]
wb.boolean(front, wb.box((0.95, 1, 1.95), at=(-0.6, -D / 2, 0.25)))          # door 0.95 × 1.95 m
wb.boolean(front, wb.box((0.7, 1, 0.6), at=(0.9, -D / 2, 1.2)))              # window
wb.boolean(walls[3], wb.box((1, 0.8, 0.6), at=(W / 2, 0.2, 1.2)))            # side window

# Corner posts and a lintel over the door.
for x in (-W / 2, W / 2):
    for y in (-D / 2, D / 2):
        wb.box((0.2, 0.2, H), at=(x, y, 0.25), mat=beams, bevel=0.02, name="Post")
wb.box((1.25, 0.18, 0.16), at=(-0.6, -D / 2 - 0.02, 2.2), mat=beams, name="Lintel")
wb.box((0.9, 0.16, 0.08), at=(0.9, -D / 2 - 0.04, 1.12), mat=beams, name="Sill")

# Gable ends (triangles) and the roof.
rise = 1.0
for y in (-D / 2 + T / 2, D / 2 - T / 2):
    wb.prism([(-W / 2, 0), (W / 2, 0), (0, rise)], T, at=(0, y, 0.25 + H), plane="XZ", mat=planks, name="Gable")

wb.gable_roof(W + 0.1, D, rise, at=(0, 0, 0.25 + H), thickness=0.1, overhang=0.35, mat=roofing)
wb.beam((0, -D / 2 - 0.4, 0.25 + H + rise + 0.08), (0, D / 2 + 0.4, 0.25 + H + rise + 0.08), size=0.16,
        mat=beams, name="Ridge")

print(wb.stats())
