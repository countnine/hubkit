export interface WorkerIdentity {
    pid: number;
    /** 프로세스가 시작된 시각. PID 재사용을 가려내는 유일한 근거다. */
    startedAt: string;
    /** 사람이 읽는 이름. 로그와 상태 출력에만 쓴다. */
    project: string;
    /** 이 워커가 속한 프로젝트 루트의 절대 경로. */
    root: string;
    machine: string;
    /** 살려두는 감시 스크립트가 있다면 그 PID. 상주 스크립트가 적는다. */
    keeperPid?: number;
    /**
     * 스스로 끝냈을 때의 기록. **강제 종료에는 남지 않는다** — 그 없음 자체가 진단이다.
     */
    lastExit?: {
        at: string;
        reason: string;
        upSeconds: number;
    };
}
export type VerifyResult = {
    state: 'running';
    identity: WorkerIdentity;
} | {
    state: 'none';
} | {
    state: 'stale';
    reason: string;
    identity: WorkerIdentity;
};
export declare function pidFilePath(dir: string, name?: string): string;
/**
 * 이 프로세스가 시작된 시각.
 *
 * OS 에 묻지 않고 계산한다 — `process.uptime()` 은 런타임이 뜬 뒤의 초이므로
 * 프로세스 생성 시각보다 조금 늦다. 그래서 비교할 때 허용 오차를 둔다.
 */
export declare function selfStartedAt(): string;
/** 그 PID 가 지금 살아 있는가. */
export declare function isAlive(pid: number): boolean;
/**
 * 그 PID 의 시작 시각을 OS 에 묻는다. 모르면 null.
 *
 * 워커가 뜰 때 한 번만 부르므로 윈도우에서 PowerShell 을 띄우는 비용을 감수한다.
 * 여기서 아끼면 PID 재사용을 못 걸러내고, 그러면 이 파일이 존재할 이유가 없다.
 */
export declare function processStartTime(pid: number): Date | null;
export declare function readIdentity(dir: string, name?: string): WorkerIdentity | null;
/**
 * 기록된 워커가 **지금도 그 워커인지** 확인한다.
 *
 * 네 단계를 모두 통과해야 'running' 이다. 하나라도 어긋나면 그 PID 를 건드리지
 * 않는다 — 남의 프로세스일 수 있기 때문이다.
 */
export declare function verify(dir: string, root: string, name?: string): VerifyResult;
/**
 * 이 프로세스를 워커로 등록한다. 이미 살아 있는 워커가 있으면 등록하지 않는다.
 *
 * 단일 인스턴스를 여기서 보장하는 이유: 크롬 프로필은 한 번에 한 곳에서만 열린다.
 * 두 벌이 뜨면 둘째는 '프로필이 이미 사용 중' 으로 끝나는데, 창 없이 도는 워커에서
 * 그 오류는 로그 파일 안에서만 일어나 화면에는 아무 일도 안 하는 워커가 하나 더
 * 있는 것으로 보인다.
 */
export declare function acquire(dir: string, info: {
    project: string;
    root: string;
    machine: string;
}): {
    ok: true;
    identity: WorkerIdentity;
} | {
    ok: false;
    running: WorkerIdentity;
};
/**
 * 스스로 끝났다고 적는다. 파일은 **지우지 않는다** — 마지막 종료 사유가 진단이다.
 *
 * 강제 종료되면 이 함수가 안 불리므로 lastExit 가 없는 채로 남는다. 그 차이가
 * "스스로 끝났나, 밖에서 죽었나" 를 가른다.
 */
export declare function release(dir: string, reason: string): void;
/**
 * 시작 프로그램 항목이나 예약 작업에 붙일, 이 루트만의 꼬리표.
 *
 * git 워크트리가 본체를 덮어쓰는 사고를 막는다 — 워크트리와 본체가 시작 프로그램
 * 폴더에 **같은 파일 이름**을 쓰면, 워크트리에서 설치하는 순간 로그온 자동 시작이
 * 조용히 워크트리를 가리키고 거기서 제거하면 본체 것이 지워진다. 예약 작업 이름에서도
 * 같은 일이 일어난다.
 */
export declare function rootTag(root: string): Promise<string>;
//# sourceMappingURL=identity.d.ts.map