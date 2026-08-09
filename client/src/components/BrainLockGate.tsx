import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { LockKeyhole, ShieldCheck } from "lucide-react";
import { api, type BrainLockStatus } from "../lib/api";

const SENSITIVE_STORAGE_KEYS = ["agent-dashboard-tabby-convo", "sidebar-connection-stats"];
const TIMEOUTS: BrainLockStatus["timeoutMinutes"][] = [1, 5, 15, 30];

export function shouldLockAfterResume(
  hiddenAt: number | null,
  now: number,
  timeoutMinutes: number
): boolean {
  return hiddenAt !== null && now - hiddenAt >= timeoutMinutes * 60_000;
}

function clearSensitiveClientState(): void {
  for (const key of SENSITIVE_STORAGE_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // In-memory React state must still lock in restricted/private storage modes.
    }
  }
}

export function BrainLockGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<BrainLockStatus | null>(null);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const hiddenAt = useRef<number | null>(null);

  const lockClient = useCallback(() => {
    clearSensitiveClientState();
    setPin("");
    setConfirmPin("");
    setError("");
    setStatus((current) => ({
      configured: current?.configured ?? true,
      unlocked: false,
      timeoutMinutes: current?.timeoutMinutes ?? 5,
      lockoutRemainingSeconds: current?.lockoutRemainingSeconds ?? 0,
    }));
  }, []);

  const lock = useCallback(async () => {
    setBusy(true);
    try {
      await api.brainLock.lock();
    } catch {
      // Hide sensitive state immediately; the server also expires idle sessions.
    } finally {
      lockClient();
      setBusy(false);
    }
  }, [lockClient]);

  useEffect(() => {
    let active = true;
    api.brainLock
      .status()
      .then((next) => active && setStatus(next))
      .catch(() => {
        if (active) {
          lockClient();
          setError("The lock service is unavailable. Check the dashboard connection.");
        }
      });
    return () => {
      active = false;
    };
  }, [lockClient]);

  useEffect(() => {
    const onLocked = () => lockClient();
    window.addEventListener("jarvis:brain-locked", onLocked);
    return () => window.removeEventListener("jarvis:brain-locked", onLocked);
  }, [lockClient]);

  useEffect(() => {
    if (!status?.unlocked) return;
    const timeoutMs = status.timeoutMinutes * 60_000;
    let inactivityTimer = window.setTimeout(lock, timeoutMs);
    let lastTick = Date.now();

    const resetInactivity = () => {
      window.clearTimeout(inactivityTimer);
      inactivityTimer = window.setTimeout(lock, timeoutMs);
    };
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt.current = Date.now();
        return;
      }
      if (shouldLockAfterResume(hiddenAt.current, Date.now(), status.timeoutMinutes)) void lock();
      hiddenAt.current = null;
      resetInactivity();
    };
    const sleepCheck = window.setInterval(() => {
      const now = Date.now();
      if (now - lastTick >= timeoutMs) void lock();
      lastTick = now;
    }, 15_000);
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "touchstart"];
    for (const event of events) window.addEventListener(event, resetInactivity, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(inactivityTimer);
      window.clearInterval(sleepCheck);
      for (const event of events) window.removeEventListener(event, resetInactivity);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [lock, status?.timeoutMinutes, status?.unlocked]);

  useEffect(() => {
    if (!status?.lockoutRemainingSeconds) return;
    const timer = window.setInterval(() => {
      setStatus((current) =>
        current
          ? {
              ...current,
              lockoutRemainingSeconds: Math.max(0, current.lockoutRemainingSeconds - 1),
            }
          : current
      );
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [status?.lockoutRemainingSeconds]);

  async function unlock() {
    if (!/^\d{4}$/.test(pin)) {
      setError("Enter exactly four digits.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setStatus(await api.brainLock.unlock(pin));
      setPin("");
    } catch {
      setPin("");
      try {
        const next = await api.brainLock.status();
        setStatus(next);
        setError(
          next.lockoutRemainingSeconds
            ? "Too many attempts. Try again when the timer ends."
            : "PIN not recognised."
        );
      } catch {
        setError("Unlock failed. Check the dashboard connection.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function setup() {
    if (!/^\d{4}$/.test(pin)) {
      setError("Choose exactly four digits.");
      return;
    }
    if (pin !== confirmPin) {
      setError("The two PINs do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setStatus(await api.brainLock.setup(pin, status?.timeoutMinutes ?? 5));
      setPin("");
      setConfirmPin("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "PIN setup failed.");
    } finally {
      setBusy(false);
    }
  }

  async function setTimeoutMinutes(timeoutMinutes: BrainLockStatus["timeoutMinutes"]) {
    if (!status) return;
    const previous = status;
    setStatus({ ...status, timeoutMinutes });
    try {
      setStatus(await api.brainLock.settings(timeoutMinutes));
    } catch {
      setStatus(previous);
    }
  }

  if (status?.unlocked) {
    return (
      <>
        {children}
        <div className="fixed right-3 top-3 z-[100] flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-slate-950/90 p-1.5 shadow-lg shadow-black/30 backdrop-blur">
          <label className="sr-only" htmlFor="brain-timeout">
            Inactivity timeout
          </label>
          <select
            id="brain-timeout"
            value={status.timeoutMinutes}
            onChange={(event) =>
              void setTimeoutMinutes(
                Number(event.target.value) as BrainLockStatus["timeoutMinutes"]
              )
            }
            className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1.5 text-xs text-slate-300 outline-none focus:border-cyan-400"
          >
            {TIMEOUTS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} min
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void lock()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-400/10 px-2.5 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/20 focus:outline-none focus:ring-2 focus:ring-cyan-400 disabled:opacity-50"
          >
            <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
            Lock brain
          </button>
        </div>
      </>
    );
  }

  const configured = status?.configured ?? true;
  const lockout = status?.lockoutRemainingSeconds ?? 0;
  const minutes = Math.floor(lockout / 60);
  const seconds = lockout % 60;

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#050912] px-5 text-slate-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,rgba(34,211,238,0.10),transparent_42%)]" />
      <section
        className="relative w-full max-w-sm rounded-3xl border border-cyan-300/15 bg-slate-950/80 p-7 shadow-2xl shadow-black/60 backdrop-blur-xl"
        aria-live="polite"
      >
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-200">
          {configured ? <LockKeyhole className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
        </div>
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300/70">
          Jarvis private layer
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {configured ? "Brain locked" : "Protect the brain"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          {configured
            ? "Enter your four-digit PIN to open this device session."
            : "Choose a four-digit PIN. It stays hashed on this PC."}
        </p>

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void (configured ? unlock() : setup());
          }}
        >
          <label className="block text-xs font-medium text-slate-300">
            {configured ? "Four-digit PIN" : "Choose four-digit PIN"}
            <input
              autoFocus
              aria-label={configured ? "Four-digit PIN" : "Choose four-digit PIN"}
              type="password"
              inputMode="numeric"
              autoComplete={configured ? "current-password" : "new-password"}
              pattern="[0-9]{4}"
              maxLength={4}
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))}
              disabled={busy || lockout > 0}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-900/90 px-4 py-3 text-center font-mono text-2xl tracking-[0.65em] text-cyan-100 caret-cyan-300 outline-none transition focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10 disabled:opacity-50"
            />
          </label>

          {!configured && (
            <>
              <label className="block text-xs font-medium text-slate-300">
                Confirm PIN
                <input
                  aria-label="Confirm PIN"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  pattern="[0-9]{4}"
                  maxLength={4}
                  value={confirmPin}
                  onChange={(event) =>
                    setConfirmPin(event.target.value.replace(/\D/g, "").slice(0, 4))
                  }
                  disabled={busy}
                  className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-900/90 px-4 py-3 text-center font-mono text-2xl tracking-[0.65em] text-cyan-100 caret-cyan-300 outline-none transition focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10"
                />
              </label>
              <label className="block text-xs font-medium text-slate-300">
                Lock after inactivity
                <select
                  value={status?.timeoutMinutes ?? 5}
                  onChange={(event) =>
                    setStatus((current) => ({
                      configured: false,
                      unlocked: false,
                      timeoutMinutes: Number(
                        event.target.value
                      ) as BrainLockStatus["timeoutMinutes"],
                      lockoutRemainingSeconds: current?.lockoutRemainingSeconds ?? 0,
                    }))
                  }
                  className="mt-2 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-cyan-300/60"
                >
                  {TIMEOUTS.map((value) => (
                    <option key={value} value={value}>
                      {value} minutes
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {lockout > 0 && (
            <p className="text-sm text-amber-300">
              Try again in {minutes}:{String(seconds).padStart(2, "0")}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-rose-300">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || lockout > 0}
            className="w-full rounded-2xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 focus:outline-none focus:ring-2 focus:ring-cyan-200 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Checking…" : configured ? "Unlock brain" : "Create PIN"}
          </button>
        </form>
        <p className="mt-5 text-xs leading-5 text-slate-500">
          This hides the dashboard brain. It does not encrypt the files stored on this Windows
          account.
        </p>
      </section>
    </main>
  );
}
