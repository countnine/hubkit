/**
 * 워커 프로세스의 신원.
 *
 * 이 파일이 있는 이유는 사고 하나다. 상주 스크립트가 워커를 **명령줄 문자열**로 찾았다:
 *
 *     Where-Object { $_.CommandLine -like '*src/index.ts worker*' }
 *
 * 한 PC 에서 같은 모양의 워커가 여러 개 돌고 있었고(형제 프로젝트들이 전부
 * `src/index.ts worker` 로 끝난다), 한 프로젝트에서 `-Stop` 한 번이
 * **다른 프로젝트의 워커 세 개를 같이 죽였다.**
 * 절대 경로를 박아 급히 막았지만 그것은 메커니즘이 아니라 문자열 관습이다 —
 * 런처가 한 줄만 바뀌면 다시 무장된다.
 *
 * 그래서 신원을 프로세스가 **스스로 적는다.** 누가 어떻게 띄웠든(상주 스크립트든
 * 터미널의 `npm run worker` 든) 이 파일이 남고, 죽이려는 쪽은 이 파일만 본다.
 *
 * 핵심은 `startedAt` 이다. PID 는 재사용되므로 "그 번호가 살아 있다" 만으로는
 * 아무것도 보장하지 못한다 — 같은 저장소의 다른 스크립트에 `Stop-Process -Id 10216`
 * 이 하드코딩돼 있고, 그게 정확히 이 부류의 사고다. 기록된 시작 시각과 지금 그
 * PID 의 시작 시각이 **같아야만** 같은 프로세스다.
 *
 * 어느 프로젝트에도 의존하지 않는다 — 경로는 전부 인자로 받는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
  lastExit?: { at: string; reason: string; upSeconds: number };
}

export type VerifyResult =
  | { state: 'running'; identity: WorkerIdentity }
  | { state: 'none' }
  | { state: 'stale'; reason: string; identity: WorkerIdentity };

/** 시작 시각 비교 허용 오차. */
const START_TOLERANCE_MS = 15_000;

export function pidFilePath(dir: string, name = 'worker'): string {
  return path.join(dir, `${name}.pid`);
}

/**
 * 이 프로세스가 시작된 시각.
 *
 * OS 에 묻지 않고 계산한다 — `process.uptime()` 은 런타임이 뜬 뒤의 초이므로
 * 프로세스 생성 시각보다 조금 늦다. 그래서 비교할 때 허용 오차를 둔다.
 */
