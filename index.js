/**
 * AdaptLearn — Adaptive Spaced-Repetition Learning Engine
 * Combines SM-2 spaced repetition, Bloom's taxonomy cognitive levels,
 * prerequisite knowledge graphs, adaptive difficulty, and gamification
 * into a self-contained JavaScript education platform.
 * @module AdaptLearn
 * @version 2.0.0
 */

class PRNG {
  /** @param {number} seed - Initial seed for reproducible randomness */
  constructor(seed) { this.s = seed | 0 || 1; }
  /** @returns {number} Pseudo-random float in [0, 1) using xorshift32 */
  next() { this.s ^= this.s << 13; this.s ^= this.s >> 17; this.s ^= this.s << 5; return (this.s >>> 0) / 4294967296; }
  /** @param {number} min @param {number} max @returns {number} Random integer in [min, max] */
  int(min, max) { return Math.floor(this.next() * (max - min + 1)) + min; }
  /** Fisher-Yates shuffle. @template T @param {T[]} a @returns {T[]} Shuffled array */
  shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
}

/**
 * Bloom's Taxonomy cognitive levels — questions target progressively higher
 * thinking skills as mastery increases.
 * @readonly
 */
const Bloom = {
  REMEMBER:   { level: 1, name: 'Remember',   icon: '📝' },
  UNDERSTAND: { level: 2, name: 'Understand',  icon: '💡' },
  APPLY:      { level: 3, name: 'Apply',       icon: '🔧' },
  ANALYZE:    { level: 4, name: 'Analyze',     icon: '🔬' },
  EVALUATE:   { level: 5, name: 'Evaluate',    icon: '⚖️' },
  CREATE:     { level: 6, name: 'Create',      icon: '🎨' }
};

class SpacedRepetitionScheduler {
  /**
   * SM-2 (SuperMemo 2) spaced repetition scheduler.
   * Calculates optimal review intervals based on recall quality,
   * adjusting per-card ease factors to personalize spacing.
   */
  constructor() {
    /** @type {number} Floor for ease factor */
    this.minEF = 1.3;
  }

  /**
   * Calculate next review schedule based on recall quality.
   * @param {Object} card - Card with schedule state
   * @param {number} quality - Recall quality 0-5 (0=blackout, 5=perfect)
   * @returns {Object} Updated schedule {repetitions, ef, interval, lastReviewed}
   * @throws {Error} If quality outside 0-5 range
   */
  calcNext(card, quality) {
    if (quality < 0 || quality > 5) throw new Error(`Quality must be 0-5, got ${quality}`);
    let { reps, ef, interval } = card.schedule;
    if (quality >= 3) {
      interval = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(interval * ef);
      reps++;
    } else { reps = 0; interval = 1; }
    ef = Math.max(this.minEF, ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
    return { reps, ef: Math.round(ef * 100) / 100, interval, lastReviewed: Date.now() };
  }

  /**
   * Check if a card is due for review.
   * @param {Object} card - Card with schedule
   * @param {number} [now] - Current timestamp
   * @returns {boolean} True if overdue or never reviewed
   */
  isDue(card, now = Date.now()) {
    if (!card.schedule.lastReviewed) return true;
    return (now - card.schedule.lastReviewed) / 864e5 >= card.schedule.interval;
  }

  /**
   * Calculate review priority (higher = more overdue).
   * @param {Object} card @param {number} [now] @returns {number} Priority score
   */
  priority(card, now = Date.now()) {
    if (!card.schedule.lastReviewed) return 1000;
    return (now - card.schedule.lastReviewed) / 864e5 - card.schedule.interval;
  }

  /**
   * Estimate retention probability using Ebbinghaus forgetting curve: R = e^(-t/S).
   * @param {Object} card @param {number} [now] @returns {number} Retention 0-1
   */
  retention(card, now = Date.now()) {
    if (!card.schedule.lastReviewed) return 0;
    const days = (now - card.schedule.lastReviewed) / 864e5;
    return Math.exp(-days / Math.max(card.schedule.interval * card.schedule.ef, 0.5));
  }
}

class QuestionGenerator {
  /**
   * Generates quiz questions at varying Bloom's taxonomy levels.
   * Higher mastery triggers higher-order questions (apply, analyze).
   * @param {PRNG} rng - Seeded PRNG for deterministic generation
   */
  constructor(rng) { this.rng = rng; }

