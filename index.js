/**
 * Host half（宿主半）。
 *
 * 合并版把状态、时间线、持久化全部放在客户端算，因此宿主半**不需要任何东西**：
 * 不起子进程、不开本地端口、不读 endpoint.json、不做健康轮询。
 * （旧版 agent-pet 那套 C# Server + 9800 端口 + history.json 已经随合并一起退役。）
 */
export function apply() {}
