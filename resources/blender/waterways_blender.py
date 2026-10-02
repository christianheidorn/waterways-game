"""
Waterways helper library for modelling game assets with Blender running headless
(`blender --background --python job.py`). Every Waterways Blender job has it on sys.path and
imported as `wb`:

    wood = wb.textured_material("Wood", "planks", "#8a6a45", "#5e4630", tile=1.0)
    hut = wb.box((3, 2.5, 2.2), at=(0, 0, 0), mat=wood, bevel=0.03)
    wb.preview()          # turntable contact sheet with a 1.8 m figure for scale
    print(wb.stats())     # triangles, materials, dimensions

Conventions (the game's): metres, ground at z = 0, model centred on x / y. Blender is Z-up; the glTF
export turns that into +Y up. The model's front faces -Y in Blender (+Z in the game). export_glb()
joins the parts, applies modifiers / transforms and moves the pivot to the base centre.

See docs/BLENDER.md for the workflow and examples (resources/blender/examples/).
"""

import json
import math
import os
import random
import sys

import bmesh
import bpy
import mathutils
import numpy as np

PROP_TRIANGLE_BUDGET = 20000
PROP_MATERIAL_BUDGET = 8
FIGURE_HEIGHT = 1.8

_JOB = {'dir': None}
_PREVIEW = '_wb_preview'
_HELPER = 'wb_origin'


# --------------------------------------------------------------------------------------------
# Scene, units, jobs
# --------------------------------------------------------------------------------------------

def reset():
    """Empties the scene (no default cube, camera or light) and sets metric units (1 unit = 1 m)."""
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.cameras,
                 bpy.data.lights, bpy.data.curves):
        for block in list(coll):
            if block.users == 0:
                coll.remove(block)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0
    scene.unit_settings.length_unit = 'METERS'
    random.seed(0)


def job_dir():
    """Folder of the running job (outputs land here); the current directory outside jobs."""
    return _JOB['dir'] or os.getcwd()


