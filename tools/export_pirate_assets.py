"""Export the approved Pirate Kit assets to self-contained GLBs with Blender.

Run from the repository root:
    blender --background --factory-startup --python tools/export_pirate_assets.py -- .
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import bpy
from mathutils import Vector


CHARACTERS = {
    "Characters_Anne.blend": "anne.glb",
    "Characters_Captain_Barbarossa.blend": "captain-barbarossa.glb",
    "Characters_Henry.blend": "henry.glb",
    "Characters_Mako.blend": "mako.glb",
    "Characters_Shark.blend": "shark.glb",
    "Characters_Sharky.blend": "sharky.glb",
    "Characters_Skeleton.blend": "skeleton.glb",
}
SUPPORTED_WEAPON_CATEGORIES = (
    "dagger",
    "sword",
    "cutlass",
    "axe",
    "doubleAxe",
)


def output_name(category: str) -> str:
    """Derive a stable runtime name from a detected category, never a source filename."""
    return re.sub(r"(?<!^)(?=[A-Z])", "-", category).lower() + ".glb"


def repository_root() -> Path:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    root = Path(args[0] if args else ".").resolve()
    if not (root / "client" / "package.json").is_file():
        raise RuntimeError(f"Not a bedwars repository root: {root}")
    return root


def prepare_materials() -> None:
    """Translate the pack's legacy Diffuse shader to glTF PBR in memory."""
    for material in bpy.data.materials:
        material.use_nodes = True
        tree = material.node_tree
        if tree is None:
            continue
        image_node = next((node for node in tree.nodes if node.type == "TEX_IMAGE" and node.image), None)
        output = next((node for node in tree.nodes if node.type == "OUTPUT_MATERIAL"), None)
        if image_node is None or output is None:
            continue
        principled = next((node for node in tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
        if principled is None:
            principled = tree.nodes.new("ShaderNodeBsdfPrincipled")
        image_node.interpolation = "Closest"
        tree.links.new(image_node.outputs["Color"], principled.inputs["Base Color"])
        if "Alpha" in image_node.outputs and "Alpha" in principled.inputs:
            tree.links.new(image_node.outputs["Alpha"], principled.inputs["Alpha"])
        tree.links.new(principled.outputs["BSDF"], output.inputs["Surface"])


def classify_loaded_weapon() -> tuple[str, float, str] | None:
    """Classify the open Blender scene from mesh geometry only."""
    minimum = [float("inf")] * 3
    maximum = [float("-inf")] * 3
    vertex_count = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        # Loop/corner count tracks exported glTF topology (UV seams split
        # vertices during export) and reliably separates detailed axe heads
        # from thin sword/cutlass blades.
        vertex_count += max(len(obj.data.vertices), len(obj.data.loops))
        for corner in obj.bound_box:
            point = obj.matrix_world @ Vector(corner)
            for axis in range(3):
                minimum[axis] = min(minimum[axis], point[axis])
                maximum[axis] = max(maximum[axis], point[axis])
    if vertex_count == 0:
        return None

    dimensions = [maximum[axis] - minimum[axis] for axis in range(3)]
    axes = sorted(range(3), key=lambda axis: dimensions[axis], reverse=True)
    long_axis, lateral_axis, thin_axis = axes
    length = max(dimensions[long_axis], 1e-6)
    lateral = dimensions[lateral_axis]
    thickness = max(dimensions[thin_axis], 1e-6)
    lateral_ratio = lateral / length
    thickness_ratio = thickness / length
    cross_aspect = lateral / thickness
    fingerprint = ":".join(f"{value:.3f}" for value in sorted(dimensions)) + f":{vertex_count}"

    if long_axis != 1:
        return None
    if thickness_ratio > 0.18:
        return None
    if lateral_ratio >= 0.52:
        return "doubleAxe", min(1, 0.7 + lateral_ratio - 0.52), fingerprint
    if lateral_ratio >= 0.37 and vertex_count >= 650:
        return "axe", min(1, 0.72 + lateral_ratio - 0.37), fingerprint
    if lateral_ratio >= 0.29 and cross_aspect >= 2.8:
        return "cutlass", min(1, 0.72 + (cross_aspect - 2.8) * 0.04), fingerprint
    if cross_aspect <= 1.35:
        return "dagger", min(1, 0.82 + (1.35 - cross_aspect) * 0.2), fingerprint
    if 0.15 <= lateral_ratio < 0.29 and cross_aspect >= 1.5:
        confidence = 1 - min(0.8, abs(lateral_ratio - 0.20) * 2 + abs(cross_aspect - 2.0) * 0.08)
        return "sword", confidence, fingerprint
    return None


def discover_weapon_sources(blends: Path) -> dict[str, Path]:
    """Scan every weapon Blend and retain the best unique geometry per category."""
    selected: dict[str, tuple[Path, float]] = {}
    fingerprints: set[str] = set()
    for source in sorted(blends.glob("Weapon_*.blend")):
        bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False)
        detected = classify_loaded_weapon()
        if detected is None:
            print(f"IGNORED unsupported weapon geometry: {source.name}")
            continue
        category, confidence, fingerprint = detected
        if fingerprint in fingerprints:
            print(f"IGNORED duplicate weapon geometry: {source.name}")
            continue
        fingerprints.add(fingerprint)
        current = selected.get(category)
        if current is None or confidence > current[1]:
            selected[category] = (source, confidence)
        print(f"DETECTED {source.name}: {category} ({confidence:.3f})")

    return {category: source for category, (source, _confidence) in selected.items()}


def export_glb(source: Path, output: Path, include_animations: bool) -> list[str]:
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False)
    prepare_materials()

    # Character files also contain assorted authored weapons. Keep every mesh
    # that forms the character's appearance (including hidden body meshes), but
    # exclude all Weapon_* objects so only separately exported, automatically
    # classified weapon visuals are attached at runtime.
    selected_names: list[str] = []
    for obj in bpy.context.scene.objects:
        selected = obj.type in {"ARMATURE", "EMPTY", "MESH"} and (
            not include_animations or not obj.name.casefold().startswith("weapon_")
        )
        obj.select_set(selected)
        if selected:
            obj.hide_set(False)
            obj.hide_viewport = False
            obj.hide_render = False
            selected_names.append(obj.name)
    print(f"SELECTED {source.name}: {', '.join(selected_names)}")
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        check_existing=False,
        export_format="GLB",
        use_selection=True,
        export_cameras=False,
        export_lights=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_unused_images=False,
        export_unused_textures=False,
        export_apply=False,
        export_skins=True,
        export_all_influences=False,
        export_morph=True,
        export_morph_normal=True,
        export_morph_tangent=False,
        export_animations=include_animations,
        export_animation_mode="ACTIONS",
        export_merge_animation="ACTION",
        export_extra_animations=False,
        # The legacy actions contain zero-width Bezier handles that Blender
        # 5.2 cannot serialize directly. Sample animation curves only; mesh
        # geometry remains unbaked and every action keeps its authored name.
        export_force_sampling=True,
        export_bake_animation=True,
        export_anim_single_armature=True,
        export_anim_slide_to_zero=False,
        export_yup=True,
    )

    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError(f"Blender did not create {output}")
    return sorted(action.name for action in bpy.data.actions) if include_animations else []


