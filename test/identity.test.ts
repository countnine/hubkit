/**
 * 워커 신원 고정물.
 *
 * 여기서 틀리면 **남의 프로세스를 죽인다.** 실제로 한 프로젝트의 `-Stop` 한 번이
 * 다른 프로젝트의 워커 세 개를 같이 죽인 적이 있고, 그 사고를 막으려고 만든 것이
 * 이 모듈이다. 그러니 "죽여도 되는가" 를 판정하는 네 갈래를 전부 못 박는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquire,
  isAlive,
  pidFilePath,
  processStartTime,
  readIdentity,
  release,
  rootTag,
  selfStartedAt,
  verify,
  type WorkerIdentity,
} from '../src/process/identity.ts';

function tmp(): { dir: string; root: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hubkit-identity-'));
  return { dir, root: path.join(dir, 'project') };
}

function writeRaw(dir: string, identity: Partial<WorkerIdentity>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidFilePath(dir), JSON.stringify(identity), 'utf8');
}

test('기록이 없으면 돌고 있지 않다', () => {
  const { dir, root } = tmp();
  assert.equal(verify(dir, root).state, 'none');
});

test('이 프로세스를 등록하면 살아 있는 것으로 보인다', () => {
  const { dir, root } = tmp();
  const got = acquire(dir, { project: 'test', root, machine: 'm4a' });
  assert.ok(got.ok);

  const result = verify(dir, root);
  assert.equal(result.state, 'running');
  assert.equal(result.state === 'running' && result.identity.pid, process.pid);
});

test('죽은 PID 의 기록은 오래된 것으로 본다', () => {
  const { dir, root } = tmp();
  // 확실히 존재하지 않는 PID. 살아 있는 번호를 골라 쓰면 테스트가 남의 프로세스에 의존한다.
  writeRaw(dir, { pid: 0x7ffffffe, startedAt: new Date().toISOString(), root, project: 't', machine: 'm' });
  const result = verify(dir, root);
  assert.equal(result.state, 'stale');
  assert.match(result.state === 'stale' ? result.reason : '', /프로세스가 없습니다/);
});

test('살아 있는 PID 라도 시작 시각이 다르면 다른 프로세스다', () => {
  const { dir, root } = tmp();
  // 이 테스트가 이 파일의 핵심이다. PID 는 재사용되므로 "살아 있다" 만 보고 죽이면
  // 그 번호를 물려받은 남의 프로세스를 죽인다 — 저장소 어딘가에 하드코딩된
  // `Stop-Process -Id 10216` 이 정확히 그 부류의 사고다.
  writeRaw(dir, {
    pid: process.pid,
    startedAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
    root,
    project: 't',
    machine: 'm',
  });
  const result = verify(dir, root);
  assert.equal(result.state, 'stale');
  assert.match(result.state === 'stale' ? result.reason : '', /다른 프로세스/);
});

test('다른 프로젝트 루트의 기록은 건드리지 않는다', () => {
  const { dir, root } = tmp();
  writeRaw(dir, {
    pid: process.pid,
    startedAt: selfStartedAt(),
    root: path.join(root, '..', 'other-project'),
    project: 'other',
    machine: 'm',
  });
  const result = verify(dir, root);
  assert.equal(result.state, 'stale');
  assert.match(result.state === 'stale' ? result.reason : '', /다른 프로젝트/);
});

test('이미 도는 워커가 있으면 두 번째는 등록되지 않는다', () => {
  const { dir, root } = tmp();
  // 살아 있는 다른 프로세스를 흉내 낸다 — 부모 PID 는 이 테스트를 띄운 셸이라 살아 있다.
  const otherPid = process.ppid;
  const started = processStartTime(otherPid);
  if (!started) {
    // 시작 시각을 못 읽는 환경이면 이 시나리오를 만들 수 없다. 건너뛴다.
    return;
  }
  writeRaw(dir, {
    pid: otherPid,
    startedAt: started.toISOString(),
    root,
    project: 't',
    machine: 'm',
  });

  const got = acquire(dir, { project: 't', root, machine: 'm4a' });
  assert.equal(got.ok, false);
  assert.equal(got.ok === false && got.running.pid, otherPid);
  // 남의 기록을 덮어쓰지 않았는지 확인한다
  assert.equal(readIdentity(dir)?.pid, otherPid);
});

test('오래된 기록 위에는 새로 등록된다', () => {
  const { dir, root } = tmp();
  writeRaw(dir, { pid: 0x7ffffffe, startedAt: new Date().toISOString(), root, project: 't', machine: 'm' });
  const got = acquire(dir, { project: 't', root, machine: 'm4a' });
  assert.ok(got.ok);
  assert.equal(readIdentity(dir)?.pid, process.pid);
});

test('스스로 끝내면 종료 사유가 남는다 — 없으면 밖에서 죽은 것이다', () => {
  const { dir, root } = tmp();
  acquire(dir, { project: 't', root, machine: 'm4a' });
  assert.equal(readIdentity(dir)?.lastExit, undefined);

  release(dir, 'SIGTERM');
  const after = readIdentity(dir);
  assert.equal(after?.lastExit?.reason, 'SIGTERM');
  assert.ok(typeof after?.lastExit?.upSeconds === 'number');
  // 파일은 지우지 않는다 — 마지막 종료 사유 자체가 진단이다
  assert.equal(after?.pid, process.pid);
});

test('남의 기록에는 종료 사유를 쓰지 않는다', () => {
  const { dir, root } = tmp();
  writeRaw(dir, { pid: 0x7ffffffe, startedAt: new Date().toISOString(), root, project: 't', machine: 'm' });
  release(dir, 'SIGTERM');
  assert.equal(readIdentity(dir)?.lastExit, undefined);
});

test('isAlive 는 이 프로세스를 살아 있다고 답한다', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(0x7ffffffe), false);
  assert.equal(isAlive(-1), false);
});

test('루트가 다르면 꼬리표도 다르다 — 워크트리가 본체를 덮어쓰지 않는다', async () => {
  // 워크트리와 본체가 시작 프로그램 폴더에 같은 파일 이름을 쓰던
  // 사고를 막는 값이다.
  const a = await rootTag('C:\\Users\\AC305\\project\\npayEvent');
  const b = await rootTag('C:\\Users\\AC305\\project\\_wt\\npayevent-x');
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{8}$/);
  // 대소문자만 다른 같은 경로는 같은 꼬리표여야 한다
  assert.equal(a, await rootTag('c:\\users\\ac305\\project\\npayevent'));
});
