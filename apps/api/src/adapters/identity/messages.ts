export const MESSAGES = {
  invalidBody: "请求不合法",
  invalidEmail: "邮箱格式不正确",
  invalidPassword: "密码长度须为 8 到 128",
  invalidName: "名称不合法",
  invalidId: "标识不合法",
  invalidCredentials: "邮箱或密码错误",
  unauthorized: "未授权",
  forbidden: "当前凭证不能执行该操作",
  emailTaken: "该邮箱已注册",
  notFound: "未找到",
} as const;

export type AuthError = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 409;
  code:
    | "validation_error"
    | "invalid_credentials"
    | "unauthorized"
    | "forbidden"
    | "email_taken"
    | "not_found";
  message: string;
};

export type AuthSuccess<T> = { ok: true; status: 200 | 201 | 204; body: T };
export type AuthResult<T> = AuthSuccess<T> | AuthError;

export function unauthorized(): AuthError {
  return { ok: false, status: 401, code: "unauthorized", message: MESSAGES.unauthorized };
}

export function forbidden(): AuthError {
  return { ok: false, status: 403, code: "forbidden", message: MESSAGES.forbidden };
}
