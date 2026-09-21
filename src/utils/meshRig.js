// Rig preservation for the Mesh Editor.
//
// The editor works on one flattened, world-space BufferGeometry — that is what
// makes its tools simple. A rigged mesh therefore has to be taken apart on load
// and put back together on save:
//
//   * the per-vertex skin data (skinIndex/skinWeight) rides along as ordinary
//     geometry attributes, so anything that only moves vertices — sculpting,
//     painting, projection, the pivot fix — keeps it valid for free;
//   * the skeleton itself (bones + inverse bind matrices) is captured here at
//     load time and kept aside, because it is a scene graph, not vertex data,
//     and nothing in the editing pipeline can carry it.
//
// On export the two are recombined into a SkinnedMesh.
//
// ── Why the bind matrix becomes identity ────────────────────────────────────
// loadEditableGeometryFromObject bakes each vertex through `child.matrixWorld`,
// so the editable geometry holds rest-pose *world* positions rather than bind
// space. Writing p' = bindMatrix·p, three's skinning of the original mesh
// reduces at rest to Σ(boneᵢ.matrixWorld · boneInverseᵢ · p' · wᵢ) = p'. Feeding
// the already-baked p' back in with bindMatrix = I therefore reproduces exactly
// the same rest pose — which is why the node transform is pinned to identity
// too. Keeping the original bind matrix instead would apply it twice and deform
// the mesh.
import * as THREE from 'three'
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js'

// True when a geometry carries usable per-vertex skin data.
export function geometryHasSkin(geometry) {
  return !!(geometry?.attributes?.skinIndex && geometry?.attributes?.skinWeight)
}

// Capture the rig of a freshly-loaded object graph, or null when it has none.
//
// The graph is deep-cloned with SkeletonUtils (a plain clone would leave the
// copy's SkinnedMesh pointing at the original skeleton) so that later edits to
// the loaded root — the editor swaps geometry onto it and pins its transforms —
// cannot disturb what will be exported.
export function extractRigFromObject(root) {
  if (!root) return null

  let sourceSkinned = null
  root.traverse(child => {
    if (!sourceSkinned && child.isSkinnedMesh && child.skeleton?.bones?.length) {
      sourceSkinned = child
    }
  })
  if (!sourceSkinned) return null

  let rigScene
  try {
    rigScene = skeletonClone(root)
  } catch (err) {
    console.warn('Could not clone the rig for preservation:', err)
    return null
  }

  let rigMesh = null
  rigScene.traverse(child => {
    if (!rigMesh && child.isSkinnedMesh) rigMesh = child
  })
  if (!rigMesh?.skeleton?.bones?.length) return null

  return {
    rigScene,
    boneCount: rigMesh.skeleton.bones.length,
    boneNames: rigMesh.skeleton.bones.map(bone => bone.name),
    // Clips travel with the skeleton, not with the geometry: they address bones
    // by NAME, so they stay valid through every edit that keeps the bone graph —
    // and they are meaningless without it. Keeping them here is what stops an
    // animated mesh losing its animations the first time it is saved from the
    // editor, and what lets a transferred rig bring its clips along.
    //
    // Read off the CLONE rather than `root`: Object3D.copy slices `animations`,
    // so the clone already holds them and the scene stays the one source of
    // truth through every later cloneRigScene (undo, redo, export).
    //
    // Renaming a bone by hand invalidates the tracks that name it. The rig editor
    // warns about the bone MAPPING for the same reason; the clips are the same
    // trade and are left alone rather than silently rewritten.
    animations: Array.isArray(rigScene.animations) ? rigScene.animations : [],
  }
}

// Put a set of animation clips on a rig, keeping the record and the scene it
// caches from in step. The scene is the source of truth (a clone carries its
// `animations` along for free, which is what makes the undo stack keep them);
// the record's copy is what the UI counts.
export function setRigAnimations(rig, clips) {
  if (!rig?.rigScene) return rig
  const animations = Array.isArray(clips) ? [...clips] : []
  rig.rigScene.animations = animations
  rig.animations = animations
  return rig
}

// Move the captured skeleton with the mesh.
//
// Anything that translates the editable geometry bodily — the Game-Ready pivot
// fix — leaves the captured bones behind, because they live in their own scene
// graph. At rest that is invisible: every joint matrix is identity there, so the
// already-translated vertices render in the right place regardless. It only
// surfaces once the rig is *posed*, when the bones rotate about points that are
// no longer inside the mesh. Silent until it reaches an engine, in other words.
//
// The inverse bind matrices are recalculated afterwards. Without that the joint
// matrices stop being identity at rest — they become the translation itself —
// and the export would shift the mesh a second time.
export function translateRig(rig, offsetX, offsetY, offsetZ) {
  transformRig(rig, 1, new THREE.Vector3(offsetX, offsetY, offsetZ))
}

