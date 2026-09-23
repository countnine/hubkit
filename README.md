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
{ "dependencies": { "hubkit": "github:countnine/hubkit#v0.1.0" } }
```

## 개발

```
npm run build       dist/ 갱신 (커밋 대상이다)
npm test
npm run typecheck
```
