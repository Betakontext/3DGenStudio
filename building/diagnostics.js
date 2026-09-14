// Every problem the compiler can report, and how it says it.
//
// THREE RULES, copied from vfx/diagnostics.js because they are what made that
// feature's error messages worth reading:
//
//   1. SAY WHAT WILL HAPPEN, not what is wrong. "No Output node, so nothing will
//      be built" beats "missing output". The author cares about the consequence.
//   2. SHOW THE ARITHMETIC. "The profile insets 4m per level and the footprint
//      is 12m across, so it is consumed at level 3 of 10" beats "footprint too
//      small". A number the author can act on beats a category.
//   3. OFFER A ONE-CLICK FIX where one exists.
//
// FIXES ARE DESCRIPTORS, NOT FUNCTIONS: { label, action, args }. That is not a
// style choice - a diagnostic has to survive JSON.stringify into an export
// bundle and back out in a different process, and a closure does not. The
// appliers live in a registry in src/utils/building/edits.js, each one an
// ordinary edit producing one undo entry.

/** How much a diagnostic matters. */
export const SEVERITY = {
  /** Nothing will be built, or what is built is wrong. */
  ERROR: 'error',
  /** Something will be built, but probably not what was meant. */
  WARN: 'warn',
  /** Worth knowing. Never blocks anything. */
  INFO: 'info',
};

/**
 * The codes. Grouped by prefix so a consumer can filter without a table:
 * E_ errors, W_ warnings, I_ info.
 */
export const CODE = {
  // --- structure ---
  E_NO_FOOTPRINT: 'E_NO_FOOTPRINT',
  E_NO_OUTPUT: 'E_NO_OUTPUT',
  E_MULTIPLE_OUTPUTS: 'E_MULTIPLE_OUTPUTS',
  E_UNKNOWN_NODE: 'E_UNKNOWN_NODE',
  E_CYCLE: 'E_CYCLE',
  E_MISSING_INPUT: 'E_MISSING_INPUT',
  E_WRONG_INPUT_KIND: 'E_WRONG_INPUT_KIND',

  // --- geometry ---
  E_INVALID_FOOTPRINT: 'E_INVALID_FOOTPRINT',
  E_EMPTY_RESULT: 'E_EMPTY_RESULT',
  W_MASS_TRUNCATED: 'W_MASS_TRUNCATED',
  W_HOLE_DROPPED: 'W_HOLE_DROPPED',
  W_TINY_FOOTPRINT: 'W_TINY_FOOTPRINT',
  W_CORNER_RADIUS: 'W_CORNER_RADIUS',

  // --- settings that quietly do nothing ---
  // Their own code, because "you changed a control and it had no effect" is the
  // single most confusing thing a generator can do, and it deserves to be
  // findable rather than filed under a node being disabled.
  W_UNUSED_SETTING: 'W_UNUSED_SETTING',

  // --- assets ---
  W_MISSING_ASSET: 'W_MISSING_ASSET',

  // --- info ---
  I_NODE_DISABLED: 'I_NODE_DISABLED',
  I_NODE_UNREACHABLE: 'I_NODE_UNREACHABLE',
};

/**
 * Build one diagnostic.
 *
 * `nodeId` is what lets the editor select and reveal the offending node, which
 * is the difference between a message and a message you can act on.
 */
export function diagnostic(code, severity, message, extra = {}) {
  const out = { code, severity, message: String(message) };
  if (extra.nodeId) out.nodeId = String(extra.nodeId);
  if (extra.hint) out.hint = String(extra.hint);
  if (extra.fix) out.fix = extra.fix;
  if (extra.detail !== undefined) out.detail = extra.detail;
  return out;
}

/** A one-click fix descriptor. Serialisable by construction - see the header. */
export function fix(label, action, args = {}) {
  return { label: String(label), action: String(action), args };
}

/** Collects diagnostics and answers "is this fatal". */
export function createDiagnostics() {
  const items = [];
  return {
    add(entry) {
      items.push(entry);
      return entry;
    },
    error(code, message, extra) {
      return this.add(diagnostic(code, SEVERITY.ERROR, message, extra));
    },
    warn(code, message, extra) {
      return this.add(diagnostic(code, SEVERITY.WARN, message, extra));
    },
    info(code, message, extra) {
      return this.add(diagnostic(code, SEVERITY.INFO, message, extra));
    },
    get all() {
      return items;
    },
    get hasError() {
      return items.some(item => item.severity === SEVERITY.ERROR);
    },
    /** Counts by severity, for a status line. */
    summary() {
      let errors = 0, warnings = 0, infos = 0;
      for (const item of items) {
        if (item.severity === SEVERITY.ERROR) errors++;
        else if (item.severity === SEVERITY.WARN) warnings++;
        else infos++;
      }
      return { errors, warnings, infos, total: items.length };
    },
  };
}

/**
 * Format a metre value for a message.
 *
 * Two decimals, trailing zeros stripped. Rule 2 above is about showing real
 * numbers, and "12.5m" reads as a measurement while "12.500000000000002m" reads
 * as a bug in the tool.
 */
export function metres(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '?';
  return `${Math.round(n * 100) / 100}m`;
}
