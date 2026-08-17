import {
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { MailIcon, SpinnerIcon, UserIcon } from "../components/Icons";
import { APIError, api } from "../lib/api";
import { usePlayerStore } from "../store/player-store";

const OTP_LENGTH = 6;
const RESEND_SECONDS = 60;

type AuthStep = "email" | "code" | "approval" | "blocked";
type BusyAction = "request" | "verify";

function retryAfterSeconds(reason: APIError, fallback = RESEND_SECONDS) {
  const value = reason.details?.retry_after_seconds;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.ceil(value));
}

function friendlyAuthError(reason: unknown, action: "request" | "verify") {
  if (reason instanceof APIError) {
    switch (reason.code) {
      case "email_unavailable":
        return "We couldn’t send the code right now. Please try again in a moment.";
      case "invalid_code":
      case "unauthorized":
        return "That code is incorrect or has expired. Enter the latest code from your email, or request a new one.";
      case "too_many_code_attempts":
        return "Too many incorrect attempts. Request a new code before trying again.";
      case "access_blocked":
        return "Access for this email has been blocked by the owner. Contact the owner if you think this is a mistake.";
      default:
        if (reason.status === 400) {
          return action === "request"
            ? "Enter a valid email address, for example name@example.com."
            : "Enter all six digits from the latest email.";
        }
        if (reason.status >= 500) {
          return "ANTOLEX is temporarily unavailable. Please try again in a moment.";
        }
    }
  }

  if (reason instanceof TypeError) {
    return "We couldn’t reach ANTOLEX. Check your internet connection and try again.";
  }

  return action === "request"
    ? "We couldn’t send the code. Please try again."
    : "We couldn’t verify the code. Please try again.";
}

