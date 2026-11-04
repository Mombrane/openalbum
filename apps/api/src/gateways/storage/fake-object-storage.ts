import { createHash } from "node:crypto";
import type { ObjectStorage } from "../../domain/library/ports.js";

export type StorageGate = {
  entered: Promise<void>;
  signalEntered(): void;
  wait(): Promise<void>;
  release(): void;
};

export function createStorageGate(): StorageGate {
  let signalEntered: () => void = () => undefined;
  let releaseWait: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const waitPromise = new Promise<void>((resolve) => {
    releaseWait = resolve;
  });
  return {
    entered,
    signalEntered,
    wait: () => waitPromise,
    release: () => releaseWait(),
  };
}

type MultipartRecord = {
  key: string;
  contentType: string;
  parts: Map<number, Buffer>;
};

export type FakeObjectStorage = ObjectStorage & {
  completeCalls: number;
  abortCount: number;
  deletedKeys: string[];
  failDelete: boolean;
  failComplete: boolean;
  failAbort: boolean;
  failUploadPart: boolean;
  failHeadObject: boolean;
  completeAsNoSuchUpload: boolean;
  createCalls: number;
  blockComplete(gate: StorageGate | null): void;
  completedBytes(key: string): Buffer | null;
};

export function createFakeObjectStorage(): FakeObjectStorage {
  const uploads = new Map<string, MultipartRecord>();
  const completed = new Map<string, Buffer>();
  let completeGate: StorageGate | null = null;
  let nextUploadId = 0;

  const storage: FakeObjectStorage = {
    completeCalls: 0,
    abortCount: 0,
    deletedKeys: [],
    failDelete: false,
    failComplete: false,
    failAbort: false,
    failUploadPart: false,
    failHeadObject: false,
    completeAsNoSuchUpload: false,
    createCalls: 0,

    blockComplete(gate: StorageGate | null) {
      completeGate = gate;
    },

    completedBytes(key: string): Buffer | null {
      return completed.get(key) ?? null;
    },

    async createMultipartUpload(input) {
      storage.createCalls += 1;
      nextUploadId += 1;
      const uploadId = createHash("sha256").update(`${input.key}:${nextUploadId}`).digest("hex").slice(0, 32);
      uploads.set(uploadId, { key: input.key, contentType: input.contentType, parts: new Map() });
      return { uploadId };
    },

    async uploadPart(input) {
      if (storage.failUploadPart) {
        throw Object.assign(new Error("hidden"), { name: "InternalError" });
      }
      const record = uploads.get(input.uploadId);
      if (!record || record.key !== input.key) {
        throw Object.assign(new Error("hidden"), { name: "NoSuchUpload" });
      }
      record.parts.set(input.partNumber, Buffer.from(input.body));
      const etag = createHash("md5").update(input.body).digest("hex");
      return { etag, byteSize: input.body.length };
    },

    async completeMultipartUpload(input) {
      storage.completeCalls += 1;
      if (storage.completeAsNoSuchUpload) {
        throw Object.assign(new Error("hidden"), { name: "NoSuchUpload" });
      }
      const record = uploads.get(input.uploadId);
      if (!record || record.key !== input.key) {
        throw Object.assign(new Error("hidden"), { name: "NoSuchUpload" });
      }
      if (completeGate) {
        completeGate.signalEntered();
        await completeGate.wait();
      }
      if (storage.failComplete) {
        throw Object.assign(new Error("hidden"), { name: "InternalError" });
      }
      const chunks: Buffer[] = [];
      for (const part of input.parts) {
        const body = record.parts.get(part.partNumber);
        if (!body) {
          throw Object.assign(new Error("hidden"), { name: "InvalidPart" });
        }
        chunks.push(body);
      }
      completed.set(input.key, Buffer.concat(chunks));
      uploads.delete(input.uploadId);
    },

    async abortMultipartUpload(input) {
      storage.abortCount += 1;
      if (storage.failAbort) {
        throw Object.assign(new Error("hidden"), { name: "InternalError" });
      }
      const record = uploads.get(input.uploadId);
      if (!record || record.key !== input.key) {
        return;
      }
      uploads.delete(input.uploadId);
    },

    async headObject(input) {
      if (storage.failHeadObject) {
        throw Object.assign(new Error("hidden"), { name: "InternalError" });
      }
      const body = completed.get(input.key);
      if (!body) return null;
      return { byteSize: body.length };
    },

    async deleteObject(input) {
      storage.deletedKeys.push(input.key);
      if (storage.failDelete) {
        throw Object.assign(new Error("hidden"), { name: "AccessDenied" });
      }
      completed.delete(input.key);
    },

    async presignGet(input) {
      const expiresAt = new Date(input.now.getTime() + input.expiresInSeconds * 1000);
      const url = `http://storage.invalid/get?key=${encodeURIComponent(input.key)}&exp=${Math.floor(expiresAt.getTime() / 1000)}`;
      return { url, expiresAt };
    },
  };

  return storage;
}
