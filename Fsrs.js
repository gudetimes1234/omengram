.pragma library

// FSRS-6, the scheduler Anki uses by default, for omengram's own cards.
//
// A port of GleamDrill's fsrs.gleam, which is itself a faithful port of the
// reference py-fsrs (fsrs/scheduler.py). tests/fsrs-vectors.json holds
// py-fsrs's own output for the same inputs (tools/gen_fsrs_vectors.py), so a
// drift from upstream fails a test instead of quietly moving review dates.
//
// Pure: no clock, no randomness. Times are epoch seconds, `now` and the fuzz
// sample are arguments. Plain ES5, so Qt's JS engine and node both run it.

var PARAMETERS = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
  0.1542
]

var DESIRED_RETENTION = 0.9
// Minutes, as py-fsrs counts them.
var LEARNING_STEPS = [1, 10]
var RELEARNING_STEPS = [10]
var MAXIMUM_INTERVAL = 36500

var STABILITY_MIN = 0.001
var MIN_DIFFICULTY = 1.0
var MAX_DIFFICULTY = 10.0
var DAY = 86400

// The card's place in the pipeline, numbered as py-fsrs numbers them.
var LEARNING = 1
var REVIEW = 2
var RELEARNING = 3

// 1 again, 2 hard, 3 good, 4 easy.
var AGAIN = 1
var HARD = 2
var GOOD = 3
var EASY = 4

function config(overrides) {
  var c = {
    parameters: PARAMETERS,
    desiredRetention: DESIRED_RETENTION,
    learningSteps: LEARNING_STEPS,
    relearningSteps: RELEARNING_STEPS,
    maximumInterval: MAXIMUM_INTERVAL,
    fuzz: true
  }
  var o = overrides || {}
  for (var k in o) if (o[k] !== undefined) c[k] = o[k]
  // A parameter list of the wrong length can only come from corrupt input;
  // the defaults beat refusing to schedule.
  if (!c.parameters || c.parameters.length !== 21) c.parameters = PARAMETERS
  return c
}

// Round half to even, like Python's round, which py-fsrs uses everywhere it
// turns a float into days. The fuzz sampler lands on exact halves.
function roundHalfEven(x) {
  var below = Math.floor(x)
  var fraction = x - below
  if (fraction < 0.5) return below
  if (fraction > 0.5) return below + 1
  return below % 2 === 0 ? below : below + 1
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x))
}

function clampStability(s) {
  return Math.max(s, STABILITY_MIN)
}

function clampDifficulty(d) {
  return clamp(d, MIN_DIFFICULTY, MAX_DIFFICULTY)
}

function decay(w) {
  return -w[20]
}

function curveFactor(w) {
  return Math.pow(0.9, 1 / decay(w)) - 1
}

// Whole days, flooring toward negative infinity, as Python's timedelta.days.
function elapsedDays(from, to) {
  return Math.floor((to - from) / DAY)
}

function retrievabilityAfter(cfg, stability, days) {
  var w = cfg.parameters
  return Math.pow(1 + curveFactor(w) * Math.max(0, days) / stability, decay(w))
}

// Probability of recalling the card at `now`; 0 for a card never reviewed.
function retrievability(card, now, cfg) {
  if (!card || card.stability === null || card.stability === undefined || !card.lastReview) return 0
  return retrievabilityAfter(cfg, card.stability, elapsedDays(card.lastReview, now))
}

function initialStability(cfg, rating) {
  return clampStability(cfg.parameters[rating - 1])
}

function initialDifficultyRaw(cfg, rating) {
  var w = cfg.parameters
  return w[4] - Math.exp(w[5] * (rating - 1)) + 1
}

function initialDifficulty(cfg, rating) {
  return clampDifficulty(initialDifficultyRaw(cfg, rating))
}

function nextDifficulty(cfg, difficulty, rating) {
  var w = cfg.parameters
  var delta = -(w[6] * (rating - 3))
  var damped = difficulty + (10 - difficulty) * delta / 9
  // Mean reversion toward a new Easy card's difficulty, unclamped, as upstream.
  var target = initialDifficultyRaw(cfg, EASY)
  return clampDifficulty(w[7] * target + (1 - w[7]) * damped)
}

function shortTermStability(cfg, stability, rating) {
  var w = cfg.parameters
  var increase = Math.exp(w[17] * (rating - 3 + w[18])) * Math.pow(stability, -w[19])
  if (rating !== AGAIN) increase = Math.max(increase, 1)
  return clampStability(stability * increase)
}

function recallStability(cfg, stability, difficulty, r, rating) {
  var w = cfg.parameters
  var hardPenalty = rating === HARD ? w[15] : 1
  var easyBonus = rating === EASY ? w[16] : 1
  return stability * (1 + Math.exp(w[8]) * (11 - difficulty) * Math.pow(stability, -w[9])
                      * (Math.exp((1 - r) * w[10]) - 1) * hardPenalty * easyBonus)
}