def out(name):
    """Path of a file in the job folder (e.g. wb.out("hut.glb"))."""
    path = os.path.join(job_dir(), name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def open_model(path):
    """Opens a .blend, or resets the scene and imports a .glb / .gltf."""
    path = os.path.expanduser(path)
    if path.lower().endswith('.blend'):
        bpy.ops.wm.open_mainfile(filepath=path)
    else:
        reset()
        bpy.ops.import_scene.gltf(filepath=path)


def _run_job(directory, open_path=None, script='script.py', save=True):
    """Entry point of job.py: runs the agent's script, then saves scene.blend and result.json."""
    _JOB['dir'] = directory
    if open_path:
        open_model(open_path)
    else:
        reset()
    script_path = os.path.join(directory, script)
    with open(script_path, encoding='utf-8') as fh:
        source = fh.read()
    namespace = {'wb': sys.modules[__name__], '__name__': '__main__', '__file__': script_path}
    exec(compile(source, script, 'exec'), namespace)
    _cleanup_preview()
    result = {'blender': bpy.app.version_string, 'stats': stats() if _meshes() else None}
    if save:
        blend = os.path.join(directory, 'scene.blend')
        for image in bpy.data.images:
            if image.source == 'GENERATED' or (image.is_dirty and not image.packed_file):
                try:
                    image.pack()
                except RuntimeError:
                    pass
        bpy.ops.wm.save_as_mainfile(filepath=blend, compress=True)
        result['blend'] = blend
    with open(os.path.join(directory, 'result.json'), 'w', encoding='utf-8') as fh:
        json.dump(result, fh)
    print('@@WB_RESULT ' + json.dumps(result))


# --------------------------------------------------------------------------------------------
# Colours and materials
# --------------------------------------------------------------------------------------------

def _srgb(color):
    """'#rrggbb', (r, g, b) in 0-1 or 0-255 → sRGB floats (0-1)."""
    if isinstance(color, str):
        h = color.lstrip('#')
        if len(h) == 3:
            h = ''.join(c * 2 for c in h)
        return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    rgb = tuple(float(c) for c in color[:3])
    if max(rgb) > 1.0:
        rgb = tuple(c / 255 for c in rgb)
    return rgb


def _linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear(color):
    """sRGB colour (as for _srgb) → linear RGBA, what Blender's colour sockets expect."""
    return tuple(_linear(c) for c in _srgb(color)) + (1.0,)


def _principled(mat):
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        bsdf = nodes.new('ShaderNodeBsdfPrincipled')
        output = next(n for n in nodes if n.type == 'OUTPUT_MATERIAL')
        mat.node_tree.links.new(bsdf.outputs[0], output.inputs[0])
    return bsdf


def material(name, color='#bbbbbb', roughness=0.8, metallic=0.0, emission=None, emission_strength=1.0,
             alpha=None, vertex_colors=False):
    """Plain PBR material (glTF metallic-roughness). Reuses a material of the same name.

    vertex_colors=True multiplies the colour by the mesh's colour attribute (see vertex_gradient()).
    alpha < 1 makes it blended (use sparingly: water, glass)."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    bsdf = _principled(mat)
    bsdf.inputs['Base Color'].default_value = linear(color)
    bsdf.inputs['Roughness'].default_value = float(roughness)
    bsdf.inputs['Metallic'].default_value = float(metallic)
    mat.diffuse_color = linear(color)
    if emission is not None:
        socket = bsdf.inputs.get('Emission Color') or bsdf.inputs.get('Emission')
        socket.default_value = linear(emission)
        bsdf.inputs['Emission Strength'].default_value = float(emission_strength)
    if alpha is not None and alpha < 1:
        bsdf.inputs['Alpha'].default_value = float(alpha)
        if hasattr(mat, 'surface_render_method'):
            mat.surface_render_method = 'BLENDED'
        elif hasattr(mat, 'blend_method'):
            mat.blend_method = 'BLEND'
    if vertex_colors:
        tree = mat.node_tree
        attr = tree.nodes.new('ShaderNodeVertexColor')
        attr.layer_name = 'Col'
        mix = tree.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        mix.inputs[6].default_value = linear(color)
        tree.links.new(attr.outputs['Color'], mix.inputs[7])
        tree.links.new(mix.outputs[2], bsdf.inputs['Base Color'])
    return mat


def _periodic_noise(size, cells, rng):
    """Tileable value noise (size × size, values 0-1) on a cells × cells lattice."""
    grid = rng.random((cells, cells))
    t = np.arange(size) * cells / size
    i0 = np.floor(t).astype(int) % cells
    i1 = (i0 + 1) % cells
    f = t - np.floor(t)
    f = f * f * (3 - 2 * f)
    rows = grid[np.ix_(i0, i0)] * (1 - f)[None, :] + grid[np.ix_(i0, i1)] * f[None, :]
    rows2 = grid[np.ix_(i1, i0)] * (1 - f)[None, :] + grid[np.ix_(i1, i1)] * f[None, :]
    return rows * (1 - f)[:, None] + rows2 * f[:, None]


def _fbm(size, cells, octaves, rng):
    total = np.zeros((size, size))
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        total += _periodic_noise(size, min(size, cells * 2 ** o), rng) * amp
        norm += amp
        amp *= 0.5
    return total / norm


PATTERNS = ('noise', 'wood', 'planks', 'stone', 'bricks', 'thatch', 'metal')


def _pattern(kind, size, seed):
    """Tileable greyscale pattern (0-1, rows = v) for textured_material()."""
    rng = np.random.default_rng(seed)
    n = _fbm(size, 4, 5, rng)
    y, x = np.mgrid[0:size, 0:size] / size
    if kind == 'noise':
        return n
    if kind == 'metal':
        return 0.75 + 0.25 * _fbm(size, 8, 4, rng)
    if kind in ('wood', 'planks'):
        warp = _fbm(size, 2, 3, rng)
        grain = 0.5 + 0.5 * np.sin((x * 24 + warp * 6) * math.pi * 2)
        value = 0.55 + 0.25 * grain + 0.2 * (n - 0.5)
        if kind == 'planks':
            boards = 4
            v = (y * boards) % 1.0
            gap = np.clip(np.minimum(v, 1 - v) * size / boards / 1.5, 0, 1)
            shade = rng.random(boards)[np.floor(y * boards).astype(int) % boards] * 0.25
            value = (value - shade) * (0.35 + 0.65 * gap)
        return np.clip(value, 0, 1)
    if kind == 'stone':
        cells = _fbm(size, 6, 3, rng)
        cracks = np.clip(np.abs(cells - 0.5) * 12, 0, 1)
        return np.clip(0.35 + 0.45 * n + 0.2 * cracks, 0, 1)
    if kind == 'bricks':
        rows = 8
        r = np.floor(y * rows)
        u = (x * 4 + 0.5 * (r % 2)) % 1.0
        v = (y * rows) % 1.0
        mortar = np.clip(np.minimum(np.minimum(u, 1 - u) * size / 4, np.minimum(v, 1 - v) * size / rows) / 2.5, 0, 1)
        tone = rng.random(rows * 8)[(r * 8 + np.floor(x * 4 + 0.5 * (r % 2))).astype(int) % (rows * 8)]
        return np.clip((0.6 + 0.25 * tone + 0.15 * (n - 0.5)) * (0.3 + 0.7 * mortar), 0, 1)
    if kind == 'thatch':
        streak = _periodic_noise(size, size // 2, rng)[:, :]
        streak = np.repeat(streak[:1, :], size, axis=0)
        return np.clip(0.4 + 0.45 * streak + 0.3 * (n - 0.5), 0, 1)
    raise ValueError('Unknown pattern %r: use one of %s' % (kind, ', '.join(PATTERNS)))


def textured_material(name, pattern='noise', color='#8a6a45', color2=None, tile=1.0, roughness=0.85,
                      metallic=0.0, size=256, seed=1):
    """PBR material with a procedural, tileable colour texture baked into an image (glTF needs images).

    pattern: noise, wood (grain along u), planks (boards along u, gaps along v), stone, bricks, thatch,
    metal. color → color2 is the dark → light range (color2 defaults to a lighter color). tile: metres
    one texture repeat covers (objects get box-projected UVs in metres on assign). size: 128-1024 px."""
    size = int(max(64, min(1024, size)))
    dark = np.array(_srgb(color))
    light = np.array(_srgb(color2)) if color2 is not None else np.clip(dark * 1.45 + 0.04, 0, 1)
    value = _pattern(pattern, size, seed)
    rgb = dark[None, None, :] * (1 - value[..., None]) + light[None, None, :] * value[..., None]
    rgba = np.concatenate([rgb, np.ones((size, size, 1))], axis=2).astype(np.float32)
    image_name = 'T_' + name
    old = bpy.data.images.get(image_name)
    if old is not None:
        bpy.data.images.remove(old)
    image = bpy.data.images.new(image_name, size, size, alpha=False)
    image.pixels.foreach_set(rgba.ravel())
    image.pack()

    mat = material(name, color=tuple(dark * 0.5 + light * 0.5), roughness=roughness, metallic=metallic)
    tree = mat.node_tree
    bsdf = _principled(mat)
    tex = tree.nodes.new('ShaderNodeTexImage')
    tex.image = image
    tex.interpolation = 'Linear'
    tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    mat['wb_tile'] = float(tile)
    return mat


def assign(obj, mat, uv=True):
    """Gives obj the material (replacing its materials). Textured materials also get box-projected UVs
    in metres (1 repeat per `tile` metres) unless uv=False."""
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    if uv and mat.get('wb_tile'):
        uv_box(obj, mat['wb_tile'])
    return obj


def uv_box(obj, tile=1.0):
    """Box-projected UVs in metres: each face is mapped from the two axes it faces least."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    layer = bm.loops.layers.uv.verify()
    scale = obj.scale
    for face in bm.faces:
        n = face.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for loop in face.loops:
            co = loop.vert.co
            p = (co.x * scale.x, co.y * scale.y, co.z * scale.z)
            if ax == 0:
                u, v = p[1], p[2]
            elif ax == 1:
                u, v = p[0], p[2]
            else:
                u, v = p[0], p[1]
            loop[layer].uv = (u / tile, v / tile)
    bm.to_mesh(me)
    bm.free()
    return obj


def vertex_gradient(obj, bottom='#555555', top='#ffffff', power=1.0):
    """Colour attribute 'Col' from bottom to top colour along the object's height (cheap baked
    shading / dirt). Use with material(..., vertex_colors=True)."""
    me = obj.data
    attr = me.color_attributes.get('Col') or me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    zs = [v.co.z for v in me.vertices]
    lo, hi = min(zs), max(zs)
    span = max(hi - lo, 1e-6)
    b, t = linear(bottom), linear(top)
    for loop in me.loops:
        f = ((me.vertices[loop.vertex_index].co.z - lo) / span) ** power
        attr.data[loop.index].color = tuple(b[i] * (1 - f) + t[i] * f for i in range(4))
    return obj


# --------------------------------------------------------------------------------------------
# Primitives (built with bmesh at their real size: no object scale)
# --------------------------------------------------------------------------------------------

def _object(name, bm, at, rotate, mat):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = at
    if rotate:
        obj.rotation_euler = tuple(math.radians(a) for a in rotate)
    if mat is not None:
        assign(obj, mat)
    return obj


def mesh(name, bm, at=(0, 0, 0), mat=None, rotate=None):
    """Object from a bmesh you built yourself (custom shapes: hulls, lofts); frees the bmesh."""
    return _object(name, bm, at, rotate, mat)


def box(size=(1, 1, 1), at=(0, 0, 0), name='Box', mat=None, rotate=None, base=True, bevel=0.0):
    """Box of size (x, y, z) metres. base=True: `at` is the bottom centre, else the centre.
    rotate: (x, y, z) degrees. bevel: rounded edges width in metres (modifier, 1 segment)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    sx, sy, sz = size
    for v in bm.verts:
        v.co = mathutils.Vector((v.co.x * sx, v.co.y * sy, v.co.z * sz + (sz / 2 if base else 0)))
    obj = _object(name, bm, at, rotate, mat)
    if bevel:
        globals()['bevel'](obj, bevel)
    return obj


def cylinder(radius=0.5, height=1.0, at=(0, 0, 0), segments=8, radius_top=None, name='Cylinder', mat=None,
             rotate=None, base=True, caps=True):
    """Cylinder (or frustum with radius_top; cone with radius_top=0) along Z. base=True: `at` is the
    bottom centre. Low-poly: 6-12 segments for game props."""
    bm = bmesh.new()
    top = radius if radius_top is None else radius_top
    bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=int(segments), radius1=radius,
                          radius2=top, depth=height)
    if base:
        bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, height / 2))
    return _object(name, bm, at, rotate, mat)


def cone(radius=0.5, height=1.0, **kwargs):
    """Cone along Z (see cylinder())."""
    return cylinder(radius=radius, height=height, radius_top=0.0, **kwargs)


def sphere(radius=0.5, at=(0, 0, 0), subdivisions=2, name='Sphere', mat=None, rotate=None):
    """Icosphere (subdivisions 1 = 80 triangles, 2 = 320, 3 = 1280); `at` is the centre."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=int(subdivisions), radius=radius)
    return _object(name, bm, at, rotate, mat)


def plane(size=(1, 1), at=(0, 0, 0), name='Plane', mat=None, rotate=None):
    """Flat rectangle (x, y) facing up."""
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.5)
    for v in bm.verts:
        v.co.x *= size[0]
        v.co.y *= size[1]
    return _object(name, bm, at, rotate, mat)


