# hubkit

허브/워커 구조를 쓰는 프로젝트들이 같이 쓰는 뼈대.

`autoapply` · `PreviewAuto` · `npayEvent` 가 같은 구조를 각자 복사해 쓰고 있었다.
원천 DB 와 화면은 상시 켜진 VPS 에, 브라우저 작업은 집 PC 에 두는 구조다.
새 프로젝트가 생길 때마다 또 복사해야 했고, 한쪽을 고쳐도 다른 쪽에 전해지지 않았다.

## 지금 들어 있는 것

### `hubkit/process` — 워커 신원

워커가 시작할 때 `data/worker.pid` 에 자기 신원을 적고, 죽이려는 쪽은 그 파일만 본다.

```ts
import { acquire, release, verify } from 'hubkit/process';

const claim = acquire(DATA_DIR, { project: 'npayEvent', root: ROOT, machine: 'm4a' });
if (!claim.ok) throw new Error(`이미 워커가 돌고 있습니다 (PID ${claim.running.pid})`);
// …
release(DATA_DIR, 'SIGTERM');
```

**왜 있는가.** 상주 스크립트가 워커를 명령줄 문자열로 찾았다:

```powershell
Where-Object { $_.CommandLine -like '*src/index.ts worker*' }
```

형제 프로젝트들이 전부 같은 모양이라, 한 프로젝트의 `-Stop` 한 번이
**다른 프로젝트의 워커 세 개를 같이 죽였다.** 절대 경로를 박아 막아 봤지만 그것은
메커니즘이 아니라 문자열 관습이라, 런처가 한 줄만 바뀌면 다시 무장된다.

`verify()` 는 네 가지를 확인하고, 하나라도 어긋나면 그 PID 를 건드리지 않는다:

1. 기록의 `root` 가 이 프로젝트인가
2. 그 PID 가 살아 있는가
3. **그 PID 의 시작 시각이 기록과 같은가** — PID 는 재사용된다
4. (호출자 쪽에서) 프로세스 형태가 맞는가

3번이 이 패키지의 존재 이유다. "살아 있다" 만 보고 죽이면 그 번호를 물려받은
남의 프로세스를 죽인다.

### `hubkit/worker` — 묻고, 하고, 보고하는 루프

프로젝트가 채우는 것은 **`handle` 하나**다. 신원 등록, 로그 버퍼링, 하트비트,
취소 수신, 결과 보고, 종료 신호는 이쪽이 맡는다 — 그 여섯 가지가 프로젝트마다
한 벌씩 있었고, 조금씩 달랐다.

```ts
import { HubClient, runWorkerLoop } from 'hubkit/worker';

await runWorkerLoop({
  hub: new HubClient({ hubUrl: HUB_URL, token: WORKER_TOKEN, machine }),
  kinds: ['run', 'check', 'login'],
  // 폴링할 때마다 다시 읽는다 — 워커를 재시작하지 않고 로그인을 추가하는 일이 흔하다
  capabilities: localProfileNames,
  identity: { dir: DATA_DIR, project: 'npayEvent', root: ROOT },
  handle: async (plan, ctx) => doRun(plan, ctx),
});
```

**보고는 루프가 반드시 한다.** `handle` 이 던져도 실패로 보고된다 — 이것을
프로젝트에 맡기면 예외 경로에서 빠뜨리기 쉽고, 그러면 허브에 '실행 중' 인 작업이
리스 만료까지 남는다.

#### `settle` — 상태 어휘는 프로젝트가 정한다

기본은 `done` / `failed` / `canceled` 지만 그 셋으로 끝나지 않는다. autoapply 는
**`deferred`**(아직 응모하지 않았으니 큐에 남겨 둬라)가 필요하고, 그 허브는
`canceled` 를 모른다. 프레임워크가 어휘를 고정하면 그런 프로젝트는 이 통로를 쓸 수 없다.

```ts
settle: (o) => {
  if (!o.ok && o.error instanceof BlockedError) {
    // 실패로 보고하면 큐로 되돌아가 같은 차단을 다시 밟는다.
    return { report: null, pauseMs: 15_000 };
  }
  const r = o.result as ExecOutcome;
  return { report: { status: r.status, error: r.error } };
},
```

`report: null` 은 **일부러 보고하지 않는다**는 뜻이다. 작업은 허브에서 '실행 중' 으로
남고 리스가 만료될 때 그 프로젝트의 회수 규칙이 판단한다.

`settle` 은 **형태만 정하는 순수 함수**다. 보고하는 책임은 루프가 계속 들고 있고,
`settle` 이 던지면 기본 판정으로 되돌려 보고한다 — 판정 하나 잘못 쓴 것이 작업을
리스 만료까지 붙잡는 일로 번지지 않게.

