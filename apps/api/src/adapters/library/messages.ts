export const LIBRARY_MESSAGES = {
  invalidBody: "请求不合法",
  invalidId: "标识不合法",
  unsupportedType: "不支持的文件类型",
  invalidSize: "文件大小须为 1 字节到 32 MiB",
  badPart: "分片不合法",
  notFound: "未找到",
  uploadClosed: "上传已结束",
  uploadCompleting: "上传正在完成",
  uploadCompleted: "上传已完成",
  storageError: "对象存储不可用",
  uploadIncomplete: "上传未能完成",
  deleteIncomplete: "删除未能完成",
  notFailed: "照片不在失败状态",
  patchIncomplete: "修改未能完成",
} as const;

export type LibraryError = {
  ok: false;
  status: 400 | 404 | 409 | 500;
  code:
    | "validation_error"
    | "not_found"
    | "upload_closed"
    | "upload_completing"
    | "upload_completed"
    | "storage_error"
    | "internal_error"
    | "not_failed";
  message: string;
};

export type LibrarySuccess<T> = { ok: true; status: 200 | 201 | 204; body: T };
export type LibraryResult<T> = LibrarySuccess<T> | LibraryError;

export function notFound(): LibraryError {
  return { ok: false, status: 404, code: "not_found", message: LIBRARY_MESSAGES.notFound };
}

export function uploadClosed(): LibraryError {
  return { ok: false, status: 409, code: "upload_closed", message: LIBRARY_MESSAGES.uploadClosed };
}

export function uploadCompleting(): LibraryError {
  return { ok: false, status: 409, code: "upload_completing", message: LIBRARY_MESSAGES.uploadCompleting };
}

export function uploadCompleted(): LibraryError {
  return { ok: false, status: 409, code: "upload_completed", message: LIBRARY_MESSAGES.uploadCompleted };
}

export function badPart(): LibraryError {
  return { ok: false, status: 400, code: "validation_error", message: LIBRARY_MESSAGES.badPart };
}

export function storageError(): LibraryError {
  return { ok: false, status: 500, code: "storage_error", message: LIBRARY_MESSAGES.storageError };
}

export function uploadIncomplete(): LibraryError {
  return { ok: false, status: 500, code: "internal_error", message: LIBRARY_MESSAGES.uploadIncomplete };
}

export function deleteIncomplete(): LibraryError {
  return { ok: false, status: 500, code: "internal_error", message: LIBRARY_MESSAGES.deleteIncomplete };
}

export function unsupportedType(): LibraryError {
  return { ok: false, status: 400, code: "validation_error", message: LIBRARY_MESSAGES.unsupportedType };
}

export function invalidSize(): LibraryError {
  return { ok: false, status: 400, code: "validation_error", message: LIBRARY_MESSAGES.invalidSize };
}

export function notFailed(): LibraryError {
  return { ok: false, status: 409, code: "not_failed", message: LIBRARY_MESSAGES.notFailed };
}

export function patchIncomplete(): LibraryError {
  return { ok: false, status: 500, code: "internal_error", message: LIBRARY_MESSAGES.patchIncomplete };
}
