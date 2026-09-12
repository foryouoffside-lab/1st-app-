const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual component callbacks with deferred network responses.
// No Firebase connection, accounts, or live queue writes are involved.
function initializer(file, name) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  let result;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) result = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(result, `Missing callback ${name}`);
  return result;
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

const arena = 'app/challenge/ChallengeArenaClient.js';
const drill = { slug: 'cognitive/attention/multi-tasking', name: 'Multi-Tasking' };
function setup(overrides = {}) {
  const timers = new Map();
  let timerId = 0;
  const calls = { sends: 0, withdrawals: [], routes: [] };
  const context = {
    console, Promise,
    user: { uid: 'a' }, db: {},
    router: { push: path => calls.routes.push(path) },
    matchmakingEiqRange: () => 300,
    scanForMatch: async () => ({ uid: 'b' }),
    sendChallenge: async () => { calls.sends++; return 'match-1'; },
    joinMatchmakingQueue: async () => {},
    leaveMatchmakingQueue: async () => {},
    refreshMatchmakingQueue: async () => {},
    withdrawChallenge: async id => { calls.withdrawals.push(id); return true; },
    withConnectionTimeout: promise => promise,
    setInterval: fn => { timers.set(++timerId, { type: 'interval', fn }); return timerId; },
    setTimeout: fn => { timers.set(++timerId, { type: 'timeout', fn }); return timerId; },
    clearInterval: id => timers.delete(id), clearTimeout: id => timers.delete(id),
    renderMatchmakingState: () => {}, setMatchmakingDrill: () => {},
    setMatchmakingSeconds: () => {}, setOfflineNotice: () => {}, alert: () => {},
    MATCHMAKING_POLL_MS: 4000, MATCHMAKING_TAKEOVER_MS: 2000, MATCH_ACCEPT_TIMEOUT_MS: 15000,
    ...overrides,
  };
  for (const name of ['matchmakingPollRef', 'matchmakingTickRef', 'matchmakingTimeoutRef', 'matchmakingHeartbeatRef', 'matchmakingTakeoverRef', 'matchedChallengeIdRef', 'matchmakingScanRef']) context[name] = { current: null };
  context.matchmakingStateRef = { current: 'idle' };
  context.matchmakingSessionRef = { current: 0 };
  context.matchmakingElapsedRef = { current: 0 };
  vm.createContext(context);
  for (const name of ['setMatchmakingState', 'stopMatchmakingTimers', 'cancelMatchmaking', 'attemptMatchmakingScan', 'startMatchmaking']) {
    vm.runInContext(`globalThis.${name} = ${initializer(arena, name)}`, context);
  }
  return { context, timers, calls };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('an immediate match leaves only its accept timeout, no queue polling', async () => {
  const { context: c, timers, calls } = setup();
  await c.startMatchmaking(drill);
  await flush();
  assert.equal(c.matchmakingStateRef.current, 'found');
  assert.equal(calls.sends, 1);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].type, 'timeout');
});

test('cancel during queue join cannot restart timers', async () => {
  const join = deferred();
  const { context: c, timers, calls } = setup({ joinMatchmakingQueue: () => join.promise });
  const starting = c.startMatchmaking(drill);
  await c.cancelMatchmaking();
  join.resolve();
  await starting;
  assert.equal(c.matchmakingStateRef.current, 'idle');
  assert.equal(timers.size, 0);
  assert.equal(calls.sends, 0);
});

test('concurrent scans are serialized and a cancelled response is ignored', async () => {
  const scan = deferred();
  let scans = 0;
  const { context: c, calls } = setup({ scanForMatch: () => { scans++; return scan.promise; } });
  c.setMatchmakingState('searching');
  const first = c.attemptMatchmakingScan(drill);
  await c.attemptMatchmakingScan(drill);
  assert.equal(scans, 1);
  await c.cancelMatchmaking();
  scan.resolve({ uid: 'b' });
  await first;
  assert.equal(calls.sends, 0);
});

test('an invite that finishes after cancellation is withdrawn', async () => {
  const send = deferred();
  const { context: c, calls, timers } = setup({ sendChallenge: () => send.promise });
  c.setMatchmakingState('searching');
  const pending = c.attemptMatchmakingScan(drill);
  await flush();
  await c.cancelMatchmaking();
  send.resolve('late-match');
  await pending;
  assert.deepEqual(calls.withdrawals, ['late-match']);
  assert.equal(c.matchmakingStateRef.current, 'idle');
  assert.equal(timers.size, 0);
});

test('a previous search response cannot replace a newer search', async () => {
  const scan = deferred();
  const { context: c, calls } = setup({ scanForMatch: () => scan.promise });
  c.setMatchmakingState('searching');
  const old = c.attemptMatchmakingScan(drill);
  await c.cancelMatchmaking();
  c.matchmakingSessionRef.current++;
  c.setMatchmakingState('searching');
  scan.resolve({ uid: 'b' });
  await old;
  assert.equal(calls.sends, 0);
  assert.equal(c.matchmakingStateRef.current, 'searching');
});

