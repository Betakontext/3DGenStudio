// Deterministic randomness for the building generator.
//
// THE WHOLE PRNG IS BORROWED. vfx/random.js is a tested PCG32 with an external
// oracle (it asserts against PCG's own published vectors), and it already solved
// the exact problem a building graph has. Re-implementing it here would mean a
// second thing to keep correct and a second thing to get wrong, so this file is
// a THIN SHIM: it re-exports the primitives and adds only the part that is
// specific to buildings, which is what an "identity" is.
//
// That indirection is deliberate rather than lazy. Every building module imports
// its randomness from here and never from ../vfx/random.js directly, so if the
// PRNG is ever promoted to a shared root directory - or swapped - this file is
// the single import site that changes.
//
// ESLINT ENFORCES THIS. eslint.config.js bans Math.random under building/**, the
// same guard vfx/** has. A single ambient random call anywhere in the generator
// breaks the live preview (a slider drag would reshuffle the whole facade), the
// stored thumbnail, and the promise that a document regenerates its mesh
// bit-for-bit. That failure reads as "it looks different every time", which is
// miserable to trace, so it is caught mechanically instead of in review.
//
// ------------------------------------------------------------------------
// THE TWO RULES, and the specific failure each one prevents
// ------------------------------------------------------------------------
//
// 1. A SLOT'S RANDOMNESS IS A HASH OF ITS IDENTITY, NOT A POSITION IN A STREAM.
//
//    The tempting implementation is one RNG walked once per placed window. It
//    is wrong, and the failure is the one that makes these tools feel broken:
//    change the floor count from 6 to 7 and every window in the building shuffles,
//    because each one is now reading a different position in the stream. Authors
//    read that as "the tool destroyed my work".
//
//    So a window's seed is hashed from WHERE IT IS - which face, which floor,
//    which bay - and nothing else. Floor 3 bay 2 draws the same numbers whether
//    the building is 4 storeys or 40, and whether it was generated before or
//    after its neighbours.
//
//    Note the tree generator does the opposite: services/treegen walks a single
//    numpy Generator. That is fine there, because a tree is generated once from
//    a fixed spec and never interactively re-evaluated with one parameter
//    nudged. A building graph is edited live, so it needs this.
//
// 2. FLOOR INDICES ARE COUNTED FROM THE GROUND. UPWARD. ALWAYS.
//
//    This looks like a detail and is the entire point of rule 1. If floors are
//    numbered from the top - or from "the top minus n", which is what you get
//    by iterating a reversed array - then adding a storey renumbers every floor
//    beneath it, every identity changes, and the reshuffle rule 1 exists to
//    prevent happens anyway. Ground is 0. The roof is wherever it lands.
//
// 3. PER-DRAW VALUES ARE ADDRESSED BY A COMPILE-TIME SLOT, NOT A COUNTER.
//
//    slotId(nodeId, prop) hashes the node's identity and the property name, so
//    inserting a node above another node does not change what the one below it
//    draws. A counter incremented per draw would reshuffle every node after the
//    edit, which reads as "editing one thing broke everything else".

export {
  PCG_STATE_WORDS,
  pcgAt,
  pcgFloat,
  pcgFloatAt,
  pcgHash2,
  pcgInit,
  pcgNext,
  pcgReseed,
  triple32,
} from '../vfx/random.js';

import { pcgAt, pcgFloatAt, pcgHash2, triple32 } from '../vfx/random.js';

/** 1 / 2^32, for turning a uint32 draw into [0, 1). */
const INV_2_32 = 2.3283064365386963e-10;

/**
 * FNV-1a over a string, to a uint32.
 *
 * Node ids are strings ('node-mtvb5ip8-3e'), and a slot has to be a number.
 * FNV-1a rather than a sum or a simple shift-hash because ids are highly similar
 * - they share a prefix and differ in a few trailing characters - and a weak
 * hash collides exactly there. A collision means two different nodes drawing the
 * same numbers, which is invisible until someone notices two facades are twins.
 *
 * Not cryptographic and does not need to be; it needs to avalanche on short,
 * near-identical ASCII, which FNV-1a does.
 */
