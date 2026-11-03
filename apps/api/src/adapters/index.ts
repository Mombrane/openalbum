/**
 * 适配层入口。
 *
 * 后续阶段在此编排用例：解析 JWT / API Key、划定事务、把领域结果映射成 DTO。
 * 本层调用领域端口，不直接写 SQL，也不直接调用对象存储或模型 SDK。
 */
export const ADAPTERS_LAYER = "adapters" as const;
