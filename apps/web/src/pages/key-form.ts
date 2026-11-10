export type ValidateKeyNameResult =
  | { ok: true; name: string }
  | { ok: false; message: "名称不合法" };

const INVALID_CONTROLS = /[\u0000\u007f]/;

export function validateKeyName(raw: string): ValidateKeyNameResult {
  const name = raw.trim();
  if (name.length === 0 || name.length > 64 || INVALID_CONTROLS.test(name)) {
    return { ok: false, message: "名称不合法" };
  }
  return { ok: true, name };
}
