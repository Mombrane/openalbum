import { NETWORK_MESSAGE, visibleMessage } from "../copy";
import { session } from "../session";

export type PerformLogoutResult = { ok: true } | { ok: false; notice: string };

export async function performLogout(
  navigate: (to: string, mode?: "push" | "replace") => void,
): Promise<PerformLogoutResult> {
  const result = await session.logout();
  if (result.ok) {
    navigate("/login", "replace");
    return { ok: true };
  }
  if (result.kind === "network") {
    return { ok: false, notice: NETWORK_MESSAGE };
  }
  return {
    ok: false,
    notice: visibleMessage({
      status: result.status,
      code: result.code,
      serverMessage: result.serverMessage,
      audience: "general",
    }),
  };
}
