# Rowing boat: a lofted hull (stations from bow to stern), solidified planking, two thwarts
# (benches), a keel strip and a pair of oars. 3.6 m long, 1.3 m wide. Import with buoyancy so it floats.
#
# Blender is Z-up: x = length (bow at +x), y = beam (width), z = height. The keel touches z = 0.
import bmesh

LENGTH, BEAM, DEPTH = 3.6, 1.3, 0.55

hull_wood = wb.textured_material("Boat planks", "planks", "#3f5d6e", "#6f93a3", tile=0.8)
inner_wood = wb.textured_material("Boat inside", "wood", "#7a5a3c", "#b08a62", tile=0.7)
trim = wb.material("Boat trim", "#d8d2c2", roughness=0.6)

# Hull stations: (x, half width at the gunwale, keel height, sheer height). Each is a U-shaped
# cross-section; the stations are bridged into one surface.
stations = [
    (-1.80, 0.42, 0.10, DEPTH + 0.02),   # transom (flat stern)
    (-1.20, 0.60, 0.02, DEPTH - 0.03),
    (-0.30, 0.65, 0.00, DEPTH - 0.06),
    (0.60, 0.58, 0.02, DEPTH - 0.04),
    (1.40, 0.32, 0.08, DEPTH + 0.04),
    (1.80, 0.02, 0.20, DEPTH + 0.12),    # stem (bow)
]
SECTION = 7  # points per half section, gunwale → keel

bm = bmesh.new()
rings = []
for x, half, keel, sheer in stations:
    ring = []
    for side in (-1, 1):
        pts = []
        for i in range(SECTION):
            t = i / (SECTION - 1)                 # 0 = gunwale, 1 = keel
            y = side * half * (1 - t ** 1.6)
            z = keel + (sheer - keel) * (1 - t) ** 1.3
            pts.append((x, y, z))
        ring.extend(pts if side < 0 else list(reversed(pts))[1:])
    rings.append([bm.verts.new(p) for p in ring])
for a, b in zip(rings, rings[1:]):
    for i in range(len(a) - 1):
        bm.faces.new((a[i], a[i + 1], b[i + 1], b[i]))
# Close the transom.
bm.faces.new(list(reversed(rings[0])))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
hull = wb.mesh("Hull", bm, mat=hull_wood)
wb.solidify(hull, thickness=0.035, offset=1.0)
wb.shade(hull, smooth=True, angle=50)

# Gunwale rail, keel strip, thwarts and oars.
for side in (-1, 1):
    pts = [(x, side * half, sheer + 0.01) for x, half, keel, sheer in stations]
    for p, q in zip(pts, pts[1:]):
        wb.beam(p, q, size=(0.06, 0.04), mat=trim, name="Gunwale")
wb.beam((-1.75, 0, 0.0), (1.82, 0, 0.12), size=(0.06, 0.08), mat=trim, name="Keel")
for x, w in ((-0.9, 1.05), (0.35, 1.18)):
    wb.box((0.26, w, 0.04), at=(x, 0, 0.36), mat=inner_wood, bevel=0.01, name="Thwart")
wb.box((0.9, 0.6, 0.02), at=(-0.3, 0, 0.06), mat=inner_wood, name="Floorboards")
for side in (-1, 1):
    wb.beam((0.9, side * 0.45, 0.45), (-1.4, side * 0.55, 0.42), size=0.045, round=True, mat=inner_wood, name="Oar")
    wb.box((0.5, 0.14, 0.015), at=(-1.55, side * 0.56, 0.41), mat=inner_wood, name="Oar blade")

print(wb.stats())