export function selfStartedAt(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

/** 그 PID 가 지금 살아 있는가. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // 시그널 0 은 아무것도 보내지 않고 존재만 확인한다.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 은 "있지만 내 것이 아니다" — 살아 있는 것이 맞다.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 그 PID 의 시작 시각을 OS 에 묻는다. 모르면 null.
 *
 * 워커가 뜰 때 한 번만 부르므로 윈도우에서 PowerShell 을 띄우는 비용을 감수한다.
 * 여기서 아끼면 PID 재사용을 못 걸러내고, 그러면 이 파일이 존재할 이유가 없다.
 */
export function processStartTime(pid: number): Date | null {
  if (!isAlive(pid)) return null;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString('o')`,
        ],
        { encoding: 'utf8', timeout: 15_000, windowsHide: true },
      ).trim();
      const at = new Date(out);
      return Number.isNaN(at.getTime()) ? null : at;
    }

    // 리눅스: /proc/<pid>/stat 의 22번째 필드가 부팅 이후 클럭틱 단위 시작 시각이다.
    // 괄호 안의 실행 파일 이름에 공백이 있을 수 있어 마지막 ')' 뒤부터 센다.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(after[19]);
    if (!Number.isFinite(ticks)) return null;
    const uptimeSec = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    const bootMs = Date.now() - uptimeSec * 1000;
    return new Date(bootMs + (ticks / 100) * 1000);
  } catch {
    return null;
  }
}

export function readIdentity(dir: string, name = 'worker'): WorkerIdentity | null {
  try {
    const raw = fs.readFileSync(pidFilePath(dir, name), 'utf8');
    const parsed = JSON.parse(raw) as WorkerIdentity;
    return typeof parsed?.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 기록된 워커가 **지금도 그 워커인지** 확인한다.
 *
 * 네 단계를 모두 통과해야 'running' 이다. 하나라도 어긋나면 그 PID 를 건드리지
 * 않는다 — 남의 프로세스일 수 있기 때문이다.
 */
export function verify(dir: string, root: string, name = 'worker'): VerifyResult {
  const identity = readIdentity(dir, name);
  if (!identity) return { state: 'none' };

  // 1. 이 기록이 이 프로젝트의 것인가. 워크트리나 복사본이 같은 폴더를 보는 경우를 가른다.
  if (path.resolve(identity.root).toLowerCase() !== path.resolve(root).toLowerCase()) {
    return { state: 'stale', reason: '다른 프로젝트 루트의 기록입니다', identity };
  }

  // 2. 살아 있는가.
  if (!isAlive(identity.pid)) {
    return { state: 'stale', reason: '기록된 프로세스가 없습니다', identity };
  }

  // 3. 그 PID 가 **같은 프로세스**인가. PID 는 재사용된다.
  const actual = processStartTime(identity.pid);
  if (actual) {
    const recorded = Date.parse(identity.startedAt);
    if (Number.isFinite(recorded) && Math.abs(actual.getTime() - recorded) > START_TOLERANCE_MS) {
      return {
        state: 'stale',
        reason: `PID ${identity.pid} 는 다른 프로세스입니다 (시작 시각 불일치)`,
        identity,
      };
    }
  }

  return { state: 'running', identity };
}

/**
 * 이 프로세스를 워커로 등록한다. 이미 살아 있는 워커가 있으면 등록하지 않는다.
 *
 * 단일 인스턴스를 여기서 보장하는 이유: 크롬 프로필은 한 번에 한 곳에서만 열린다.
 * 두 벌이 뜨면 둘째는 '프로필이 이미 사용 중' 으로 끝나는데, 창 없이 도는 워커에서
 * 그 오류는 로그 파일 안에서만 일어나 화면에는 아무 일도 안 하는 워커가 하나 더
 * 있는 것으로 보인다.
 */
export function acquire(
  dir: string,
  info: { project: string; root: string; machine: string },
): { ok: true; identity: WorkerIdentity } | { ok: false; running: WorkerIdentity } {
  fs.mkdirSync(dir, { recursive: true });

  const existing = verify(dir, info.root);
  if (existing.state === 'running' && existing.identity.pid !== process.pid) {
    return { ok: false, running: existing.identity };
  }

  const identity: WorkerIdentity = {
    pid: process.pid,
    startedAt: selfStartedAt(),
    project: info.project,
    root: path.resolve(info.root),
    machine: info.machine,
  };
  fs.writeFileSync(pidFilePath(dir), JSON.stringify(identity, null, 2), 'utf8');
  return { ok: true, identity };
}

/**
 * 스스로 끝났다고 적는다. 파일은 **지우지 않는다** — 마지막 종료 사유가 진단이다.
 *
 * 강제 종료되면 이 함수가 안 불리므로 lastExit 가 없는 채로 남는다. 그 차이가
 * "스스로 끝났나, 밖에서 죽었나" 를 가른다.
 */
export function release(dir: string, reason: string): void {
  const identity = readIdentity(dir);
  if (!identity || identity.pid !== process.pid) return;
  identity.lastExit = {
    at: new Date().toISOString(),
    reason,
    upSeconds: Math.round(process.uptime()),
  };
  try {
    fs.writeFileSync(pidFilePath(dir), JSON.stringify(identity, null, 2), 'utf8');
  } catch {
    // 기록에 실패했다고 종료를 막을 이유는 없다.
  }
}

/**
 * 시작 프로그램 항목이나 예약 작업에 붙일, 이 루트만의 꼬리표.
 *
 * git 워크트리가 본체를 덮어쓰는 사고를 막는다 — 워크트리와 본체가 시작 프로그램
 * 폴더에 **같은 파일 이름**을 쓰면, 워크트리에서 설치하는 순간 로그온 자동 시작이
 * 조용히 워크트리를 가리키고 거기서 제거하면 본체 것이 지워진다. 예약 작업 이름에서도
 * 같은 일이 일어난다.
 */
export async function rootTag(root: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 8);
}