def main() -> None:
    root = repository_root()
    pack = root / "animation" / "Pirate Kit - Nov 2023"
    blends = pack / "Blends"
    runtime = root / "client" / "src" / "assets" / "pirate"

    missing = [name for name in CHARACTERS if not (blends / name).is_file()]
    if missing:
        raise FileNotFoundError(f"Missing required character sources: {', '.join(missing)}")

    exported: list[Path] = []
    loaded_animations: set[str] = set()
    for source_name, output_name in CHARACTERS.items():
        output = runtime / "characters" / output_name
        actions = export_glb(blends / source_name, output, include_animations=True)
        loaded_animations.update(actions)
        exported.append(output)
        print(f"EXPORTED character {source_name} -> {output.relative_to(root)}")
        print(f"ACTIONS {source_name}: {', '.join(actions) or 'none'}")

    weapon_sources = discover_weapon_sources(blends)
    missing_weapons = [category for category in SUPPORTED_WEAPON_CATEGORIES if category not in weapon_sources]
    if missing_weapons:
        raise FileNotFoundError(
            "No geometry match for required Pirate weapon categories: " + ", ".join(missing_weapons)
        )
    for category in SUPPORTED_WEAPON_CATEGORIES:
        source = weapon_sources[category]
        output = runtime / "weapons" / output_name(category)
        export_glb(source, output, include_animations=False)
        exported.append(output)
        print(f"EXPORTED weapon category {category}: {source.name} -> {output.relative_to(root)}")

    animations_dir = pack / "Animations"
    animation_sources = sorted(animations_dir.glob("*.blend")) if animations_dir.is_dir() else []
    for source in animation_sources:
        output = runtime / "animations" / f"{source.stem}.glb"
        actions = export_glb(source, output, include_animations=True)
        loaded_animations.update(actions)
        exported.append(output)
        print(f"EXPORTED animation {source.name} -> {output.relative_to(root)}")
        print(f"ACTIONS {source.name}: {', '.join(actions) or 'none'}")

    if not animation_sources:
        print(f"MISSING animation sources: {animations_dir.relative_to(root)}")

    print("EXPORTED_GLBS", ", ".join(str(path.relative_to(root)) for path in exported))
    print("LOADED_CHARACTERS", ", ".join(Path(name).stem.removeprefix("Characters_") for name in CHARACTERS))
    print("DETECTED_WEAPON_CATEGORIES", ", ".join(SUPPORTED_WEAPON_CATEGORIES))
    print("LOADED_ANIMATIONS", ", ".join(sorted(loaded_animations)) or "none")
    print("MISSING_ASSETS", "Animations folder" if not animation_sources else "none")


if __name__ == "__main__":
    main()
