// The building contract: everything about a procedural building that both the
// browser and the backend have to agree on.
//
// WHY THIS IS A ROOT DIRECTORY and not src/utils/building/. The server needs the
// document schema (to validate an imported .building.json and to mirror its
// digest into the Assets.metadata column), and it will need the catalog and the
// compiler to build an export bundle - and src/ IS NOT SHIPPED in a packaged
// build. Only dist/ is. So shared code cannot live under src/ without breaking
// the desktop app and the Docker image, which is why db/, mcp/ and vfx/ are laid
// out the same way.
//
// THREE BUILD REGISTRATIONS ARE MANDATORY for that to hold, and the repo has
// been bitten by forgetting them before - serverMode.js notes that user asset
// directories shipped missing twice. They are:
//
//   electron-builder.yml  files:            - building/**/*
//   Dockerfile                              COPY --chown=node:node building ./building
//   .dockerignore                           !building/
//
// The .dockerignore entry is needed TWICE OVER: the builder stage's `COPY . .`
// is filtered by that allowlist too, so without it the FRONTEND build also fails
// to resolve ../../building/*.js and the whole image build dies at vite.
//
// tools/check-packaged-modules.mjs walks the import graph from server.js and
// fails the build if any module reachable from it is missing from either
// allowlist, so once server.js imports this directory the rule is enforced
// mechanically rather than remembered.
//
// WHAT BELONGS HERE: pure, environment-neutral modules. No React, no three.js,
// no fs, no process. Everything in this directory has to run identically in a
// browser tab, in Node, and inside a test harness - which is also what makes it
// all testable with plain `node building/*.test.mjs`.
//
// The one external dependency is clipper-lib, imported only by clip.js. It is a
// 200KB UMD file with no Node builtins, so it is as environment-neutral as the
// rest of this directory; see clip.js for why polygon offsetting is not
// something we hand-roll.
//
// WHAT DOES NOT BELONG HERE: the meshing itself and anything that touches the
// GPU. Turning a BuildingIR into BufferGeometry, instancing the slots, building
// materials and the R3F components all live in src/utils/building/ and
// src/components/building/, because only the preview runs them - an exporter
// consumes the IR instead.
//
// DETERMINISM IS ENFORCED. eslint.config.js bans Math.random under building/**.
// A stored building is a small spec that must regenerate its geometry
// bit-for-bit; see building/random.js for why a slot's seed is a hash of its
// identity rather than a position in a stream.

export {
  ARC_TOLERANCE,
  JOIN,
  MITER_LIMIT,
  SCALE,
  cleanPolygons,
  clipperArea,
  differencePolygons,
  intersectPolygons,
  offsetPolygon,
  offsetRings,
  polygonToRings,
  ringsToPolygons,
  unionPolygons,
  xorPolygons,
} from './clip.js';

export {
  CATALOG,
  CATALOG_ORDER,
  CATEGORY,
  DEFAULT_FOOTPRINT,
  PORT_KIND,
  PROP_TYPE,
  coerceProp,
  createNode,
  defaultModes,
  defaultProps,
  getNodeDef,
  getPort,
  propApplies,
  readMode,
  readProp,
} from './catalog.js';

export {
  MAX_ROOF_STEPS,
  ROOF_KIND,
  bandBetween,
  generateRoof,
  roofIsCapped,
  roofTop,
  rungKind,
  stackRoofs,
} from './roof.js';

export { MAX_SLOTS, generateFacade } from './facade.js';

export {
  MAX_REPEAT,
  MIN_CELL,
  SIZE,
  STRETCH,
  bayParts,
  placeInCell,
  repeatCount,
  splitSpan,
  storeyParts,
  tileSpan,
} from './grammar.js';

export {
  CURVE_INTERP,
  createCurve,
  defaultProfileCurve,
  evalCurve,
  isCurve,
  isFlatCurve,
  sampleCurve,
  toCurve,
} from './param.js';

export { BUILDING_IR_FORMAT, compileBuilding } from './compile.js';

export {
  CODE,
  SEVERITY,
  createDiagnostics,
  diagnostic,
  fix,
  metres,
} from './diagnostics.js';

export {
  LEVEL_KIND,
  SLOT_TYPE,
  createBuildingIr,
  createPolygonTable,
  flattenRing,
  irDigest,
  makeLevel,
  makeRoofRung,
  makeSlot,
  makeSolid,
  makeTrim,
  quantize,
  unflattenRing,
  validateIrJson,
} from './ir.js';

export {
  MASS_PROFILE,
  MAX_LEVELS,
  insetAt,
  offsetFootprint,
  sampleProfileCurve,
  stackMass,
  topOfStack,
} from './mass.js';

export {
  ASSET_REF_PATTERN,
  BUILDING_DOC_FORMAT,
  BUILDING_DOC_KIND,
  BUILDING_UNITS,
  MAX_SEED,
  REFERENCE_KIND,
  buildingAssetDigest,
  buildingSignature,
  clearReference,
  collectReferenceIds,
  createBuildingDoc,
  danglingReferences,
  findNode,
  looksLikeBuildingDoc,
  migrateBuildingDoc,
  nodesOfType,
  normalizeBuildingDoc,
  parseBuildingDoc,
  serializeBuildingDoc,
  setReference,
} from './doc.js';

export {
  EPS,
  MIN_RING_VERTICES,
  bounds,
  centroid,
  dedupeRing,
  ensureWinding,
  isCCW,
  normalizePolygon,
  normalizeRing,
  perimeter,
  pointInRing,
  polygonArea,
  removeCollinear,
  ringEdges,
  rotateRing,
  scaleRing,
  segmentsCross,
  selfIntersects,
  signedArea,
  translateRing,
  validateRing,
} from './poly.js';

export {
  PCG_STATE_WORDS,
  chanceAt,
  digest,
  digestFloat,
  hashString,
  instanceSeed,
  intRangeAt,
  pcgAt,
  pcgFloat,
  pcgFloatAt,
  pcgHash2,
  pcgInit,
  pcgNext,
  pcgReseed,
  randomAt,
  rangeAt,
  slotId,
  triple32,
  weightedPick,
} from './random.js';