### `hubkit/hub` — 워커의 말을 받는 창구

허브 쪽 라우터. 토큰 검사, 롱폴링, 진행 보고, 끝맺음이 여기 있다. **저장은 `ports` 로
넘긴다** — 테이블 모양은 프로젝트마다 다르고, 이 모듈이 그것을 알면 프로젝트가 늘
때마다 자란다.

```ts
import express from 'express';
import { workerRouter } from 'hubkit/hub';

app.use(
  `${basePath}/api/worker`,
  workerRouter({
    token: () => WORKER_TOKEN,          // 함수로 주면 요청마다 다시 읽는다
    tokenMissingMessage: 'NPAY_WORKER_TOKEN 이 설정되지 않아 워커를 받지 않습니다.',
    jsonBody: express.json({ limit: '256kb' }),
    ports: {
      seen: markWorkerSeen,
      capabilities: recordMachineProfiles,
      claim: ({ machine, capabilities, kinds }) => claimTask({ machine, profiles: capabilities, kinds }),
      progress: (id, patch) => appendProgress(id, patch),
      finish: (id, report) => finishTask(id, report),
    },
    extend: (router) => {               // 프로젝트 고유 라우트
      router.post('/attempt/:id', jsonBody, handleAttempt);
    },
  }),
);
```

express 는 **peerDependency** 다. 소비 프로젝트가 이미 자기 express 를 들고 있고,
여기서 한 벌 더 가져오면 라우터가 다른 express 의 것이 되어 미들웨어가 어긋난다.

#### 본문 파서는 라우트마다 붙인다

`jsonBody` 를 옵션으로 받는 이유다. `router.use(express.json())` 로 한 번에 붙이면
**Content-Type 이 application/json 인 모든 요청**을 그 파서가 집어삼킨다 —
PreviewAuto 는 수집 배치를 바이트 그대로 받아야 하는데(멱등성 판정이 본문 해시다)
그러면 413 으로 거절되거나 해시가 달라진다.

#### `res.on('close')` — `req` 가 아니다

롱폴링이 클라이언트 끊김을 볼 때 **`res`** 를 본다. express 5 에서 `req.on('close')` 는
**본문을 다 읽은 직후** 발화한다. 클라이언트가 멀쩡히 기다리고 있어도 그렇다.

세 프로젝트가 전부 `req` 를 보고 있었고, 그래서 **롱폴링이 실제로는 없었다** —
25초를 붙잡을 자리에서 즉시 204 를 돌려줬다. 실측(express 5.2.1): `req` 는 134ms,
`res` 는 1571ms(기대 1500ms). 끊김은 `res` 가 300ms 에 끊으면 310ms 에 잡는다.

조용했던 이유는 **204 가 정상 응답**이라는 것이다. 아무 데도 오류로 남지 않고, 워커는
그냥 더 자주 물어봤다. npayEvent 워커는 `idleMs` 가 0 이라 쉬지 않고 물었다.

## 런타임

컴파일한 `.js` + `.d.ts` 를 내보낸다. raw `.ts` 를 내보내려 했지만 Node 는
`node_modules` 안의 타입 스트리핑을 의도적으로 거부한다
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — 실측으로 확인했다.

소비 프로젝트는 빌드 단계가 없고 bare node 와 tsx 가 섞여 있으므로,
**빌드는 이 라이브러리 안에서만 끝낸다.** `dist/` 는 저장소에 커밋한다 —
git 의존성으로 쓸 때 설치 시점에 빌드가 돌지 않아야 VPS 가 devDependencies 를
받지 않는다.

확인된 소비 방식: bare node(`--experimental-transform-types`) · tsx · 순수 `.mjs`.

## 쓰기

```json
{ "dependencies": {
    "hubkit": "https://github.com/countnine/hubkit/archive/refs/tags/v0.1.0.tar.gz"
} }
```

**왜 `github:` 단축형이 아니라 tarball URL 인가.** npm 은 `github:owner/repo` 와
`git+https://github.com/...` 를 **둘 다 lockfile 에 `git+ssh://git@github.com/...` 로
정규화한다.** 그러면 설치하는 쪽마다 GitHub SSH 키가 있어야 하고, 없는 기기에서
`npm ci` 가 깨진다 — 공개 저장소로 만든 이유(어디서도 자격증명이 필요 없게)가
사라진다. tarball URL 은 lockfile 에 그대로 남고 git 조차 필요 없다.

## 개발

```
npm run build       dist/ 갱신 (커밋 대상이다)
npm test
npm run typecheck
```
