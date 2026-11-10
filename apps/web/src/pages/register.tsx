import { useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { NETWORK_MESSAGE, visibleMessage } from "../copy";
import { consumeReturnTo } from "../router";
import { validateEmail, validatePassword } from "./auth-form";

type RegisterPageProps = {
  onNavigate: (to: string, mode?: "push" | "replace") => void;
};

export function RegisterPage({ onNavigate }: RegisterPageProps) {
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [showLoginLink, setShowLoginLink] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const focusSummary = () => {
    requestAnimationFrame(() => {
      summaryRef.current?.focus();
    });
  };

  const goLogin = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onNavigate("/login", "push");
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const emailResult = validateEmail(email);
    if (!emailResult.ok) {
      setShowLoginLink(false);
      setSummary(emailResult.message);
      focusSummary();
      return;
    }
    const passwordResult = validatePassword(password);
    if (!passwordResult.ok) {
      setShowLoginLink(false);
      setSummary(passwordResult.message);
      focusSummary();
      return;
    }
    setSubmitting(true);
    void (async () => {
      const result = await api.register(emailResult.email, password);
      setSubmitting(false);
      if (result.ok) {
        onNavigate(consumeReturnTo(), "replace");
        return;
      }
      if (result.kind === "network") {
        setShowLoginLink(false);
        setSummary(NETWORK_MESSAGE);
        focusSummary();
        return;
      }
      if (result.kind === "http") {
        const message = visibleMessage({
          status: result.status,
          code: result.code,
          serverMessage: result.serverMessage,
          audience: "login",
        });
        setShowLoginLink(result.status === 409 && message === "该邮箱已注册");
        setSummary(message);
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
          {showLoginLink ? (
            <>
              {" "}
              <a href="/login" onClick={goLogin}>
                登录
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      <label>
        邮箱
        <input
          name="email"
          type="text"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label>
        密码
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <button type="submit" disabled={submitting}>
        注册
      </button>
    </form>
  );
}