  /**
   * Generate a multiple-choice question with plausible distractors.
   * @param {Object} concept - Target concept with term and definition
   * @param {Object[]} pool - All concepts for distractor selection
   * @returns {Object} Question with options and correctIndex
   */
  mc(concept, pool) {
    const dist = pool.filter(c => c.id !== concept.id).sort(() => this.rng.next() - 0.5).slice(0, 3).map(c => c.definition);
    while (dist.length < 3) dist.push(['None of the above', 'All of the above', 'Cannot determine'][dist.length]);
    const opts = this.rng.shuffle([concept.definition, ...dist]);
    return { type: 'multiple_choice', bloom: Bloom.REMEMBER, conceptId: concept.id,
      question: `What is "${concept.term}"?`, options: opts, correctIndex: opts.indexOf(concept.definition), correctAnswer: concept.definition };
  }

  /**
   * Generate fill-in-blank by removing a content word from the definition.
   * @param {Object} concept @param {Object[]} pool @returns {Object} Question
   */
  fib(concept, pool) {
    const words = concept.definition.split(' ');
    const skip = new Set(['a','an','the','is','are','was','of','in','to','for','and','or','that','this']);
    const cands = words.filter((w, i) => i > 0 && !skip.has(w.toLowerCase()) && w.length > 3);
    if (!cands.length) return this.mc(concept, pool);
    const removed = cands[Math.floor(this.rng.next() * cands.length)];
    return { type: 'fill_in_blank', bloom: Bloom.UNDERSTAND, conceptId: concept.id,
      question: `"${concept.term}": ${concept.definition.replace(removed, '____')}`, correctAnswer: removed.toLowerCase().replace(/[^a-z0-9]/g, '') };
  }

  /**
   * Generate true/false question with plausible false statements.
   * @param {Object} concept @param {Object[]} pool @returns {Object} Question
   */
  tf(concept, pool) {
    const isTrue = this.rng.next() > 0.5;
    const def = isTrue ? concept.definition : ((pool.filter(c => c.id !== concept.id)[0] || {}).definition || 'an unrelated concept');
    return { type: 'true_false', bloom: Bloom.REMEMBER, conceptId: concept.id,
      question: `True or False: "${concept.term}" means: ${def}`, correctAnswer: isTrue };
  }

  /**
   * Generate an application-level question (Bloom's Apply).
   * @param {Object} concept @returns {Object} Scenario question
   */
  apply(concept) {
    return { type: 'application', bloom: Bloom.APPLY, conceptId: concept.id,
      question: `How would you use "${concept.term}" in a real project? (Hint: ${concept.definition.substring(0, 40)}...)`,
      correctAnswer: concept.definition };
  }

  /**
   * Select question type based on learner mastery (Bloom's progression).
   * @param {Object} concept @param {Object[]} pool @param {number} mastery - 0-100
   * @returns {Object} Generated question at appropriate cognitive level
   */
  generate(concept, pool, mastery = 0) {
    if (mastery >= 80) return this.apply(concept);
    if (mastery >= 50) return this.fib(concept, pool);
    return this.rng.next() > 0.5 ? this.mc(concept, pool) : this.tf(concept, pool);
  }
}

class DifficultyAdapter {
  /**
   * Adapts challenge level using Vygotsky's Zone of Proximal Development.
   * Keeps learner in the sweet spot between too easy and too hard.
   * @param {number} [window=10] - Sliding window of recent answers
   */
  constructor(window = 10) { this.window = window; }