def prism(points, thickness=0.1, at=(0, 0, 0), plane='XZ', name='Prism', mat=None, rotate=None):
    """A flat polygon (list of 2D points in `plane`: XZ = front view, YZ = side view, XY = top view)
    extruded `thickness` metres (centred) along the remaining axis: gable ends, signs, boat ribs,
    house outlines (XY extruded upwards = walls of a floor plan)."""
    plane = plane.upper()
    a, b = 'XYZ'.index(plane[0]), 'XYZ'.index(plane[1])
    c = 3 - a - b
    bm = bmesh.new()
    ring = []
    for d in (-thickness / 2, thickness / 2):
        verts = []
        for p in points:
            co = [0.0, 0.0, 0.0]
            co[a], co[b], co[c] = p[0], p[1], d
            verts.append(bm.verts.new(co))
        ring.append(verts)
    bm.faces.new(ring[0])
    bm.faces.new(list(reversed(ring[1])))
    n = len(points)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((ring[0][j], ring[0][i], ring[1][i], ring[1][j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _object(name, bm, at, rotate, mat)


def beam(start, end, size=0.1, name='Beam', mat=None, round=False, segments=6):
    """Square (size or (w, h)) or round (round=True, size = diameter) beam from start to end:
    posts, rails, rafters, ropes."""
    a, b = mathutils.Vector(start), mathutils.Vector(end)
    length = (b - a).length
    w, h = (size, size) if not isinstance(size, (tuple, list)) else size
    bm = bmesh.new()
    if round:
        bmesh.ops.create_cone(bm, cap_ends=True, segments=int(segments), radius1=w / 2, radius2=w / 2, depth=length)
    else:
        bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co = mathutils.Vector((v.co.x * w, v.co.y * h, v.co.z * length))
    obj = _object(name, bm, (a + b) / 2, None, mat)
    obj.rotation_mode = 'QUATERNION'
    obj.rotation_quaternion = (b - a).to_track_quat('Z', 'Y')
    if mat is not None and mat.get('wb_tile'):
        apply_transforms(obj)
        uv_box(obj, mat['wb_tile'])
    return obj


def gable_roof(width, depth, rise, at=(0, 0, 0), thickness=0.12, overhang=0.3, name='Roof', mat=None):
    """Two-sided pitched roof. width along x (the ridge runs along y), `at` is the centre of the eaves
    line (wall top); rise = ridge height above it."""
    half = width / 2 + overhang
    slope = math.atan2(rise, width / 2)
    length = half / math.cos(slope)
    x0, y0, z0 = at
    parts = []
    for side in (-1, 1):
        part = box((length, depth + 2 * overhang, thickness), at=(0, 0, 0), name=name, mat=None, base=False)
        part.rotation_euler = (0, side * slope, 0)
        part.location = (x0 + side * half / 2, y0, z0 + rise - (half / 2) * math.tan(slope) + thickness / 2)
        parts.append(part)
    roof = join(parts, name)
    if mat is not None:
        apply_transforms(roof)
        assign(roof, mat)
    return roof


# --------------------------------------------------------------------------------------------
# Modifiers and mesh edits
# --------------------------------------------------------------------------------------------

def _origin_empty():
    empty = bpy.data.objects.get(_HELPER)
    if empty is None:
        empty = bpy.data.objects.new(_HELPER, None)
        bpy.context.scene.collection.objects.link(empty)
    return empty


def bevel(obj, width=0.02, segments=1, angle=40):
    """Bevels edges sharper than `angle` degrees (catches light; 1 segment keeps it cheap)."""
    mod = obj.modifiers.new('Bevel', 'BEVEL')
    mod.width = width
    mod.segments = int(segments)
    mod.limit_method = 'ANGLE'
    mod.angle_limit = math.radians(angle)
    if hasattr(mod, 'harden_normals'):
        mod.harden_normals = False
    return mod


def array(obj, count, offset=(1, 0, 0)):
    """Repeats obj `count` times, each copy moved by `offset` metres (planks, fence pickets, steps)."""
    mod = obj.modifiers.new('Array', 'ARRAY')
    mod.count = int(count)
    mod.use_relative_offset = False
    mod.use_constant_offset = True
    mod.constant_offset_displace = offset
    return mod


def mirror(obj, axis='X'):
    """Mirrors obj across the world plane through the origin (axis X: left / right halves)."""
    mod = obj.modifiers.new('Mirror', 'MIRROR')
    mod.use_axis = [a in axis.upper() for a in 'XYZ']
    mod.mirror_object = _origin_empty()
    mod.use_clip = False
    return mod


def solidify(obj, thickness=0.05, offset=-1.0):
    """Gives a flat surface thickness (planes → boards, sails, roofs)."""
    mod = obj.modifiers.new('Solidify', 'SOLIDIFY')
    mod.thickness = thickness
    mod.offset = offset
    return mod


def boolean(obj, cutter, operation='DIFFERENCE'):
    """Cuts (DIFFERENCE), merges (UNION) or intersects obj with cutter, applies it (and the modifiers
    before it) and deletes the cutter. Doors and windows: a box cutter through a wall."""
    mod = obj.modifiers.new('Boolean', 'BOOLEAN')
    mod.object = cutter
    mod.operation = operation
    if hasattr(mod, 'solver'):
        mod.solver = 'EXACT'
    apply_modifiers(obj)
    bpy.data.objects.remove(cutter, do_unlink=True)
    return obj


def decimate(obj, ratio=0.5):
    """Collapse-decimates obj to `ratio` of its triangles (applied)."""
    apply_modifiers(obj)
    mod = obj.modifiers.new('Decimate', 'DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = max(0.01, min(1.0, ratio))
    if hasattr(mod, 'use_collapse_triangulate'):
        mod.use_collapse_triangulate = True
    apply_modifiers(obj)
    return obj


def subdivide(obj, cuts=1):
    """Splits every edge `cuts` times (more vertices for jitter())."""
    apply_modifiers(obj)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges, cuts=int(cuts), use_grid_fill=True)
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def jitter(obj, amount=0.1, scale=1.0, seed=0):
    """Moves vertices by smooth 3D noise (amount metres, features about `scale` metres): rocks, hand-made
    wobble, terrain-like lumps."""
    apply_modifiers(obj)
    offset = mathutils.Vector((seed * 13.7, seed * 7.3, seed * 3.1))
    for v in obj.data.vertices:
        p = v.co / max(scale, 1e-4) + offset
        v.co += mathutils.noise.noise_vector(p) * amount
    obj.data.update()
    return obj


def flatten_bottom(obj, z=0.0):
    """Clamps vertices below world height z to it (a flat base that sits on the ground)."""
    apply_transforms(obj)
    for v in obj.data.vertices:
        if v.co.z < z:
            v.co.z = z
    obj.data.update()
    return obj


def shade(obj, smooth=True, angle=35):
    """Smooth shading with edges sharper than `angle` degrees kept hard (exported as split normals)."""
    apply_modifiers(obj)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for face in bm.faces:
        face.smooth = smooth
    limit = math.radians(angle)
    for edge in bm.edges:
        edge.smooth = not (len(edge.link_faces) == 2 and edge.calc_face_angle(0) > limit)
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def apply_modifiers(obj):
    """Bakes obj's modifier stack into its mesh."""
    if obj.type != 'MESH' or not obj.modifiers:
        return obj
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph), preserve_all_data_layers=True,
                                           depsgraph=depsgraph)
    old = obj.data
    obj.modifiers.clear()
    obj.data = mesh
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return obj


def apply_transforms(obj):
    """Bakes location / rotation / scale into the mesh (the object sits at the origin afterwards)."""
    bpy.context.view_layer.update()
    if obj.type == 'MESH':
        obj.data.transform(obj.matrix_world)
        obj.data.update()
    obj.matrix_world = mathutils.Matrix.Identity(4)
    return obj


def duplicate(obj, at=None, rotate=None, name=None):
    """Linked-free copy of obj (with its modifiers), optionally moved / turned (degrees)."""
    copy = obj.copy()
    copy.data = obj.data.copy()
    if name:
        copy.name = name
    bpy.context.scene.collection.objects.link(copy)
    if at is not None:
        copy.location = at
    if rotate is not None:
        copy.rotation_mode = 'XYZ'
        copy.rotation_euler = tuple(math.radians(a) for a in rotate)
    return copy


def join(objs, name='Model'):
    """Joins meshes into one object (modifiers and transforms applied)."""
    objs = [o for o in objs if o.type == 'MESH']
    if not objs:
        raise ValueError('join(): no mesh objects')
    for o in objs:
        apply_modifiers(o)
        apply_transforms(o)
    target = objs[0]
    if len(objs) > 1:
        with bpy.context.temp_override(active_object=target, selected_editable_objects=objs,
                                       selected_objects=objs, object=target):
            bpy.ops.object.join()
    target.name = name
    target.data.name = name
    return target


def delete(obj):
    bpy.data.objects.remove(obj, do_unlink=True)


# --------------------------------------------------------------------------------------------
# Whole model: stats, budgets, finalising, LODs, export
# --------------------------------------------------------------------------------------------

def _meshes():
    preview = bpy.data.collections.get(_PREVIEW)
    hidden = set(preview.objects) if preview else set()
    return [o for o in bpy.context.scene.objects if o.type == 'MESH' and o not in hidden]


def triangles(objs=None):
    """Triangles of the objects (default: the whole model) with modifiers applied."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    total = 0
    for obj in objs or _meshes():
        mesh = obj.evaluated_get(depsgraph).to_mesh()
        mesh.calc_loop_triangles()
        total += len(mesh.loop_triangles)
        obj.evaluated_get(depsgraph).to_mesh_clear()
    return total


def bounds(objs=None):
    """World bounds ((min x, y, z), (max x, y, z)) of the model with modifiers applied."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    for obj in objs or _meshes():
        ev = obj.evaluated_get(depsgraph)
        mesh = ev.to_mesh()
        mw = ev.matrix_world
        for v in mesh.vertices:
            p = mw @ v.co
            for i in range(3):
                lo[i] = min(lo[i], p[i])
                hi[i] = max(hi[i], p[i])
        ev.to_mesh_clear()
    if lo[0] == math.inf:
        return (0, 0, 0), (0, 0, 0)
    return tuple(lo), tuple(hi)


def _lod_of(name):
    import re
    m = re.search(r'(?:^|[_\-\s.])lod[_\-\s]?(\d+)$', name, re.I)
    return int(m.group(1)) if m else None


def stats(objs=None):
    """Triangles, vertices, meshes (draw calls ≈ meshes × materials), materials and dimensions (metres;
    width x, depth y, height z) of the model, with prop budget warnings. With LODs: LOD0 counts."""
    objs = objs or _meshes()
    lods = {}
    for o in objs:
        lod = _lod_of(o.name)
        if lod is not None:
            lods.setdefault(lod, []).append(o)
    main = lods.get(min(lods)) if lods else objs
    depsgraph = bpy.context.evaluated_depsgraph_get()
    verts = 0
    for o in main:
        mesh = o.evaluated_get(depsgraph).to_mesh()
        verts += len(mesh.vertices)
        o.evaluated_get(depsgraph).to_mesh_clear()
    mats = sorted({s.material.name for o in main for s in o.material_slots if s.material})
    lo, hi = bounds(main)
    tris = triangles(main)
    result = {
        'triangles': tris,
        'vertices': verts,
        'meshes': len(main),
        'materials': len(mats),
        'material_names': mats,
        'dimensions': {'width': round(hi[0] - lo[0], 3), 'depth': round(hi[1] - lo[1], 3),
                       'height': round(hi[2] - lo[2], 3)},
        'base': {'x': round((lo[0] + hi[0]) / 2, 3), 'y': round((lo[1] + hi[1]) / 2, 3), 'z': round(lo[2], 3)},
    }
    if lods:
        result['lods'] = {str(k): triangles(v) for k, v in sorted(lods.items())}
    warnings = []
    if tris > PROP_TRIANGLE_BUDGET:
        warnings.append('%d triangles: over the prop budget of %d (decimate_to()).' % (tris, PROP_TRIANGLE_BUDGET))
    if len(mats) > PROP_MATERIAL_BUDGET:
        warnings.append('%d materials: over the prop budget of %d (share materials).' % (len(mats), PROP_MATERIAL_BUDGET))
    if abs(result['base']['z']) > 0.01 or abs(result['base']['x']) > 0.05 or abs(result['base']['y']) > 0.05:
        warnings.append('The model is not standing on the origin (base %s); export_glb() moves the pivot to the base centre.' % result['base'])
    if warnings:
        result['warnings'] = warnings
    return result


def decimate_to(max_triangles, objs=None):
    """Decimates the model (proportionally over all meshes) to about max_triangles. No-op below it."""
    objs = objs or _meshes()
    total = triangles(objs)
    if total <= max_triangles:
        return total
    ratio = max_triangles / total
    for o in objs:
        decimate(o, ratio)
    return triangles(objs)


def finalize(name='Model', join_parts=True):
    """Prepares the model for the game: applies modifiers and transforms, removes helper objects,
    joins the parts into one mesh (one draw call per material) and moves the pivot to the base centre
    (x / y centred, lowest point at z = 0). Returns the model object (or the parts)."""
    _cleanup_preview()
    helper = bpy.data.objects.get(_HELPER)
    objs = _meshes()
    if not objs:
        raise ValueError('finalize(): the scene has no meshes')
    for o in objs:
        apply_modifiers(o)
    if helper is not None:
        bpy.data.objects.remove(helper, do_unlink=True)
    for o in list(bpy.context.scene.objects):
        if o.type not in ('MESH',):
            bpy.data.objects.remove(o, do_unlink=True)
    for o in objs:
        apply_transforms(o)
    parts = [join(objs, name)] if join_parts and len(objs) > 1 else objs
    if len(parts) == 1:
        parts[0].name = name
    lo, hi = bounds(parts)
    shift = mathutils.Matrix.Translation((-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]))
    for o in parts:
        o.data.transform(shift)
        o.data.update()
    return parts[0] if len(parts) == 1 else parts