export function hashString(text) {
  let h = 0x811c9dc5;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The compile-time draw identity for one property of one node.
 *
 * Assigned once by the compiler and stored in the IR, so the runtime never has
 * to know a node id. Stable across edits ELSEWHERE in the graph: the only things
 * that change it are renaming the property or replacing the node.
 *
 * @param {string} nodeId  the node's document id
 * @param {string} prop    the property name
 * @returns {number} uint32
 */
export function slotId(nodeId, prop) {
  return pcgHash2(hashString(nodeId), hashString(prop));
}

/**
 * The seed for one placed thing, hashed from WHERE IT IS.
 *
 * `identity` names a position in the building, and every field of it must be
 * stable under edits that do not move the thing being placed:
 *
 *   face   index of the footprint edge this sits on
 *   floor  storey number, COUNTED FROM THE GROUND (see rule 2)
 *   bay    position along the face within that storey, from the face's start
 *   sub    optional discriminator when one bay holds several slots
 *          (sill / window / lintel), so they do not share a seed
 *
 * Missing fields default to 0, so a whole-floor decision can pass { floor } and
 * a whole-building one can pass nothing at all.
 *
 * @param {number} docSeed  the document's seed, uint32
 * @param {number} slot     from slotId(), the node+property drawing this
 * @param {object} identity { face, floor, bay, sub }
 * @returns {number} uint32
 */
export function instanceSeed(docSeed, slot, identity = {}) {
  const face = (identity.face | 0) >>> 0;
  const floor = (identity.floor | 0) >>> 0;
  const bay = (identity.bay | 0) >>> 0;
  const sub = (identity.sub | 0) >>> 0;

  // Fold the four coordinates into one uint32 before hashing. Multiplying each
  // by a distinct odd constant keeps (face 1, bay 0) apart from (face 0, bay 1),
  // which a plain sum or a bit-packing with too few bits would collide - and
  // that collision is exactly "the window on the north wall matches the one on
  // the east wall", which looks like a repeat rather than a bug.
  let where = Math.imul(face + 1, 0x9e3779b1);
  where = (where ^ Math.imul(floor + 1, 0x85ebca6b)) >>> 0;
  where = (where ^ Math.imul(bay + 1, 0xc2b2ae35)) >>> 0;
  where = (where ^ Math.imul(sub + 1, 0x27d4eb2f)) >>> 0;

  return pcgHash2((docSeed >>> 0) ^ (slot >>> 0), triple32(where));
}

/**
 * One draw in [0, 1) for a placed thing.
 *
 * `index` distinguishes several draws by the same node for the same slot - a
 * window that wants both a variant and a jitter - without walking a stream.
 */
export function randomAt(docSeed, slot, identity, index = 0) {
  return pcgFloatAt(instanceSeed(docSeed, slot, identity), index >>> 0);
}

/** A draw in [min, max). */
export function rangeAt(docSeed, slot, identity, min, max, index = 0) {
  return min + (max - min) * randomAt(docSeed, slot, identity, index);
}

/** An integer draw in [min, max]. Inclusive, because bay counts are inclusive. */
export function intRangeAt(docSeed, slot, identity, min, max, index = 0) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi <= lo) return lo;
  const r = randomAt(docSeed, slot, identity, index);
  return lo + Math.min(hi - lo, Math.floor(r * (hi - lo + 1)));
}

/** True with probability `p`. */
export function chanceAt(docSeed, slot, identity, p, index = 0) {
  return randomAt(docSeed, slot, identity, index) < p;
}

/**
 * Pick one entry from a weighted list - how a style pack chooses between the
 * three window meshes in its vocabulary.
 *
 * `weights` may be omitted or partly undefined; a missing weight counts as 1, so
 * a pack that lists variants without weighting them gets a uniform choice.
 * Returns an INDEX rather than the item so callers can use it against parallel
 * arrays without this needing to know what a vocabulary entry looks like.
 */
export function weightedPick(docSeed, slot, identity, weights, index = 0) {
  const n = Array.isArray(weights) ? weights.length : 0;
  if (n === 0) return -1;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const w = Number(weights[i]);
    total += Number.isFinite(w) && w > 0 ? w : (weights[i] == null ? 1 : 0);
  }
  if (total <= 0) return 0;

  let r = randomAt(docSeed, slot, identity, index) * total;
  for (let i = 0; i < n; i++) {
    const w = Number(weights[i]);
    const weight = Number.isFinite(w) && w > 0 ? w : (weights[i] == null ? 1 : 0);
    r -= weight;
    if (r < 0) return i;
  }
  return n - 1;
}

/**
 * A uint32 digest of a whole document seed plus an arbitrary string.
 *
 * Used for one-off decisions that belong to the building rather than to a place
 * in it, such as choosing which of a pack's grammar presets a facade uses.
 */
export function digest(docSeed, text) {
  return pcgAt((docSeed >>> 0) ^ hashString(text), 0);
}

/** As digest, in [0, 1). */
export function digestFloat(docSeed, text) {
  return digest(docSeed, text) * INV_2_32;
}
