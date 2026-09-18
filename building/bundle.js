// A building export bundle: the graph plus the files its slots point at.
//
// WHY A BUNDLE AND NOT JUST THE JSON. A building document names its textures and
// models as `asset:<id>` - invariant 4 in doc.js - and those ids belong to the
// library that exported it. Hand someone the .building.json alone and every slot
// points at a row in somebody else's database: on a fresh install they resolve to
// nothing, and on a populated one they resolve to WHATEVER happens to hold that
// id. The second is the dangerous case, because it imports clean and shows the
// wrong brick.
//
// So a bundle carries the files, and importing is a remap: upload each file,
// learn the id it got HERE, and rewrite the slot. That is the whole feature.
//
// THE ONE RULE THIS MODULE EXISTS TO ENFORCE: a reference the bundle could not
// supply is CLEARED, never left as it was. An unresolved `asset:1646` is the
// silent-wrong-texture bug above; an empty slot falls back to the palette
// colour, which is what an unbound slot has always looked like and is
// immediately legible as "this did not come across".
//
// Modelled on vfx/bundle.js, which solved the same problem for effects, and
// deliberately a separate module rather than a shared one: the two manifests
// describe different things (an effect ships an IR and an engine mapping table;
// a building ships a graph and nothing else), and coupling them would mean every
// change to one format had to be safe for the other.
//
// PURE, and in the root package rather than src/ for the usual reason: server.js
// builds the manifest, the browser reads it, and `node building/bundle.test.mjs`
// exercises both without either.

/** Bundle format this build writes. Bump when an older reader would MISREAD it. */
export const BUILDING_BUNDLE_FORMAT = 1;

/** The oldest format this build still reads. */
export const BUILDING_BUNDLE_MIN_FORMAT = 1;

const ASSET_REF = /^asset:(\d+)$/;

const str = (value) => (typeof value === 'string' ? value : '');

/** A bundle-relative path, with no leading slash, no backslashes and no `..`. */
export function normalizeBundlePath(value) {
  const raw = str(value).trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw) return '';
  // A manifest is data from another machine, so a path that climbs out of the
  // bundle is refused rather than sanitised into something that still resolves.
  if (raw.split('/').some((part) => part === '..')) return '';
  return raw;
}

/** A bundle that cannot be read, with a message meant for the person importing. */
export class BuildingBundleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BuildingBundleError';
  }
}

/**
 * Every reference slot in a document, for the EXPORT side to resolve to files.
 *
 * Returned for slots with no ref as well, because the manifest has to record
 * that the slot existed and shipped nothing - that is what lets the import
 * distinguish "the author never filled this" from "the file went missing", and
 * only report the second.
 *
 * @param {Object} doc a normalised building document
 * @returns {Array<{slot: string, kind: string, assetId: number, name: string}>}
 */
export function bundleReferencePlan(doc) {
  const references = doc?.references && typeof doc.references === 'object' ? doc.references : {};
  const plan = [];
  for (const [slot, entry] of Object.entries(references)) {
    const match = ASSET_REF.exec(str(entry?.ref));
    plan.push({
      slot,
      kind: entry?.kind === 'mesh' ? 'mesh' : 'image',
      assetId: match ? Number(match[1]) : 0,
      name: str(entry?.name),
    });
  }
  // Sorted, so two exports of the same document write byte-identical manifests.
  return plan.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
}

/**
 * Read a manifest, or say why it cannot be read.
 *
 * Every failure here happens BEFORE anything is written to the library - see the
 * header of bundleImport.js. A folder that is not a bundle, or one from a newer
 * build, is refused rather than half-installed.
 *
 * @param {Object|string} input the parsed manifest or its JSON text
 * @returns {Object}
 */
