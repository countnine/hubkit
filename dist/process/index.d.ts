/**
 * 워커 프로세스 관리.
 *
 * 지금은 신원(PID 파일)뿐이다. 상주·중지 스크립트는 `scripts/worker-service.ps1`
 * 에 있고, 소비 프로젝트는 그것을 얇은 래퍼로 부른다.
 */
export { acquire, isAlive, pidFilePath, processStartTime, readIdentity, release, rootTag, selfStartedAt, verify, type VerifyResult, type WorkerIdentity, } from './identity.ts';
//# sourceMappingURL=index.d.ts.map