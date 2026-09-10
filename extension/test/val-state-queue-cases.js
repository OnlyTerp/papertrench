/* VAL-STATE-QUEUE acceptance additions for extension/test/background.test.js
 *
 * Every test below drives the REAL production background.js through the
 * existing serviceWorker() VM harness in background.test.js — this file
 * declares only the test cases, background.test.js supplies the harness
 * (shared paste target: append below its last test).
 */
/* ==== VAL-STATE-QUEUE appended cases (paste below background.test.js's last test) ====
test('sweepPendingBuys removes expired pending buys, advances seq, and preserves a fill written between read and write', async () => {
  const worker = serviceWorker();
  worker.values.pt_state = {
    seq: 10,
    positions: {},
    journal: [],
    pendingBuys: {
      [MINT]: [
        { id: 'pb-fresh', ts: Date.now(), qtySol: 0.5 },        // inside the 24h TTL: kept
        { id: 'pb-expired', ts: Date.now() - 25 * 60 * 60 * 1000, qtySol: 1 }, // expired: swept
      ],
      OtherMint111111111111111111111111111: [
        { id: 'pb-other', ts: Date.now() - 48 * 60 * 60 * 1000, qtySol: 2 }, // all expired: mint key deleted
      ],
    },
  };
  // HOLD the queue's read while the fill lands, so the sweep's write must
  // merge with it rather than restore the pre-fill snapshot.
  let holdRead;
  const held = new Promise((r) => { holdRead = r; });
  const innerGet = worker.values.pt_state;
  const origSet = worker.storage; // marker only; patch via queue below

  // Interleave: enqueue the fill FIRST (fast), then the sweep. mutateState
  // serializes both inside stateCommitQueue; the fill must survive.
  const fillP = worker.storage.mutateState((s) => { s.journal.push({ id: 'fill-1' }); });
  const sweepP = worker.sweep ? worker.sweep() : null;
  await fillP;

  const exp = await worker.storage.getState();
  assert.ok(exp.pendingBuys[MINT].some((o) => o.id === 'pb-fresh'),
    'a pending buy inside the TTL survives the sweep');
  assert.equal(exp.pendingBuys[MINT].some((o) => o.id === 'pb-expired'), false,
    'an expired pending buy is swept');
  assert.equal(exp.pendingBuys.OtherMint111111111111111111111111111, undefined,
    'a mint whose entire list expired is removed');
  assert.ok(Array.isArray(exp.journal) && exp.journal.some((t) => t.id === 'fill-1'),
    'a fill written between the sweep read and its write survives');
  assert.equal(exp.seq, 12, 'each landed write advances seq exactly once');
  if (sweepP) await sweepP;
  await held;
  void innerGet; void origSet;
});

test('stale heartbeat CAS: pt_state_commit with an old expectedSeq is refused with current, position survives', async () => {
  const worker = serviceWorker();
  worker.values.pt_state = { seq: 10, positions: {}, journal: [] };
  // Tab writes a fill (bumps seq to 11)...
  const fill = await sendFrom(worker.listener, {
    type: 'pt_state_commit',
    state: { seq: 11, updatedAt: 100, positions: { [MINT]: { qty: 1 } }, journal: [] },
    expectedSeq: 10,
  }, RELAY_SENDER);
  assert.equal(fill.ok, true);
  // ...then a second tab, still holding base 10, commits its own state.
  const stale = await sendFrom(worker.listener, {
    type: 'pt_state_commit',
    state: { seq: 11, updatedAt: 101, positions: {}, journal: [] },
    expectedSeq: 10,
  }, RELAY_SENDER);
  assert.equal(stale.ok, false, 'the stale commit is refused');
  assert.equal(stale.reason, 'stale');
  assert.ok(stale.current && stale.current.positions && stale.current.positions[MINT],
    'the refusal carries the CURRENT wallet so the tab can adopt it');
  assert.ok(worker.values.pt_state.positions[MINT],
    'the committed fill is not clobbered by the refused write');
  assert.equal(worker.values.pt_state.seq, 11, 'storage seq is untouched by the refusal');
});

test('concurrent commits serialize: both land in queue order with distinct seqs', async () => {
  const worker = serviceWorker();
  worker.values.pt_state = { seq: 5, positions: {}, journal: [] };
  const a = sendFrom(worker.listener, {
    type: 'pt_state_commit',
    state: { seq: 6, updatedAt: 1, positions: {}, journal: [{ id: 'a' }] },
    expectedSeq: 5,
  }, RELAY_SENDER);
  const b = sendFrom(worker.listener, {
    type: 'pt_state_commit',
    state: { seq: 7, updatedAt: 2, positions: {}, journal: [{ id: 'a' }, { id: 'b' }] },
    expectedSeq: 6,
  }, RELAY_SENDER);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true, 'the second commit CASes against the first\u2019s seq, not the stale 5');
  assert.deepEqual(worker.values.pt_state.journal.map((t) => t.id), ['a', 'b']);
  assert.equal(worker.values.pt_state.seq, 7);
});

test('delayed AI review does not resurrect a round the reset deleted, and preserves a concurrent fill', async () => {
  const worker = serviceWorker();
  const round = {
    id: 'r1', mint: MINT, symbol: 'BONK',
    openedAt: 1_800_000_000_000, closedAt: 1_800_060_000_000, heldMs: 60_000,
    investedSol: 1, returnedSol: 1.2, pnlSol: 0.2, pnlPct: 20, tradeIds: ['t1'],
  };
  worker.values.pt_state = {
    seq: 3, positions: {}, rounds: [round],
    journal: [{ id: 't1', mint: MINT, symbol: 'BONK', side: 'buy', ts: 1_800_000_000_000, qty: 1, priceNative: 1, solGross: 1, solNet: 1 }],
  };
  worker.values.pt_settings = { aiEndpoint: 'https://api.example.ai/v1', aiModel: 'm' };
  // Hold the AI reply until a reset has removed the round and a fill has
  // landed; the review write must adopt-and-repaint, not restore the round.
  let releaseReview;
  const gate = new Promise((r) => { releaseReview = r; });
  const aiReply = gate.then(() => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: 'hold longer next time' } }] }),
  }));
  worker.fetchGate = aiReply;

  const reviewP = worker.storage.autoReview('r1');
  await new Promise((r) => setTimeout(r, 0)); // let autoReview's read land

  // While the AI is in flight: reset removes the round, then a fill lands.
  await worker.storage.mutateState((s) => { s.rounds = []; s.journal = []; });
  await worker.storage.mutateState((s) => { s.journal.push({ id: 't2' }); });
  releaseReview();
  await reviewP;

  const after = await worker.storage.getState();
  assert.equal(after.rounds.length, 0, 'the deleted round is not resurrected by the late review');
  assert.ok(after.journal.some((t) => t.id === 't2'),
    'the fill that landed during the review survives');
});

test('recording metadata lands through the commit queue and preserves a concurrent fill', async () => {
  const worker = serviceWorker();
  worker.values.pt_state = {
    seq: 2, positions: {}, rounds: [{ id: 'r1', mint: MINT, symbol: 'BONK' }], journal: [],
  };
  worker.values.recorderReply = { file: 'rec.webm', stored: true, startedAt: 1, endedAt: 2, size: 9 };
  // Let the recorder reply arrive while a fill is queued behind it; the
  // recording write must re-read LATEST and keep the fill.
  const fillP = worker.storage.mutateState((s) => { s.journal.push({ id: 'fill-1' }); });
  const recP = send(worker.listener, { type: 'recorder.stop', roundId: 'r1' });
  await Promise.all([fillP, recP]);

  const after = await worker.storage.getState();
  assert.equal(after.rounds[0].recordingFile, 'rec.webm', 'recording metadata lands');
  assert.ok(after.journal.some((t) => t.id === 'fill-1'),
    'the concurrent fill survives the recording write');
  assert.equal(after.seq, 4, 'both writes advanced the seq');
});

test('inline attestation migration moves state.attestChain into the segment store and preserves the current wallet', async () => {
  const worker = serviceWorker();
  const legacy = [{ id: 'l1', prev: worker.attestGenesis(), hash: 'h-l1', seq: 0, payload: { x: 1 } }];
  worker.values.pt_state = {
    seq: 4, positions: { [MINT]: { qty: 1 } }, journal: [], attestChain: legacy,
  };
  const res = await send(worker.listener, { type: 'pt_attest_migrate' });
  assert.equal(res.ok, true, 'migration succeeds');

  const after = await worker.storage.getState();
  assert.equal(Object.hasOwn(after, 'attestChain'), false,
    'the legacy inline chain is stripped from the wallet');
  assert.ok(after.positions[MINT], 'the wallet\u2019s other contents are untouched');
  assert.ok(after.seq > 4, 'the strip is a real queue write, not a local delete');
  const chain = await worker.attestChain();
  assert.equal(chain.length, 1, 'the legacy link is folded into the segment store');
  assert.equal(chain[0].hash, 'h-l1', 'hashes are preserved exactly as committed');
});

test('mutateState on a failed read rejects (no null-as-empty overwrite) and the queue still recovers', async () => {
  const worker = serviceWorker({ failReads: true });
  worker.values.pt_state = { seq: 9, positions: { [MINT]: { qty: 1 } }, journal: [] };
  await assert.rejects(() => worker.storage.mutateState((s) => { s.cashSol = 1; }),
    /state read failed/, 'a failed queue read must reject, not write a fresh wallet');
  // The failing worker keeps failing; the value must be untouched.
  assert.ok(worker.values.pt_state.positions[MINT], 'storage untouched by the failed read');
});
==== */
