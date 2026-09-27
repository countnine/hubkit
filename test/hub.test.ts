/**
 * 워커 라우트 — 진짜 express 앱을 띄워 HTTP 로 두드린다.
 *
 * 핸들러를 직접 부르면 통과하지만 실제로는 깨지는 것들이 있다: 본문 파서를 어디에
 * 붙였는지, 미들웨어 순서, `req.on('close')`. 그래서 여기서는 포트를 연다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { workerRouter, type WorkerRoutesPorts } from '../src/hub/index.ts';

const TOKEN = 'secret-token';

interface Harness {
  base: string;
  server: Server;
  calls: string[];
}

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

async function serve(
  ports: Partial<WorkerRoutesPorts>,
  extra: Partial<Parameters<typeof workerRouter>[0]> = {},
): Promise<Harness> {
  const calls: string[] = [];
  const app = express();
  app.use(
    '/api/worker',
    workerRouter({
      token: TOKEN,
      jsonBody: express.json({ limit: '256kb' }),
      longPollMs: 300,
      pollIntervalMs: 50,
      ports: {
        claim: () => undefined,
        progress: () => ({ cancel: false }),
        ...ports,
        seen: (m, k) => {
          calls.push(`seen:${m}:${(k ?? []).join(',')}`);
          ports.seen?.(m, k);
        },
        capabilities: (m, list) => {
          calls.push(`caps:${m}:${list.join(',')}`);
          ports.capabilities?.(m, list);
        },
      } as WorkerRoutesPorts,
      ...extra,
    }),
  );
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((r) => server.once('listening', () => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, calls };
}

const post = (
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'X-Worker-Machine': 'test-pc',
      ...headers,
    },
    body: JSON.stringify(body),
  });

/* ───────────── 인증 ───────────── */

test('토큰이 없으면 503 — 잘못된 토큰(401)과 구별된다', async () => {
  const h = await serve({}, { token: undefined });
  const res = await post(h.base, '/api/worker/poll', { machine: 'm' });
  assert.equal(res.status, 503);
});

test('틀린 토큰은 401', async () => {
  const h = await serve({});
  const res = await post(h.base, '/api/worker/poll', { machine: 'm' }, { Authorization: 'Bearer nope' });
  assert.equal(res.status, 401);
});

test('토큰 길이가 달라도 500 이 아니라 401 — timingSafeEqual 은 길이가 다르면 던진다', async () => {
  const h = await serve({});
  for (const bad of ['', 'x', `${TOKEN}${TOKEN}`]) {
    const res = await post(h.base, '/api/worker/poll', { machine: 'm' }, { Authorization: `Bearer ${bad}` });
    assert.equal(res.status, 401, `'${bad.slice(0, 12)}' 에서 ${res.status}`);
  }
});

test('토큰을 함수로 주면 요청마다 다시 읽는다 — 설정 화면에서 회전할 수 있다', async () => {
  let current = 'first';
  const h = await serve({}, { token: () => current });
  const hit = (t: string): Promise<Response> =>
    post(h.base, '/api/worker/poll', { machine: 'm' }, { Authorization: `Bearer ${t}` });

  assert.equal((await hit('first')).status, 204);
  current = 'second';
  assert.equal((await hit('first')).status, 401, '회전했는데 옛 토큰이 통했다');
  assert.equal((await hit('second')).status, 204);
});

test('protocol 을 주면 안 맞는 워커는 426 — 구버전이 조용히 오동작하지 않는다', async () => {
  const h = await serve({}, { protocol: '2' });
  assert.equal((await post(h.base, '/api/worker/poll', { machine: 'm' })).status, 426);
  const ok = await post(h.base, '/api/worker/poll', { machine: 'm' }, { 'X-Worker-Protocol': '2' });
  assert.equal(ok.status, 204);
});

test('protocol 을 주지 않으면 검사하지 않는다 — 쓰지 않는 프로젝트가 있다', async () => {
  const h = await serve({});
  assert.equal((await post(h.base, '/api/worker/poll', { machine: 'm' })).status, 204);
});

