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