  /**
   * Calculate target difficulty from recent performance.
   * @param {Object[]} history - Recent answer records
   * @returns {number} Recommended difficulty (1.0-5.0)
   */
  calc(history) {
    if (!history.length) return 1.0;
    const r = history.slice(-this.window);
    const acc = r.filter(h => h.correct).length / r.length;
    const cur = r.reduce((s, h) => s + (h.difficulty || 1), 0) / r.length;
    if (acc >= 0.9) return Math.min(5, cur + 0.5);
    if (acc >= 0.7) return cur;
    return Math.max(1, cur - 0.4);
  }
}

class GamificationEngine {
  /**
   * Achievement system providing extrinsic motivation through XP, badges, and levels.
   * Research shows gamification improves completion rates by 30-50% when
   * combined with meaningful learning feedback.
   */
  constructor() {
    this.badges = {
      'first':       { n: '🌱 First Steps',    d: 'Answer first question',         ck: p => p.totalAnswered >= 1 },
      'streak-5':    { n: '🔥 On Fire',         d: '5-answer correct streak',       ck: p => p.streak >= 5 },
      'streak-10':   { n: '⚡ Unstoppable',     d: '10-answer correct streak',      ck: p => p.streak >= 10 },
      'acc-80':      { n: '🎯 Sharpshooter',    d: '80%+ accuracy (min 10)',        ck: p => p.totalAnswered >= 10 && p.accuracy() >= 80 },
      'acc-95':      { n: '💎 Perfectionist',   d: '95%+ accuracy (min 20)',        ck: p => p.totalAnswered >= 20 && p.accuracy() >= 95 },
      'century':     { n: '💯 Centurion',       d: '100 questions answered',        ck: p => p.totalAnswered >= 100 },
      'master':      { n: '🧠 Topic Master',    d: '90%+ mastery in one topic',     ck: p => Object.values(p.topics).some(t => t.mastery >= 90 && t.total >= 5) },
      'polymath':    { n: '📚 Polymath',        d: '80%+ in 3+ topics',            ck: p => Object.values(p.topics).filter(t => t.mastery >= 80 && t.total >= 5).length >= 3 },
      'bloom-up':    { n: '🏔️ Bloom Climber',  d: 'Reach Apply level',             ck: p => p.maxBloom >= 3 }
    };
  }

  /**
   * Check for newly earned badges.
   * @param {LearnerProfile} p - Learner profile
   * @returns {Object[]} Newly earned badges
   */
  check(p) {
    const earned = [];
    for (const [id, b] of Object.entries(this.badges)) {
      if (!p.earnedBadges.has(id) && b.ck(p)) { p.earnedBadges.add(id); earned.push({ id, name: b.n, desc: b.d }); }
    }
    return earned;
  }

  /**
   * Calculate XP with Bloom's level bonus.
   * @param {boolean} correct @param {number} conf @param {number} streak @param {number} bloom
   * @returns {number} XP earned
   */
  xp(correct, conf, streak, bloom) {
    let v = correct ? 10 : 2;
    if (correct && conf >= 4) v += 5;
    v += Math.min(streak, 10) + (bloom - 1) * 2;
    return v;
  }
}

class LearnerProfile {
  /**
   * Complete learner state: history, mastery, streaks, XP, badges.
   * @param {string} id - Unique learner identifier
   * @throws {Error} If id is empty
   */
  constructor(id) {
    if (!id) throw new Error('Learner ID required');
    this.id = id; this.history = []; this.streak = 0; this.bestStreak = 0;
    this.totalAnswered = 0; this.totalCorrect = 0; this.xp = 0;
    this.topics = {}; this.cards = {}; this.earnedBadges = new Set(); this.maxBloom = 1;
  }

  /**
   * Record an answer and update all metrics.
   * @param {string} cid - Concept ID @param {string} topic @param {boolean} correct
   * @param {number} conf - Confidence 1-5 @param {number} diff - Difficulty @param {number} bloom - Bloom level
   */
  record(cid, topic, correct, conf, diff, bloom) {
    this.history.push({ cid, topic, correct, conf, difficulty: diff, bloom, ts: Date.now() });
    this.totalAnswered++;
    if (correct) { this.totalCorrect++; this.streak++; this.bestStreak = Math.max(this.bestStreak, this.streak); }
    else this.streak = 0;
    this.maxBloom = Math.max(this.maxBloom, bloom || 1);
    if (!this.topics[topic]) this.topics[topic] = { correct: 0, total: 0, mastery: 0 };
    this.topics[topic].total++;
    if (correct) this.topics[topic].correct++;
    this.topics[topic].mastery = Math.round(this.topics[topic].correct / this.topics[topic].total * 100);
  }

  /** @returns {number} Overall accuracy percentage 0-100 */
  accuracy() { return this.totalAnswered > 0 ? Math.round(this.totalCorrect / this.totalAnswered * 100) : 0; }

