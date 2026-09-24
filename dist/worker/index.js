/**
 * 워커 쪽 — 허브에 묻고, 일하고, 보고한다.
 *
 * 프로젝트가 채우는 것은 `handle` 하나다. 나머지(신원·로그 버퍼링·하트비트·
 * 취소 수신·결과 보고·종료 신호)는 이쪽이 맡는다.
 */
export { HubClient, HubError, HubUnreachable, } from "./client.js";
export { runWorkerLoop, } from "./loop.js";
//# sourceMappingURL=index.js.map