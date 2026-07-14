import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarClock, Command, LayoutDashboard, ListTodo, Orbit, Settings } from "lucide-react";

const COMMANDS = [
  { label: "Command Center", hint: "Missions and approvals", to: "/missions", icon: Orbit },
  { label: "Dashboard", hint: "System overview", to: "/", icon: LayoutDashboard },
  { label: "Today", hint: "What is next", to: "/today", icon: ListTodo },
  {
    label: "Scheduled",
    hint: "Author and inspect schedules",
    to: "/scheduled",
    icon: CalendarClock,
  },
  { label: "Settings", hint: "Providers and permissions", to: "/settings", icon: Settings },
];

export function CommandPalette() {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? COMMANDS.filter((command) =>
          `${command.label} ${command.hint}`.toLowerCase().includes(needle)
        )
      : COMMANDS;
  }, [query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) window.setTimeout(() => input.current?.focus(), 0);
    else setQuery("");
  }, [open]);

  if (!open) return null;
  const choose = (to: string) => {
    navigate(to);
    setOpen(false);
  };
  return (
    <div
      className="fixed inset-0 z-[100] bg-black/65 backdrop-blur-sm flex items-start justify-center px-4 pt-[12vh]"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-cyan-500/25 bg-surface-1 shadow-[0_0_50px_rgba(0,194,232,.15)] overflow-hidden"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Command className="w-4 h-4 text-cyan-400" />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && matches[0]) choose(matches[0].to);
            }}
            placeholder="Go to…"
            className="w-full bg-transparent py-4 text-sm text-gray-100 placeholder-gray-600 focus:outline-none"
          />
          <kbd className="text-[10px] text-gray-600">ESC</kbd>
        </div>
        <div className="p-2">
          {matches.map(({ label, hint, to, icon: Icon }) => (
            <button
              key={to}
              onClick={() => choose(to)}
              className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-cyan-500/10 transition-colors"
            >
              <Icon className="w-4 h-4 text-cyan-400" />
              <span>
                <span className="block text-sm text-gray-200">{label}</span>
                <span className="block text-[10px] text-gray-600">{hint}</span>
              </span>
            </button>
          ))}
          {!matches.length && (
            <p className="p-4 text-center text-xs text-gray-600">No command found.</p>
          )}
        </div>
      </div>
    </div>
  );
}
