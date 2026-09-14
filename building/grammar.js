// The split grammar: cutting a span into parts.
//
// This is the piece that decides whether one facade rule can dress any wall, or
// whether every building needs its own hand-tuned numbers. It is CGA's split
// operation, reduced to the part that earns its keep.
//
// THREE WAYS TO SIZE A PART, and the mix is the whole point:
//
//   abs    a fixed measurement in metres. A pier is 600mm because that is what
//          a pier is; it does not get wider on a longer wall.
//   rel    a fraction OF THE WHOLE SPAN. Useful for "the entrance is a third of
//          the frontage" - the kind of proportion that should scale.
//   float  a share of WHATEVER IS LEFT after abs and rel are satisfied. This is
//          what absorbs the slack, and it is why a wall of any length can be
//          dressed without stretching anything that should not stretch.
//
// INTEGER SNAPPING ON REPEATS IS NON-NEGOTIABLE. A 13.4m wall with a nominal 3m
// bay does not get four bays and a 1.4m stub; it gets four bays of 3.35m. Half a
// window at the end of a wall is the single most obvious way for generated
// architecture to look generated. `tileSpan` rounds to a whole number of bays
// and divides the span evenly between them, and everything downstream works in
// those cells rather than in the nominal size.
//
// AND THE TRICK THAT MAKES IT WORK: a cell being 3.35m wide does NOT mean the
// window in it is 3.35m wide. A part carries `stretch`, and only the parts that
// should stretch do - the wall between openings. A window is placed at its
// natural size, centred in its cell. That single distinction is the difference
// between "one rule fits every wall" and "every wall needs its own rule", and it
// is why `placeInCell` exists next to the splitters rather than in the caller.
//
// PURE ARITHMETIC over plain numbers. No geometry, no polygons, no three.js -
// a span is just a length, so this file is testable in complete isolation and is
// reused for both the horizontal split (a wall into bays) and the vertical one
// (a storey into sill, opening and lintel).

/** How a part claims its share of a span. */
export const SIZE = {
  /** Fixed metres. */
  ABS: 'abs',
  /** A fraction of the whole span. */
  REL: 'rel',
  /** A share of what is left after abs and rel. */
  FLOAT: 'float',
};

/** Whether a part's content resizes with its cell. */
export const STRETCH = {
  /** Placed at its natural size, centred. Windows, doors, columns. */
  NONE: 'none',
  /** Fills the cell. Wall, glazing ribbons, anything continuous. */
  FILL: 'fill',
};

/** Nothing narrower than this is worth emitting. Metres. */
export const MIN_CELL = 1e-4;

/** A repeat may never produce more cells than this, whatever the numbers say. */
export const MAX_REPEAT = 512;

// The last index matching a predicate, or null. Null rather than -1 so `??` can
// chain the fallbacks at the call site without -1 counting as a hit.
function lastIndexWhere(items, predicate) {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i;
  return null;
}

function sizeOf(part) {
  const size = part?.size;
  if (!size) return { kind: SIZE.FLOAT, v: 1 };
  const v = Number(size.v);
  return {
    kind: size.kind === SIZE.ABS || size.kind === SIZE.REL ? size.kind : SIZE.FLOAT,
    v: Number.isFinite(v) && v >= 0 ? v : (size.kind === SIZE.FLOAT ? 1 : 0),
  };
}

/**
 * Cut `total` metres into parts.
 *
 * Returns one cell per part: `{ index, part, start, size }`, in order, with
 * `start` measured from the beginning of the span.
 *
 * OVER-SUBSCRIPTION IS HANDLED, NOT REJECTED. If the absolute parts alone
 * exceed the span - a 2m wall with two 1.5m piers - they are scaled down
 * proportionally rather than overflowing. A facade rule meets walls it was not
 * designed for all the time (the short return of an L-plan), and the answer that
 * keeps the building intact is a squashed bay, not a bay hanging off the end.
 * `overflowed` says it happened so the compiler can mention it once.
 */
export function splitSpan(total, parts) {
  const span = Number(total);
  const list = Array.isArray(parts) ? parts : [];
  const out = { cells: [], overflowed: false };
  if (!Number.isFinite(span) || span <= MIN_CELL || list.length === 0) return out;

  const sizes = list.map(sizeOf);

  let absTotal = 0;
  let relTotal = 0;
  let floatWeight = 0;
  for (const size of sizes) {
    if (size.kind === SIZE.ABS) absTotal += size.v;
    else if (size.kind === SIZE.REL) relTotal += size.v * span;
    else floatWeight += size.v;
  }

  // Scale the fixed claims down together when they do not fit, so their
  // proportions survive even though their measurements cannot.
  let scale = 1;
  const fixed = absTotal + relTotal;
  if (fixed > span) {
    scale = span / fixed;
    out.overflowed = true;
  }

  const slack = Math.max(0, span - fixed * scale);

  const widths = sizes.map(size => {
    if (size.kind === SIZE.ABS) return size.v * scale;
    if (size.kind === SIZE.REL) return size.v * span * scale;
    return floatWeight > 0 ? (slack * size.v) / floatWeight : 0;
  });

  // Absorb the rounding, so the parts always sum to EXACTLY the span - without
  // it a 13.4m wall can end at 13.399999999999999 and leave a hairline gap at
  // the corner.
  //
  // It goes into the last FLOAT part, not simply the last part. A float exists
  // to take up slack, so a micron more of it is invisible; putting it on an
  // absolute part instead breaks the promise that made abs worth having - a
  // 600mm pier came out 600.0000000000001mm, and "my pier is not 600" is
  // exactly the kind of thing an author checks. Falls back to rel, then to the
  // last part, for rules that have no float at all.
  const absorber = lastIndexWhere(sizes, size => size.kind === SIZE.FLOAT)
    ?? lastIndexWhere(sizes, size => size.kind === SIZE.REL)
    ?? widths.length - 1;
  if (absorber >= 0) {
    const sum = widths.reduce((a, b) => a + b, 0);
    widths[absorber] = Math.max(0, widths[absorber] + (span - sum));
  }

  let cursor = 0;
  for (let index = 0; index < widths.length; index++) {
    out.cells.push({ index, part: list[index], start: cursor, size: widths[index] });
    cursor += widths[index];
  }

  return out;
}

