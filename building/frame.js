// Half-timbering: the frame drawn ON the wall.
//
// THIS IS THE ONE THING A TRIM RUN COULD NOT SAY. Trim follows edges, and every
// edge a building has is horizontal - a plinth, a string course, a cornice all
// ring the plan at a height. A timber frame is the other two directions: studs
// standing between the rails, and braces cutting across the panels between them.
// Without them a medieval or Tudor building is a beige box with a steep roof,
// which is exactly what the generator produced before this file existed.
//
// MEMBERS ARE TRIM RUNS, not a new kind of geometry. A run is a swept polyline
// with a cross-section, which is precisely what a timber is; making them runs
// means the deformation warps them, the exporter bakes them, the material
// selector dresses them and the mesher sweeps them, all with no new code in any
// of those places. The only thing that had to change is that a run may now be
// OPEN and non-horizontal - see makeTrim's `normal` and buildTrimGeometry.
//
// IT REUSES THE FACADE'S OWN BAY TILING, and that is not an optimisation. A
// frame whose studs land anywhere other than on the bay boundaries reads as
// wrong immediately, because the windows are IN those bays: a stud through the
// middle of a window is the single most obvious way to get this wrong. So this
// file calls the same tileSpan with the same nominal bay width, and lines up by
// construction rather than by the author matching two numbers.
//
// THE PANEL, NOT THE WALL, IS THE UNIT. Braces are chosen and drawn per panel -
// one bay wide by one storey tall - so a long wall gets variety along it and the
// pattern survives a wall of any length. Mixed mode rolls each panel from its
// own identity, which is what makes two buildings from one document differ and
// what stops adding a storey reshuffling the ones below.

import { intRangeAt, slotId } from './random.js';
import { LEVEL_KIND } from './ir.js';
import { tileSpan } from './grammar.js';

/** What fills a panel between the studs. */
export const BRACE = {
  NONE: 'none',
  /** One diagonal, alternating direction bay by bay. Herringbone. */
  DIAGONAL: 'diagonal',
  /** Both diagonals: a St Andrew's cross. */
  CROSS: 'cross',
  /** Two diagonals meeting at the top centre. The classic Tudor chevron. */
  CHEVRON: 'chevron',
  /** A cross plus the two midlines - close-studded lattice panels. */
  LATTICE: 'lattice',
  /** A different one per panel, rolled from the seed. */
  MIXED: 'mixed',
};

/** The patterns `mixed` draws from. Deliberately excludes the empty one. */
const MIXED_POOL = [BRACE.DIAGONAL, BRACE.CROSS, BRACE.CHEVRON, BRACE.LATTICE];

/** A wall shorter than this carries no frame worth drawing. Metres. */
const MIN_WALL = 0.4;

/** Hard ceiling on members, for the same reason facade.js has one. */
export const MAX_FRAME_MEMBERS = 4000;

/** The edges of a ring, as stored. Same convention and reasons as facade.js. */
function edgesOf(ring) {
  const edges = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    edges.push({ a, dir: [dx / length, dy / length], normal: [dy / length, -dx / length], length });
  }
  return edges;
}

/**
 * Build one frame node's members.
 *
 * @param {object} options
 * @param {Array}  options.levels   the stack, from mass.stackMass
 * @param {number} options.seed
 * @param {string} options.nodeId
 * @param {object} options.rule
 * @returns {{runs: Array, truncated: boolean}}
 */
