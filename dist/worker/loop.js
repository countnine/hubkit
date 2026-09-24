/**
 * 워커 루프 — 묻고, 하고, 보고하고, 다시 묻는다.
 *
 * 워커에는 자기 데이터베이스도 화면도 스케줄러도 없다. 하는 일은 셋뿐이다:
 * 허브에 일거리를 묻고, 실제로 실행하고, 일어난 일을 즉시 보고한다.
 *
 * 프로젝트가 채우는 것은 `handle` 하나다. 신원 등록, 로그 버퍼링, 하트비트,
 * 취소 수신, 결과 보고, 종료 신호 처리는 전부 여기가 맡는다 — 그 여섯 가지가
 * 프로젝트마다 한 벌씩 있었고, 조금씩 달랐다.
 */
import * as identity from "../process/identity.js";
import { HubClient, HubUnreachable } from "./client.js";
/**
 * 로그를 모아 주기적으로 허브에 밀어 넣고, 돌아오는 취소 신호를 들고 있는다.
 *
 * 줄마다 요청을 보내면 작업 하나에 왕복이 예닐곱 번 생긴다. 반대로 끝에 한 번만
 * 보내면 화면이 몇 분간 조용하다 — 그 사이 사람은 멈춘 줄 안다.
 *
 * 로그가 없어도 보낸다. 이 요청이 리스를 갱신하고 취소를 받아 오므로, **로그가
 * 조용한 구간이 오히려 가장 위험하다.**
 */
class ProgressPump {
    hub;
    taskId;
    flushMs;
    echo;
    buffer = [];
    canceled = false;
    timer;
    constructor(hub, taskId, flushMs, echo) {
        this.hub = hub;
        this.taskId = taskId;
        this.flushMs = flushMs;
        this.echo = echo;
    }
    start() {
        this.timer = setInterval(() => void this.flush(), this.flushMs);
    }
    log = (message) => {
        this.echo(message);
        for (const line of String(message).split('\n'))
            this.buffer.push(line);
    };
    canceledByHub = () => this.canceled;
    async flush() {
        const lines = this.buffer;
        this.buffer = [];
        try {
            const { cancel } = await this.hub.progress(this.taskId, { log: lines });
            if (cancel)
                this.canceled = true;
        }
        catch {
            // 보고가 한 번 실패했다고 실행을 멈추지는 않는다. 다음 주기에 다시 보낸다.
            this.buffer = [...lines, ...this.buffer];
        }
    }
    async stop() {
        if (this.timer)
            clearInterval(this.timer);
        await this.flush();
    }
}
export async function runWorkerLoop(opts) {
    const log = opts.log ?? ((m) => console.log(m));
    const flushMs = opts.flushMs ?? 2_000;
    const backoffMs = opts.backoffMs ?? 15_000;
    const idleMs = opts.idleMs ?? 0;
    const machine = opts.hub.machine;
    /*
     * 신원을 먼저 적는다. 어떻게 띄웠든(상주 스크립트든 터미널에서 직접이든) 여기를
     * 지나므로, 중지 스크립트가 터미널에서 띄운 워커를 못 보던 구멍이 닫힌다.
     *
     * 살아 있는 워커가 이미 있으면 뜨지 않는다 — 브라우저 프로필은 한 번에 한 곳에서만
     * 열려서, 두 벌이 뜨면 둘째는 조용히 아무 일도 못 하는 워커가 된다.
     */
    if (opts.identity) {
        const claim = identity.acquire(opts.identity.dir, {
            project: opts.identity.project,
            root: opts.identity.root,
            machine,
        });
        if (!claim.ok) {
            const other = claim.running;
            throw new Error([
                `이미 워커가 돌고 있습니다 (PID ${other.pid}, ${new Date(other.startedAt).toLocaleString('ko-KR')} 시작).`,
                '브라우저 프로필은 한 번에 한 곳에서만 열리므로 두 번째는 띄우지 않습니다.',
                '멈추려면: npm run worker:stop',
            ].join('\n'));
        }
    }
    const finish = (reason) => {
        if (opts.identity)
            identity.release(opts.identity.dir, reason);
        void opts.onExit?.(reason);
    };
    let stopping = false;
    const onSignal = (signal) => () => {
        stopping = true;
        finish(signal);
        log('\n종료 신호를 받았습니다. 진행 중인 작업을 마치고 멈춥니다.');
    };
    process.on('SIGINT', onSignal('SIGINT'));
    process.on('SIGTERM', onSignal('SIGTERM'));
    await opts.onStart?.(machine);
    try {
        while (!stopping) {
            let plan;
            try {
                plan = await opts.hub.poll(await opts.capabilities(), opts.kinds);
            }
            catch (err) {
                const message = err instanceof HubUnreachable ? err.message : err.message;
                log(`허브 연결 실패: ${message}`);
                await sleep(backoffMs);
                continue;
            }
            if (!plan) {
                if (idleMs > 0)
                    await sleep(idleMs);
                continue;
            }
            await runOne(plan, opts, flushMs, log, () => stopping);
        }
        finish('normal');
    }
    catch (err) {
        finish(`오류: ${err.message.split('\n')[0]}`);
        throw err;
    }
}
/**
 * 작업 하나를 처리하고 **반드시 결과를 보고한다.**
 *
 * 보고를 프로젝트에 맡기면 예외 경로에서 빠뜨리기 쉽다. 그러면 허브 쪽에는
 * '실행 중' 인 작업이 남고, 리스가 만료될 때까지 아무도 그것을 집지 못한다.
 */
async function runOne(plan, opts, flushMs, log, stopping) {
    const pump = new ProgressPump(opts.hub, plan.taskId, flushMs, log);
    pump.start();
    const ctx = {
        hub: opts.hub,
        taskId: plan.taskId,
        log: pump.log,
        shouldStop: () => pump.canceledByHub() || stopping(),
    };
    try {
        const result = await opts.handle(plan, ctx);
        await pump.stop();
        await opts.hub.result(plan.taskId, {
            status: ctx.shouldStop() ? 'canceled' : 'done',
            result,
        });
    }
    catch (err) {
        const message = err.message;
        pump.log(`중단: ${message}`);
        await pump.stop();
        try {
            await opts.hub.result(plan.taskId, { status: 'failed', error: message });
        }
        catch {
            // 보고조차 못 했다. 허브의 리스가 만료되면 회수되므로 다음 작업으로 넘어간다.
            log(`결과를 보고하지 못했습니다 (작업 ${plan.taskId}). 리스 만료로 회수됩니다.`);
        }
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
//# sourceMappingURL=loop.js.map