/**
 * How many whole repeats of `nominal` fit in `total`.
 *
 * Rounds rather than floors: a 13.4m wall with a 3m nominal bay wants four bays
 * of 3.35m, not four of 3m and a 1.4m stub. Flooring would bias every wall
 * toward wider-than-asked bays and would make a 5.9m wall produce one 5.9m bay
 * where two 2.95m bays are plainly right.
 */
export function repeatCount(total, nominal, { min = 1, max = MAX_REPEAT } = {}) {
  const span = Number(total);
  const unit = Number(nominal);
  const lo = Math.max(1, Math.floor(min));
  const hi = Math.max(lo, Math.min(MAX_REPEAT, Math.floor(max)));
  if (!Number.isFinite(span) || span <= MIN_CELL) return 0;
  if (!Number.isFinite(unit) || unit <= MIN_CELL) return lo;
  return Math.min(hi, Math.max(lo, Math.round(span / unit)));
}

/**
 * Tile a span with a whole number of equal cells.
 *
 * The horizontal half of the grammar: a wall becomes N bays of exactly
 * total/N metres, so no bay is a fraction of another and nothing lands half-cut
 * at a corner. Returns `{ cells, count, size }`.
 */
export function tileSpan(total, nominal, options = {}) {
  const span = Number(total);
  const count = repeatCount(span, nominal, options);
  if (count <= 0) return { cells: [], count: 0, size: 0 };

  const size = span / count;
  const cells = [];
  for (let index = 0; index < count; index++) {
    // start is computed from the index rather than accumulated, so cell 40 is
    // exactly 40 * size from the origin instead of forty additions of drift.
    cells.push({ index, start: index * size, size });
  }
  return { cells, count, size };
}

/**
 * Where a part's content actually goes inside its cell.
 *
 * THE STRETCH RULE, and the reason one facade rule fits any wall. A `fill` part
 * takes the cell. A `none` part keeps its natural size and sits centred, so a
 * 1.2m window stays 1.2m whether its bay came out at 3m or 3.35m - the slack
 * goes into the wall on either side, which is exactly where a mason would put
 * it.
 *
 * Natural size is clamped to the cell: a 2m door in a 1.4m bay becomes a 1.4m
 * door rather than poking through the pier beside it.
 */
export function placeInCell(cell, { stretch = STRETCH.FILL, natural = 0 } = {}) {
  if (stretch !== STRETCH.NONE || !(natural > 0)) {
    return { start: cell.start, size: cell.size, clamped: false };
  }
  const size = Math.min(natural, cell.size);
  return {
    start: cell.start + (cell.size - size) / 2,
    size,
    clamped: size < natural - 1e-9,
  };
}

/**
 * A bay's internal layout, as parts.
 *
 * The commonest rule in architecture and the one the Facade node builds by
 * default: a solid pier, an opening, and the slack absorbed by the wall around
 * it. Expressed through the general splitter rather than special-cased, so a
 * style pack can replace it with any other part list and everything downstream
 * is unchanged.
 */
export function bayParts({ pierWidth = 0.6, openingSlot = 'window', pierSlot = 'wall' } = {}) {
  return [
    { size: { kind: SIZE.ABS, v: pierWidth / 2 }, slot: pierSlot, stretch: STRETCH.FILL },
    { size: { kind: SIZE.FLOAT, v: 1 }, slot: openingSlot, stretch: STRETCH.NONE },
    { size: { kind: SIZE.ABS, v: pierWidth / 2 }, slot: pierSlot, stretch: STRETCH.FILL },
  ];
}

/**
 * A storey's vertical layout, as parts.
 *
 * Sill below, opening, lintel above. The sill and lintel are absolute because
 * they are construction dimensions - a lintel does not get deeper because the
 * ceiling is higher - and the opening floats, which is what makes a 4m ground
 * floor produce a taller window than a 3m storey above it without being told to.
 */
export function storeyParts({ sillHeight = 0.9, lintelHeight = 0.5, openingSlot = 'window' } = {}) {
  return [
    { size: { kind: SIZE.ABS, v: sillHeight }, slot: 'wall', stretch: STRETCH.FILL },
    { size: { kind: SIZE.FLOAT, v: 1 }, slot: openingSlot, stretch: STRETCH.NONE },
    { size: { kind: SIZE.ABS, v: lintelHeight }, slot: 'wall', stretch: STRETCH.FILL },
  ];
}
