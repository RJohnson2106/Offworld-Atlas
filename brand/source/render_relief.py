"""Render a relief model of one site's real elevation data in Blender.

blender -b --python-exit-code 1 -P render_relief.py -- --terrain <folder> --mode icon|banner --out file.png
The terrain is the app's own height grid (Copernicus DEM), split into a Moon-grey and a Mars-rust half.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
parser = argparse.ArgumentParser()
parser.add_argument("--terrain", required=True)
parser.add_argument("--mode", choices=["icon", "banner"], required=True)
parser.add_argument("--out", required=True)
parser.add_argument("--width", type=int, default=1024)
parser.add_argument("--height", type=int, default=1024)
parser.add_argument("--samples", type=int, default=96)
parser.add_argument("--step", type=int, default=2, help="use every Nth height sample for the mesh")
parser.add_argument("--exaggeration", type=float, default=3.0)
parser.add_argument("--texture", type=int, default=3072)
parser.add_argument("--split-angle", type=float, default=22.0, help="degrees clockwise from north")
parser.add_argument("--sun-elevation", type=float, default=28.0)
parser.add_argument("--sun-azimuth", type=float, default=315.0, help="degrees clockwise from north, where the light comes from")
parser.add_argument("--cam-azimuth", type=float, default=200.0)
parser.add_argument("--cam-elevation", type=float, default=27.0)
parser.add_argument("--cam-distance", type=float, default=6.2)
parser.add_argument("--lens", type=float, default=85.0)
parser.add_argument("--shift-x", type=float, default=0.0)
parser.add_argument("--shift-y", type=float, default=0.0)
parser.add_argument("--ortho-scale", type=float, default=2.0)
args = parser.parse_args(argv)

MOON = np.array([0.80, 0.79, 0.76], dtype=np.float32)
MARS = np.array([0.76, 0.40, 0.24], dtype=np.float32)
EDGE = (0.050, 0.064, 0.090)

folder = Path(args.terrain)
meta = json.loads((folder / "meta.json").read_text())
size = meta["size"]
heights = np.fromfile(folder / "height.bin", dtype="<i2").reshape(size, size).astype(np.float32)  # row 0 is north
extent_m = size * meta["metresPerSample"]


def smooth(grid, passes):
    for _ in range(passes):
        padded = np.pad(grid, 1, mode="edge")
        grid = (padded[:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:] + 4 * grid) / 8
    return grid


def resample(grid, out):
    """Bilinear resize of a square grid to out x out."""
    n = grid.shape[0]
    pos = np.linspace(0, n - 1, out, dtype=np.float32)
    lo = np.floor(pos).astype(np.int32)
    hi = np.minimum(lo + 1, n - 1)
    t = pos - lo
    rows = grid[lo] * (1 - t)[:, None] + grid[hi] * t[:, None]
    return rows[:, lo] * (1 - t)[None, :] + rows[:, hi] * t[None, :]


# ---------------------------------------------------------------- colour texture
tex = args.texture
fine = resample(smooth(heights, 2), tex)
gy, gx = np.gradient(fine)
slope = np.maximum(np.hypot(gx, gy), 1e-4)


def contour(interval, width_px):
    phase = fine / interval
    distance = np.abs(phase - np.round(phase)) * interval / slope  # in texture pixels
    line = np.clip(width_px / 2 + 0.5 - distance, 0, 1)
    # Flat ground would otherwise fill with wide smears of line.
    return line * np.clip((slope * tex / size - 0.35) / 0.5, 0, 1)


minor = contour(50, 2.2 * tex / 2048)
major = contour(250, 4.0 * tex / 2048)
ink = np.maximum(minor * 0.30, major * 0.48)

yy, xx = np.mgrid[0:tex, 0:tex].astype(np.float32)
u = (xx + 0.5) / tex - 0.5  # east positive
v = 0.5 - (yy + 0.5) / tex  # north positive
angle = math.radians(args.split_angle)
side = u * math.cos(angle) - v * math.sin(angle)  # signed distance east of the split line, in tile widths
blend = np.clip(side * tex / (1.5 * tex / 2048) + 0.5, 0, 1)[..., None]
colour = MOON * (1 - blend) + MARS * blend
colour = colour * (1 - ink[..., None])

image = bpy.data.images.new("relief-colour", tex, tex, alpha=False)
rgba = np.ones((tex, tex, 4), dtype=np.float32)
rgba[..., :3] = colour[::-1]  # Blender image rows run bottom to top
image.pixels.foreach_set(rgba.ravel())
image.pack()

# ---------------------------------------------------------------- mesh
bpy.ops.wm.read_factory_settings(use_empty=True)
# read_factory_settings drops data blocks, so the image is rebuilt after it.
image = bpy.data.images.new("relief-colour", tex, tex, alpha=False)
image.pixels.foreach_set(rgba.ravel())
image.pack()

grid = smooth(heights, 1)[::args.step, ::args.step]
n = grid.shape[0]
scale = 2.0 / extent_m
z = (grid - meta["minElevation"]) * scale * args.exaggeration
base_z = -0.035
axis = np.linspace(-1, 1, n, dtype=np.float32)
co = np.empty((n, n, 3), dtype=np.float32)
co[..., 0] = axis[None, :]
co[..., 1] = -axis[:, None]
co[..., 2] = z
index = np.arange(n * n, dtype=np.int32).reshape(n, n)
quads = np.stack([index[1:, :-1], index[1:, 1:], index[:-1, 1:], index[:-1, :-1]], axis=-1).reshape(-1, 4)


def build(name, coords, faces, uvs=None):
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(len(coords))
    mesh.vertices.foreach_set("co", coords.astype(np.float32).ravel())
    mesh.loops.add(faces.size)
    mesh.loops.foreach_set("vertex_index", faces.astype(np.int32).ravel())
    mesh.polygons.add(len(faces))
    mesh.polygons.foreach_set("loop_start", np.arange(0, faces.size, 4, dtype=np.int32))
    try:
        mesh.polygons.foreach_set("loop_total", np.full(len(faces), 4, dtype=np.int32))
    except Exception:
        pass
    if uvs is not None:
        layer = mesh.uv_layers.new(name="UVMap")
        layer.data.foreach_set("uv", uvs.astype(np.float32).ravel())
    mesh.update(calc_edges=True)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


vertex_uv = np.stack([(co[..., 0] + 1) / 2, (co[..., 1] + 1) / 2], axis=-1).reshape(-1, 2)
surface = build("relief", co.reshape(-1, 3), quads, vertex_uv[quads.ravel()])
surface.data.polygons.foreach_set("use_smooth", np.ones(len(quads), dtype=bool))

# Cut faces of the block, so it reads as a physical model.
rim = np.concatenate([index[-1, :], index[-2::-1, -1], index[0, -2::-1], index[1:-1, 0]])
top = co.reshape(-1, 3)[rim]
bottom = top.copy()
bottom[:, 2] = base_z
wall_co = np.concatenate([top, bottom])
count = len(rim)
k = np.arange(count)
wall_faces = np.stack([k + count, (k + 1) % count + count, (k + 1) % count, k], axis=-1)
walls = build("walls", wall_co, wall_faces)


def material(name, colour=None, texture=None, roughness=0.92):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = roughness
    for key in ("Specular IOR Level", "Specular"):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = 0.15
            break
    if texture is not None:
        node = nodes.new("ShaderNodeTexImage")
        node.image = texture
        node.interpolation = "Cubic"
        node.extension = "EXTEND"
        mat.node_tree.links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
    else:
        bsdf.inputs["Base Color"].default_value = (*colour, 1)
    return mat


surface.data.materials.append(material("relief", texture=image))
walls.data.materials.append(material("walls", colour=(0.13, 0.15, 0.19)))

# ---------------------------------------------------------------- scene
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = args.samples
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 4
scene.render.film_transparent = True
scene.render.resolution_x = args.width
scene.render.resolution_y = args.height
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.image_settings.color_depth = "16"
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"

device = "CPU"
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            found = [d for d in prefs.devices if d.type == kind]
            if found:
                for d in prefs.devices:
                    d.use = d.type == kind
                scene.cycles.device = "GPU"
                device = kind
                break
        except Exception:
            continue
except Exception:
    pass
print("render device:", device)

world = bpy.data.worlds.new("world")
world.use_nodes = True
background = world.node_tree.nodes["Background"]
background.inputs["Color"].default_value = (0.72, 0.80, 1.0, 1)
background.inputs["Strength"].default_value = 0.22
scene.world = world

sun_data = bpy.data.lights.new("sun", "SUN")
sun_data.energy = 3.4
sun_data.angle = math.radians(2.5)
sun_data.color = (1.0, 0.96, 0.90)
sun = bpy.data.objects.new("sun", sun_data)
scene.collection.objects.link(sun)
az, el = math.radians(args.sun_azimuth), math.radians(args.sun_elevation)
to_sun = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))
sun.rotation_euler = (-to_sun).to_track_quat("-Z", "Y").to_euler()

camera_data = bpy.data.cameras.new("camera")
camera = bpy.data.objects.new("camera", camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
if args.mode == "icon":
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = args.ortho_scale
    camera.location = (0, 0, 10)
    camera.rotation_euler = (0, 0, 0)
    walls.hide_render = True
else:
    camera_data.lens = args.lens
    camera_data.sensor_width = 36
    camera_data.shift_x = args.shift_x
    camera_data.shift_y = args.shift_y
    az, el = math.radians(args.cam_azimuth), math.radians(args.cam_elevation)
    position = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el))) * args.cam_distance
    target = Vector((0, 0, float(z.max()) * 0.25))
    camera.location = position + target
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    # A floor that only receives the model's shadow.
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, base_z))
    floor = bpy.context.active_object
    floor.is_shadow_catcher = True

scene.render.filepath = args.out
bpy.ops.render.render(write_still=True)
print("wrote", args.out)
