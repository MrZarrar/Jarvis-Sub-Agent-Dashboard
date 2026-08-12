import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { LockKeyhole, ShieldCheck, UnlockKeyhole, X } from "lucide-react";
import { api, type BrainLockStatus } from "../lib/api";

const SENSITIVE_STORAGE_KEYS = ["agent-dashboard-tabby-convo", "sidebar-connection-stats"];
const TIMEOUTS: BrainLockStatus["timeoutMinutes"][] = [1, 5, 15, 30];
const UNAVAILABLE_MESSAGE = "The lock service is unavailable. Check the dashboard connection.";

export type BrainLockState = "locked" | "unlocked" | "unavailable";

export type BrainLockContextValue = {
  state: BrainLockState;
  accessRevision: number;
  requestUnlock: () => Promise<boolean>;
  lock: () => Promise<void>;
  timeoutMinutes: number;
  setTimeoutMinutes: (minutes: number) => Promise<void>;
};

const BrainLockContext = createContext<BrainLockContextValue | null>(null);

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

export function useBrainLock(): BrainLockContextValue {
  const context = useContext(BrainLockContext);
  if (!context) throw new Error("useBrainLock must be used within BrainLockProvider");
  return context;
}

const unavailableRequestUnlock = () => Promise.resolve(false);

export function useBrainLockAccess(): Pick<
  BrainLockContextValue,
  "state" | "accessRevision" | "requestUnlock"
> {
  const context = useContext(BrainLockContext);
  return context
    ? {
        state: context.state,
        accessRevision: context.accessRevision,
        requestUnlock: context.requestUnlock,
      }
    : { state: "locked", accessRevision: 0, requestUnlock: unavailableRequestUnlock };
}

