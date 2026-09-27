import { HubClient, type TaskReport } from './client.ts';
export interface WorkerContext {
    hub: HubClient;
    taskId: number;
    /** 화면까지 흘러가는 로그. 콘솔에도 같이 찍힌다. */
    log(message: string): void;
    /** 화면에서 [중지] 를 눌렀거나 종료 신호를 받았다. 진행 중인 것만 마치고 멈춰야 한다. */
    shouldStop(): boolean;
}
/** 핸들러가 어떻게 끝났는지. `settle` 이 이것을 보고 보고 형태를 정한다. */
export interface SettleInput {
    /** 핸들러가 정상으로 끝났는가. */
    ok: boolean;
    /** ok 일 때 핸들러가 돌려준 값. */
    result?: unknown;
    /** ok 가 아닐 때 던져진 오류. */
    error?: Error;
    /** 화면에서 [중지] 를 눌렀거나 종료 신호를 받았다. */
    canceled: boolean;
}
export interface SettleDecision {
    /**
     * 허브에 보낼 보고.
     *
     * **null 이면 보고하지 않는다.** 작업은 허브에서 '실행 중' 으로 남고, 리스가
     * 만료될 때 그 프로젝트의 회수 규칙이 판단한다. 차단을 감지해 멈춘 경우처럼
     * "여기서 결론을 내리면 안 되는" 실패에 쓴다 — 실패로 보고해 버리면 큐로
     * 되돌아가 같은 차단을 다시 밟는다.
     */
    report: TaskReport | null;
    /** 보고한 뒤 쉬는 시간. 차단이나 연속 실패 뒤에 몰아치지 않으려고 둔다. */
    pauseMs?: number;
}
export interface WorkerLoopOptions<Plan extends {
    taskId: number;
}> {
    hub: HubClient;
    /**
     * 이 워커가 처리할 수 있는 작업 종류.
     *
     * 허브가 이 목록에 없는 종류를 내주지 않으므로, 배포와 워커 재시작 사이에
     * 구버전 워커가 모르는 작업을 집어가 망치는 일이 없다.
     */
    kinds: string[];
    /**
     * 이 기기가 지금 할 수 있는 일의 목록(로그인된 프로필 이름 등).
     *
     * 폴링할 때마다 다시 부른다 — 워커를 재시작하지 않고 로그인을 추가하는 일이
     * 흔한데, 한 번만 읽으면 그 계정이 영영 배정되지 않는다.
     */
    capabilities: () => string[] | Promise<string[]>;
    /** 실제로 일하는 자리. 반환값이 결과로 보고되고, 던지면 실패로 보고된다. */
    handle: (plan: Plan, ctx: WorkerContext) => Promise<unknown>;
    /**
     * 끝난 결과를 **무엇으로 보고할지** 정한다. 기본은 done/failed/canceled.
     *
     * 상태 어휘가 프로젝트마다 다르기 때문에 있다 — autoapply 는 'deferred' 가 필요하고
     * 그 허브는 'canceled' 를 모른다. 그래도 **보고하는 책임은 루프가 계속 들고 있다**:
     * 여기는 형태만 정하는 순수 함수다. 프로젝트가 직접 보고하게 두면 예외 경로에서
     * 빠뜨리기 쉽고, 그러면 허브에 '실행 중' 인 작업이 리스 만료까지 남는다.
     */
    settle?: (outcome: SettleInput) => SettleDecision;
    /** 신원 파일을 둘 곳. 주면 단일 인스턴스가 보장된다. */
    identity?: {
        dir: string;
        project: string;
        root: string;
    };
    /** 루프 자체의 말. 기본은 콘솔. */
    log?: (message: string) => void;
    /** 로그를 모아 보내는 간격. 이 요청이 곧 하트비트다. */
    flushMs?: number;
    /** 허브에 못 닿을 때 쉬는 시간. */
    backoffMs?: number;
    /** 일거리가 없을 때 쉬는 시간. 롱폴링이 있으면 0 이어도 된다. */
    idleMs?: number;
    /** 워커가 뜬 직후. 알림 같은 프로젝트 고유 동작을 여기에 건다. */
    onStart?: (machine: string) => void | Promise<void>;
    /** 스스로 끝날 때. 강제 종료에는 불리지 않는다. */
    onExit?: (reason: string) => void | Promise<void>;
}
export declare function runWorkerLoop<Plan extends {
    taskId: number;
}>(opts: WorkerLoopOptions<Plan>): Promise<void>;
//# sourceMappingURL=loop.d.ts.map