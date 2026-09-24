/**
 * 허브 클라이언트와 워커 루프 고정물.
 *
 * 진짜 허브를 띄우지 않고 `fetch` 를 갈아끼워 시험한다 — 여기서 확인할 것은
 * 네트워크가 아니라 **판단**이다: 무엇을 다시 보내고, 무엇을 즉시 포기하고,
 * 결과를 언제 보고하는가.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HubClient, HubError, HubUnreachable, runWorkerLoop } from '../src/worker/index.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/** fetch 를 대신하고, 온 요청을 기록하고, 정해진 응답을 돌려준다. */
function stubFetch(responder: (call: Call, n: number) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>),
    );
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      headers,
    };
    calls.push(call);
    return responder(call, calls.length);
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = (): HubClient =>
  new HubClient({
    hubUrl: 'https://hub.example/app/',
    token: 'tok',
    machine: 'm4a',
    retryBaseMs: 1, // 테스트가 실제로 기다리지 않게
  });

/* ───────────── 클라이언트 ───────────── */

test('끝의 슬래시를 떼고 토큰과 기기 이름을 붙여 보낸다', async () => {
  const calls = stubFetch(() => json({ task: null }));
  await client().poll(['p1'], ['run']);

  assert.equal(calls[0]?.url, 'https://hub.example/app/api/worker/poll');
  assert.equal(calls[0]?.headers['Authorization'], 'Bearer tok');
  assert.equal(calls[0]?.headers['X-Worker-Machine'], 'm4a');
  assert.equal(calls[0]?.headers['X-Worker-Protocol'], '1');
});

test('204 는 일거리가 없다는 뜻이다', async () => {
  stubFetch(() => new Response(null, { status: 204 }));
  assert.equal(await client().poll([], ['run']), undefined);
});

test('5xx 는 다시 보내고, 성공하면 그 값을 돌려준다', async () => {
  const calls = stubFetch((_c, n) => (n < 3 ? json({ error: 'nope' }, 503) : json({ task: { taskId: 7 } })));
  const plan = await client().poll<{ taskId: number }>([], ['run']);

  assert.equal(plan?.taskId, 7);
  assert.equal(calls.length, 3, '두 번 실패한 뒤 세 번째에 성공해야 한다');
});

