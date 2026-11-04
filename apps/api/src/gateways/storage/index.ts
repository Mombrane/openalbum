/** 对象存储网关占位（Phase 2 实现 S3 兼容上传与读取）。 */
export const STORAGE_GATEWAY = "storage" as const;

export { loadStorageConfig, type StorageConfig } from "./config.js";
export { createFakeObjectStorage, createStorageGate, type FakeObjectStorage, type StorageGate } from "./fake-object-storage.js";
export { createS3ObjectStorage } from "./s3-object-storage.js";