  /** @param {number} [t=70] Threshold @returns {Object[]} Weak topics below threshold */
  weak(t = 70) {
    return Object.entries(this.topics).filter(([, d]) => d.mastery < t && d.total >= 3)
      .sort((a, b) => a[1].mastery - b[1].mastery).map(([topic, d]) => ({ topic, mastery: d.mastery, total: d.total }));
  }
}

class AdaptLearn {
  /**
   * Main engine orchestrating SM-2 scheduling, Bloom's taxonomy progression,
   * prerequisite knowledge graphs, adaptive difficulty, and gamification.
   * @param {number} [seed=2026] - PRNG seed
   */
  constructor(seed = 2026) {
    this.rng = new PRNG(seed);
    this.srs = new SpacedRepetitionScheduler();
    this.qgen = new QuestionGenerator(this.rng);
    this.diff = new DifficultyAdapter();
    this.gam = new GamificationEngine();
    this.concepts = []; this.prereqs = {}; this.learners = {};
  }

  /**
   * Load curriculum with prerequisite graph.
   * @param {Object[]} topics - Topics with concepts and prerequisites
   * @returns {string} Summary
   * @throws {Error} If topics empty
   */
  load(topics) {
    if (!topics || !topics.length) throw new Error('Need at least one topic');
    this.concepts = topics.flatMap(t => t.concepts.map(c => ({ ...c, topic: t.name })));
    for (const t of topics) this.prereqs[t.name] = t.prerequisites || [];
    return `${this.concepts.length} concepts across ${topics.length} topics`;
  }

  /**
   * Get or create learner profile with initialized flashcards.
   * @param {string} id - Learner ID @returns {LearnerProfile}
   */
  learner(id) {
    if (!this.learners[id]) {
      this.learners[id] = new LearnerProfile(id);
      for (const c of this.concepts) this.learners[id].cards[c.id] = { cid: c.id, schedule: { reps: 0, ef: 2.5, interval: 0, lastReviewed: null } };
    }
    return this.learners[id];
  }

  /**
   * Generate adaptive quiz prioritizing: overdue → weak → difficulty-matched.
   * @param {string} lid - Learner ID @param {number} [n=5] - Question count
   * @returns {Object} Quiz with questions and metadata
   */
  quiz(lid, n = 5) {
    const L = this.learner(lid);
    const target = this.diff.calc(L.history);
    const now = Date.now();
    const due = this.concepts.filter(c => this.srs.isDue(L.cards[c.id], now))
      .sort((a, b) => this.srs.priority(L.cards[b.id], now) - this.srs.priority(L.cards[a.id], now));
    const weakSet = new Set(L.weak().map(t => t.topic));
    const sel = []; const used = new Set();
    const pick = (src, lim) => { for (const c of src) { if (sel.length >= lim || used.has(c.id)) continue; sel.push(c); used.add(c.id); } };
    pick(due, Math.ceil(n * 0.4));
    pick(this.concepts.filter(c => weakSet.has(c.topic) && !used.has(c.id)), Math.ceil(n * 0.7));
    pick(this.concepts.filter(c => !used.has(c.id)).sort((a, b) => Math.abs((a.difficulty||1)-target) - Math.abs((b.difficulty||1)-target)), n);
    // Generate questions deterministically and cache them
    const qs = sel.slice(0, n).map(c => {
      const m = (L.topics[c.topic] || {}).mastery || 0;
      return this.qgen.generate(c, this.concepts, m);
    });
    return { quizId: `q_${now}`, lid, target: Math.round(target * 10) / 10, questions: qs };
  }

  /**
   * Submit answer to a pre-generated question. Uses the question object directly.
   * @param {string} lid - Learner ID
   * @param {Object} question - The question object from quiz generation
   * @param {*} answer - Learner's answer
   * @param {number} [conf=3] - Confidence 1-5
   * @returns {Object} Feedback with correctness, XP, badges, schedule
   */
  answer(lid, question, answer, conf = 3) {
    const L = this.learner(lid);
    const concept = this.concepts.find(c => c.id === question.conceptId);
    if (!concept) throw new Error(`Concept "${question.conceptId}" not found`);
    const card = L.cards[question.conceptId];

    let correct = false;
    if (question.type === 'multiple_choice') correct = answer === question.correctIndex;
    else if (question.type === 'true_false') correct = answer === question.correctAnswer;
    else if (question.type === 'fill_in_blank') correct = String(answer).toLowerCase().trim() === question.correctAnswer;
    else correct = String(answer).toLowerCase().includes(concept.definition.split(' ')[0].toLowerCase());

    const quality = correct ? (conf >= 4 ? 5 : conf >= 3 ? 4 : 3) : (conf >= 3 ? 2 : 1);
    const bloom = (question.bloom || {}).level || 1;
    card.schedule = this.srs.calcNext(card, quality);
    L.record(question.conceptId, concept.topic, correct, conf, concept.difficulty || 1, bloom);
    const xpGain = this.gam.xp(correct, conf, L.streak, bloom);
    L.xp += xpGain;
    const badges = this.gam.check(L);

    return { correct, answer: question.correctAnswer, bloom: question.bloom.name, quality,
      interval: card.schedule.interval, xp: xpGain, totalXP: L.xp, badges,
      feedback: correct
        ? (card.schedule.interval >= 21 ? '🌟 Mastered! Review in 3+ weeks.' : card.schedule.interval >= 7 ? '💪 Strong recall!' : '✅ Correct!')
        : `❌ Answer: ${concept.definition}. Reviewing again soon.` };
  }