def make_lods(obj, ratios=(1.0, 0.5, 0.25), name=None):
    """LOD copies of a finalized object, named <name>_LOD0, _LOD1 … (the naming the game's foliage
    loader understands). ratios: share of LOD0's triangles per level."""
    name = name or obj.name
    levels = []
    for i, ratio in enumerate(ratios):
        lod = obj if i == 0 else duplicate(obj)
        lod.name = '%s_LOD%d' % (name, i)
        if i > 0 and ratio < 1:
            decimate(lod, ratio)
        levels.append(lod)
    return levels


def _export_kwargs(path):
    wanted = {
        'filepath': path,
        'export_format': 'GLB',
        'export_yup': True,
        'export_apply': True,
        'export_texcoords': True,
        'export_normals': True,
        'export_materials': 'EXPORT',
        'export_image_format': 'AUTO',
        'export_cameras': False,
        'export_lights': False,
        'export_extras': False,
        'export_animations': False,
        'use_selection': False,
        'use_visible': False,
    }
    known = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    return {k: v for k, v in wanted.items() if k in known}


def export_glb(path=None, name='Model', max_triangles=None, lods=None, join_parts=True):
    """Finalizes and exports the model as a game-ready .glb (metres, +Y up, pivot at the base centre).

    path: defaults to <job>/<name>.glb. max_triangles: decimate first. lods: ratios such as
    (1, 0.5, 0.2) to write <name>_LOD0.. levels (for foliage models; props draw LOD0 only).
    Returns (path, stats)."""
    path = os.path.expanduser(path) if path else out(name.replace(' ', '_') + '.glb')
    model = finalize(name, join_parts=join_parts)
    if max_triangles:
        decimate_to(int(max_triangles))
    if lods:
        if isinstance(model, list):
            model = join(model, name)
        make_lods(model, lods, name)
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.ops.export_scene.gltf(**_export_kwargs(path))
    info = stats()
    info['path'] = path
    info['bytes'] = os.path.getsize(path)
    print('@@WB_EXPORT ' + json.dumps(info))
    return path, info


