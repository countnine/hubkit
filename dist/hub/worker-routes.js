import { timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * 토큰 비교.
 *
 * 길이를 먼저 본다 — `timingSafeEqual` 은 길이가 다르면 **예외를 던진다.** 이 한 줄이
 * 없으면 틀린 길이의 토큰 하나가 500 을 만들고, 그것은 401 보다 많은 것을 알려 준다.
 */
function tokenOk(header, expected) {
    const got = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (got.length !== expected.length)
        return false;
    return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
function taskIdOf(req) {
    return Number(req.params.id);
}
/**
 * 이 요청을 보낸 기기.
 *
 * 본문과 헤더 둘 다 본다 — 세 프로젝트가 여기서 갈렸다(둘은 본문의 `machine`,
 * 하나는 `X-Worker-Machine` 헤더). 어느 쪽이든 받으면 프로젝트가 고를 일이 없다.
 */
function machineOf(req) {
    const body = (req.body ?? {});
    const fromBody = typeof body.machine === 'string' ? body.machine : '';
    return (fromBody || String(req.get('X-Worker-Machine') ?? '')).slice(0, 100);
}
/**
 * 이 기기가 할 수 있는 일.
 *
 * 이름이 프로젝트마다 다르다 — `profiles`(계정 프로필), `sessions`(로그인 세션),
 * `capabilities`(둘을 아우르려 나중에 붙인 이름). 셋 다 받는다.
 */
function capabilitiesOf(req) {
    const body = (req.body ?? {});
    for (const key of ['capabilities', 'profiles', 'sessions']) {
        const value = body[key];
        if (Array.isArray(value))
            return value.map(String).slice(0, 200);
    }
    return [];
}
function kindsOf(req) {
    const body = (req.body ?? {});
    return Array.isArray(body.kinds) ? body.kinds.map(String) : undefined;
}
/**
 * 워커용 라우터를 만든다. 앱에 붙이는 것은 호출자가 한다:
 *
 * ```ts
 * app.use(`${basePath}/api/worker`, workerRouter({ ... }));
 * ```
 */
export function workerRouter(opts) {
    // express 를 값으로 쓰지 않으면 Router 를 만들 수 없다. 타입만 가져오면 런타임에 없다.
    const { Router: makeRouter } = requireExpress();
    const router = makeRouter();
    const longPollMs = opts.longPollMs ?? 25_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 700;
    const readToken = () => typeof opts.token === 'function' ? opts.token() : opts.token;
    const parse = opts.jsonBody ? [opts.jsonBody] : [];
    const onError = opts.onError ??
        ((res, err) => {
            console.error('[worker] 요청 처리 실패', err);
            res.status(500).json({ error: err.message });
        });
    router.use((req, res, next) => {
        const expected = readToken();
        if (!expected) {
            return res.status(503).json({
                error: opts.tokenMissingMessage ?? '워커 토큰이 설정되지 않아 워커를 받지 않습니다.',
            });
        }
        if (opts.protocol !== undefined && req.get('X-Worker-Protocol') !== opts.protocol) {
            return res.status(426).json({
                error: `워커 프로토콜이 맞지 않습니다 (허브 ${opts.protocol}). 워커를 다시 배포하세요.`,
            });
        }
        if (!tokenOk(req.get('Authorization'), expected)) {
            return res.status(401).json({ error: '워커 토큰이 올바르지 않습니다.' });
        }
        if (opts.requireMachineHeader && !req.get('X-Worker-Machine')) {
            return res.status(400).json({ error: 'X-Worker-Machine 헤더가 필요합니다.' });
        }
        return next();
    });
    /**
     * 일거리를 받아 간다. 없으면 정해진 시간만큼 붙잡고 기다린 뒤 204.
     *
     * 롱폴링인 이유: 화면에서 누른 [실행] 이 고정 주기 폴링이면 평균 절반을 기다린다.
     * 붙잡아 두면 일이 생기는 순간 바로 나가고, 워커는 이미 열린 연결을 쓴다.
     */
    router.post('/poll', ...parse, async (req, res) => {
        try {
            const machine = machineOf(req);
            if (!machine)
                return res.status(400).json({ error: 'machine 이 필요합니다.' });
            const capabilities = capabilitiesOf(req);
            const kinds = kindsOf(req);
            opts.ports.seen?.(machine, kinds);
            opts.ports.capabilities?.(machine, capabilities);
            const until = Date.now() + longPollMs;
            /*
             * 워커가 연결을 끊으면(재시작·네트워크) 더 붙잡고 있을 이유가 없다. 죽은 연결을
             * 위해 작업을 집어 주면 그 작업은 리스 만료까지 묶인다.
             *
             * **`res` 를 본다. `req` 가 아니다.** express 5 에서 `req.on('close')` 는 본문을
             * 다 읽은 직후 발화한다 — 클라이언트가 멀쩡히 기다리고 있어도 그렇다. 세
             * 프로젝트가 전부 `req` 를 보고 있었고, 그래서 **롱폴링이 실제로는 없었다**:
             * 25초를 붙잡을 자리에서 즉시 204 를 돌려줬다. 실측으로 확인했다 —
             * express 5.2.1, `req` 는 134ms, `res` 는 1571ms(기대 1500ms). 끊김도 `res` 가
             * 잡는다(300ms 에 끊으면 310ms 에 감지).
             *
             * 이것이 조용했던 이유: 204 는 정상 응답이라 아무 데도 오류로 남지 않고, 워커는
             * 그냥 더 자주 물어봤다. npayEvent 워커는 idleMs 가 0 이라 **쉬지 않고** 물었다.
             */
            let closed = false;
            res.on('close', () => {
                closed = true;
            });
            for (;;) {
                const task = opts.ports.claim({ machine, capabilities, kinds });
                if (task)
                    return res.json({ task });
                if (closed || Date.now() >= until)
                    break;
                await sleep(pollIntervalMs);
            }
            return res.status(204).end();
        }
        catch (err) {
            return onError(res, err);
        }
    });
    /** 하트비트 겸 로그. 리스를 갱신하고 취소 여부를 알려 준다. */
    router.post(opts.progressPath ?? '/progress/:id', ...parse, (req, res) => {
        try {
            const { log, progress } = (req.body ?? {});
            res.json(opts.ports.progress(taskIdOf(req), { log, progress }, { machine: machineOf(req) }));
        }
        catch (err) {
            onError(res, err);
        }
    });
    if (opts.resultPath !== null) {
        router.post(opts.resultPath ?? '/result/:id', ...parse, (req, res) => {
            try {
                const report = (req.body ?? {});
                if (!report.status) {
                    return res.status(400).json({ error: 'status 가 필요합니다.' });
                }
                if (!opts.ports.finish) {
                    return res.status(500).json({ error: 'finish 포트가 없습니다.' });
                }
                opts.ports.finish(taskIdOf(req), { status: report.status, error: report.error, result: report.result }, { machine: machineOf(req) });
                return res.json({ ok: true });
            }
            catch (err) {
                return onError(res, err);
            }
        });
    }
    opts.extend?.(router);
    return router;
}
/**
 * express 를 런타임에 가져온다.
 *
 * peerDependency 로 두는 이유: 세 프로젝트가 이미 자기 express 를 쓰고 있고, 여기서
 * 한 벌 더 들고 오면 라우터 인스턴스가 다른 express 것이 되어 미들웨어가 어긋난다.
 */
function requireExpress() {
    const mod = createRequire(import.meta.url)('express');
    return 'Router' in mod ? mod : mod.default;
}
//# sourceMappingURL=worker-routes.js.map