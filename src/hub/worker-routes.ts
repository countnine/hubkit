/**
 * 워커가 일을 받아 가고 결과를 돌려주는 자리 — 허브 쪽.
 *
 * **사람이 쓰는 화면과 다른 인증을 쓴다.** 화면 쪽 경계(세션 토큰·루프백·tailnet)를
 * 손볼 때 눈앞에 없는 PC 의 워커 연결이 조용히 끊기면, 그날 할 일이 통째로 날아가고
 * 아무도 이유를 모른다. 그래서 별도의 공유 토큰을 쓴다.
 *
 * 그리고 이 라우트들은 **화면용 검사보다 먼저** 등록해야 한다. 스크립트가 보내는
 * POST 라 브라우저가 붙이는 헤더(`Origin` 등)가 없고, 화면용 검사는 그런 POST 를
 * 403 으로 막는다.
 *
 * ## 무엇이 여기 있고 무엇이 프로젝트에 남는가
 *
 * 여기 있는 것은 **세 프로젝트가 글자까지 같던 것**들이다: 토큰 검사(timingSafeEqual
 * 의 길이 함정 포함), 롱폴링 루프, 진행 보고, 끝맺음. 저장은 `ports` 로 넘긴다 —
 * 테이블 모양은 프로젝트마다 다르고, 이 파일이 그것을 알면 프로젝트가 늘 때마다
 * 자란다.
 *
 * 프로젝트 고유 라우트는 `extend` 로 얹는다.
 */
import type express from 'express';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';

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
  /** 하트비트 겸 로그. 리스를 갱신하고 취소 여부를 돌려준다. */
  progress(
    taskId: number,
    patch: { log?: string[]; progress?: unknown },
  ): { cancel: boolean };
  /** 끝맺음. `resultPath: null` 로 공용 라우트를 끄면 필요 없다. */
  finish?(
    taskId: number,
    report: { status: string; error?: string; result?: unknown },
  ): void;
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 토큰 비교.
 *
 * 길이를 먼저 본다 — `timingSafeEqual` 은 길이가 다르면 **예외를 던진다.** 이 한 줄이
 * 없으면 틀린 길이의 토큰 하나가 500 을 만들고, 그것은 401 보다 많은 것을 알려 준다.
 */
function tokenOk(header: string | undefined, expected: string): boolean {
  const got = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

function taskIdOf(req: Request): number {
  return Number(req.params.id);
}

/**
 * 이 요청을 보낸 기기.
 *
 * 본문과 헤더 둘 다 본다 — 세 프로젝트가 여기서 갈렸다(둘은 본문의 `machine`,
 * 하나는 `X-Worker-Machine` 헤더). 어느 쪽이든 받으면 프로젝트가 고를 일이 없다.
 */
function machineOf(req: Request): string {
  const body = (req.body ?? {}) as { machine?: unknown };
  const fromBody = typeof body.machine === 'string' ? body.machine : '';
  return (fromBody || String(req.get('X-Worker-Machine') ?? '')).slice(0, 100);
}

/**
 * 이 기기가 할 수 있는 일.
 *
 * 이름이 프로젝트마다 다르다 — `profiles`(계정 프로필), `sessions`(로그인 세션),
 * `capabilities`(둘을 아우르려 나중에 붙인 이름). 셋 다 받는다.
 */
function capabilitiesOf(req: Request): string[] {
  const body = (req.body ?? {}) as Record<string, unknown>;
  for (const key of ['capabilities', 'profiles', 'sessions']) {
    const value = body[key];
    if (Array.isArray(value)) return value.map(String).slice(0, 200);
  }
  return [];
}

function kindsOf(req: Request): string[] | undefined {
  const body = (req.body ?? {}) as { kinds?: unknown };
  return Array.isArray(body.kinds) ? body.kinds.map(String) : undefined;
}

/**
 * 워커용 라우터를 만든다. 앱에 붙이는 것은 호출자가 한다:
 *
 * ```ts
 * app.use(`${basePath}/api/worker`, workerRouter({ ... }));
 * ```
 */
export function workerRouter(opts: WorkerRoutesOptions): Router {
  // express 를 값으로 쓰지 않으면 Router 를 만들 수 없다. 타입만 가져오면 런타임에 없다.
  const { Router: makeRouter } = requireExpress();
  const router = makeRouter();

  const longPollMs = opts.longPollMs ?? 25_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 700;
  const readToken = (): string | undefined =>
    typeof opts.token === 'function' ? opts.token() : opts.token;
  const parse: RequestHandler[] = opts.jsonBody ? [opts.jsonBody] : [];

  const onError =
    opts.onError ??
    ((res: Response, err: unknown): void => {
      console.error('[worker] 요청 처리 실패', err);
      res.status(500).json({ error: (err as Error).message });
    });

  router.use((req: Request, res: Response, next: NextFunction) => {
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
  router.post('/poll', ...parse, async (req: Request, res: Response) => {
    try {
      const machine = machineOf(req);
      if (!machine) return res.status(400).json({ error: 'machine 이 필요합니다.' });

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
        if (task) return res.json({ task });
        if (closed || Date.now() >= until) break;
        await sleep(pollIntervalMs);
      }
      return res.status(204).end();
    } catch (err) {
      return onError(res, err) as unknown as Response;
    }
  });

  /** 하트비트 겸 로그. 리스를 갱신하고 취소 여부를 알려 준다. */
  router.post(
    opts.progressPath ?? '/progress/:id',
    ...parse,
    (req: Request, res: Response) => {
      try {
        const { log, progress } = (req.body ?? {}) as { log?: string[]; progress?: unknown };
        res.json(opts.ports.progress(taskIdOf(req), { log, progress }));
      } catch (err) {
        onError(res, err);
      }
    },
  );

  if (opts.resultPath !== null) {
    router.post(
      opts.resultPath ?? '/result/:id',
      ...parse,
      (req: Request, res: Response) => {
        try {
          const report = (req.body ?? {}) as {
            status?: string;
            error?: string;
            result?: unknown;
          };
          if (!report.status) {
            return res.status(400).json({ error: 'status 가 필요합니다.' });
          }
          if (!opts.ports.finish) {
            return res.status(500).json({ error: 'finish 포트가 없습니다.' });
          }
          opts.ports.finish(taskIdOf(req), {
            status: report.status,
            error: report.error,
            result: report.result,
          });
          return res.json({ ok: true });
        } catch (err) {
          return onError(res, err) as unknown as Response;
        }
      },
    );
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
function requireExpress(): typeof express {
  const mod = createRequire(import.meta.url)('express') as
    | typeof express
    | { default: typeof express };
  return 'Router' in mod ? mod : mod.default;
}
