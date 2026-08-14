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
import { api } from "../lib/api";
import { usePlayerStore } from "../store/player-store";

const OTP_LENGTH = 6;
const RESEND_SECONDS = 60;

export function ProfileView() {
  const navigate = useNavigate();
  const user = usePlayerStore((state) => state.user);
  const setSession = usePlayerStore((state) => state.setSession);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resendRemaining, setResendRemaining] = useState(0);
  const codeRefs = useRef<Array<HTMLInputElement | null>>([]);

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
    setBusy(true); setError(null); setMessage(null);
    try {
      await api.requestCode({ email: email.trim() });
      setStep("code");
      setMessage("Code sent. Check your inbox.");
      setResendRemaining(RESEND_SECONDS);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send code");
    } finally { setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step === "email") { await requestCode(); return; }
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await api.verifyCode({ email: email.trim(), code });
      setSession(response.token, response.user, response.session_expires_at);
      navigate("/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not verify code");
    } finally { setBusy(false); }
  }
  if (user) {
    return <Navigate to="/" replace />;
  }

  return (
    <section className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-heading">
          <div className="profile-avatar">{step === "email" ? <MailIcon className="h-7 w-7" /> : <UserIcon className="h-7 w-7" />}</div>
          <div><p className="eyebrow">{step === "email" ? "Welcome" : "Security code"}</p><h1>{step === "email" ? "Sign in to ANTOLEX" : "Check your email"}</h1></div>
        </div>
        {step === "email" ? (
          <label className="form-field"><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" required disabled={busy} /></label>
        ) : (
          <div className="auth-code-step">
            <div className="auth-email"><span>{email}</span><button type="button" onClick={() => { setStep("email"); setCode(""); }}>Change</button></div>
            <div className="otp-grid">
              {codeDigits.map((digit, index) => <input key={index} ref={(node) => { codeRefs.current[index] = node; }} value={digit} onChange={(event) => changeDigit(index, event)} onKeyDown={(event) => keyDown(index, event)} onPaste={paste} onFocus={(event) => event.currentTarget.select()} type="text" inputMode="numeric" autoComplete={index === 0 ? "one-time-code" : "off"} aria-label={`Code digit ${index + 1}`} disabled={busy} />)}
            </div>
            <button className="resend-button" type="button" disabled={busy || resendRemaining > 0} onClick={() => void requestCode()}>{resendRemaining > 0 ? `Resend in ${resendRemaining}s` : "Resend code"}</button>
          </div>
        )}
        {message && <p className="notice notice-success">{message}</p>}
        {error && <p className="notice notice-error">{error}</p>}
        <button className="primary-button auth-submit" type="submit" disabled={busy || (step === "code" && code.length !== OTP_LENGTH)}>{busy && <SpinnerIcon className="h-5 w-5 animate-spin" />}{busy ? "Working…" : step === "email" ? "Send code" : "Confirm"}</button>
      </form>
    </section>
  );
}
