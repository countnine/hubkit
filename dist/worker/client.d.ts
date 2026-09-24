/**
 * 워커가 허브와 이야기하는 유일한 통로.
 *
 * **워커는 데이터베이스를 갖지 않는다.** 그래서 이 파일이 자기 DB 를 대신한다 —
 * 판정은 허브가 미리 내려 작업 payload 에 실어 보내고, 일어난 일은 즉시 여기로
 * 보고된다.
 *
 * 방향이 한쪽인 것도 의도다. **워커가 허브를 부르고, 허브는 워커를 부르지 않는다.**
 * 그래서 워커 PC 가 방화벽 뒤에 있든 NAT 뒤에 있든 상관이 없고, 열어 둘 포트도 없다.
 */
/** 재시도를 다 하고도 허브에 닿지 못했다. 잠시 뒤 다시 시도할 일이다. */
export declare class HubUnreachable extends Error {
    constructor(message: string);
}
/** 허브가 요청을 거절했다. 다시 보내도 같으므로 즉시 올린다. */
export declare class HubError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
export interface HubClientOptions {
    hubUrl: string;
    token: string;
    machine: string;
    /**
     * 워커가 말하는 프로토콜 판. 허브가 모르는 판이면 426 으로 거절한다.
     * 공유 라이브러리라 허브만 먼저 배포되는 상황이 잦아서 필요하다.
     */
    protocol?: string;
    attempts?: number;
    retryBaseMs?: number;
    timeoutMs?: number;
    /** 폴링은 허브가 붙잡고 있으므로 더 길게 기다린다. */
    pollTimeoutMs?: number;
}
export interface ProgressPatch {
    log?: string[];
    progress?: unknown;
}
export declare class HubClient {
    private readonly base;
    private readonly token;
    readonly machine: string;
    private readonly protocol;
    private readonly attempts;
    private readonly retryBaseMs;
    private readonly timeoutMs;
    private readonly pollTimeoutMs;
    constructor(opts: HubClientOptions);
    /**
     * 일거리를 받아 온다. 허브가 한동안 붙잡고 있다가 없으면 204 로 답한다.
     *
     * 폴링 주기를 짧게 두는 대신 요청을 길게 붙잡는다 — 화면에서 누른 실행이 평균
     * 주기의 절반을 기다리지 않고 거의 즉시 나가는 이유다.
     */
    poll<Plan>(capabilities: string[], kinds: string[]): Promise<Plan | undefined>;
    /** 하트비트 겸 로그. 돌려받는 cancel 이 화면의 [중지] 다. */
    progress(taskId: number, patch: ProgressPatch): Promise<{
        cancel: boolean;
    }>;
    result(taskId: number, report: {
        status: 'done' | 'failed' | 'canceled';
        error?: string;
        result?: unknown;
    }): Promise<void>;
    /**
     * 도메인 보고용 통로.
     *
     * 미션 한 건, 행동 한 번, 수집한 목록 — 프로젝트마다 다른 것들은 이 문으로 나간다.
     * 프레임워크가 그 모양까지 알 필요는 없고, 알면 프로젝트가 늘 때마다 여기가 자란다.
     */
    post(path: string, body: unknown, timeoutMs?: number): Promise<Response>;
    get(path: string, timeoutMs?: number): Promise<Response>;
    /**
     * 바이트 그대로 올린다 (스크린샷·이미지 같은 것).
     *
     * 재시도하지 않는다. 몇 MB 를 네 번 다시 보내는 값이 크고, 이런 업로드는 실패해도
     * 작업 자체의 실패가 아니라 곁가지인 경우가 대부분이다.
     */
    postRaw(path: string, bytes: Uint8Array, contentType: string, timeoutMs?: number): Promise<Response>;
    /**
     * 재시도는 하되, 영원히 붙잡지는 않는다.
     *
     * 간격은 1초 · 3초 · 6초(삼각수)다. 세 프로젝트의 주석이 전부 이 값을 적어 두고
     * 실제로는 제각각이었는데(선형 1·2·3, 이차 1·4·9), 여기서 하나로 맞춘다.
     * 허브를 배포하면 몇 초 내려가므로 첫 재시도가 너무 빠르면 정상 배포가 매번
     * 오류 줄로 보인다.
     */
    private send;
}
//# sourceMappingURL=client.d.ts.map