export function parseBundleManifest(input) {
  let manifest = input;
  if (typeof input === 'string') {
    try {
      manifest = JSON.parse(input);
    } catch {
      throw new BuildingBundleError('manifest.json is not valid JSON. The bundle may be damaged.');
    }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new BuildingBundleError('manifest.json does not describe a building bundle.');
  }

  const format = Number(manifest.bundleFormat);
  if (!Number.isFinite(format)) {
    throw new BuildingBundleError(
      'That folder has a manifest.json, but it is not a building export - it carries no bundleFormat.',
    );
  }
  // NAMED, because an effect bundle and a building bundle are both a folder with
  // a manifest.json in it, and picking the wrong one is an easy mistake to make.
  if (str(manifest.kind) && str(manifest.kind) !== 'building') {
    throw new BuildingBundleError(
      `That folder is a "${str(manifest.kind)}" bundle, not a building.`,
    );
  }
  if (format > BUILDING_BUNDLE_FORMAT) {
    throw new BuildingBundleError(
      `This bundle was written by a newer version of the app (format ${format}; this one reads up `
      + `to ${BUILDING_BUNDLE_FORMAT}). Update before importing it.`,
    );
  }
  if (format < BUILDING_BUNDLE_MIN_FORMAT) {
    throw new BuildingBundleError(
      `This bundle is in format ${format}, which this version no longer reads.`,
    );
  }

  const graph = manifest.graph && typeof manifest.graph === 'object' ? manifest.graph : null;
  const file = normalizeBundlePath(manifest.asset?.file);
  if (!graph && !file) {
    throw new BuildingBundleError(
      'The bundle carries no building - neither an embedded graph nor a building/ file.',
    );
  }
  return manifest;
}

/**
 * Where the document is: embedded in the manifest, or a file beside it.
 *
 * Both are written, so the folder is self-describing without the manifest. Only
 * the caller can read a second file, so this reports which it needs rather than
 * fetching it.
 *
 * @param {Object} manifest
 * @returns {{graph: Object|null, file: string}}
 */
export function bundleGraphSource(manifest) {
  return {
    graph: manifest?.graph && typeof manifest.graph === 'object' ? manifest.graph : null,
    file: normalizeBundlePath(manifest?.asset?.file),
  };
}

/** The building's name as the exporting library knew it. */
export function bundleBuildingName(manifest) {
  return str(manifest?.asset?.name).trim();
}

/** The card image's path inside the bundle, if it shipped one. */
export function bundleThumbnailPath(manifest) {
  return normalizeBundlePath(manifest?.asset?.thumbnail);
}

/**
 * Every file the bundle wants installed, and the slot that wants it.
 *
 * SLOTS WITH NO FILE ARE STILL RETURNED, with `file: ''`. Those are exactly the
 * ones that must be emptied rather than carried across, and a caller that only
 * saw the installable ones would not know they existed.
 *
 * TWO SLOTS CAN NAME ONE FILE - a building commonly uses one stone for the
 * plinth run of two different masses - so the caller keys its uploads by `file`
 * and uploads each one once.
 *
 * @param {Object} manifest
 * @returns {Array<{slot: string, kind: string, file: string, name: string, hadRef: boolean}>}
 */
export function bundleAssetNeeds(manifest) {
  const references = Array.isArray(manifest?.references) ? manifest.references : [];
  const needs = [];
  for (const entry of references) {
    const slot = str(entry?.slot);
    if (!slot) continue;
    needs.push({
      slot,
      kind: entry?.kind === 'mesh' ? 'mesh' : 'image',
      file: normalizeBundlePath(entry?.file),
      // The ASSET's name first: it is what the exporting library called the file
      // and therefore what a name match against this library can hit. The slot's
      // display name is a label and only the fallback.
      name: str(entry?.assetName).trim() || str(entry?.name).trim(),
      hadRef: ASSET_REF.test(str(entry?.ref)),
    });
  }
  return needs;
}

/**
 * Point a bundle's document at the ids its files got in THIS library.
 *
 * EVERYTHING ELSE ON THE ENTRY SURVIVES. A reference carries more than its id -
 * how many metres one tile covers across and up, and a model's rotation - and
 * those describe the ASSET, not the library it came from. Rebuilding the entry
 * instead of spreading it would silently reset every texture to a 2m square
 * tile, which looks like a working import.
 *
 * @param {Object} doc a normalised building document
 * @param {Array<Object>} needs from bundleAssetNeeds
 * @param {Map<string, number>|Object} idsByFile bundle path to local asset id
 * @returns {{doc: Object, resolved: Object[], missing: Object[]}}
 */
