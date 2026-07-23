// Robustness fuzz for the scoring/board/contest/scorecard endpoints. Fires
// malformed, boundary, wrong-type, and abusive inputs at the DEPLOYED APIs and
// asserts every response is a GRACEFUL client error — never a 5xx / crash and
// never a silent success on invalid data. Any 5xx is a real bug.
//   npx tsx scripts/fuzz-scoring.ts
const BASE = process.env.E2E_BASE_URL ?? 'https://tourneycoach.com';
const UUID = '00000000-0000-0000-0000-000000000000';
const LONG_TOKEN = 'z'.repeat(36); // valid length, unknown device

let failures = 0;
async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return res.status;
}
async function get(path: string) { return (await fetch(`${BASE}${path}`, { cache: 'no-store' } as RequestInit)).status; }
// A well-behaved endpoint answers invalid input with a client error, not a crash.
const expectClientError = async (label: string, status: number, allowed = [400, 401, 403, 404, 422]) => {
  const bad5xx = status >= 500;
  const ok = allowed.includes(status) && !bad5xx;
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${label} → ${status}${bad5xx ? '  *** 5xx / CRASH ***' : ok ? '' : '  (unexpected)'}`);
  if (!ok) failures++;
};

(async () => {
  console.log(`FUZZ against ${BASE}\n`);

  console.log('POST /api/gps/score — malformed / boundary / wrong-type');
  await expectClientError('empty body {}', await post('/api/gps/score', {}));
  await expectClientError('non-JSON body', await post('/api/gps/score', 'not json at all'));
  await expectClientError('null body', await post('/api/gps/score', 'null'));
  await expectClientError('short deviceToken', await post('/api/gps/score', { deviceToken: 'x', holeNumber: 1, strokes: 4 }));
  await expectClientError('deviceToken not a string', await post('/api/gps/score', { deviceToken: 12345, holeNumber: 1, strokes: 4 }));
  await expectClientError('holeNumber 0', await post('/api/gps/score', { deviceToken: LONG_TOKEN, holeNumber: 0, strokes: 4 }));
  await expectClientError('holeNumber 19', await post('/api/gps/score', { deviceToken: LONG_TOKEN, holeNumber: 19, strokes: 4 }));
  await expectClientError('holeNumber string', await post('/api/gps/score', { deviceToken: LONG_TOKEN, holeNumber: 'five', strokes: 4 }));
  await expectClientError('holeNumber float', await post('/api/gps/score', { deviceToken: LONG_TOKEN, holeNumber: 5.5, strokes: 4 }));
  await expectClientError('strokes 0', await post('/api/gps/score', { deviceToken: LONG_TOKEN, holeNumber: 5, strokes: 0 }));
  await expectClientError('strokes 21', await post('/api/gps/score', { deviceToken: LONG_TOKEN, holeNumber: 5, strokes: 21 }));
  await expectClientError('strokes float', await post('/api/gps/score', { deviceToken: LONG_TOKEN, holeNumber: 5, strokes: 4.5 }));
  await expectClientError('strokes NaN', await post('/api/gps/score', { deviceToken: LONG_TOKEN, holeNumber: 5, strokes: Number.NaN }));
  await expectClientError('strokes huge', await post('/api/gps/score', { deviceToken: LONG_TOKEN, holeNumber: 5, strokes: 1e9 }));
  await expectClientError('unknown device (valid shape)', await post('/api/gps/score', { deviceToken: LONG_TOKEN, holeNumber: 5, strokes: 4 }), [403]);
  await expectClientError('garbage currentLat type', await post('/api/gps/score', { deviceToken: LONG_TOKEN, holeNumber: 5, strokes: 4, currentLat: 'x', currentLng: {} }), [403]);
  await expectClientError('currentLat out of range', await post('/api/gps/score', { deviceToken: LONG_TOKEN, holeNumber: 5, strokes: 4, currentLat: 999, currentLng: -999 }), [403]);
  await expectClientError('injection-y deviceToken', await post('/api/gps/score', { deviceToken: "'; DROP TABLE score_submissions;--", holeNumber: 5, strokes: 4 }), [403]);

  console.log('\nPOST /api/scores/correct — auth + validation');
  await expectClientError('no auth', await post('/api/scores/correct', { registrationId: UUID, holeNumber: 1, strokes: 4 }), [401]);
  await expectClientError('no auth + garbage', await post('/api/scores/correct', { registrationId: 42, holeNumber: 'x', strokes: -5 }), [400, 401]);
  await expectClientError('no auth empty', await post('/api/scores/correct', {}), [400, 401]);

  console.log('\nPOST /api/tournament/[id]/contests — auth + validation');
  await expectClientError('no auth', await post(`/api/tournament/${UUID}/contests`, { holeNumber: 1, contestType: 'hole_in_one' }), [401]);
  await expectClientError('bad contestType (no auth)', await post(`/api/tournament/${UUID}/contests`, { holeNumber: 1, contestType: 'nope' }), [400, 401]);
  await expectClientError('contests id garbage', await post('/api/tournament/not-a-uuid/contests', { holeNumber: 1, contestType: 'hole_in_one' }), [400, 401, 404]);

  console.log('\nGET public reads — bad / missing ids');
  await expectClientError('board unknown id', await get(`/api/tournament/${UUID}/board`), [404]);
  await expectClientError('board non-uuid id', await get('/api/tournament/not-a-uuid/board'), [400, 404]);
  await expectClientError('leaderboard unknown id', await get(`/api/tournament/${UUID}/leaderboard`), [404]);
  await expectClientError('scorecard unknown id', await get(`/api/registration/${UUID}/scorecard`), [404]);
  await expectClientError('scorecard non-uuid', await get('/api/registration/💥/scorecard'), [400, 404]);
  await expectClientError('profile unknown id', await get(`/api/course/${UUID}/profile`), [404]);

  console.log('\nGET pages — bad ids should render (not 5xx)');
  await expectClientError('/tv/<bad> page', await get('/tv/not-a-uuid'), [200, 404]);
  await expectClientError('/leaderboard/<bad> page', await get('/leaderboard/not-a-uuid'), [200, 404]);
  await expectClientError('/scorecard/<bad> page', await get('/scorecard/not-a-uuid'), [200, 404]);

  console.log(`\n${failures === 0 ? '✅ FUZZ PASSED — every endpoint degrades gracefully, zero 5xx' : `❌ ${failures} endpoint(s) mishandled abusive input`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
