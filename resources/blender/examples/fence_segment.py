# Fence segment: two posts and two rails with pickets, 2.4 m long and 1.1 m high. Built so copies
# line up end to end: the posts sit at x = ±1.2 (place_props `path` rows them along a line).
#
# Blender is Z-up: x = length, y = depth, z = height. Ground at z = 0.

L, H = 2.4, 1.1

wood = wb.textured_material("Fence wood", "wood", "#7b6046", "#b39874", tile=0.6)

# Posts with a pointed top.
for x in (-L / 2 + 0.06, L / 2 - 0.06):
    wb.box((0.12, 0.12, H), at=(x, 0, 0), mat=wood, bevel=0.015, name="Post")
    wb.cone(radius=0.085, height=0.1, segments=4, at=(x, 0, H), rotate=(0, 0, 45), mat=wood, name="Cap")

# Two rails.
for z in (0.3, 0.85):
    wb.box((L - 0.12, 0.05, 0.09), at=(0, 0.06, z), mat=wood, name="Rail")

# Pickets: one picket repeated with an array modifier (one object, cheap to edit).
count = 11
gap = (L - 0.36) / (count - 1)
picket = wb.box((0.08, 0.025, H - 0.15), at=(-L / 2 + 0.18, 0.1, 0.05), mat=wood, name="Picket")
wb.array(picket, count, offset=(gap, 0, 0))

print(wb.stats())
