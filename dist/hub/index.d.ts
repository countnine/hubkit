/**
 * 허브 쪽 — 워커의 말을 받는 창구.
 *
 * express 를 **peerDependency** 로 쓴다. 소비 프로젝트가 이미 자기 express 를 들고
 * 있고, 여기서 한 벌 더 가져오면 라우터가 다른 express 의 것이 되어 미들웨어가
 * 어긋난다.
 */
export { workerRouter, type WorkerRoutesOptions, type WorkerRoutesPorts, } from './worker-routes.ts';
//# sourceMappingURL=index.d.ts.map