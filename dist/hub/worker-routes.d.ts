import type { RequestHandler, Response, Router } from 'express';
/** 저장을 프로젝트에 맡기는 자리. 이쪽은 HTTP 모양만 안다. */
export interface WorkerRoutesPorts {
    /** 폴링이 왔다 — 이 기기가 살아 있다는 기록. 화면의 '연결됨' 이 여기서 나온다. */
    seen?(machine: string, kinds: string[] | undefined): void;
    /**
     * 이 기기가 지금 할 수 있는 일(로그인된 프로필·세션 이름).
     *
     * **허브가 이것을 알게 되는 유일한 경로다.** 세션 파일은 워커 PC 에만 있고
     * 허브로 옮겨서도 안 되는 것이라, 허브가 자기 파일시스템을 봐서는 알 수 없다.
     */
    capabilities?(machine: string, list: string[]): void;
    /** 일거리 하나를 집어 준다. 없으면 undefined — 그때 롱폴링이 기다린다. */
    claim(claim: {
        machine: string;
        capabilities: string[];
        kinds: string[] | undefined;
    }): unknown | undefined;
    /**
     * 하트비트 겸 로그. 리스를 갱신하고 취소 여부를 돌려준다.
     *
     * `ctx.machine` 을 주는 이유: 보고한 기기가 **그 작업의 주인인지** 확인하는
     * 프로젝트가 있다(PreviewAuto 의 requireLiveTask). 남의 작업에 로그를 쓰거나
     * 끝맺음을 보내는 것을 막는 검사라, 넘겨주지 않으면 그 프로젝트는 이 통로를
     * 쓸 수 없다.
     */
    progress(taskId: number, patch: {
        log?: string[];
        progress?: unknown;
    }, ctx: {
        machine: string;
    }): {
        cancel: boolean;
    };
    /** 끝맺음. `resultPath: null` 로 공용 라우트를 끄면 필요 없다. */
    finish?(taskId: number, report: {
        status: string;
        error?: string;
        result?: unknown;
    }, ctx: {
        machine: string;
    }): void;
}
export interface WorkerRoutesOptions {
    /**
     * 공유 토큰. **함수로 주면 요청마다 다시 읽는다** — 설정 화면에서 토큰을 회전하는
     * 프로젝트가 있고, 상수로 굳히면 회전한 뒤 서버를 재시작해야 한다.
     */
    token: string | undefined | (() => string | undefined);
    /** 토큰이 없을 때의 503 문구. 환경변수 이름이 프로젝트마다 다르다. */
    tokenMissingMessage?: string;
    /**
     * 주면 `X-Worker-Protocol` 을 검사하고 안 맞으면 426.
     *
     * 구버전 워커가 **조용히 오동작하는** 것을 막는다. 배포와 워커 재시작 사이에는
     * 반드시 그 틈이 생긴다.
     */
    protocol?: string;
    /** 기기 이름을 `X-Worker-Machine` 헤더로만 받고, 없으면 400. */
    requireMachineHeader?: boolean;
    /** 폴링을 붙잡아 두는 시간. 이 길이만큼은 일이 생기는 순간 바로 나간다. */
    longPollMs?: number;
    pollIntervalMs?: number;
    /**
     * 라우트마다 붙이는 본문 파서.
     *
     * **라우터 전체에 붙이면 안 되는 프로젝트가 있다.** PreviewAuto 는 수집 배치를
     * 바이트 그대로 받아야 하는데(멱등성 판정이 본문 해시다), `router.use(express.json())`
     * 을 쓰면 Content-Type 이 application/json 이라서 그 파서가 먼저 집어삼킨다.
     * 실제로 그렇게 만들어 배치가 413 으로 거절된 적이 있다.
     *
     * 주지 않으면 본문 파서를 붙이지 않는다 — 앱이 이미 전역으로 붙였다는 뜻이다.
     */
    jsonBody?: RequestHandler;
    /** 기본 `/progress/:id`. PreviewAuto 는 `/tasks/:id/progress` 를 쓴다. */
    progressPath?: string;
    /** 기본 `/result/:id`. `null` 이면 붙이지 않는다 — 끝맺음이 둘로 갈린 프로젝트가 있다. */
    resultPath?: string | null;
    ports: WorkerRoutesPorts;
    /** 프로젝트 고유 라우트. 공용 라우트 **뒤에** 붙는다. */
    extend?(router: Router): void;
    /**
     * 예외를 응답으로 옮기는 법.
     *
     * 프로젝트마다 자기 오류 종류에 상태 코드를 달고 있다(DispatchError 등).
     * 주지 않으면 500 으로 답하고 콘솔에 남긴다.
     */
    onError?(res: Response, err: unknown): void;
}
/**
 * 워커용 라우터를 만든다. 앱에 붙이는 것은 호출자가 한다:
 *
 * ```ts
 * app.use(`${basePath}/api/worker`, workerRouter({ ... }));
 * ```
 */
export declare function workerRouter(opts: WorkerRoutesOptions): Router;
//# sourceMappingURL=worker-routes.d.ts.map