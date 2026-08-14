// parser.js — forgiving rule-based workout parser.
// Turns messy pasted notes into { name, exercises:[...] }.
//
// Exercise shape:
//   { id, name, cue, setGroups:[{ label, sets, inferred }], supersetId }
//   - setGroups length 1 = normal exercise
//   - setGroups length >1 = split implement ("2 sets cable - 2 sets dumbbell")
//   - supersetId (non-null) pairs exercises that alternate
//   - cue = free text shown under the name during a workout
//
// Wrapped in an IIFE so internal names stay private (classic scripts share one
// global scope — leaking these would collide with app.js).
(function () {

const DEFAULT_SETS = 3;

// Match a set count in a fragment: "4 sets", "3 set", "sets: 3", "4x"
function extractSets(str) {
  if (!str) return null;
  let m = str.match(/(\d+)\s*(?:x\s*)?sets?\b/i);
  if (m) return parseInt(m[1], 10);
  m = str.match(/\bsets?\s*[:=]?\s*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

function hasSetCount(str) {
  return extractSets(str) !== null;
}

// Strip the "N sets" token from a fragment, leaving the implement label.
// "2 sets cable" -> "cable" ; "4 sets" -> "" ; "dumbbell 3 sets" -> "dumbbell"
function labelFromSetFragment(frag) {
  return frag
    .replace(/(\d+)\s*(?:x\s*)?sets?\b/i, ' ')
    .replace(/\bsets?\s*[:=]?\s*(\d+)/i, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

let _id = 0;
function uid(prefix) {
  _id += 1;
  return `${prefix}_${Date.now().toString(36)}_${_id}`;
}

// Parse a single non-header exercise line into name / setGroups / cue.
function parseExerciseLine(line) {
  const frags = line
    .split(/\s+-\s+/)
    .map((f) => f.trim())
    .filter((f) => f.length);

  let name = null;
  const setGroups = [];
  const cues = [];

  frags.forEach((frag, i) => {
    const sets = extractSets(frag);
    if (i === 0 && sets === null) {
      name = frag; // first fragment with no count = the exercise name
      return;
    }
    if (sets !== null) {
      const label = labelFromSetFragment(frag);
      setGroups.push({ label: label || null, sets });
    } else {
      cues.push(frag); // any other non-count fragment = a cue
    }
  });

  if (name === null) name = 'Exercise';

  const hasOwnSets = setGroups.length > 0;
  const groups = hasOwnSets
    ? setGroups.map((g) => ({ ...g, inferred: false }))
    : [{ label: null, sets: DEFAULT_SETS, inferred: true }];

  return {
    id: uid('ex'),
    name,
    cue: cues.join(' · '),
    setGroups: groups,
    supersetId: null,
    _hasOwnSets: hasOwnSets,
  };
}

function parseWorkout(text) {
  const lines = (text || '').split(/\r?\n/);
  const result = { name: null, exercises: [] };
  let supersetSeq = 0;
  let currentSuperset = null; // { id, sets }

  for (const raw of lines) {
    const line = raw.trim();

    if (line === '') {
      currentSuperset = null; // blank line closes an open superset
      continue;
    }

    // Superset header: "superset: 3 sets"
    if (/^superset\b/i.test(line)) {
      supersetSeq += 1;
      currentSuperset = {
        id: `ss_${supersetSeq}`,
        sets: extractSets(line) ?? DEFAULT_SETS,
      };
      continue;
    }

    // Workout title: first meaningful line with no set count, before any exercise.
    if (result.name === null && !currentSuperset && !hasSetCount(line)) {
      result.name = line;
      continue;
    }

    const ex = parseExerciseLine(line);

    if (currentSuperset) {
      if (ex._hasOwnSets) {
        // A line with its own set count ends the superset and stands alone.
        currentSuperset = null;
      } else {
        // Superset member: inherit the group's set count.
        ex.supersetId = currentSuperset.id;
        ex.setGroups = [{ label: null, sets: currentSuperset.sets, inferred: false }];
      }
    }

    delete ex._hasOwnSets;
    result.exercises.push(ex);
  }

  if (result.name === null) result.name = 'Imported Workout';
  return result;
}

// Total working sets across all groups.
function totalSets(ex) {
  return ex.setGroups.reduce((n, g) => n + (parseInt(g.sets, 10) || 0), 0);
}

// Expose (works both as ES import and plain <script>).
if (typeof window !== 'undefined') {
  window.WorkoutParser = { parseWorkout, totalSets, extractSets, uid, DEFAULT_SETS };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseWorkout, totalSets, extractSets, DEFAULT_SETS };
}

})();