test('queue deletion never blocks showing a found match', async () => {
  const { context: c } = setup({ leaveMatchmakingQueue: () => new Promise(() => {}) });
  c.setMatchmakingState('searching');
  await c.attemptMatchmakingScan(drill);
  assert.equal(c.matchmakingStateRef.current, 'found');
});

test('a failed withdrawal cannot route into a declined match', async () => {
  const { context: c, timers, calls } = setup({
    withdrawChallenge: async () => false,
    doc: () => ({}),
    getDoc: async () => ({ exists: () => true, data: () => ({ status: 'declined' }) }),
  });
  c.setMatchmakingState('searching');
  await c.attemptMatchmakingScan(drill);
  await [...timers.values()][0].fn();
  assert.equal(calls.routes.length, 0);
  assert.equal(c.matchmakingStateRef.current, 'idle');
});

function presenceHarness(native = false) {
  const listeners = new Map();
  const writes = [];
  const nativeListener = deferred();
  const document = {
    visibilityState: 'visible',
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
  };
  const mocks = {
    'firebase/firestore': { doc: () => ({}), serverTimestamp: () => 123, updateDoc: async (_, data) => { writes.push(data.online); } },
    '@capacitor/core': { Capacitor: { isNativePlatform: () => native } },
    '@capacitor/app': { App: { addListener: () => nativeListener.promise } },
    './firebase': { initFirebase: () => ({ db: {} }) },
    './storage': { Storage: {} },
  };
  const c = {
    exports: {}, require: name => { assert.ok(mocks[name], name); return mocks[name]; },
    document, console, setInterval: () => 1, clearInterval: () => {},
    window: { addEventListener: () => {}, removeEventListener: () => {} },
  };
  vm.createContext(c);
  const compiled = ts.transpileModule(fs.readFileSync('lib/presence.js', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  vm.runInContext(compiled.outputText, c);
  return { start: c.exports.startPresence, document, listeners, writes, nativeListener };
}

test('briefly backgrounding and resuming immediately restores online presence', () => {
  const p = presenceHarness();
  const stop = p.start('player');
  p.document.visibilityState = 'hidden';
  p.listeners.get('visibilitychange')();
  p.document.visibilityState = 'visible';
  p.listeners.get('visibilitychange')();
  assert.deepEqual(p.writes, [true, false, true]);
  stop();
});

test('a native listener arriving after cleanup is removed', async () => {
  const p = presenceHarness(true);
  let removed = 0;
  const stop = p.start('player');
  stop();
  p.nativeListener.resolve({ remove: async () => { removed++; } });
  await flush();
  assert.equal(removed, 1);
});

test('daily arena picks stay valid and distinct across unsigned date hashes', () => {
  const pool = vm.runInNewContext(initializer('lib/challengeEngine.js', 'DUEL_DRILLS'));
  const mocks = {
    './storage': { Storage: {} }, './dailyChallenge': {}, './progressStore': {},
    './challengeEngine': { DUEL_DRILLS: pool }, './drillIndex': { DRILL_INDEX: [] },
  };
  const context = { exports: {}, require: name => mocks[name] };
  vm.createContext(context);
  const compiled = ts.transpileModule(fs.readFileSync('lib/arenaChallenge.js', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  vm.runInContext(compiled.outputText, context);
  for (let day = 0; day < 3650; day++) {
    const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
    const picks = context.exports.drillsForDate(date);
    assert.equal(picks.length, 2, date);
    assert.notEqual(picks[0].slug, picks[1].slug, date);
    assert.ok(picks.every(pick => pool.some(drill => drill.slug === pick.slug)), date);
  }
});

test('leaving Sequence Aim during fullscreen setup cannot restart its countdown', async () => {
  const fullscreen = deferred();
  let locks = 0;
  const context = {
    useCallback: fn => fn,
    launchSequenceRef: { current: 0 }, cancelLaunchRef: { current: null },
    mountedRef: { current: true }, setLaunching: () => {}, audioSynth: null,
    isChallenge: false, totalTime: 45, runCountdown: () => assert.fail('stale countdown'),
    document: { fullscreenElement: null },
    containerRef: { current: { requestFullscreen: () => fullscreen.promise } },
    Capacitor: { isNativePlatform: () => false },
    lockLandscape: async () => { locks++; },
  };
  vm.createContext(context);
  vm.runInContext(`globalThis.start = ${initializer('app/drills/cognitive/processing-speed/finger-sequencing/FingerSequencingClient.js', 'startGame')}`, context);
  const starting = context.start();
  context.mountedRef.current = false;
  context.launchSequenceRef.current++;
  fullscreen.resolve();
  await starting;
  assert.equal(locks, 0);
});