export function ProfileView() {
  const navigate = useNavigate();
  const user = usePlayerStore((state) => state.user);
  const setSession = usePlayerStore((state) => state.setSession);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<AuthStep>("email");
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resendRemaining, setResendRemaining] = useState(0);
  const codeRefs = useRef<Array<HTMLInputElement | null>>([]);
  const busy = busyAction !== null;

  const codeDigits = Array.from({ length: OTP_LENGTH }, (_, index) => code[index] ?? "");

  useEffect(() => {
    if (resendRemaining <= 0) return;
    const timer = window.setInterval(() => {
      setResendRemaining((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendRemaining]);

  useEffect(() => {
    if (step !== "code") return;
    const frame = requestAnimationFrame(() => codeRefs.current[Math.min(code.length, 5)]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [code.length, step]);

  function digits(value = code) {
    return Array.from({ length: OTP_LENGTH }, (_, index) => value[index] ?? "");
  }
  function setDigits(next: string[], focus?: number) {
    setCode(next.join("").slice(0, OTP_LENGTH));
    if (typeof focus === "number") requestAnimationFrame(() => codeRefs.current[focus]?.focus());
  }
  function changeDigit(index: number, event: ChangeEvent<HTMLInputElement>) {
    const values = digits();
    const incoming = event.target.value.replace(/\D/g, "");
    if (!incoming) {
      values[index] = "";
      setCode(values.join(""));
      return;
    }
    let cursor = index;
    for (const digit of incoming) {
      if (cursor >= OTP_LENGTH) break;
      values[cursor++] = digit;
    }
    setDigits(values, Math.min(cursor, OTP_LENGTH - 1));
  }
  function keyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace") {
      event.preventDefault();
      const values = digits();
      const target = values[index] ? index : Math.max(0, index - 1);
      values[target] = "";
      setDigits(values, target);
    } else if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault(); codeRefs.current[index - 1]?.focus();
    } else if (event.key === "ArrowRight" && index < 5) {
      event.preventDefault(); codeRefs.current[index + 1]?.focus();
    }
  }
  function paste(event: ClipboardEvent<HTMLInputElement>) {
    const value = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!value) return;
    event.preventDefault();
    setDigits(Array.from({ length: 6 }, (_, index) => value[index] ?? ""), Math.min(value.length, 6) - 1);
  }

  async function requestCode() {
    const startedFromEmail = step === "email";
    setBusyAction("request"); setError(null); setMessage(null);
    try {
      await api.requestCode({ email: email.trim() });
      setStep("code");
      setCode("");
      setMessage("We sent a 6-digit code. Enter the latest code below, and check spam if it doesn’t arrive within a minute.");
      setResendRemaining(RESEND_SECONDS);
    } catch (reason) {
      if (reason instanceof APIError && reason.code === "code_rate_limited") {
        if (startedFromEmail) setCode("");
        setStep("code");
        setResendRemaining(Math.max(1, retryAfterSeconds(reason)));
        setMessage("A code was sent recently. Check your inbox and spam folder while you wait to request another one.");
      } else {
        setError(friendlyAuthError(reason, "request"));
      }
    } finally { setBusyAction(null); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step === "email") { await requestCode(); return; }
    if (step === "approval" || step === "blocked") return;
    setBusyAction("verify"); setError(null); setMessage(null);
    try {
      const response = await api.verifyCode({ email: email.trim(), code });
      setSession(response.token, response.user, response.session_expires_at);
      navigate("/");
    } catch (reason) {
      if (reason instanceof APIError && reason.code === "access_pending") {
        setStep("approval");
        setCode("");
        setMessage(null);
      } else if (reason instanceof APIError && reason.code === "access_blocked") {
        setStep("blocked");
        setCode("");
        setError(null);
      } else {
        if (reason instanceof APIError && (reason.code === "invalid_code" || reason.code === "too_many_code_attempts")) {
          setCode("");
        }
        if (reason instanceof APIError && reason.code === "too_many_code_attempts") {
          setResendRemaining(retryAfterSeconds(reason, 0));
        }
        setError(friendlyAuthError(reason, "verify"));
      }
    } finally { setBusyAction(null); }
  }
  if (user) {
    return <Navigate to="/" replace />;
  }

  return (
    <section className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-heading">
          <div className="profile-avatar">{step === "email" ? <MailIcon className="h-7 w-7" /> : <UserIcon className="h-7 w-7" />}</div>
          <div>
            <p className="eyebrow">{step === "email" ? "Private library" : step === "code" ? "Security code" : step === "approval" ? "Request sent" : "Access unavailable"}</p>
            <h1>{step === "email" ? "Sign in or request access" : step === "code" ? "Check your email" : step === "approval" ? "Waiting for approval" : "This email can’t sign in"}</h1>
          </div>
        </div>
        {step === "email" ? (
          <>
            <p className="auth-guidance"><strong>First time here?</strong> We’ll email you a 6-digit code. After you verify it, the owner must approve your account before you can sign in.</p>
            <label className="form-field"><span>Email</span><input type="email" value={email} onChange={(event) => { setEmail(event.target.value); setError(null); }} placeholder="you@example.com" autoComplete="email" required disabled={busy} aria-invalid={Boolean(error)} aria-describedby={error ? "auth-error" : undefined} /></label>
          </>
        ) : step === "code" ? (
          <div className="auth-code-step">
            <p className="auth-guidance">Enter the latest code we sent. For a new account, owner approval comes next.</p>
            <div className="auth-email"><span>{email}</span><button type="button" onClick={() => { setStep("email"); setCode(""); setError(null); setMessage(null); }}>Change</button></div>
            <div className="otp-grid" role="group" aria-label="6-digit verification code">
              {codeDigits.map((digit, index) => <input key={index} ref={(node) => { codeRefs.current[index] = node; }} value={digit} onChange={(event) => { setError(null); changeDigit(index, event); }} onKeyDown={(event) => keyDown(index, event)} onPaste={paste} onFocus={(event) => event.currentTarget.select()} type="text" inputMode="numeric" autoComplete={index === 0 ? "one-time-code" : "off"} aria-label={`Code digit ${index + 1}`} aria-invalid={Boolean(error)} aria-describedby={error ? "auth-error" : undefined} disabled={busy} />)}
            </div>
            <button className="resend-button" type="button" disabled={busy || resendRemaining > 0} onClick={() => void requestCode()}>{resendRemaining > 0 ? `Resend in ${resendRemaining}s` : "Resend code"}</button>
          </div>
        ) : step === "approval" ? (
          <div className="auth-approval">
            <p><strong>Approval requested for {email}.</strong></p>
            <p>The owner needs to approve new accounts. You can close this page now. After approval, come back and request a new code to sign in.</p>
            <button className="secondary-button" type="button" onClick={() => { setStep("email"); setEmail(""); setError(null); setMessage(null); }}>Use another email</button>
          </div>
        ) : (
          <div className="auth-approval auth-blocked">
            <p><strong>Access for {email} has been disabled by the owner.</strong></p>
            <p>Use another email or contact the owner if you think this is a mistake.</p>
            <button className="secondary-button" type="button" onClick={() => { setStep("email"); setEmail(""); setError(null); setMessage(null); }}>Use another email</button>
          </div>
        )}
        {message && <p className="notice notice-success" role="status" aria-live="polite">{message}</p>}
        {error && <p id="auth-error" className="notice notice-error" role="alert">{error}</p>}
        {(step === "email" || step === "code") && <button className="primary-button auth-submit" type="submit" disabled={busy || (step === "code" && code.length !== OTP_LENGTH)}>{busy && <SpinnerIcon className="h-5 w-5 animate-spin" />}{busyAction === "request" ? "Sending code…" : busyAction === "verify" ? "Checking code…" : step === "email" ? "Send code" : "Confirm code"}</button>}
      </form>
    </section>
  );
}