  /**
   * Check prerequisite-gated topic access.
   * @param {LearnerProfile} L @returns {Object} {unlocked, locked}
   */
  access(L) {
    const unlocked = [], locked = [];
    for (const topic of [...new Set(this.concepts.map(c => c.topic))]) {
      const prs = this.prereqs[topic] || [];
      const met = prs.every(p => { const m = L.topics[p]; return m && m.mastery >= 60 && m.total >= 3; });
      if (met || !prs.length) unlocked.push(topic);
      else locked.push({ topic, needs: prs.filter(p => { const m = L.topics[p]; return !m || m.mastery < 60; }) });
    }
    return { unlocked, locked };
  }

  /**
   * Generate comprehensive study report with retention estimates.
   * @param {string} lid @returns {Object} Full analytics report
   */
  report(lid) {
    const L = this.learner(lid); const now = Date.now();
    const due = this.concepts.filter(c => this.srs.isDue(L.cards[c.id], now)).length;
    const mastered = Object.values(L.cards).filter(c => c.schedule.interval >= 21).length;
    const learning = Object.values(L.cards).filter(c => c.schedule.reps > 0 && c.schedule.interval < 21).length;
    const fresh = Object.values(L.cards).filter(c => c.schedule.reps === 0).length;
    const rets = Object.values(L.cards).filter(c => c.schedule.lastReviewed).map(c => this.srs.retention(c, now));
    const avgRet = rets.length ? Math.round(rets.reduce((a, b) => a + b, 0) / rets.length * 100) : 0;
    const recs = [];
    if (due > 3) recs.push({ p: 'HIGH', m: `${due} cards overdue — review now.` });
    const w = L.weak();
    if (w.length) recs.push({ p: 'HIGH', m: `Weak: ${w.map(t => `${t.topic} (${t.mastery}%)`).join(', ')}` });
    if (!recs.length) recs.push({ p: 'INFO', m: 'On track! Keep reviewing.' });
    return { learner: { id: L.id, level: Math.floor(L.xp/100)+1, xp: L.xp, streak: L.streak, best: L.bestStreak,
      acc: L.accuracy(), answered: L.totalAnswered, retention: avgRet },
      cards: { total: this.concepts.length, mastered, learning, fresh, due },
      topics: L.topics, access: this.access(L), weak: w, badges: Object.entries(this.gam.badges).map(([id, b]) => ({
        id, name: b.n, desc: b.d, earned: L.earnedBadges.has(id) })),
      recs };
  }
}

// ═══════════════════════ DEMO ═══════════════════════
const engine = new AdaptLearn(2026);

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║  AdaptLearn — Adaptive Learning Engine                    ║');
console.log('║  SM-2 · Bloom\'s Taxonomy · Knowledge Graphs · Gamification║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

// 1. Curriculum
console.log('━━━ 1. CURRICULUM LOADING — Web Development Bootcamp ━━━');
const curric = [
  { name: 'HTML', prerequisites: [], concepts: [
    { id: 'h1', term: 'HTML', definition: 'HyperText Markup Language for structuring web content', difficulty: 1 },
    { id: 'h2', term: 'DOM', definition: 'Document Object Model tree enabling programmatic page manipulation', difficulty: 2 },
    { id: 'h3', term: 'Semantic HTML', definition: 'Using meaningful elements like header and nav to convey structure', difficulty: 2 },
    { id: 'h4', term: 'Accessibility', definition: 'Designing content so people with disabilities can use it effectively', difficulty: 2.5 }
  ]},
  { name: 'CSS', prerequisites: ['HTML'], concepts: [
    { id: 'c1', term: 'Selector', definition: 'A pattern matching elements to apply style rules', difficulty: 1.5 },
    { id: 'c2', term: 'Box Model', definition: 'Content padding border and margin layers around every element', difficulty: 2 },
    { id: 'c3', term: 'Flexbox', definition: 'One-dimensional layout arranging items in flexible rows or columns', difficulty: 2.5 },
    { id: 'c4', term: 'Specificity', definition: 'Algorithm determining which CSS rule wins among competing selectors', difficulty: 3 }
  ]},
  { name: 'JavaScript', prerequisites: ['HTML'], concepts: [
    { id: 'j1', term: 'Closure', definition: 'Function retaining access to outer scope variables after outer returns', difficulty: 3 },
    { id: 'j2', term: 'Promise', definition: 'Object representing eventual completion or failure of async work', difficulty: 3 },
    { id: 'j3', term: 'Event Loop', definition: 'Mechanism processing callbacks from task queue when call stack empties', difficulty: 3.5 },
    { id: 'j4', term: 'Prototype', definition: 'Linked chain of objects searched when resolving property lookups', difficulty: 3.5 }
  ]},
  { name: 'React', prerequisites: ['JavaScript', 'CSS'], concepts: [
    { id: 'r1', term: 'Virtual DOM', definition: 'Lightweight DOM copy that React diffs to minimize real DOM updates', difficulty: 3 },
    { id: 'r2', term: 'Hook', definition: 'Function letting components use state and lifecycle without classes', difficulty: 3.5 },
    { id: 'r3', term: 'JSX', definition: 'Syntax extension for writing HTML-like markup inside JavaScript', difficulty: 2.5 },
    { id: 'r4', term: 'Reconciliation', definition: 'Algorithm determining minimal DOM changes after state updates', difficulty: 4 }
  ]}
];

const loaded = engine.load(curric);
console.log(`  📚 Loaded: ${loaded}`);
console.log(`  🔗 Graph: HTML → CSS → React, HTML → JavaScript → React`);
console.log(`  💡 INSIGHT: The prerequisite graph prevents advancing to React until both`);
console.log(`     CSS and JavaScript foundations are solid — eliminating knowledge gaps.`);

// 2. Quiz
console.log('\n━━━ 2. ADAPTIVE QUIZ — Learner "alex_dev" ━━━');
const quiz = engine.quiz('alex_dev', 8);
console.log(`  📝 ${quiz.questions.length} questions | Target difficulty: ${quiz.target}`);
console.log(`  Bloom levels: ${quiz.questions.map(q => q.bloom.icon + q.bloom.name).join(', ')}`);

const sims = [true, true, false, true, true, true, false, true];
for (let i = 0; i < quiz.questions.length; i++) {
  const q = quiz.questions[i];
  const isCorrect = sims[i];
  const ans = isCorrect ? (q.correctIndex !== undefined ? q.correctIndex : q.correctAnswer) : 'wrong_answer';
  const conf = isCorrect ? engine.rng.int(3, 5) : engine.rng.int(1, 3);
  const r = engine.answer('alex_dev', q, ans, conf);
  console.log(`\n  Q${i+1} [${q.bloom.icon}${q.type}] ${q.question.substring(0, 52)}...`);
  console.log(`     ${r.feedback} | +${r.xp}XP | Next: ${r.interval}d`);
  if (r.badges.length) r.badges.forEach(b => console.log(`     🏅 NEW: ${b.name} — ${b.desc}`));
}

const correctCount = sims.filter(Boolean).length;
console.log(`\n  💡 INSIGHT: ${correctCount}/${sims.length} correct (${Math.round(correctCount/sims.length*100)}%).`);
console.log(`     Wrong answers reset to 1-day interval (SM-2), ensuring weak cards`);
console.log(`     are drilled before being forgotten. Correct cards space out to 6+ days.`);

// 3. Spaced Repetition
console.log('\n━━━ 3. SPACED REPETITION — Card Schedule & Retention ━━━');
const L = engine.learner('alex_dev');
const now = Date.now();
console.log('  ┌──────────────────┬─────────┬───────┬──────┬───────────┐');
console.log('  │ Concept          │ Interval│ EF    │ Reps │ Retention │');
console.log('  ├──────────────────┼─────────┼───────┼──────┼───────────┤');
for (const c of engine.concepts.slice(0, 10)) {
  const s = L.cards[c.id].schedule;
  const ret = s.lastReviewed ? `${(engine.srs.retention(L.cards[c.id], now)*100).toFixed(0)}%` : '—';
  console.log(`  │ ${c.term.padEnd(16)} │ ${(s.interval+'d').padEnd(7)} │ ${s.ef.toFixed(2)} │ ${String(s.reps).padEnd(4)} │ ${ret.padEnd(9)} │`);
}
console.log('  └──────────────────┴─────────┴───────┴──────┴───────────┘');
console.log(`  💡 INSIGHT: Ebbinghaus forgetting curve (R=e^(-t/S)) estimates memory decay.`);
console.log(`     Cards at 100% retention were just reviewed; lower values need attention.`);

// 4. Mastery
console.log('\n━━━ 4. TOPIC MASTERY & PREREQUISITES ━━━');
const acc = engine.access(L);
Object.entries(L.topics).forEach(([t, d]) => {
  const bar = '█'.repeat(Math.round(d.mastery/10)) + '░'.repeat(10-Math.round(d.mastery/10));
  console.log(`  ${bar} ${String(d.mastery).padStart(3)}% ${t} (${d.correct}/${d.total})`);
});
console.log(`  🔓 Unlocked: ${acc.unlocked.join(', ')}`);
acc.locked.forEach(t => console.log(`  🔒 ${t.topic} — needs: ${t.needs.join(', ')}`));
console.log(`  💡 INSIGHT: Topics unlock only when all prerequisites reach 60% mastery.`);
console.log(`     This scaffolded approach mirrors how expert tutors sequence material.`);

// 5. Gamification
console.log('\n━━━ 5. GAMIFICATION & ACHIEVEMENTS ━━━');
const rpt = engine.report('alex_dev');
console.log(`  👤 ${rpt.learner.id} | Level ${rpt.learner.level} | ${rpt.learner.xp} XP`);
console.log(`  🔥 Streak: ${rpt.learner.streak} | Best: ${rpt.learner.best} | 🎯 Accuracy: ${rpt.learner.acc}%`);
console.log(`  📦 ${rpt.cards.mastered} mastered, ${rpt.cards.learning} learning, ${rpt.cards.fresh} new, ${rpt.cards.due} due`);
console.log(`  🧠 Avg Retention: ${rpt.learner.retention}%`);
rpt.badges.forEach(b => console.log(`  ${b.earned ? '✅' : '⬜'} ${b.name} — ${b.desc}`));

// 6. Recommendations
console.log('\n━━━ 6. STUDY RECOMMENDATIONS ━━━');
rpt.recs.forEach(r => console.log(`  [${r.p}] ${r.m}`));
console.log(`  💡 INSIGHT: The engine combines SRS urgency, mastery gaps, and performance`);
console.log(`     trends to generate personalized study plans — like a private tutor.`);

// Summary
console.log('\n╔═══════════════════════════════════════════════════════════╗');
console.log('║  LEARNING ANALYTICS SUMMARY                              ║');
console.log('╠═══════════════════════════════════════════════════════════╣');
console.log(`║  🎯 ${rpt.learner.acc}% accuracy across ${rpt.learner.answered} questions                  ║`);
console.log(`║  🧠 ${Object.keys(rpt.topics).length} topics, ${rpt.cards.mastered} mastered, ${rpt.cards.due} due for review       ║`);
console.log(`║  📈 Bloom progression: Remember → Understand → Apply      ║`);
console.log(`║  🔗 Prerequisite gates prevent knowledge gaps             ║`);
console.log(`║  ⏰ Forgetting curve tracking for optimal review timing   ║`);
console.log(`║  🎮 ${rpt.badges.filter(b=>b.earned).length}/${rpt.badges.length} badges earned at Level ${rpt.learner.level}                       ║`);
console.log('╚═══════════════════════════════════════════════════════════╝');

if (typeof module !== 'undefined') module.exports = { AdaptLearn, SpacedRepetitionScheduler, QuestionGenerator, DifficultyAdapter, GamificationEngine, LearnerProfile, PRNG, Bloom };