# --------------------------------------------------------------------------------------------
# Preview renders
# --------------------------------------------------------------------------------------------

def _preview_collection():
    coll = bpy.data.collections.get(_PREVIEW)
    if coll is None:
        coll = bpy.data.collections.new(_PREVIEW)
        bpy.context.scene.collection.children.link(coll)
    return coll


def _cleanup_preview():
    coll = bpy.data.collections.get(_PREVIEW)
    if coll is None:
        return
    for o in list(coll.objects):
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if data is not None and data.users == 0:
            if isinstance(data, bpy.types.Mesh):
                bpy.data.meshes.remove(data)
            elif isinstance(data, bpy.types.Camera):
                bpy.data.cameras.remove(data)
            elif isinstance(data, bpy.types.Light):
                bpy.data.lights.remove(data)
    bpy.data.collections.remove(coll)
    for name in ('_wb_figure', '_wb_ground'):
        mat = bpy.data.materials.get(name)
        if mat is not None and mat.users == 0:
            bpy.data.materials.remove(mat)


def _to_preview(obj):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    _preview_collection().objects.link(obj)
    return obj


def _figure(x, y):
    """A 1.8 m tall stand-in person (legs, body, arms, head) for scale."""
    mat = material('_wb_figure', '#d9734a', roughness=0.7)
    parts = [
        box((0.13, 0.15, 0.86), at=(x - 0.09, y, 0), mat=mat),
        box((0.13, 0.15, 0.86), at=(x + 0.09, y, 0), mat=mat),
        box((0.42, 0.24, 0.66), at=(x, y, 0.84), mat=mat),
        box((0.1, 0.12, 0.62), at=(x - 0.27, y, 0.86), mat=mat),
        box((0.1, 0.12, 0.62), at=(x + 0.27, y, 0.86), mat=mat),
        box((0.08, 0.08, 0.08), at=(x, y, 1.5), mat=mat),
        sphere(0.12, at=(x, y, FIGURE_HEIGHT - 0.12), subdivisions=2, mat=mat),
    ]
    for p in parts:
        _to_preview(p)
    return parts