export function generateFrame({
  levels = [], seed = 0, nodeId = 'frame', rule = {},
} = {}) {
  const {
    bayWidth = 1.6,
    brace = BRACE.CHEVRON,
    // How thick the timber is and how far it stands off the wall. `width` is the
    // face of the board, `depth` how proud of the plaster it sits.
    width = 0.16,
    depth = 0.06,
    rails = true,
    // Insets so a member sits inside its panel rather than straddling the
    // boundary it shares with the next one.
    margin = 0,
    includeCourtyards = false,
    floorFrom = 0,
    floorTo = Infinity,
  } = rule;

  const out = { runs: [], truncated: false, claimed: new Set() };
  const solid = levels.filter(level => level.kind !== LEVEL_KIND.PLINTH);
  if (!solid.length) return out;

  const braceSlot = slotId(nodeId, 'brace');
  const covers = index => index >= floorFrom && index <= floorTo;

  // `projection` is how far the section reaches out of the wall and `depth` is
  // its other extent - so for these runs, which are mostly vertical and
  // diagonal, the trim section's "depth" is the WIDTH of the board. Named here
  // once rather than confusing the caller at every push.
  const push = (path, normal) => {
    if (out.runs.length >= MAX_FRAME_MEMBERS) { out.truncated = true; return; }
    out.runs.push({
      profileId: 'frame',
      path,
      closed: false,
      level: -1,
      projection: depth,
      depth: width,
      source: nodeId,
      normal,
    });
  };

  for (const level of solid) {
    if (!covers(level.index)) continue;
    const height = level.z1 - level.z0;
    if (!(height > MIN_WALL)) continue;
    out.claimed.add(level.index);

    const rings = [level.polygon.outer];
    if (includeCourtyards) rings.push(...(level.polygon.holes || []));

    let faceIndex = 0;
    for (const ring of rings) {
      for (const edge of edgesOf(ring)) {
        const face = faceIndex++;
        if (edge.length < MIN_WALL) continue;
        const normal = [edge.normal[0], edge.normal[1], 0];

        // A point on this wall, at `along` metres from its start and `z` high.
        const at = (along, z) => [
          edge.a[0] + edge.dir[0] * along,
          edge.a[1] + edge.dir[1] * along,
          z,
        ];
        const line = (a, b, za, zb) => push([...at(a, za), ...at(b, zb)], normal);

        const { cells } = tileSpan(edge.length, bayWidth);
        if (!cells.length) continue;

        // RAILS first: the horizontal top and bottom of every panel. Drawn per
        // wall rather than per panel so a long wall is one timber and not
        // fifteen butted end to end - which matters because each one is swept
        // geometry and because the joins would show.
        if (rails) {
          line(0, edge.length, level.z0 + width / 2, level.z0 + width / 2);
          line(0, edge.length, level.z1 - width / 2, level.z1 - width / 2);
        }

        // STUDS on every bay boundary, plus the one that closes the wall. The
        // same boundaries the facade used, so nothing lands through a window.
        for (let i = 0; i <= cells.length; i++) {
          const along = i < cells.length ? cells[i].start : edge.length;
          line(along, along, level.z0, level.z1);
        }

        // BRACES, per panel.
        if (brace === BRACE.NONE) continue;
        const z0 = level.z0 + width;
        const z1 = level.z1 - width;
        if (!(z1 > z0)) continue;

        for (let i = 0; i < cells.length; i++) {
          const lo = cells[i].start + margin;
          const hi = cells[i].start + cells[i].size - margin;
          if (!(hi > lo)) continue;
          const mid = (lo + hi) / 2;
          const zMid = (z0 + z1) / 2;

          // THE PATTERN IS CHOSEN FROM THE PANEL'S OWN IDENTITY, never from a
          // counter: adding a storey must not reshuffle the panels below it, and
          // a panel removed by a shorter wall must not shift its neighbours.
          const pattern = brace === BRACE.MIXED
            ? MIXED_POOL[intRangeAt(seed, braceSlot, {
              face, floor: level.index, bay: i,
            }, 0, MIXED_POOL.length - 1)]
            : brace;

          switch (pattern) {
            case BRACE.DIAGONAL:
              // Alternating by bay, so a wall reads as herringbone rather than
              // as a row of identical slashes.
              if (i % 2 === 0) line(lo, hi, z0, z1);
              else line(lo, hi, z1, z0);
              break;
            case BRACE.CROSS:
              line(lo, hi, z0, z1);
              line(lo, hi, z1, z0);
              break;
            case BRACE.CHEVRON:
              line(lo, mid, z0, z1);
              line(mid, hi, z1, z0);
              break;
            case BRACE.LATTICE:
              line(lo, hi, z0, z1);
              line(lo, hi, z1, z0);
              line(lo, hi, zMid, zMid);
              line(mid, mid, z0, z1);
              break;
            default:
              break;
          }
          if (out.truncated) return out;
        }
      }
    }
  }

  return out;
}
