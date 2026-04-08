import {
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { LogOutIcon, MailIcon, UserIcon } from '../components/Icons';
import { api } from '../lib/api';
import { usePlayerStore } from '../store/player-store';

const OTP_LENGTH = 6;

export function ProfileView() {
  const navigate = useNavigate();
  const user = usePlayerStore((state) => state.user);
  const sessionExpiresAt = usePlayerStore((state) => state.sessionExpiresAt);
  const setSession = usePlayerStore((state) => state.setSession);
  const clearSession = usePlayerStore((state) => state.clearSession);

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const codeRefs = useRef<Array<HTMLInputElement | null>>([]);

  const formattedExpiry = useMemo(() => {
    if (!sessionExpiresAt) {
      return null;
    }

    const date = new Date(sessionExpiresAt);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }, [sessionExpiresAt]);

  const codeDigits = useMemo(
    () => Array.from({ length: OTP_LENGTH }, (_, index) => code[index] ?? ''),
    [code],
  );

  useEffect(() => {
    if (step !== 'code') {
      return;
    }

    const focusIndex = Math.min(code.length, OTP_LENGTH - 1);
    const frame = requestAnimationFrame(() => {
      const input = codeRefs.current[focusIndex];
      input?.focus();
      input?.select();
    });

    return () => cancelAnimationFrame(frame);
  }, [code.length, step]);

  function buildCodeDigits(value = code) {
    return Array.from({ length: OTP_LENGTH }, (_, index) => value[index] ?? '');
  }

  function focusCodeSlot(index: number) {
    const input = codeRefs.current[index];
    input?.focus();
    input?.select();
  }

  function setCodeDigits(nextDigits: string[], focusIndex?: number) {
    const nextCode = nextDigits.join('').slice(0, OTP_LENGTH);
    setCode(nextCode);

    if (typeof focusIndex === 'number') {
      requestAnimationFrame(() => {
        focusCodeSlot(focusIndex);
      });
    }
  }

  function handleCodeSlotChange(index: number, event: ChangeEvent<HTMLInputElement>) {
    const sanitized = event.target.value.replace(/\D/g, '');
    const nextDigits = buildCodeDigits();

    if (!sanitized) {
      nextDigits[index] = '';
      setCode(nextDigits.join(''));
      return;
    }

    let writeIndex = index;
    for (const digit of sanitized) {
      if (writeIndex >= OTP_LENGTH) {
        break;
      }
      nextDigits[writeIndex] = digit;
      writeIndex += 1;
    }

    const focusIndex = Math.min(writeIndex, OTP_LENGTH - 1);
    setCodeDigits(nextDigits, focusIndex);
  }

  function handleCodeSlotKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace') {
      event.preventDefault();

      const nextDigits = buildCodeDigits();
      if (nextDigits[index]) {
        nextDigits[index] = '';
        setCode(nextDigits.join(''));
        return;
      }

      if (index > 0) {
        nextDigits[index - 1] = '';
        setCodeDigits(nextDigits, index - 1);
      }
      return;
    }

    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      focusCodeSlot(index - 1);
      return;
    }

    if (event.key === 'ArrowRight' && index < OTP_LENGTH - 1) {
      event.preventDefault();
      focusCodeSlot(index + 1);
    }
  }

  function handleCodePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!pasted) {
      return;
    }

    event.preventDefault();

    const nextDigits = Array.from({ length: OTP_LENGTH }, (_, index) => pasted[index] ?? '');
    setCodeDigits(nextDigits, Math.min(pasted.length, OTP_LENGTH) - 1);
  }

  async function handleRequestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      await api.requestCode({ email });
      setStep('code');
      setMessage('Code sent.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send sign-in code');
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const response = await api.verifyCode({ email, code });
      setSession(response.token, response.user, response.session_expires_at);
      setCode('');
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify code');
    } finally {
      setBusy(false);
    }
  }

  if (user) {
    return (
      <div className="mx-auto w-full max-w-xl">
        <div className="rounded-[2rem] border border-white/10 bg-black/25 p-6 sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/5 text-zinc-50">
                <UserIcon className="h-7 w-7" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-zinc-500">
                  Profile
                </p>
                <h2 className="truncate text-lg font-semibold text-zinc-50">{user.email}</h2>
                {formattedExpiry && (
                  <p className="mt-1 text-xs text-zinc-500">Valid until {formattedExpiry}</p>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={clearSession}
              aria-label="Sign out"
              title="Sign out"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-zinc-400 transition hover:text-rose-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
            >
              <LogOutIcon className="h-6 w-6" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full justify-center pt-4">
      <form
        onSubmit={step === 'email' ? handleRequestCode : handleVerifyCode}
        className="w-full max-w-md space-y-6 rounded-[2rem] border border-white/10 bg-black/25 p-6 sm:p-7"
      >
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/6 text-zinc-50">
            {step === 'email' ? (
              <MailIcon className="h-7 w-7" />
            ) : (
              <UserIcon className="h-7 w-7" />
            )}
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-zinc-500">
              {step === 'email' ? 'Profile' : 'Code'}
            </p>
            <p className="text-base font-medium text-zinc-50">
              {step === 'email' ? 'Sign in with email' : 'Enter the 6-digit code'}
            </p>
          </div>
        </div>

        {step === 'email' ? (
          <label className="grid gap-2 text-sm text-zinc-300">
            <span className="sr-only">Email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
              placeholder="Email"
              className="rounded-2xl border border-white/10 bg-zinc-950/70 px-4 py-3 text-zinc-50 outline-none transition focus:border-emerald-300 disabled:opacity-70"
            />
          </label>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <p className="truncate text-sm text-zinc-300">{email}</p>
              <button
                type="button"
                onClick={() => {
                  setStep('email');
                  setCode('');
                  setMessage(null);
                  setError(null);
                }}
                className="shrink-0 text-xs font-medium text-zinc-500 transition hover:text-zinc-200"
              >
                Change
              </button>
            </div>

            <div className="flex items-center justify-between gap-2">
              {codeDigits.map((digit, index) => (
                <input
                  key={index}
                  ref={(node) => {
                    codeRefs.current[index] = node;
                  }}
                  type="text"
                  inputMode="numeric"
                  autoComplete={index === 0 ? 'one-time-code' : 'off'}
                  value={digit}
                  onChange={(event) => handleCodeSlotChange(index, event)}
                  onKeyDown={(event) => handleCodeSlotKeyDown(index, event)}
                  onPaste={handleCodePaste}
                  onFocus={(event) => event.currentTarget.select()}
                  disabled={busy}
                  aria-label={`Code digit ${index + 1}`}
                  className="h-14 w-12 rounded-2xl border border-white/10 bg-zinc-950/70 text-center text-lg font-semibold tabular-nums text-zinc-50 outline-none transition focus:border-emerald-300 disabled:opacity-70"
                />
              ))}
            </div>
          </div>
        )}

        {message && <p className="text-sm text-emerald-300">{message}</p>}
        {error && <p className="text-sm text-rose-300">{error}</p>}

        <button
          type="submit"
          disabled={busy || (step === 'code' && code.length < OTP_LENGTH)}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-zinc-50 px-5 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {step === 'email' ? (
            <MailIcon className="h-6 w-6" />
          ) : (
            <UserIcon className="h-6 w-6" />
          )}
          {busy ? 'Working...' : step === 'email' ? 'Send code' : 'Confirm'}
        </button>
      </form>
    </div>
  );
}
