const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(
  raw: string,
): { ok: true; email: string } | { ok: false; message: "邮箱格式不正确" } {
  const email = raw.trim();
  if (email.length < 1 || email.length > 320 || !EMAIL_RE.test(email)) {
    return { ok: false, message: "邮箱格式不正确" };
  }
  return { ok: true, email };
}

export function validatePassword(
  password: string,
): { ok: true } | { ok: false; message: "密码长度须为 8 到 128" } {
  if (password.length < 8 || password.length > 128) {
    return { ok: false, message: "密码长度须为 8 到 128" };
  }
  return { ok: true };
}
