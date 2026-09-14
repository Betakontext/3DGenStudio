# 3D Gen Studio VFX Import (Unity)

Imports a VFX bundle exported from 3D Gen Studio and builds a Unity particle
effect from it: one prefab, one `ParticleSystem` per system in the effect, with
the textures, meshes and materials it needs.

Editor-only. Nothing ships in a player build.

## Install

Copy `com.3dgenstudio.vfx-import/` into your project's `Packages/` folder, or add it
by path from the Package Manager (**+ → Add package from disk…**).

Requires Unity 6000.0 or newer. It has **no render-pipeline requirement** —
Shuriken works under Built-in, URP and HDRP alike — though the material it
creates looks for URP's particle shader first and falls back to the built-in
ones.

## Use

**Assets → Import VFX Bundle…**, then pick the folder the app wrote (the one
containing `manifest.json`). The effect lands in
`Assets/ImportedVfx/<bundle>/`, with a `.import-report.txt` beside the prefab
saying exactly what came across natively, what was approximated and what could
not be carried at all.

## Why Shuriken and not VFX Graph

This was measured, not assumed — see `../Spikes/`, which runs against your own
Unity install and writes its answers to disk.

**VFX Graph's graph model is `internal`.** `VFXGraph`, `VFXContext`, `VFXBlock`
and `VFXModel` cannot be touched by a plugin, and there is no public
asset-creation API. A VFX Graph importer can therefore only *bind exposed
properties on a template a human drew by hand*, which caps structural fidelity
at whatever that template has slots for: a fixed number of systems, a fixed
number of bursts, one renderer per system.

**Shuriken's modules are all public, writable, and survive a prefab save.** A
burst list of any length, curves with their tangents, gradients with separate
colour and alpha rails, every emitter shape the catalog uses, forces, noise,
collision, spin, sub-emitters, billboard/stretched/mesh rendering and sorting.

So Shuriken carries strictly more of the effect across and needs no
hand-authored assets. A VFX Graph backend is still worth having for effects that
need GPU particle counts; it needs templates before it can exist.

## Platform reach

A second reason Shuriken wins, and it was not the deciding one but it matters
more in practice than the first: **Shuriken runs everywhere Unity runs.** It is
CPU-simulated, so it needs no compute shaders and no SSBOs, and it works under
Built-in, URP and HDRP alike.

Visual Effect Graph does not. From its own package documentation
(`com.unity.visualeffectgraph`, Documentation~/System-Requirements.md):

- it requires **compute shader** support and **SSBO** support;
- **"The Visual Effect Graph does not support Open GL ES"** - which rules out a
  large share of Android devices and builds;
- and on URP specifically it **"isn't out of preview ... which means it only
  supports some of the platforms that URP supports."**

WebGL follows from the compute requirement: there are no compute shaders there.

So an effect imported through this plugin ships on mobile, on WebGL and on
low-end hardware. A VFX Graph backend would be a desktop-and-console feature.

## Coordinate space

The IR is **right-handed**, Y-up, metres. **Unity is left-handed** — measured,
not recalled: `Vector3.Cross(right, up)` returns `(0, 0, 1)`.

Same up axis, same unit, opposite handedness, so every position, velocity,
direction and offset has its **Z negated**, and euler rotations have X and Y
negated. That lives in `VfxConvert` and nowhere else. Skipping it mirrors the
effect — obvious on a vortex, invisible on a sphere emitter, which is the
combination that ships broken.

The importer reads `ir.space` and **refuses** a bundle in a space it does not
recognise rather than importing it wrongly.

## What it refuses

- A `bundleFormat` or `irFormat` outside its supported range.
- A coordinate space it cannot convert.

Half-importing a bundle you do not fully understand produces an effect that
looks nearly right, which is worse than an error.

## Known gaps

| Feature | Status |
|---|---|
| Point attractor | **Dropped.** No Shuriken module attracts toward a point. |
| Kill on bounds | **Dropped.** Shuriken kills on lifetime only. |
| Sphere / box collision | **Approximated.** Shuriken collides with scene colliders or planes, not implicit shapes. |
| Curl-noise turbulence | **Approximated.** Unity's noise module is value noise, so the motion differs in character. |
| Vortex | **Approximated.** Becomes orbital velocity: right swirl, but a fixed angular rate rather than a force, so no falloff with distance. |
| Directional / random start velocity | **Approximated.** Becomes velocity-over-life, re-applied per frame rather than drawn once at birth. |
| HDR gradient keys | **Approximated.** Unity's `Gradient` is LDR; intensity is folded into the colour. Use material emission for the glow. |
| Gradients past 8 keys per rail | **Approximated.** Unity's hard limit; the excess is dropped and reported. |
| `.glb` meshes | **Dropped** unless a glTF importer is installed. Unity has no built-in one — add `com.unity.cloud.gltfast` or UnityGLTF, or export the mesh as FBX. |

Every one of these is reported per import, by name. Compatibility is already
surfaced at *author* time in the app, so an import confirms what the author
already saw rather than surprising them.

### Plane collision

Shuriken collides a particle as a **sphere of `size/2 x radiusScale`**; the app's
`collide.plane` kernel clamps the particle's **centre** and knows nothing about
its size. The importer therefore sets `collision.radiusScale = 0`, so the two
agree.

Left at Unity's default of 1 the difference is half a particle — nothing for a
10cm spark, and fatal for a mesh. Frost Nova's Ice Shards are 0.5–1.3 across and
born 0.2 above the floor, so every one of them started already intersecting the
plane; Unity re-resolved that collision every frame and each resolution took
`dampen` (0.6) off the speed, leaving 6% of it after three frames. Forty shards
spun on the spot inside the frost cloud while the preview threw them clear.

### Verifying motion

`ParticleSystem.Simulate` is **not** the playback path for plane collision — the
same prefab that pinned every shard in play mode flew correctly under Simulate.
Motion has to be measured in play mode.

And Unity **does not simulate particles in batchmode at all**: a control system
built in the same scene with a plain `startSpeed` advanced exactly one frame and
then froze. So run the editor without `-batchmode` for this, and always put a
known-good control system in the scene — otherwise "nothing moved" is as likely
to be the harness as the effect.

### Mesh particles

A particle's `size` is a **multiplier, not a length**, and that only holds for a
mesh that has been normalised — otherwise what `size = 1` means depends on the
units the model happened to be authored in. The app normalises every mesh it
loads, so the importer does too: each referenced model gets a
`Meshes/<name> (particle).asset` beside it, centred and scaled so its bounding
sphere is one unit across, and that is what the renderer is given. The original
model is left untouched.

Mesh renderers are also set to **Local** render alignment rather than Unity's
default of `View`. Render Alignment applies to mesh particles too, and on `View`
every instance is turned to face the camera — a field of tumbling debris draws
as identically-oriented chips that pivot together when the camera moves. For the
same reason a mesh emitter's start rotation and spin go on the **Y** axis
(`startRotation3D` / `separateAxes`), which is the axis the app's shader yaws
about; a billboard keeps the single-float roll.