def _engine(name):
    items = bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items.keys()
    if name == 'eevee':
        return 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in items else 'BLENDER_EEVEE'
    if name == 'cycles':
        return 'CYCLES'
    return 'BLENDER_WORKBENCH'


def _setup_render(engine, size):
    scene = bpy.context.scene
    scene.render.engine = _engine(engine)
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    if hasattr(scene.view_settings, 'view_transform'):
        try:
            scene.view_settings.view_transform = 'AgX' if engine != 'workbench' else 'Standard'
        except TypeError:
            scene.view_settings.view_transform = 'Filmic'
    if engine == 'eevee':
        scene.eevee.taa_render_samples = 16
        for attr in ('use_shadows', 'use_raytracing'):
            if hasattr(scene.eevee, attr):
                setattr(scene.eevee, attr, attr == 'use_shadows')
    elif engine == 'cycles':
        scene.cycles.device = 'CPU'
        scene.cycles.samples = 24
        scene.cycles.use_denoising = False
        scene.cycles.max_bounces = 3
    else:
        shading = scene.display.shading
        shading.light = 'STUDIO'
        shading.color_type = 'TEXTURE'
        shading.show_shadows = True
        shading.show_cavity = True
        shading.cavity_type = 'WORLD'
        scene.display.render_aa = '8'
    world = scene.world or bpy.data.worlds.new('World')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    if bg is not None:
        bg.inputs[0].default_value = (0.42, 0.5, 0.6, 1.0)
        bg.inputs[1].default_value = 0.9