// Move AND resize the captured skeleton: every bone's rest world position maps
// to p · scale + offset.
//
// The scaling half exists for the rig transfer (utils/rigTransfer.js). A mesh
// simplified or re-exported outside the editor comes back as the same object in
// different units, and the transfer corrects for that by scaling the source
// surface onto this mesh — so the bones whose weights that surface carries have
// to make the identical move, or the mesh is bound to a skeleton half its size
// sitting inside it.
//
// Only positions change. A UNIFORM scale leaves every rotation alone, so the
// bones keep their orientation, and rotation and scale tracks keep meaning what
// they meant. What does not come free is a clip's own TRANSLATION tracks (root
// motion, a hips bob): those are keyed in the source's units, so they are
// remapped here too — on CLONED clips, because the caller hands over the source
// rig's own animation objects and a second run must start from them unmodified.
//
// A translation track is remapped by where the bone it drives sits in the
// hierarchy, and the two cases are not the same:
//
//   * a CHILD bone's position is an offset from its parent, expressed in the
//     parent's frame. That frame's rotation is untouched, so the offset simply
//     scales: v → v · s.
//   * a ROOT bone's position is a place, not an offset — it is what the whole
//     rig stands on. Scaling it alone would key the rig back to where the source
//     stood, undoing the move the rest of this function just made, so it takes
//     the FULL transform (through its parent's frame, which itself did not move).
//
// The inverse bind matrices are recalculated afterwards. Without that the joint
// matrices stop being identity at rest — they become the transform itself — and
// the export would apply it a second time.
export function transformRig(rig, scale = 1, offset = null) {
  const scene = rig?.rigScene
  if (!scene) return

  // Pre-order, so a bone is always reached before its descendants — which is
  // what lets each one be placed against a parent that is already in its new
  // position.
  const bones = []
  scene.traverse(node => { if (node.isBone) bones.push(node) })
  if (!bones.length) return

  scene.updateMatrixWorld(true)
  // Read every original world position BEFORE moving anything: once a parent
  // moves, its children's world positions are no longer the ones being mapped.
  const before = bones.map(bone => bone.getWorldPosition(new THREE.Vector3()))

  const boneSet = new Set(bones)
  // How a keyframed position on each bone has to be remapped — the root case,
  // built per bone because it goes through that bone's parent frame. Collected
  // in the same pass that moves the bones so the two cannot drift apart.
  const rootMap = new Map()
  const parentInverse = new THREE.Matrix4()
  const place = new THREE.Matrix4().makeScale(scale, scale, scale)
  if (offset) place.premultiply(new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z))

  bones.forEach((bone, index) => {
    const target = before[index].clone().multiplyScalar(scale)
    if (offset) target.add(offset)
    if (bone.parent) {
      bone.parent.updateWorldMatrix(true, false)
      parentInverse.copy(bone.parent.matrixWorld).invert()
      if (!boneSet.has(bone.parent) && !rootMap.has(bone.name)) {
        rootMap.set(bone.name, parentInverse.clone().multiply(place).multiply(bone.parent.matrixWorld))
      }
      target.applyMatrix4(parentInverse)
    } else if (!rootMap.has(bone.name)) {
      rootMap.set(bone.name, place.clone())
    }
    bone.position.copy(target)
    bone.updateMatrix()
  })
  scene.updateMatrixWorld(true)

  if ((scale !== 1 || offset) && rig.animations?.length) {
    const point = new THREE.Vector3()
    setRigAnimations(rig, rig.animations.map(clip => {
      const copy = clip.clone()
      for (const track of copy.tracks) {
        if (!track.name.endsWith('.position')) continue
        const rootTransform = rootMap.get(track.name.slice(0, -'.position'.length).split('/').pop())
        for (let i = 0; i + 2 < track.values.length; i += 3) {
          point.fromArray(track.values, i)
          if (rootTransform) point.applyMatrix4(rootTransform)
          else point.multiplyScalar(scale)
          point.toArray(track.values, i)
        }
      }
      return copy
    }))
  }

  scene.traverse(node => {
    if (node.isSkinnedMesh && node.skeleton) node.skeleton.calculateInverses()
  })
}

// Rebuild an exportable scene: the captured bone hierarchy plus a SkinnedMesh
// carrying `geometry`. Returns null when the geometry has no skin data to bind,
// so callers fall back to a plain static export rather than emit a SkinnedMesh
// with nothing to skin (which is what three crashes on).
export function buildRiggedObject(rig, geometry, material = null) {
  if (!rig?.rigScene || !geometryHasSkin(geometry)) return null

  let scene
  try {
    scene = skeletonClone(rig.rigScene)
  } catch (err) {
    console.warn('Could not rebuild the rig for export:', err)
    return null
  }

  let mesh = null
  scene.traverse(child => {
    if (!mesh && child.isSkinnedMesh) mesh = child
  })
  if (!mesh) return null

  mesh.geometry = geometry
  if (material) mesh.material = material

  // The geometry is already in world space (see the note at the top), so this
  // node contributes nothing further.
  mesh.position.set(0, 0, 0)
  mesh.quaternion.identity()
  mesh.scale.set(1, 1, 1)
  mesh.updateMatrix()
  mesh.matrixWorldNeedsUpdate = true

  mesh.bind(mesh.skeleton, new THREE.Matrix4())
  scene.updateMatrixWorld(true)

  // exportObject3D reads `object.animations`, so this is the single point that
  // puts the clips back into every save/export path at once. Tracks naming a
  // node the rebuilt scene does not have are dropped by GLTFExporter with a
  // warning rather than failing the export.
  scene.animations = Array.isArray(rig.animations) ? rig.animations : []

  return scene
}