export function BrainLockProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<BrainLockStatus | null>(null);
  const [serviceUnavailable, setServiceUnavailable] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [accessRevision, setAccessRevision] = useState(0);
  const hiddenAt = useRef<number | null>(null);
  const pendingUnlocks = useRef(new Set<(unlocked: boolean) => void>());
  const backgroundRef = useRef<HTMLDivElement>(null);
  const unlockOpener = useRef<HTMLElement | null>(null);
  const wasModalOpen = useRef(false);

  const state: BrainLockState = serviceUnavailable
    ? "unavailable"
    : status?.unlocked
      ? "unlocked"
      : "locked";

  const resolvePendingUnlocks = useCallback((unlocked: boolean) => {
    for (const resolve of pendingUnlocks.current) resolve(unlocked);
    pendingUnlocks.current.clear();
  }, []);

  const lockClient = useCallback(() => {
    clearSensitiveClientState();
    setPin("");
    setConfirmPin("");
    setError("");
    setModalOpen(false);
    setServiceUnavailable(false);
    setAccessRevision((revision) => revision + 1);
    setStatus((current) => ({
      configured: current?.configured ?? true,
      unlocked: false,
      timeoutMinutes: current?.timeoutMinutes ?? 5,
      lockoutRemainingSeconds: current?.lockoutRemainingSeconds ?? 0,
    }));
    resolvePendingUnlocks(false);
  }, [resolvePendingUnlocks]);

  const lock = useCallback(async () => {
    setBusy(true);
    lockClient();
    try {
      await api.brainLock.lock();
    } catch {
      // Sensitive client state is already cleared; idle expiry also protects the server session.
    } finally {
      setBusy(false);
    }
  }, [lockClient]);

  const requestUnlock = useCallback((): Promise<boolean> => {
    if (status?.unlocked && !serviceUnavailable) return Promise.resolve(true);
    if (!modalOpen) unlockOpener.current = document.activeElement as HTMLElement | null;
    setError(serviceUnavailable ? UNAVAILABLE_MESSAGE : "");
    setModalOpen(true);
    if (serviceUnavailable) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => pendingUnlocks.current.add(resolve));
  }, [modalOpen, serviceUnavailable, status?.unlocked]);

  const cancelUnlock = useCallback(() => {
    setModalOpen(false);
    setPin("");
    setConfirmPin("");
    setError("");
    resolvePendingUnlocks(false);
  }, [resolvePendingUnlocks]);

  useEffect(() => {
    let active = true;
    api.brainLock
      .status()
      .then((next) => {
        if (!active) return;
        setStatus(next);
        setServiceUnavailable(false);
        if (next.unlocked) {
          setModalOpen(false);
          setPin("");
          setConfirmPin("");
          setError("");
        }
      })
      .catch(() => {
        if (!active) return;
        setServiceUnavailable(true);
        setError(UNAVAILABLE_MESSAGE);
        resolvePendingUnlocks(false);
      });
    return () => {
      active = false;
      resolvePendingUnlocks(false);
    };
  }, [resolvePendingUnlocks]);

  useEffect(() => {
    if (state !== "unlocked") return;
    resolvePendingUnlocks(true);
  }, [resolvePendingUnlocks, state]);

  useEffect(() => {
    const background = backgroundRef.current;
    if (modalOpen) {
      background?.setAttribute("inert", "");
      background?.setAttribute("aria-hidden", "true");
    } else {
      background?.removeAttribute("inert");
      background?.removeAttribute("aria-hidden");
      if (wasModalOpen.current && unlockOpener.current?.isConnected) {
        unlockOpener.current.focus();
      }
      unlockOpener.current = null;
    }
    wasModalOpen.current = modalOpen;
    return () => {
      background?.removeAttribute("inert");
      background?.removeAttribute("aria-hidden");
    };
  }, [modalOpen]);

  useEffect(() => {
    const onLocked = () => lockClient();
    window.addEventListener("jarvis:brain-locked", onLocked);
    return () => window.removeEventListener("jarvis:brain-locked", onLocked);
  }, [lockClient]);

  useEffect(() => {
    if (!status?.unlocked || serviceUnavailable) return;
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
  }, [lock, serviceUnavailable, status?.timeoutMinutes, status?.unlocked]);

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

  useEffect(() => {
    if (!modalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) cancelUnlock();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, cancelUnlock, modalOpen]);

  async function unlock() {
    if (!/^\d{4}$/.test(pin)) {
      setError("Enter exactly four digits.");
      resolvePendingUnlocks(false);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await api.brainLock.unlock(pin);
      setStatus(next);
      setServiceUnavailable(false);
      setPin("");
      if (next.unlocked) {
        setAccessRevision((revision) => revision + 1);
        setModalOpen(false);
      } else {
        setError("PIN not recognised.");
        resolvePendingUnlocks(false);
      }
    } catch {
      setPin("");
      try {
        const next = await api.brainLock.status();
        setStatus(next);
        setServiceUnavailable(false);
        setError(
          next.lockoutRemainingSeconds
            ? "Too many attempts. Try again when the timer ends."
            : "PIN not recognised."
        );
      } catch {
        setServiceUnavailable(true);
        setError("Unlock failed. Check the dashboard connection.");
      }
      resolvePendingUnlocks(false);
    } finally {
      setBusy(false);
    }
  }

  async function setup() {
    if (!/^\d{4}$/.test(pin)) {
      setError("Choose exactly four digits.");
      resolvePendingUnlocks(false);
      return;
    }
    if (pin !== confirmPin) {
      setError("The two PINs do not match.");
      resolvePendingUnlocks(false);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await api.brainLock.setup(pin, status?.timeoutMinutes ?? 5);
      setStatus(next);
      setServiceUnavailable(false);
      setPin("");
      setConfirmPin("");
      if (next.unlocked) {
        setAccessRevision((revision) => revision + 1);
        setModalOpen(false);
      } else {
        setError("PIN setup did not unlock this session.");
        resolvePendingUnlocks(false);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "PIN setup failed.");
      resolvePendingUnlocks(false);
    } finally {
      setBusy(false);
    }
  }

  const setTimeoutMinutes = useCallback(
    async (minutes: number) => {
      if (!status || !TIMEOUTS.includes(minutes as BrainLockStatus["timeoutMinutes"])) return;
      const timeoutMinutes = minutes as BrainLockStatus["timeoutMinutes"];
      const previous = status;
      setStatus({ ...status, timeoutMinutes });
      try {
        const next = await api.brainLock.settings(timeoutMinutes);
        setStatus(next);
        setServiceUnavailable(false);
      } catch {
        setStatus(previous);
        setError("Could not update the inactivity timeout.");
      }
    },
    [status]
  );

  const context = useMemo<BrainLockContextValue>(
    () => ({
      state,
      accessRevision,
      requestUnlock,
      lock,
      timeoutMinutes: status?.timeoutMinutes ?? 5,
      setTimeoutMinutes,
    }),
    [accessRevision, lock, requestUnlock, setTimeoutMinutes, state, status?.timeoutMinutes]
  );

  const configured = status?.configured ?? true;
  const lockout = status?.lockoutRemainingSeconds ?? 0;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void (configured ? unlock() : setup());
  }

  return (
    <BrainLockContext.Provider value={context}>
      <div ref={backgroundRef}>{children}</div>
      {modalOpen && (
        <BrainLockModal
          configured={configured}
          lockout={lockout}
          timeoutMinutes={status?.timeoutMinutes ?? 5}
          pin={pin}
          confirmPin={confirmPin}
          error={error}
          busy={busy}
          onPinChange={setPin}
          onConfirmPinChange={setConfirmPin}
          onTimeoutChange={(minutes) =>
            setStatus((current) => ({
              configured: false,
              unlocked: false,
              timeoutMinutes: minutes,
              lockoutRemainingSeconds: current?.lockoutRemainingSeconds ?? 0,
            }))
          }
          onCancel={cancelUnlock}
          onSubmit={submit}
        />
      )}
    </BrainLockContext.Provider>
  );
}

