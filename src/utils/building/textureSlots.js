// What each material slot is for, and how a generated texture is steered.
//
// SEPARATE FROM THE PANEL because a component file that also exports constants
// breaks fast refresh, and because the tile sizes here are read by the slot list
// too. Both of those are reasons to keep vocabulary out of a dialog.

/** Appended to whatever the author types. See the header for why each clause. */
export const TILEABLE_SUFFIX = 'seamless tileable texture, flat even lighting, '
  + 'orthographic top-down view, no shadows, no perspective, no border, no text, '
  + 'photographic material sample'

/**
 * What each slot is for, and a starting prompt.
 *
 * The tile size is the part people get wrong: brickwork reads at about 2m, roof
 * tiles at under a metre, and a stone plinth block at around 1m. A texture at
 * the wrong scale looks like a different material entirely.
 */
/**
 * Which slots tile by METRES, and which fill the thing they are drawn on.
 *
 * Two different kinds of surface, and treating them alike is what put a corner
 * of a window texture in every opening.
 *
 * A WALL, ROOF or TRIM is UV-mapped in metres by mesh.js - see its header - so a
 * texture's repeat is 1/tileMetres and brickwork is the same size on a cottage
 * and on a tower. That is the whole reason the tile size exists.
 *
 * An OPENING or a DOOR is not a material, it is a THING: one window, one door,
 * drawn on an instanced unit box whose UVs run 0..1 across the cell. Tiling it
 * samples a fraction of the image - at a 1.5m tile, the bottom-left two thirds
 * of the window and nothing else. It has to fill the cell exactly.
 */
export const CELL_SLOTS = new Set(['opening', 'door'])

/** Whether a slot's texture repeats by metres rather than filling its cell. */
export function tilesByMetres(slot) {
  return !CELL_SLOTS.has(slot)
}

export const SLOT_GUIDE = {
  wall: {
    label: 'Wall',
    tile: 2,
    hint: 'The main facade material. Tiles across the whole elevation.',
    prompts: [
      ['Red brick', 'a wall of weathered red brick with pale mortar joints'],
      ['Stucco', 'a smooth cream lime stucco wall, subtle trowel texture'],
      ['Cut stone', 'a wall of large cut limestone blocks, fine joints'],
      ['Concrete', 'board-formed grey concrete with faint timber grain'],
      ['Sandstone', 'warm golden sandstone ashlar, softly eroded'],
    ],
  },
  trim: {
    label: 'Trim',
    tile: 1,
    hint: 'Cornices, string courses and plinths. Tiles along the run.',
    prompts: [
      ['Painted timber', 'dark stained oak beam, straight grain'],
      ['Pale stone', 'pale carved limestone moulding, smooth'],
      ['Weathered metal', 'oxidised copper sheet, green patina'],
    ],
  },
  roof: {
    label: 'Roof',
    tile: 0.8,
    hint: 'The roof surface. Small tile: roofing units are small.',
    prompts: [
      ['Clay tiles', 'rows of terracotta clay roof tiles, overlapping'],
      ['Slate', 'grey slate roof tiles, rectangular, slightly uneven'],
      ['Thatch', 'thick golden straw thatch, combed'],
      ['Metal deck', 'ribbed grey metal roof decking, industrial'],
    ],
  },
  opening: {
    label: 'Windows',
    tile: 1.5,
    hint: 'What fills a window opening.',
    prompts: [
      ['Dark glass', 'dark tinted glass pane with a faint sky reflection'],
      ['Leaded glass', 'leaded diamond-pane glass, dark lead cames'],
      ['Shutters', 'closed painted timber shutters, horizontal slats'],
    ],
  },
  door: {
    label: 'Doors',
    tile: 2,
    hint: 'What fills a door opening.',
    prompts: [
      ['Plank door', 'heavy vertical oak plank door with iron studs'],
      ['Panelled door', 'painted panelled timber door, six panels'],
    ],
  },
}