test('requireMachineHeader 면 헤더가 없을 때 400', async () => {
  const h = await serve({}, { requireMachineHeader: true });
  const res = await fetch(`${h.base}/api/worker/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: '{}',
  });
  assert.equal(res.status, 400);
});

/* ───────────── 폴링 ───────────── */

test('일이 있으면 즉시 내준다', async () => {
  const h = await serve({ claim: () => ({ taskId: 7, kind: 'run' }) });
  const res = await post(h.base, '/api/worker/poll', { machine: 'm4a', profiles: ['a'], kinds: ['run'] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { task: { taskId: 7, kind: 'run' } });
});

test('일이 없으면 붙잡고 기다린 뒤 204', async () => {
  const h = await serve({ claim: () => undefined });
  const started = Date.now();
  const res = await post(h.base, '/api/worker/poll', { machine: 'm' });
  assert.equal(res.status, 204);
  // longPollMs=300 을 실제로 기다렸는가. 즉시 204 면 롱폴링이 죽은 것이다.
  assert.ok(Date.now() - started >= 250, `${Date.now() - started}ms 만에 돌아왔다`);
});

test('기다리는 중에 일이 생기면 그때 나간다', async () => {
  let ready = false;
  const h = await serve({ claim: () => (ready ? { taskId: 1 } : undefined) });
  setTimeout(() => {
    ready = true;
  }, 80);
  const res = await post(h.base, '/api/worker/poll', { machine: 'm' });
  assert.equal(res.status, 200, '일이 생겼는데 204 로 끝났다');
});

test('machine 이 없으면 400', async () => {
  const h = await serve({});
  const res = await fetch(`${h.base}/api/worker/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: '{}',
  });
  assert.equal(res.status, 400);
});

test('기기 이름은 본문과 헤더 둘 다에서 읽는다 — 프로젝트마다 갈렸다', async () => {
  const h = await serve({});
  // 본문에 machine
  assert.equal((await post(h.base, '/api/worker/poll', { machine: 'from-body' })).status, 204);
  assert.ok(h.calls.includes('seen:from-body:'), h.calls.join(' '));
  // 헤더만
  assert.equal((await post(h.base, '/api/worker/poll', {})).status, 204);
  assert.ok(h.calls.includes('seen:test-pc:'), h.calls.join(' '));
});

test('capabilities 는 profiles·sessions·capabilities 어느 이름으로도 받는다', async () => {
  for (const [key, value] of [
    ['profiles', ['p1', 'p2']],
    ['sessions', ['s1']],
    ['capabilities', ['c1']],
  ] as const) {
    const h = await serve({});
    await post(h.base, '/api/worker/poll', { machine: 'm', [key]: value });
    assert.ok(
      h.calls.includes(`caps:m:${value.join(',')}`),
      `${key} 를 읽지 못했다: ${h.calls.join(' ')}`,
    );
  }
});

/* ───────────── 진행·끝맺음 ───────────── */

test('progress 는 취소 여부를 그대로 돌려준다', async () => {
  const h = await serve({ progress: () => ({ cancel: true }) });
  const res = await post(h.base, '/api/worker/progress/42', { log: ['한 줄'] });
  assert.deepEqual(await res.json(), { cancel: true });
});

test('progressPath 를 바꿀 수 있다 — 주소 모양이 갈린 프로젝트가 있다', async () => {
  let seenId = 0;
  const h = await serve(
    {
      progress: (id) => {
        seenId = id;
        return { cancel: false };
      },
    },
    { progressPath: '/tasks/:id/progress' },
  );
  assert.equal((await post(h.base, '/api/worker/tasks/99/progress', { log: [] })).status, 200);
  assert.equal(seenId, 99);
  assert.equal((await post(h.base, '/api/worker/progress/99', { log: [] })).status, 404);
});

test('result 는 status 를 요구한다', async () => {
  const h = await serve({ finish: () => {} });
  assert.equal((await post(h.base, '/api/worker/result/1', {})).status, 400);
});

test('result 는 프로젝트가 정한 status 를 그대로 넘긴다', async () => {
  const got: unknown[] = [];
  const h = await serve({ finish: (id, r) => got.push([id, r]) });
  await post(h.base, '/api/worker/result/5', { status: 'deferred', error: '큐에 남긴다' });
  assert.deepEqual(got, [[5, { status: 'deferred', error: '큐에 남긴다', result: undefined }]]);
});