type BrainLockModalProps = {
  configured: boolean;
  lockout: number;
  timeoutMinutes: BrainLockStatus["timeoutMinutes"];
  pin: string;
  confirmPin: string;
  error: string;
  busy: boolean;
  onPinChange: (pin: string) => void;
  onConfirmPinChange: (pin: string) => void;
  onTimeoutChange: (minutes: BrainLockStatus["timeoutMinutes"]) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

function BrainLockModal({
  configured,
  lockout,
  timeoutMinutes,
  pin,
  confirmPin,
  error,
  busy,
  onPinChange,
  onConfirmPinChange,
  onTimeoutChange,
  onCancel,
  onSubmit,
}: BrainLockModalProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const minutes = Math.floor(lockout / 60);
  const seconds = lockout % 60;

  function containFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []
    );
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-slate-950/70 p-3 backdrop-blur-sm sm:items-center sm:p-5">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="brain-lock-title"
        onKeyDown={containFocus}
        className="relative max-h-[calc(100dvh-1.5rem)] w-full max-w-sm overflow-y-auto rounded-3xl border border-cyan-300/15 bg-slate-950 p-5 text-slate-100 shadow-2xl shadow-black/60 sm:p-7"
      >
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          aria-label="Cancel"
          className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 transition hover:bg-white/5 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-400 disabled:opacity-50"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-200">
          {configured ? (
            <LockKeyhole className="h-5 w-5" aria-hidden="true" />
          ) : (
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          )}
        </div>
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.28em] text-cyan-300/70">
          Jarvis private layer
        </p>
        <h2 id="brain-lock-title" className="text-2xl font-semibold tracking-tight">
          {configured ? "Brain locked" : "Protect the brain"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          {configured
            ? "Enter your four-digit PIN to unlock sensitive notes for this device session."
            : "Choose a four-digit PIN. It stays hashed on this PC."}
        </p>

        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
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
              onChange={(event) => onPinChange(event.target.value.replace(/\D/g, "").slice(0, 4))}
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
                    onConfirmPinChange(event.target.value.replace(/\D/g, "").slice(0, 4))
                  }
                  disabled={busy}
                  className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-900/90 px-4 py-3 text-center font-mono text-2xl tracking-[0.65em] text-cyan-100 caret-cyan-300 outline-none transition focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/10"
                />
              </label>
              <label className="block text-xs font-medium text-slate-300">
                Lock after inactivity
                <select
                  value={timeoutMinutes}
                  onChange={(event) =>
                    onTimeoutChange(Number(event.target.value) as BrainLockStatus["timeoutMinutes"])
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
            className="min-h-11 w-full rounded-2xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 focus:outline-none focus:ring-2 focus:ring-cyan-200 focus:ring-offset-2 focus:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Checking…" : configured ? "Unlock sensitive notes" : "Create PIN"}
          </button>
        </form>
        <p className="mt-5 text-xs leading-5 text-slate-500">
          This protects sensitive notes. It does not encrypt files stored on this Windows account.
        </p>
      </section>
    </div>
  );
}

export function BrainLockControls() {
  const { state, requestUnlock, lock, timeoutMinutes, setTimeoutMinutes } = useBrainLock();
  const unavailable = state === "unavailable";

  if (state !== "unlocked") {
    return (
      <button
        type="button"
        onClick={() => void requestUnlock()}
        aria-label="Unlock sensitive notes"
        title={unavailable ? UNAVAILABLE_MESSAGE : "Unlock sensitive notes"}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-cyan-400/20 bg-slate-950/90 px-3 py-2 text-xs font-medium text-cyan-200 shadow-lg shadow-black/30 backdrop-blur transition hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-400"
      >
        <UnlockKeyhole className="h-4 w-4" aria-hidden="true" />
        <span className="hidden sm:inline">Unlock sensitive notes</span>
        {unavailable && <span className="h-2 w-2 rounded-full bg-rose-400" aria-hidden="true" />}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5 rounded-xl border border-cyan-400/20 bg-slate-950/90 p-1.5 shadow-lg shadow-black/30 backdrop-blur">
      <label className="sr-only" htmlFor="brain-timeout">
        Inactivity timeout
      </label>
      <select
        id="brain-timeout"
        value={timeoutMinutes}
        onChange={(event) => void setTimeoutMinutes(Number(event.target.value))}
        className="min-h-9 rounded-lg border border-white/10 bg-slate-900 px-2 py-1.5 text-xs text-slate-300 outline-none focus:border-cyan-400"
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
        aria-label="Lock sensitive notes"
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-cyan-400/10 px-2.5 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/20 focus:outline-none focus:ring-2 focus:ring-cyan-400"
      >
        <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Lock sensitive notes</span>
      </button>
    </div>
  );
}
