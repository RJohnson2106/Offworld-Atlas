"""Render a looping camera move over the Mount Suswa relief model, for the landing page background.

blender -b --python-exit-code 1 -P render_flyover.py -- --terrain <folder> --out <frames folder> [--frames 384]

The camera sways around the caldera and the divide between Moon grey and Mars rust sweeps across
and back. Both motions repeat exactly over the length of the clip, so the video loops without a jump.
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
parser.add_argument("--out", required=True)
parser.add_argument("--frames", type=int, default=384)
parser.add_argument("--only", type=int, nargs="*", help="render just these frame numbers, to test")
parser.add_argument("--width", type=int, default=1280)
parser.add_argument("--height", type=int, default=720)
parser.add_argument("--samples", type=int, default=48)
parser.add_argument("--step", type=int, default=2)
parser.add_argument("--exaggeration", type=float, default=3.0)
parser.add_argument("--texture", type=int, default=3072)
args = parser.parse_args(argv)

MOON = (0.80, 0.79, 0.76, 1)
MARS = (0.76, 0.40, 0.24, 1)
SPLIT_ANGLE = math.radians(22)
N = args.frames

folder = Path(args.terrain)
meta = json.loads((folder / "meta.json").read_text())
size = meta["size"]
heights = np.fromfile(folder / "height.bin", dtype="<i2").reshape(size, size).astype(np.float32)
extent_m = size * meta["metresPerSample"]


def smooth(grid, passes):
    for _ in range(passes):
        padded = np.pad(grid, 1, mode="edge")
        grid = (padded[:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:] + 4 * grid) / 8
    return grid


def resample(grid, out):
    n = grid.shape[0]
    pos = np.linspace(0, n - 1, out, dtype=np.float32)
    lo = np.floor(pos).astype(np.int32)
    hi = np.minimum(lo + 1, n - 1)
    t = pos - lo
    rows = grid[lo] * (1 - t)[:, None] + grid[hi] * t[:, None]
    return rows[:, lo] * (1 - t)[None, :] + rows[:, hi] * t[None, :]


# Contour lines, as a paper-white picture with darker lines.
tex = args.texture
fine = resample(smooth(heights, 2), tex)
gy, gx = np.gradient(fine)
slope = np.maximum(np.hypot(gx, gy), 1e-4)


def contour(interval, width_px):
    phase = fine / interval
    distance = np.abs(phase - np.round(phase)) * interval / slope
    line = np.clip(width_px / 2 + 0.5 - distance, 0, 1)
    return line * np.clip((slope * tex / size - 0.35) / 0.5, 0, 1)


ink = np.maximum(contour(50, 2.2 * tex / 2048) * 0.30, contour(250, 4.0 * tex / 2048) * 0.48)
paper = np.ones((tex, tex, 4), dtype=np.float32)
paper[..., :3] = (1 - ink)[::-1, :, None]

bpy.ops.wm.read_factory_settings(use_empty=True)
image = bpy.data.images.new("contours", tex, tex, alpha=False)
image.pixels.foreach_set(paper.ravel())
image.pack()

# The terrain surface.
grid = smooth(heights, 1)[::args.step, ::args.step]
n = grid.shape[0]
z = (grid - meta["minElevation"]) * (2.0 / extent_m) * args.exaggeration
axis = np.linspace(-1, 1, n, dtype=np.float32)
co = np.empty((n, n, 3), dtype=np.float32)
co[..., 0] = axis[None, :]
co[..., 1] = -axis[:, None]
co[..., 2] = z
index = np.arange(n * n, dtype=np.int32).reshape(n, n)
quads = np.stack([index[1:, :-1], index[1:, 1:], index[:-1, 1:], index[:-1, :-1]], axis=-1).reshape(-1, 4)
uv = np.stack([(co[..., 0] + 1) / 2, (co[..., 1] + 1) / 2], axis=-1).reshape(-1, 2)[quads.ravel()]

mesh = bpy.data.meshes.new("relief")
mesh.vertices.add(n * n)
mesh.vertices.foreach_set("co", co.ravel())
mesh.loops.add(quads.size)
mesh.loops.foreach_set("vertex_index", quads.ravel())
mesh.polygons.add(len(quads))
mesh.polygons.foreach_set("loop_start", np.arange(0, quads.size, 4, dtype=np.int32))
try:
    mesh.polygons.foreach_set("loop_total", np.full(len(quads), 4, dtype=np.int32))
except Exception:
    pass
mesh.uv_layers.new(name="UVMap").data.foreach_set("uv", uv.astype(np.float32).ravel())
mesh.update(calc_edges=True)
mesh.validate()
mesh.polygons.foreach_set("use_smooth", np.ones(len(quads), dtype=bool))
surface = bpy.data.objects.new("relief", mesh)
scene = bpy.context.scene
scene.collection.objects.link(surface)

# Material: the tint depends on which side of a moving line each point lies.
mat = bpy.data.materials.new("relief")
mat.use_nodes = True
nodes, links = mat.node_tree.nodes, mat.node_tree.links
bsdf = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
bsdf.inputs["Roughness"].default_value = 0.92
for key in ("Specular IOR Level", "Specular"):
    if key in bsdf.inputs:
        bsdf.inputs[key].default_value = 0.15
        break


def math_node(operation, a=None, b=None, clamp=False):
    node = nodes.new("ShaderNodeMath")
    node.operation = operation
    node.use_clamp = clamp
    for slot, value in enumerate((a, b)):
        if value is None:
            continue
        if isinstance(value, (int, float)):
            node.inputs[slot].default_value = value
        else:
            links.new(value, node.inputs[slot])
    return node.outputs[0]


coords = nodes.new("ShaderNodeTexCoord")
parts = nodes.new("ShaderNodeSeparateXYZ")
links.new(coords.outputs["Object"], parts.inputs[0])
east = math_node("SUBTRACT", math_node("MULTIPLY", parts.outputs["X"], math.cos(SPLIT_ANGLE)),
                 math_node("MULTIPLY", parts.outputs["Y"], math.sin(SPLIT_ANGLE)))
line = nodes.new("ShaderNodeValue")
line.name = "divide"
offset = math_node("SUBTRACT", east, line.outputs[0])
side = math_node("ADD", math_node("MULTIPLY", offset, 500.0), 0.5, clamp=True)
glow = math_node("SUBTRACT", 1.0, math_node("MULTIPLY", math_node("ABSOLUTE", offset), 300.0), clamp=True)

tint = nodes.new("ShaderNodeMixRGB")
tint.inputs[1].default_value = MOON
tint.inputs[2].default_value = MARS
links.new(side, tint.inputs[0])
lines = nodes.new("ShaderNodeTexImage")
lines.image = image
lines.interpolation = "Cubic"
inked = nodes.new("ShaderNodeMixRGB")
inked.blend_type = "MULTIPLY"
inked.inputs[0].default_value = 1.0
links.new(tint.outputs[0], inked.inputs[1])
links.new(lines.outputs["Color"], inked.inputs[2])
marked = nodes.new("ShaderNodeMixRGB")
marked.inputs[2].default_value = (1.0, 0.78, 0.25, 1)
links.new(glow, marked.inputs[0])
links.new(inked.outputs[0], marked.inputs[1])
links.new(marked.outputs[0], bsdf.inputs["Base Color"])
for key in ("Emission Color", "Emission"):
    if key in bsdf.inputs:
        bsdf.inputs[key].default_value = (1.0, 0.78, 0.25, 1)
        break
if "Emission Strength" in bsdf.inputs:
    links.new(math_node("MULTIPLY", glow, 1.0), bsdf.inputs["Emission Strength"])
surface.data.materials.append(mat)

# Scene, light and camera.
scene.render.engine = "CYCLES"
scene.cycles.samples = args.samples
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 3
scene.render.use_persistent_data = True
scene.render.resolution_x = args.width
scene.render.resolution_y = args.height
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "JPEG"
scene.render.image_settings.quality = 94
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"

device = "CPU"
try:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            if any(d.type == kind for d in prefs.devices):
                for d in prefs.devices:
                    d.use = d.type == kind
                scene.cycles.device = "GPU"
                device = kind
                break
        except Exception:
            continue
except Exception:
    pass
if device == "OPTIX":
    try:
        scene.cycles.denoiser = "OPTIX"
    except Exception:
        pass
print("render device:", device)

world = bpy.data.worlds.new("world")
world.use_nodes = True
background = world.node_tree.nodes["Background"]
background.inputs["Color"].default_value = (0.72, 0.80, 1.0, 1)
background.inputs["Strength"].default_value = 0.2
scene.world = world

sun_data = bpy.data.lights.new("sun", "SUN")
sun_data.energy = 2.7
sun_data.angle = math.radians(2.5)
sun_data.color = (1.0, 0.96, 0.90)
sun = bpy.data.objects.new("sun", sun_data)
scene.collection.objects.link(sun)
az, el = math.radians(315), math.radians(26)
sun.rotation_euler = (-Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))).to_track_quat("-Z", "Y").to_euler()

camera_data = bpy.data.cameras.new("camera")
camera_data.lens = 46
camera_data.sensor_width = 36
camera = bpy.data.objects.new("camera", camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
target = Vector((0.02, 0.0, float(z.max()) * 0.2))

out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)
for frame in (args.only if args.only else range(N)):
    turn = 2 * math.pi * frame / N
    # Everything below repeats after N frames.
    azimuth = math.radians(196 + 26 * math.sin(turn))
    elevation = math.radians(47 + 4 * math.sin(turn * 2 + 0.8))
    distance = 1.62 + 0.10 * math.cos(turn)
    position = Vector((math.sin(azimuth) * math.cos(elevation), math.cos(azimuth) * math.cos(elevation), math.sin(elevation))) * distance
    camera.location = position + target
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    line.outputs[0].default_value = 0.78 * math.sin(turn - 1.2)
    scene.render.filepath = str(out / f"frame_{frame:04d}.jpg")
    bpy.ops.render.render(write_still=True)
print("rendered", len(args.only) if args.only else N, "frames to", out)
