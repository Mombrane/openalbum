import { useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { NETWORK_MESSAGE, SESSION_EXPIRED, visibleMessage } from "../copy";
import { consumeReturnTo } from "../router";
import { session } from "../session";
import { validateEmail, validatePassword } from "./auth-form";

type LoginPageProps = {
  onNavigate: (to: string, mode?: "push" | "replace") => void;
};

export function LoginPage({ onNavigate }: LoginPageProps) {
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [summary, setSummary] = useState<string | null>(() => {
    const notice = session.getSnapshot().notice;
    return notice === SESSION_EXPIRED ? notice : null;
  });
  const [submitting, setSubmitting] = useState(false);

  const focusSummary = () => {
    requestAnimationFrame(() => {
      summaryRef.current?.focus();
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const emailResult = validateEmail(email);
    if (!emailResult.ok) {
      setSummary(emailResult.message);
      focusSummary();
      return;
    }
    const passwordResult = validatePassword(password);
    if (!passwordResult.ok) {
      setSummary(passwordResult.message);
      focusSummary();
      return;
    }
    setSubmitting(true);
    void (async () => {
      const result = await api.login(emailResult.email, password);
      setSubmitting(false);
      if (result.ok) {
        onNavigate(consumeReturnTo(), "replace");
        return;
      }
      if (result.kind === "network") {
        setSummary(NETWORK_MESSAGE);
        focusSummary();
        return;
      }
      if (result.kind === "http") {
        setSummary(
          visibleMessage({
            status: result.status,
            code: result.code,
            serverMessage: result.serverMessage,
            audience: "login",
          }),
        );
        focusSummary();
      }
    })();
  };

  return (
    <form className="stack-form" onSubmit={handleSubmit}>
      {summary !== null ? (
        <p
          ref={summaryRef}
          className="form-summary"
          role="alert"
          aria-live="polite"
          tabIndex={-1}
        >
          {summary}
        </p>
      ) : null}
      <label>
        邮箱
        <input
          name="email"
          type="text"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label>
        密码
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <button type="submit" disabled={submitting}>
        登录
      </button>
    </form>
  );
}