export function applyBundleAssets(doc, needs, idsByFile) {
  const references = { ...(doc?.references || {}) };
  const lookup = (file) => (idsByFile instanceof Map ? idsByFile.get(file) : idsByFile?.[file]);
  const resolved = [];
  const missing = [];

  for (const need of Array.isArray(needs) ? needs : []) {
    const slot = references[need.slot];
    if (!slot) {
      // A manifest naming a slot the document does not have. Nothing to write
      // and nothing to clear, but worth reporting: it means the two halves of
      // the bundle disagree.
      missing.push({ ...need, reason: 'the building has no such slot' });
      continue;
    }
    const id = Number(lookup(need.file));
    if (need.file && Number.isFinite(id) && id > 0) {
      references[need.slot] = {
        ...slot,
        ref: `asset:${id >>> 0}`,
        name: need.name || slot.name || '',
      };
      resolved.push({ ...need, assetId: id });
      continue;
    }
    references[need.slot] = { ...slot, ref: '' };
    // A SLOT THE AUTHOR NEVER FILLED IS NOT A PROBLEM. It had no ref and no
    // file, it arrives empty and stays empty - reporting it would mean every
    // building with a spare slot imports "with 4 warnings", which is how a
    // warning list stops being read.
    if (!need.file && !need.hadRef) continue;
    missing.push({
      ...need,
      reason: need.file
        ? 'its file could not be added to your library'
        // The export already warned about this one; repeating it here is what
        // turns a warning buried in the manifest into something the person
        // importing actually sees.
        : 'the bundle shipped without that file',
    });
  }

  // Any slot the manifest never mentioned. It cannot have travelled with a file,
  // so its ref is a foreign id by definition.
  for (const [slot, entry] of Object.entries(references)) {
    if (!ASSET_REF.test(str(entry?.ref))) continue;
    if (resolved.some((need) => need.slot === slot)) continue;
    references[slot] = { ...entry, ref: '' };
    missing.push({
      slot,
      kind: entry?.kind === 'mesh' ? 'mesh' : 'image',
      file: '',
      name: str(entry?.name),
      hadRef: true,
      reason: 'the manifest does not list it',
    });
  }

  return { doc: { ...doc, references }, resolved, missing };
}

/** The warnings the EXPORT recorded, worth repeating to whoever is importing. */
export function bundleWarnings(manifest) {
  const warnings = Array.isArray(manifest?.warnings) ? manifest.warnings : [];
  return warnings
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      code: str(entry.code) || 'WARNING',
      severity: entry.severity === 'error' ? 'error' : 'warn',
      message: str(entry.message),
    }));
}

/**
 * A one-line description of what a picked folder holds, for the dialog to show
 * BEFORE anything is written.
 *
 * @param {Object} manifest
 * @returns {{name: string, textures: number, models: number, empty: number,
 *   warnings: number, appVersion: string, exportedAt: number}}
 */
export function summarizeBundle(manifest) {
  const needs = bundleAssetNeeds(manifest);
  const withFile = needs.filter((need) => need.file);
  // BY FILE, not by slot: one stone bound to two plinth runs is one texture to
  // install, and counting it twice would overstate what the import will do.
  const files = new Set(withFile.map((need) => need.file));
  const kindOf = (file) => withFile.find((need) => need.file === file)?.kind;
  return {
    name: bundleBuildingName(manifest),
    textures: [...files].filter((file) => kindOf(file) === 'image').length,
    models: [...files].filter((file) => kindOf(file) === 'mesh').length,
    empty: needs.length - withFile.length,
    warnings: bundleWarnings(manifest).length,
    appVersion: str(manifest?.appVersion),
    exportedAt: Number(manifest?.exportedAt) || 0,
  };
}