function forgetStability(cfg, stability, difficulty, r) {
  var w = cfg.parameters
  var longTerm = w[11] * Math.pow(difficulty, -w[12]) * (Math.pow(stability + 1, w[13]) - 1)
                 * Math.exp((1 - r) * w[14])
  var shortTerm = stability / Math.exp(w[17] * w[18])
  return Math.min(longTerm, shortTerm)
}

function nextStability(cfg, stability, difficulty, r, rating) {
  return clampStability(rating === AGAIN
    ? forgetStability(cfg, stability, difficulty, r)
    : recallStability(cfg, stability, difficulty, r, rating))
}

// Days until recall falls to the desired retention.
function nextIntervalDays(cfg, stability) {
  var w = cfg.parameters
  var days = stability / curveFactor(w) * (Math.pow(cfg.desiredRetention, 1 / decay(w)) - 1)
  return clamp(roundHalfEven(days), 1, cfg.maximumInterval)
}

// +/-15% of the interval between 2.5 and 7 days, 10% to 20, 5% beyond.
var FUZZ_RANGES = [[2.5, 7.0, 0.15], [7.0, 20.0, 0.1], [20.0, 1e18, 0.05]]

function fuzzDays(days, cfg, sample) {
  if (days < 2.5) return days
  var delta = 1
  for (var i = 0; i < FUZZ_RANGES.length; i++) {
    var r = FUZZ_RANGES[i]
    delta += r[2] * Math.max(Math.min(days, r[1]) - r[0], 0)
  }
  var maxIvl = Math.min(roundHalfEven(days + delta), cfg.maximumInterval)
  var minIvl = Math.min(Math.max(roundHalfEven(days - delta), 2), maxIvl)
  // Floored, not rounded, as py-fsrs 6.3 does: the sample is in [0, 1), so
  // flooring gives each day from minIvl to maxIvl an equal share. (GleamDrill's
  // port predates that change and still rounds.)
  return Math.min(Math.floor(sample * (maxIvl - minIvl + 1) + minIvl), cfg.maximumInterval)
}

function minutes(m) {
  return roundHalfEven(m * 60)
}

function minutesAt(steps, i) {
  return i >= 0 && i < steps.length ? steps[i] : 1
}

// Returns [state, step, seconds until due]. step is -1 once in review.
function stepSchedule(cfg, steps, step, rating, stability, inState) {
  var count = steps.length
  var review = [REVIEW, -1, nextIntervalDays(cfg, stability) * DAY]
  if (count === 0 || (step >= count && rating !== AGAIN)) return review
  if (rating === AGAIN) return [inState, 0, minutes(minutesAt(steps, 0))]
  if (rating === HARD) {
    var hard
    if (step === 0 && count === 1) hard = minutes(steps[0] * 1.5)
    else if (step === 0) hard = minutes((steps[0] + steps[1]) / 2)
    else hard = minutes(minutesAt(steps, step))
    return [inState, step, hard]
  }
  if (rating === GOOD) {
    if (step + 1 === count) return review
    return [inState, step + 1, minutes(minutesAt(steps, step + 1))]
  }
  return review
}

// A card here is {state, step, stability, difficulty, due, lastReview}, with
// stability and difficulty null until the first rating. Returns a new card;
// the one passed in is not touched. `sample` in [0, 1) scatters review
// intervals when cfg.fuzz is on.
function review(card, rating, now, cfg, sample) {
  var c = cfg || config()
  var state = card && card.state ? card.state : LEARNING
  var step = card && card.step >= 0 ? card.step : 0
  var hasMemory = card && card.stability !== null && card.stability !== undefined
                  && card.difficulty !== null && card.difficulty !== undefined
  var sameDay = !!(card && card.lastReview) && elapsedDays(card.lastReview, now) < 1

  var s, d
  if (!hasMemory) {
    s = initialStability(c, rating)
    d = initialDifficulty(c, rating)
  } else {
    s = sameDay
      ? shortTermStability(c, card.stability, rating)
      : nextStability(c, card.stability, card.difficulty, retrievability(card, now, c), rating)
    d = nextDifficulty(c, card.difficulty, rating)
  }

  var next
  if (state === LEARNING) next = stepSchedule(c, c.learningSteps, step, rating, s, LEARNING)
  else if (state === RELEARNING) next = stepSchedule(c, c.relearningSteps, step, rating, s, RELEARNING)
  else if (rating === AGAIN && c.relearningSteps.length)
    next = [RELEARNING, 0, minutes(c.relearningSteps[0])]
  else next = [REVIEW, -1, nextIntervalDays(c, s) * DAY]

  var seconds = next[2]
  if (c.fuzz && next[0] === REVIEW && isFinite(sample))
    seconds = fuzzDays(Math.floor(seconds / DAY), c, sample) * DAY

  return {
    state: next[0],
    step: next[1],
    stability: s,
    difficulty: d,
    due: now + seconds,
    lastReview: now
  }
}