test('401 은 다시 보내지 않는다 — 토큰이 틀렸는데 네 번 더 물을 이유가 없다', async () => {
  const calls = stubFetch(() => json({ error: '워커 토큰이 올바르지 않습니다.' }, 401));
  await assert.rejects(() => client().poll([], ['run']), (err: Error) => {
    assert.ok(err instanceof HubError);
    assert.equal((err as HubError).status, 401);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('426 도 즉시 포기한다 — 워커가 낡았다는 뜻이라 재시도가 의미 없다', async () => {
  const calls = stubFetch(() => json({ error: 'protocol too old' }, 426));
  await assert.rejects(() => client().poll([], ['run']), HubError);
  assert.equal(calls.length, 1);
});

test('429 는 기다렸다 다시 보낸다', async () => {
  const calls = stubFetch((_c, n) => (n < 2 ? json({}, 429) : json({ task: null })));
  await client().poll([], ['run']);
  assert.equal(calls.length, 2);
});

test('끝까지 못 닿으면 HubUnreachable — 루프가 이것을 보고 쉰다', async () => {
  const calls = stubFetch(() => json({}, 500));
  await assert.rejects(() => client().poll([], ['run']), HubUnreachable);
  assert.equal(calls.length, 4, '기본 시도 횟수만큼만 보낸다');
});

test('도메인 보고는 통로만 빌려 쓴다', async () => {
  const calls = stubFetch(() => json({ ok: true }));
  await client().post('/api/worker/attempt/9', { missionKey: 'pp|광고|15원' });

  assert.equal(calls[0]?.url, 'https://hub.example/app/api/worker/attempt/9');
  assert.deepEqual(calls[0]?.body, { missionKey: 'pp|광고|15원' });
});

/* ───────────── 루프 ───────────── */

/** 작업 하나를 내주고 그 다음엔 빈 응답을 주는 허브. */
function hubWithOneTask(onResult: (body: unknown) => void, plan: unknown = { taskId: 42 }): Call[] {
  let served = false;
  return stubFetch((call) => {
    if (call.url.endsWith('/poll')) {
      if (served) {
        process.emit('SIGTERM');
        return new Response(null, { status: 204 });
      }
      served = true;
      return json({ task: plan });
    }
    if (call.url.includes('/progress/')) return json({ cancel: false });
    if (call.url.includes('/result/')) {
      onResult(call.body);
      return json({ ok: true });
    }
    return json({});
  });
}

test('handle 이 돌려준 값이 결과로 보고된다', async () => {
  let reported: unknown;
  hubWithOneTask((b) => {
    reported = b;
  });

  await runWorkerLoop({
    hub: client(),
    kinds: ['run'],
    capabilities: () => ['p1'],
    log: () => {},
    handle: async () => ({ done: 3 }),
  });

  assert.deepEqual(reported, { status: 'done', result: { done: 3 } });
});

test('handle 이 던져도 반드시 실패로 보고된다', async () => {
  // 보고를 프로젝트에 맡기면 예외 경로에서 빠뜨리기 쉽고, 그러면 허브에 '실행 중'
  // 인 작업이 남아 리스가 만료될 때까지 아무도 집지 못한다.
  let reported: { status?: string; error?: string } = {};
  hubWithOneTask((b) => {
    reported = b as typeof reported;
  });

  await runWorkerLoop({
    hub: client(),
    kinds: ['run'],
    capabilities: () => [],
    log: () => {},
    handle: async () => {
      throw new Error('크롬이 안 떴습니다');
    },
  });

  assert.equal(reported.status, 'failed');
  assert.match(reported.error ?? '', /크롬이 안 떴습니다/);
});

test('허브가 취소하면 canceled 로 보고한다', async () => {
  let reported: { status?: string } = {};
  let served = false;
  stubFetch((call) => {
    if (call.url.endsWith('/poll')) {
      if (served) {
        process.emit('SIGTERM');
        return new Response(null, { status: 204 });
      }
      served = true;
      return json({ task: { taskId: 5 } });
    }
    if (call.url.includes('/progress/')) return json({ cancel: true });
    if (call.url.includes('/result/')) {
      reported = call.body as typeof reported;
      return json({ ok: true });
    }
    return json({});
  });

  await runWorkerLoop({
    hub: client(),
    kinds: ['run'],
    capabilities: () => [],
    log: () => {},
    flushMs: 5,
    handle: async (_plan, ctx) => {
      // 하트비트가 취소를 받아 올 틈을 준다
      for (let i = 0; i < 40 && !ctx.shouldStop(); i += 1) await new Promise((r) => setTimeout(r, 5));
      return { stopped: ctx.shouldStop() };
    },
  });

  assert.equal(reported.status, 'canceled');
});

test('capabilities 는 폴링할 때마다 다시 읽는다', async () => {
  // 워커를 재시작하지 않고 로그인을 추가하는 일이 흔하다. 한 번만 읽으면
  // 그 계정이 영영 배정되지 않는다.
  let reads = 0;
  let polls = 0;
  stubFetch((call) => {
    if (call.url.endsWith('/poll')) {
      polls += 1;
      if (polls >= 3) process.emit('SIGTERM');
      return new Response(null, { status: 204 });
    }
    return json({});
  });

  await runWorkerLoop({
    hub: client(),
    kinds: ['run'],
    capabilities: () => {
      reads += 1;
      return ['p1'];
    },
    log: () => {},
    handle: async () => undefined,
  });

  assert.ok(reads >= 3, `폴링마다 읽어야 한다 (읽기 ${reads}회 / 폴링 ${polls}회)`);
});