test('resultPath: null 이면 공용 끝맺음을 붙이지 않는다', async () => {
  const h = await serve({}, { resultPath: null });
  assert.equal((await post(h.base, '/api/worker/result/1', { status: 'done' })).status, 404);
});

test('extend 로 프로젝트 라우트를 얹는다 — 토큰 검사를 그대로 받는다', async () => {
  const h = await serve(
    {},
    {
      extend: (router) => {
        router.post('/mine/:id', (req, res) => {
          res.json({ mine: Number(req.params.id) });
        });
      },
    },
  );
  const ok = await post(h.base, '/api/worker/mine/3', {});
  assert.deepEqual(await ok.json(), { mine: 3 });

  // 얹은 라우트도 인증 뒤에 있어야 한다.
  const bad = await post(h.base, '/api/worker/mine/3', {}, { Authorization: 'Bearer nope' });
  assert.equal(bad.status, 401, '프로젝트 라우트가 인증을 건너뛰었다');
});

test('포트가 던지면 500 으로 답하고, onError 로 바꿀 수 있다', async () => {
  const plain = await serve({
    progress: () => {
      throw new Error('디스크가 잠겼다');
    },
  });
  assert.equal((await post(plain.base, '/api/worker/progress/1', {})).status, 500);

  const mapped = await serve(
    {
      progress: () => {
        throw Object.assign(new Error('리스가 만료됐다'), { status: 409 });
      },
    },
    {
      onError: (res, err) => {
        res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message });
      },
    },
  );
  const res = await post(mapped.base, '/api/worker/progress/1', {});
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: '리스가 만료됐다' });
});

test('jsonBody 를 주지 않으면 본문 파서를 붙이지 않는다 — 앱이 이미 붙인 경우', async () => {
  const app = express();
  app.use(express.json());
  let claimed: unknown;
  app.use(
    '/api/worker',
    workerRouter({
      token: TOKEN,
      longPollMs: 50,
      pollIntervalMs: 10,
      ports: {
        claim: (c) => {
          claimed = c;
          return { taskId: 1 };
        },
        progress: () => ({ cancel: false }),
      },
    }),
  );
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const res = await post(base, '/api/worker/poll', { machine: 'm', profiles: ['x'], kinds: ['run'] });
  assert.equal(res.status, 200);
  assert.deepEqual(claimed, { machine: 'm', capabilities: ['x'], kinds: ['run'] });
});

test('워커가 연결을 끊으면 붙잡기를 그만둔다 — 죽은 연결에 작업을 주면 리스 만료까지 묶인다', async () => {
  let claimCalls = 0;
  const h = await serve(
    {
      claim: () => {
        claimCalls += 1;
        return undefined;
      },
    },
    { longPollMs: 3_000, pollIntervalMs: 50 },
  );

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  await fetch(`${h.base}/api/worker/poll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'X-Worker-Machine': 'test-pc',
    },
    body: '{}',
    signal: ac.signal,
  }).catch(() => {});

  // 끊긴 뒤에도 계속 돌고 있으면 claim 이 3초 내내 불린다(60번쯤).
  const atAbort = claimCalls;
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(
    claimCalls - atAbort <= 2,
    `끊긴 뒤에도 ${claimCalls - atAbort}번 더 집으려 했다 — res.on('close') 가 동작하지 않는다`,
  );
});

test('progress·finish 는 보고한 기기 이름을 함께 받는다 — 남의 작업을 막는 검사에 쓴다', async () => {
  const seen: unknown[] = [];
  const h = await serve({
    progress: (_id, _patch, ctx) => {
      seen.push(['progress', ctx.machine]);
      return { cancel: false };
    },
    finish: (_id, _r, ctx) => {
      seen.push(['finish', ctx.machine]);
    },
  });
  await post(h.base, '/api/worker/progress/1', { log: [] }, { 'X-Worker-Machine': 'pc-a' });
  await post(h.base, '/api/worker/result/1', { status: 'done' }, { 'X-Worker-Machine': 'pc-b' });
  assert.deepEqual(seen, [
    ['progress', 'pc-a'],
    ['finish', 'pc-b'],
  ]);
});