def preview(views=4, size=384, engine='eevee', figure=True, ground=True, elevation=22, folder='preview',
            sheet=True, distance=1.0):
    """Renders the model from `views` directions around it (front three-quarter first) with a 1.8 m
    figure beside it for scale and a ground disc. Writes <job>/<folder>/view_N.png and sheet.png (all
    views in one image). engine: eevee (materials, default), workbench (fast, flat studio light) or
    cycles (CPU, slow). distance > 1 moves the camera back. Returns the image paths (sheet first)."""
    _cleanup_preview()
    objs = _meshes()
    if not objs:
        raise ValueError('preview(): the scene has no meshes to render')
    lo, hi = bounds(objs)
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    if figure:
        _figure(hi[0] + 0.5, lo[1] + 0.3)
        hi = (hi[0] + 0.75, hi[1], max(hi[2], FIGURE_HEIGHT))
        lo = (lo[0], lo[1], min(lo[2], 0))
        cx = (lo[0] + hi[0]) / 2
    center = mathutils.Vector((cx, cy, (lo[2] + hi[2]) / 2))
    radius = max(0.3, (mathutils.Vector(hi) - mathutils.Vector(lo)).length / 2)
    if ground:
        g = cylinder(radius * 3, 0.02, at=(cx, cy, min(lo[2], 0) - 0.02), segments=48,
                     mat=material('_wb_ground', '#8f8a7e', roughness=1.0), name='_wb_ground')
        _to_preview(g)
    sun_data = bpy.data.lights.new('_wb_sun', 'SUN')
    sun_data.energy = 3.5
    sun_data.angle = math.radians(8)
    sun = bpy.data.objects.new('_wb_sun', sun_data)
    sun.rotation_euler = (math.radians(50), 0, math.radians(35))
    _preview_collection().objects.link(sun)
    cam_data = bpy.data.cameras.new('_wb_camera')
    cam_data.lens = 50
    cam_data.clip_start = 0.01
    cam_data.clip_end = radius * 50
    cam = bpy.data.objects.new('_wb_camera', cam_data)
    _preview_collection().objects.link(cam)
    scene = bpy.context.scene
    scene.camera = cam
    _setup_render(engine, int(size))
    fov = cam_data.angle
    dist = radius / math.sin(fov / 2) * 1.05 * distance
    folder_path = out(os.path.join(folder, 'x'))[:-1]
    paths = []
    count = max(1, min(8, int(views)))
    for i in range(count):
        az = math.radians(-35 + i * 360 / count)
        el = math.radians(elevation)
        offset = mathutils.Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el))) * dist
        cam.location = center + offset
        cam.rotation_euler = (-offset).to_track_quat('-Z', 'Y').to_euler()
        path = os.path.join(folder_path, 'view_%d.png' % i)
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        paths.append(path)
    if sheet and count > 1:
        paths.insert(0, _sheet(paths, os.path.join(folder_path, 'sheet.png')))
    _cleanup_preview()
    print('@@WB_PREVIEW ' + json.dumps(paths))
    return paths


def _sheet(paths, target):
    """Puts the view images side by side (2 rows from 4 views up) into one PNG."""
    images = [bpy.data.images.load(p) for p in paths]
    w, h = images[0].size
    cols = len(images) if len(images) < 4 else math.ceil(len(images) / 2)
    rows = math.ceil(len(images) / cols)
    canvas = np.ones((rows * h, cols * w, 4), dtype=np.float32)
    for i, img in enumerate(images):
        px = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        r, c = divmod(i, cols)
        # Blender image rows start at the bottom.
        y0 = (rows - 1 - r) * h
        canvas[y0:y0 + h, c * w:(c + 1) * w] = px.reshape(h, w, 4)
        bpy.data.images.remove(img)
    out_img = bpy.data.images.new('_wb_sheet', cols * w, rows * h, alpha=False)
    out_img.pixels.foreach_set(canvas.ravel())
    out_img.filepath_raw = target
    out_img.file_format = 'PNG'
    out_img.save()
    bpy.data.images.remove(out_img)
    return target
