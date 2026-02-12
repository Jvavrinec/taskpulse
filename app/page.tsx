"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { auth, db } from "./lib/firebase";

/* =========================
   Types
========================= */

type Category = "daily" | "workout" | "work";
type WorkoutPart =
  | "chest"
  | "back"
  | "legs"
  | "arms"
  | "shoulders"
  | "core"
  | "cardio";

type Todo = {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;

  category: Category;

  doneAt?: number;
  doneDay?: string; // YYYY-MM-DD
  dueDay?: string; // YYYY-MM-DD

  workoutPart?: WorkoutPart;
};

type Tab = "tasks" | "stats";
type Filter = "all" | "today" | "tomorrow" | "week" | "active" | "done";

type WeekdayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
type WorkoutPlan = Record<WeekdayKey, { enabled: boolean; part: WorkoutPart }>;

/* =========================
   Constants
========================= */

const LS_KEY = "taskpulse_cache_v13";

const partLabel: Record<WorkoutPart, string> = {
  chest: "Chest",
  back: "Back",
  legs: "Legs",
  arms: "Arms",
  shoulders: "Shoulders",
  core: "Core",
  cardio: "Cardio",
};

const weekdayOrder: WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const weekdayName: Record<WeekdayKey, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

const defaultPlan: WorkoutPlan = {
  mon: { enabled: false, part: "chest" },
  tue: { enabled: false, part: "back" },
  wed: { enabled: false, part: "legs" },
  thu: { enabled: false, part: "shoulders" },
  fri: { enabled: false, part: "arms" },
  sat: { enabled: false, part: "core" },
  sun: { enabled: false, part: "cardio" },
};

/* =========================
   Date helpers
========================= */

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function dayKey(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function addDays(base: Date, days: number) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}
function startOfWeekMonday(d: Date) {
  const x = new Date(d);
  const day = x.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}
function weekKeysMonSun(d: Date) {
  const start = startOfWeekMonday(d);
  return Array.from({ length: 7 }, (_, i) => dayKey(addDays(start, i)));
}
function labelWeekdayEN(key: string) {
  const [y, m, dd] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, dd);
  return dt.toLocaleDateString("en-US", { weekday: "short" });
}
function labelDate(key: string) {
  const [, m, d] = key.split("-");
  return `${d}.${m}.`;
}
function toWeekdayKeyFromDate(d: Date): WeekdayKey {
  const day = d.getDay(); // 0 Sun, 1 Mon, ... 6 Sat
  if (day === 0) return "sun";
  if (day === 1) return "mon";
  if (day === 2) return "tue";
  if (day === 3) return "wed";
  if (day === 4) return "thu";
  if (day === 5) return "fri";
  return "sat";
}

/* =========================
   Firestore mappers
========================= */

function toFirestoreTodo(t: Todo) {
  return {
    text: t.text,
    done: t.done,
    createdAt: t.createdAt,
    category: t.category,

    doneAt: t.doneAt ?? null,
    doneDay: t.doneDay ?? null,
    dueDay: t.dueDay ?? null,

    workoutPart: t.workoutPart ?? null,

    updatedAt: serverTimestamp(),
  };
}

function fromFirestoreTodo(id: string, data: any): Todo {
  const cat = String(data?.category ?? "daily") as Category;
  return {
    id,
    text: String(data?.text ?? ""),
    done: Boolean(data?.done ?? false),
    createdAt: Number(data?.createdAt ?? Date.now()),

    category: cat,

    doneAt: data?.doneAt == null ? undefined : Number(data.doneAt),
    doneDay: data?.doneDay == null ? undefined : String(data.doneDay),
    dueDay: data?.dueDay == null ? undefined : String(data.dueDay),

    workoutPart:
      data?.workoutPart == null ? undefined : (String(data.workoutPart) as WorkoutPart),
  };
}

/* =========================
   Chart helpers
========================= */

function niceCeil(n: number) {
  if (n <= 10) return 10;
  if (n <= 20) return 20;
  if (n <= 50) return 50;
  if (n <= 100) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(n)));
  const m = n / p;
  if (m <= 2) return 2 * p;
  if (m <= 5) return 5 * p;
  return 10 * p;
}

function buildSmoothPath(points: { x: number; y: number }[]) {
  if (points.length < 2) return "";
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const midX = (prev.x + curr.x) / 2;
    d += ` Q ${prev.x} ${prev.y} ${midX} ${(prev.y + curr.y) / 2}`;
  }
  const last = points[points.length - 1];
  d += ` T ${last.x} ${last.y}`;
  return d;
}

function AreaChart14Days({ values, labels }: { values: number[]; labels: string[] }) {
  const W = 900;
  const H = 240;
  const P = 18;

  const dataMax = Math.max(0, ...values);
  const yMax = niceCeil(Math.max(1, dataMax));
  const yMin = 0;

  const innerW = W - P * 2;
  const innerH = H - P * 2;

  const core = values.map((v, i) => {
    const x = P + (i / (values.length - 1)) * innerW;
    const t = (v - yMin) / (yMax - yMin || 1);
    const y = P + (1 - t) * innerH;
    return { x, y };
  });

  const padX = innerW * 0.03;
  const pts = [
    { x: core[0].x - padX, y: core[0].y },
    ...core,
    { x: core[core.length - 1].x + padX, y: core[core.length - 1].y },
  ];

  const line = buildSmoothPath(pts);
  const baseY = P + innerH;
  const areaPath = `${line} L ${pts[pts.length - 1].x} ${baseY} L ${pts[0].x} ${baseY} Z`;

  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur-xl p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-zinc-100 font-semibold">Last 14 days</div>
          <div className="text-zinc-400 text-sm">Total done (cumulative)</div>
        </div>
        <div className="text-zinc-400 text-sm">
          scale <span className="text-zinc-100">0–{yMax}</span>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto">
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          className="min-w-[900px]"
          role="img"
          aria-label="Area chart of cumulative done tasks"
        >
          <g opacity="0.35">
            {[0, 0.25, 0.5, 0.75, 1].map((k) => {
              const y = P + k * innerH;
              return (
                <line
                  key={k}
                  x1={P}
                  x2={W - P}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  className="text-zinc-700"
                  strokeWidth="1"
                />
              );
            })}
          </g>

          <path d={areaPath} fill="url(#gradFill)" opacity="0.95" />
          <path
            d={line}
            fill="none"
            stroke="url(#gradStroke)"
            strokeWidth="3.25"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {core.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="3.6" fill="white" opacity={0.9} />
          ))}

          {labels.map((lab, i) => {
            if (i % 2 !== 0 && i !== labels.length - 1) return null;
            const x = core[i].x;
            return (
              <text
                key={lab + i}
                x={x}
                y={H - 6}
                textAnchor="middle"
                fontSize="11"
                fill="rgba(255,255,255,0.45)"
              >
                {lab}
              </text>
            );
          })}

          <defs>
            <linearGradient id="gradStroke" x1="0" x2="1">
              <stop offset="0%" stopColor="#60a5fa" />
              <stop offset="50%" stopColor="#a78bfa" />
              <stop offset="100%" stopColor="#fb7185" />
            </linearGradient>

            <linearGradient id="gradFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgba(96,165,250,0.28)" />
              <stop offset="40%" stopColor="rgba(167,139,250,0.18)" />
              <stop offset="100%" stopColor="rgba(251,113,133,0.04)" />
            </linearGradient>
          </defs>
        </svg>
      </div>
    </div>
  );
}

/* =========================
   UI helpers
========================= */

function PrimaryButton({
  children,
  onClick,
  disabled,
  className = "",
  type,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type ?? "button"}
      onClick={onClick}
      disabled={disabled}
      className={[
        "rounded-2xl px-4 py-3 font-semibold text-zinc-950",
        "bg-gradient-to-r from-sky-300 via-violet-300 to-rose-300",
        "hover:from-sky-200 hover:via-violet-200 hover:to-rose-200",
        "disabled:opacity-40 transition",
        className,
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function GlassCard({
  title,
  value,
  subtitle,
  accent = "from-sky-400 via-violet-400 to-rose-400",
}: {
  title: string;
  value: React.ReactNode;
  subtitle?: string;
  accent?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur-xl p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
      <div
        className={`absolute -top-16 -right-16 h-40 w-40 rounded-full bg-gradient-to-br ${accent} opacity-25 blur-2xl`}
      />
      <div className="text-zinc-400 text-sm">{title}</div>
      <div className="text-3xl font-bold mt-1 text-zinc-50">{value}</div>
      {subtitle ? <div className="text-xs text-zinc-500 mt-1">{subtitle}</div> : null}
    </div>
  );
}

function CatButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "w-full rounded-2xl px-3 py-3 text-left border transition",
        active
          ? "bg-white text-black border-white"
          : "bg-white/[0.05] text-zinc-200 border-white/10 hover:border-white/20",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function Chip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "rounded-2xl px-3 py-2 text-sm transition border",
        active
          ? "bg-white text-black border-white"
          : "bg-white/[0.05] border-white/10 text-zinc-200 hover:border-white/20",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

/* =========================
   Main
========================= */

export default function Home() {
  const APP_NAME = "TaskPulse";

  const [user, setUser] = useState<User | null>(null);

  const [category, setCategory] = useState<Category>("daily");
  const [tab, setTab] = useState<Tab>("tasks");
  const [filter, setFilter] = useState<Filter>("all");

  const [text, setText] = useState("");
  const [due, setDue] = useState<string>(dayKey(new Date()));
  const [workoutPart, setWorkoutPart] = useState<WorkoutPart>("chest");

  const [inlineDay, setInlineDay] = useState<string | null>(null);
  const [inlineText, setInlineText] = useState("");

  const [todos, setTodos] = useState<Todo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // workout plan
  const [plan, setPlan] = useState<WorkoutPlan>(defaultPlan);
  const [planLoaded, setPlanLoaded] = useState(false);
  const savePlanTimer = useRef<number | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  // local cache
  useEffect(() => {
    try {
      const cached = localStorage.getItem(LS_KEY);
      if (cached) setTodos(JSON.parse(cached));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(LS_KEY, JSON.stringify(todos));
  }, [todos, loaded]);

  async function login() {
    await signInWithPopup(auth, new GoogleAuthProvider());
  }
  async function logout() {
    await signOut(auth);
  }

  // Fetch todos
  useEffect(() => {
    if (!user) return;

    (async () => {
      setSyncing(true);
      try {
        const colRef = collection(db, "users", user.uid, "todos");
        const snap = await getDocs(colRef);

        const fresh: Todo[] = [];
        snap.forEach((d) => fresh.push(fromFirestoreTodo(d.id, d.data())));
        fresh.sort((a, b) => b.createdAt - a.createdAt);
        setTodos(fresh);
      } finally {
        setSyncing(false);
      }
    })();
  }, [user]);

  // Fetch plan
  useEffect(() => {
    if (!user) return;

    (async () => {
      try {
        const settingsRef = doc(db, "users", user.uid, "meta", "settings");
        const snap = await getDoc(settingsRef);
        if (snap.exists()) {
          const data: any = snap.data();
          const p = data?.workoutPlan;
          if (p && typeof p === "object") {
            const merged: WorkoutPlan = { ...defaultPlan };
            for (const k of weekdayOrder) {
              const row = p[k];
              if (row && typeof row === "object") {
                merged[k] = {
                  enabled: Boolean(row.enabled),
                  part: (row.part as WorkoutPart) ?? defaultPlan[k].part,
                };
              }
            }
            setPlan(merged);
          }
        }
      } finally {
        setPlanLoaded(true);
      }
    })();
  }, [user]);

  // Auto-save plan (debounced)
  useEffect(() => {
    if (!user) return;
    if (!planLoaded) return;

    if (savePlanTimer.current) window.clearTimeout(savePlanTimer.current);
    savePlanTimer.current = window.setTimeout(async () => {
      try {
        const settingsRef = doc(db, "users", user.uid, "meta", "settings");
        await setDoc(
          settingsRef,
          { workoutPlan: plan, updatedAt: serverTimestamp() },
          { merge: true }
        );
      } catch {}
    }, 450);

    return () => {
      if (savePlanTimer.current) window.clearTimeout(savePlanTimer.current);
    };
  }, [plan, user, planLoaded]);

  // When in Workout category: auto-pick workout part from plan based on selected due date
  useEffect(() => {
    if (category !== "workout") return;
    const wd = toWeekdayKeyFromDate(new Date(due));
    const planned = plan[wd];
    if (planned?.enabled) setWorkoutPart(planned.part);
  }, [category, due, plan]);

  async function upsertRemote(todo: Todo) {
    if (!user) return;
    const ref = doc(db, "users", user.uid, "todos", todo.id);
    await setDoc(ref, toFirestoreTodo(todo), { merge: true });
  }
  async function patchRemote(id: string, patch: Partial<Todo>) {
    if (!user) return;
    const ref = doc(db, "users", user.uid, "todos", id);

    const data: any = { updatedAt: serverTimestamp() };
    if ("text" in patch) data.text = patch.text ?? "";
    if ("done" in patch) data.done = !!patch.done;
    if ("createdAt" in patch) data.createdAt = patch.createdAt ?? Date.now();
    if ("doneAt" in patch) data.doneAt = patch.doneAt ?? null;
    if ("doneDay" in patch) data.doneDay = patch.doneDay ?? null;
    if ("dueDay" in patch) data.dueDay = patch.dueDay ?? null;
    if ("category" in patch) data.category = patch.category ?? "daily";
    if ("workoutPart" in patch) data.workoutPart = patch.workoutPart ?? null;

    await updateDoc(ref, data);
  }
  async function deleteRemote(id: string) {
    if (!user) return;
    const ref = doc(db, "users", user.uid, "todos", id);
    await deleteDoc(ref);
  }

  /* ---------- Derived: category filtering ---------- */

  const todosInCat = useMemo(
    () => todos.filter((t) => t.category === category),
    [todos, category]
  );

  const totalCount = todosInCat.length;
  const doneCount = useMemo(() => todosInCat.filter((t) => t.done).length, [todosInCat]);
  const activeCount = totalCount - doneCount;

  const points = doneCount;

  const streak = useMemo(() => {
    const doneDays = new Set<string>();
    for (const t of todosInCat) if (t.done && t.doneDay) doneDays.add(t.doneDay);

    let s = 0;
    let d = new Date();
    while (true) {
      const k = dayKey(d);
      if (!doneDays.has(k)) break;
      s++;
      d = new Date(d);
      d.setDate(d.getDate() - 1);
    }
    return s;
  }, [todosInCat]);

  /* ---------- Actions ---------- */

  async function addTodo(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    const base: Todo = {
      id: crypto.randomUUID(),
      text: trimmed,
      done: false,
      createdAt: Date.now(),
      category,
    };

    const newTodo: Todo =
      category === "workout"
        ? { ...base, dueDay: due, workoutPart }
        : category === "work"
        ? { ...base, dueDay: due }
        : { ...base };

    setTodos((prev) => [newTodo, ...prev]);
    setText("");

    try {
      await upsertRemote(newTodo);
    } catch {}
  }

  async function addTodoInline(day: string) {
    if (!user) return;
    const trimmed = inlineText.trim();
    if (!trimmed) return;

    const base: Todo = {
      id: crypto.randomUUID(),
      text: trimmed,
      done: false,
      createdAt: Date.now(),
      category,
    };

    let newTodo: Todo = { ...base };

    if (category === "workout") {
      const wd = toWeekdayKeyFromDate(new Date(day));
      const planned = plan[wd];
      const part = planned?.enabled ? planned.part : workoutPart;
      newTodo = { ...base, dueDay: day, workoutPart: part };
    } else if (category === "work") {
      newTodo = { ...base, dueDay: day };
    }

    setTodos((prev) => [newTodo, ...prev]);
    setInlineText("");
    setInlineDay(null);

    try {
      await upsertRemote(newTodo);
    } catch {}
  }

  async function toggleTodo(id: string) {
    const today = dayKey(new Date());
    const current = todos.find((t) => t.id === id);
    if (!current) return;

    const next: Todo = current.done
      ? { ...current, done: false, doneAt: undefined, doneDay: undefined }
      : { ...current, done: true, doneAt: Date.now(), doneDay: today };

    setTodos((prev) => prev.map((t) => (t.id === id ? next : t)));

    try {
      await patchRemote(id, { done: next.done, doneAt: next.doneAt, doneDay: next.doneDay });
    } catch {}
  }

  async function removeTodo(id: string) {
    setTodos((prev) => prev.filter((t) => t.id !== id));
    try {
      await deleteRemote(id);
    } catch {}
  }

  async function clearDone() {
    const ids = todosInCat.filter((t) => t.done).map((t) => t.id);
    setTodos((prev) => prev.filter((t) => !(t.category === category && t.done)));
    try {
      for (const id of ids) await deleteRemote(id);
    } catch {}
  }

  /* ---------- Filters (per category) ---------- */

  const visibleTodos = useMemo(() => {
    const today = dayKey(new Date());
    const tomorrow = dayKey(addDays(new Date(), 1));
    const weekSet = new Set(weekKeysMonSun(new Date()));

    let filtered = todosInCat.slice();

    if (filter === "active") filtered = filtered.filter((t) => !t.done);
    if (filter === "done") filtered = filtered.filter((t) => t.done);

    if (filter === "today") filtered = filtered.filter((t) => (t.dueDay ?? today) === today);
    if (filter === "tomorrow") filtered = filtered.filter((t) => (t.dueDay ?? today) === tomorrow);
    if (filter === "week") filtered = filtered.filter((t) => weekSet.has(t.dueDay ?? today));

    filtered.sort((a, b) => {
      const ad = a.dueDay ?? today;
      const bd = b.dueDay ?? today;
      if (ad < bd) return -1;
      if (ad > bd) return 1;
      if (a.done !== b.done) return a.done ? 1 : -1;
      return b.createdAt - a.createdAt;
    });

    return filtered;
  }, [todosInCat, filter]);

  /* ---------- Weekly calendar & 14d chart (per category) ---------- */

  const weekStats = useMemo(() => {
    const keys = weekKeysMonSun(new Date());
    const planned: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
    const done: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));

    for (const t of todosInCat) {
      if (t.dueDay && t.dueDay in planned) planned[t.dueDay] += 1;
      if (t.done && t.doneDay && t.doneDay in done) done[t.doneDay] += 1;
    }

    const arr = keys.map((k) => {
      const wdKey = toWeekdayKeyFromDate(new Date(k));
      const planRow = plan[wdKey];
      const planText =
        category === "workout" && planRow?.enabled ? partLabel[planRow.part] : null;

      return {
        key: k,
        wd: labelWeekdayEN(k),
        date: labelDate(k),
        planned: planned[k],
        done: done[k],
        planText,
      };
    });

    return { arr };
  }, [todosInCat, plan, category]);

  const weekTasksByDay = useMemo(() => {
    const today = dayKey(new Date());
    const map: Record<string, Todo[]> = {};
    for (const k of weekKeysMonSun(new Date())) map[k] = [];

    for (const t of todosInCat) {
      const dueKey = t.dueDay ?? today;
      if (dueKey in map) map[dueKey].push(t);
    }

    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        return b.createdAt - a.createdAt;
      });
    }
    return map;
  }, [todosInCat]);

  const last14 = useMemo(() => {
    const end = new Date();
    const keys: string[] = [];
    for (let i = 13; i >= 0; i--) keys.push(dayKey(addDays(end, -i)));

    const perDay: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const t of todosInCat) {
      if (t.done && t.doneDay && t.doneDay in perDay) perDay[t.doneDay] += 1;
    }

    let running = 0;
    const values = keys.map((k) => {
      running += perDay[k];
      return running;
    });

    const labels = keys.map((k) => labelDate(k));
    return { values, labels };
  }, [todosInCat]);

  /* ---------- Labels ---------- */

  const categoryLabel =
    category === "daily" ? "Daily" : category === "workout" ? "Workout" : "Work";

  /* ---------- Workout plan actions ---------- */

  function togglePlanDay(day: WeekdayKey) {
    setPlan((p) => ({ ...p, [day]: { ...p[day], enabled: !p[day].enabled } }));
  }

  function setPlanPart(day: WeekdayKey, part: WorkoutPart) {
    setPlan((p) => ({ ...p, [day]: { ...p[day], part } }));
  }

  return (
    <main className="min-h-screen text-zinc-100">
      {/* Background */}
      <div className="fixed inset-0 -z-10 bg-zinc-950" />
      <div className="fixed inset-0 -z-10 bg-[radial-gradient(1200px_500px_at_10%_0%,rgba(96,165,250,0.18),transparent_60%),radial-gradient(900px_500px_at_90%_10%,rgba(167,139,250,0.16),transparent_55%),radial-gradient(900px_500px_at_50%_100%,rgba(251,113,133,0.10),transparent_55%)]" />
      <div className="fixed inset-0 -z-10 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.04),transparent_18%)]" />

      <div className="mx-auto max-w-6xl px-4 pt-6 pb-28 sm:pb-10">
        <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-4">
          {/* Sidebar (desktop) */}
          <aside className="hidden lg:block">
            <div className="rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur-xl p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
              <div className="text-xs text-zinc-400 mb-3">Sections</div>
              <div className="space-y-2">
                <CatButton
                  active={category === "daily"}
                  label="Daily"
                  onClick={() => setCategory("daily")}
                />
                <CatButton
                  active={category === "workout"}
                  label="Workout"
                  onClick={() => setCategory("workout")}
                />
                <CatButton
                  active={category === "work"}
                  label="Work"
                  onClick={() => setCategory("work")}
                />
              </div>

              <div className="mt-4 pt-4 border-t border-white/10 text-xs text-zinc-500">
                Current: <span className="text-zinc-200">{categoryLabel}</span>
              </div>
            </div>
          </aside>

          {/* Main */}
          <section>
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-sky-400 via-violet-400 to-rose-400 opacity-90" />
                  <div className="min-w-0">
                    <h1 className="text-3xl sm:text-4xl font-bold tracking-tight truncate">
                      {APP_NAME}{" "}
                      <span className="text-zinc-400 font-semibold">• {categoryLabel}</span>
                    </h1>
                    <p className="text-zinc-400 mt-1 text-sm truncate">
                      Active <span className="text-zinc-100">{activeCount}</span> • Done{" "}
                      <span className="text-zinc-100">{doneCount}</span> • Total{" "}
                      <span className="text-zinc-100">{totalCount}</span>
                      {syncing ? <span className="ml-2">• Syncing…</span> : null}
                    </p>
                  </div>
                </div>
              </div>

              {!user ? (
                <PrimaryButton onClick={login} className="shrink-0">
                  Continue with Google
                </PrimaryButton>
              ) : (
                <button
                  onClick={logout}
                  className="shrink-0 rounded-2xl px-4 py-3 font-semibold bg-white/[0.05] border border-white/10 hover:border-white/20 transition"
                >
                  Sign out
                </button>
              )}
            </div>

            {/* Category pills (mobile) */}
            <div className="lg:hidden mt-4 flex gap-2">
              <Chip active={category === "daily"} label="Daily" onClick={() => setCategory("daily")} />
              <Chip active={category === "workout"} label="Workout" onClick={() => setCategory("workout")} />
              <Chip active={category === "work"} label="Work" onClick={() => setCategory("work")} />
            </div>

            {/* Tabs (desktop) */}
            <div className="mt-4 hidden sm:flex gap-2">
              {(["tasks", "stats"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={[
                    "rounded-2xl px-4 py-2 text-sm border transition",
                    tab === t
                      ? "bg-white text-black border-white"
                      : "bg-white/[0.05] text-zinc-200 border-white/10 hover:border-white/20",
                  ].join(" ")}
                >
                  {t === "tasks" ? "Tasks" : "Stats"}
                </button>
              ))}
            </div>

            {/* Stats cards */}
            <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <GlassCard title="Points" value={points} subtitle="= done tasks" />
              <GlassCard
                title="Streak"
                value={`${streak} 🔥`}
                subtitle="days in a row"
                accent="from-violet-400 via-fuchsia-400 to-rose-400"
              />
              <GlassCard
                title="Progress"
                value={`${totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * 100)}%`}
                subtitle="done / total"
                accent="from-sky-400 via-cyan-400 to-emerald-400"
              />
            </div>

            {/* WORKOUT PLAN as big calendar grid */}
            {category === "workout" && (
              <div className="mt-5 rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur-xl p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <div className="text-zinc-100 font-semibold">Workout week plan</div>
                    <div className="text-zinc-400 text-sm">
                      Plan what you train on each weekday (Mon–Sun).
                    </div>
                  </div>
                  <div className="text-xs text-zinc-500">{user ? "Saved to cloud" : "Sign in to save"}</div>
                </div>

                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {weekdayOrder.map((d) => {
                    const row = plan[d];
                    return (
                      <div
                        key={d}
                        className="rounded-2xl border border-white/10 bg-zinc-950/30 p-4"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm font-semibold text-zinc-100">{weekdayName[d]}</div>

                          <button
                            onClick={() => togglePlanDay(d)}
                            disabled={!user}
                            className={[
                              "h-8 w-14 rounded-full border transition relative",
                              row.enabled
                                ? "bg-emerald-500/20 border-emerald-400/40"
                                : "bg-white/[0.05] border-white/10",
                              !user ? "opacity-50" : "",
                            ].join(" ")}
                            title={row.enabled ? "Enabled" : "Disabled"}
                          >
                            <span
                              className={[
                                "absolute top-1/2 -translate-y-1/2 h-6 w-6 rounded-full bg-white transition",
                                row.enabled ? "left-7" : "left-1",
                              ].join(" ")}
                            />
                          </button>
                        </div>

                        <div className="mt-3">
                          <div className="text-xs text-zinc-500 mb-2">Body part</div>
                          <select
                            value={row.part}
                            onChange={(e) => setPlanPart(d, e.target.value as WorkoutPart)}
                            disabled={!user}
                            className="w-full rounded-2xl bg-zinc-900/40 border border-white/10 px-3 py-3 text-sm text-zinc-200 outline-none focus:border-white/20"
                          >
                            {(Object.keys(partLabel) as WorkoutPart[]).map((p) => (
                              <option key={p} value={p}>
                                {partLabel[p]}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3">
                          <div className="text-xs text-zinc-500">Summary</div>
                          <div className="text-sm text-zinc-100 mt-1">
                            {row.enabled ? partLabel[row.part] : "Rest day"}
                          </div>
                        </div>

                        <div className="mt-3 text-xs text-zinc-500">
                          {row.enabled
                            ? "Auto used when you add a workout task on this weekday."
                            : "Disabled = no default body part."}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-3 text-xs text-zinc-500">
                  Tip: If the day is enabled, workout tasks on that weekday will automatically get the planned body part.
                </div>
              </div>
            )}

            {/* TASKS */}
            {tab === "tasks" && (
              <>
                {/* Desktop add bar */}
                <div className="mt-5 hidden sm:block">
                  <div className="rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur-xl p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
                    <form onSubmit={addTodo} className="flex flex-col sm:flex-row gap-2">
                      <input
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder={user ? `Add to ${categoryLabel}…` : "Sign in to add tasks…"}
                        className="flex-1 rounded-2xl bg-zinc-900/40 border border-white/10 px-4 py-3 outline-none focus:border-white/20"
                        disabled={!user}
                      />

                      {(category === "work" || category === "workout") && (
                        <input
                          type="date"
                          value={due}
                          onChange={(e) => setDue(e.target.value)}
                          className="rounded-2xl bg-zinc-900/40 border border-white/10 px-3 py-3 outline-none focus:border-white/20 text-zinc-200"
                          disabled={!user}
                        />
                      )}

                      <PrimaryButton type="submit" disabled={!user}>
                        Add
                      </PrimaryButton>
                    </form>

                    {category === "workout" && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {(Object.keys(partLabel) as WorkoutPart[]).map((p) => (
                          <Chip
                            key={p}
                            active={workoutPart === p}
                            label={partLabel[p]}
                            onClick={() => setWorkoutPart(p)}
                          />
                        ))}
                      </div>
                    )}

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap gap-2">
                        {(
                          [
                            ["all", "All"],
                            ["today", "Today"],
                            ["tomorrow", "Tomorrow"],
                            ["week", "This week"],
                            ["active", "Active"],
                            ["done", "Done"],
                          ] as const
                        ).map(([f, label]) => (
                          <Chip key={f} active={filter === f} label={label} onClick={() => setFilter(f)} />
                        ))}
                      </div>

                      <button
                        onClick={clearDone}
                        disabled={!user || doneCount === 0}
                        className="rounded-2xl px-3 py-2 text-sm bg-white/[0.05] border border-white/10 text-zinc-200 hover:border-white/20 disabled:opacity-40 transition"
                      >
                        Clear done
                      </button>
                    </div>
                  </div>
                </div>

                {/* List */}
                <ul className="mt-4 space-y-2">
                  {visibleTodos.length === 0 ? (
                    <li className="text-zinc-400">Nothing to show.</li>
                  ) : (
                    visibleTodos.map((t) => {
                      const planned = t.dueDay ?? dayKey(new Date());
                      return (
                        <li
                          key={t.id}
                          className="rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-xl px-4 py-3 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <button
                              onClick={() => toggleTodo(t.id)}
                              className="flex items-start gap-3 text-left min-w-0"
                              disabled={!user}
                            >
                              <span
                                className={[
                                  "mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-full border",
                                  t.done
                                    ? "bg-emerald-500/20 border-emerald-400/50 text-emerald-200"
                                    : "border-white/20 text-zinc-300",
                                ].join(" ")}
                              >
                                {t.done ? "✓" : ""}
                              </span>

                              <div className="flex flex-col min-w-0">
                                <span className={t.done ? "line-through text-zinc-400" : "text-zinc-100"}>
                                  {t.text}
                                </span>

                                <div className="text-xs text-zinc-400 mt-1 flex flex-wrap gap-x-2 gap-y-1">
                                  <span className="text-zinc-500">{categoryLabel}</span>

                                  {category !== "daily" && (
                                    <span>
                                      planned <span className="text-zinc-200">{labelWeekdayEN(planned)}</span>{" "}
                                      ({labelDate(planned)})
                                    </span>
                                  )}

                                  {category === "workout" && t.workoutPart ? (
                                    <span className="text-zinc-200">• {partLabel[t.workoutPart]}</span>
                                  ) : null}
                                </div>
                              </div>
                            </button>

                            <button
                              onClick={() => removeTodo(t.id)}
                              disabled={!user}
                              className="text-zinc-400 hover:text-white disabled:opacity-40 text-lg leading-none"
                              title="Delete"
                            >
                              ✕
                            </button>
                          </div>
                        </li>
                      );
                    })
                  )}
                </ul>
              </>
            )}

            {/* STATS */}
            {tab === "stats" && (
              <div className="mt-5 space-y-4">
                <AreaChart14Days values={last14.values} labels={last14.labels} />

                <div className="rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur-xl p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
                  <div>
                    <div className="text-zinc-100 font-semibold">Weekly calendar</div>
                    <div className="text-zinc-400 text-sm">
                      Planned day (Mon–Sun). Add inline directly into a day.
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    {weekStats.arr.map((d) => {
                      const list = weekTasksByDay[d.key] ?? [];
                      const doneInDay = list.filter((t) => t.done).length;
                      const totalInDay = list.length;

                      return (
                        <div key={d.key} className="rounded-2xl border border-white/10 bg-zinc-950/30 p-3">
                          <div className="flex items-baseline justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-zinc-100">
                                {d.wd} <span className="text-zinc-500 font-normal">({d.date})</span>
                              </div>
                              {d.planText ? (
                                <div className="text-xs text-zinc-300 mt-1">
                                  Plan: <span className="text-zinc-100">{d.planText}</span>
                                </div>
                              ) : null}
                            </div>
                            <div className="text-xs text-zinc-400 flex-shrink-0">
                              {doneInDay}/{totalInDay}
                            </div>
                          </div>

                          <div className="mt-3 space-y-2">
                            {list.length === 0 ? (
                              <div className="text-sm text-zinc-500">No tasks.</div>
                            ) : (
                              list.map((t) => (
                                <div
                                  key={t.id}
                                  className="flex items-start justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2"
                                >
                                  <button
                                    onClick={() => toggleTodo(t.id)}
                                    disabled={!user}
                                    className="flex items-start gap-2 text-left min-w-0"
                                  >
                                    <span
                                      className={[
                                        "mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border",
                                        t.done
                                          ? "bg-emerald-500/20 border-emerald-400/50 text-emerald-200"
                                          : "border-white/20 text-zinc-300",
                                      ].join(" ")}
                                    >
                                      {t.done ? "✓" : ""}
                                    </span>

                                    <span
                                      className={`text-sm break-words ${
                                        t.done ? "line-through text-zinc-400" : "text-zinc-100"
                                      }`}
                                    >
                                      {t.text}
                                      {category === "workout" && t.workoutPart ? (
                                        <span className="text-zinc-400"> • {partLabel[t.workoutPart]}</span>
                                      ) : null}
                                    </span>
                                  </button>

                                  <button
                                    onClick={() => removeTodo(t.id)}
                                    disabled={!user}
                                    className="text-zinc-400 hover:text-white text-sm disabled:opacity-40 flex-shrink-0"
                                    title="Delete"
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))
                            )}
                          </div>

                          <div className="mt-3">
                            {inlineDay !== d.key ? (
                              <button
                                onClick={() => {
                                  setInlineDay(d.key);
                                  setInlineText("");
                                }}
                                disabled={!user}
                                className="text-sm text-zinc-200 hover:text-white underline underline-offset-4 disabled:opacity-40"
                              >
                                + add task
                              </button>
                            ) : (
                              <div className="mt-2 flex flex-col gap-2">
                                <input
                                  value={inlineText}
                                  onChange={(e) => setInlineText(e.target.value)}
                                  placeholder="New task…"
                                  className="w-full rounded-xl bg-zinc-900/40 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/20"
                                  autoFocus
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") addTodoInline(d.key);
                                    if (e.key === "Escape") {
                                      setInlineDay(null);
                                      setInlineText("");
                                    }
                                  }}
                                />
                                <div className="flex gap-2">
                                  <PrimaryButton onClick={() => addTodoInline(d.key)} className="flex-1 py-2">
                                    Add
                                  </PrimaryButton>
                                  <button
                                    onClick={() => {
                                      setInlineDay(null);
                                      setInlineText("");
                                    }}
                                    className="flex-1 rounded-xl px-3 py-2 text-sm font-semibold bg-white/[0.05] border border-white/10 text-zinc-200 hover:border-white/20"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-3 text-xs text-zinc-500">
                    Tip: Press <span className="text-zinc-200">Enter</span> to add,{" "}
                    <span className="text-zinc-200">Esc</span> to cancel.
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Sticky Add Bar (MOBILE) */}
      <div className="sm:hidden fixed left-0 right-0 bottom-14 px-4 pb-3">
        <div className="rounded-3xl border border-white/10 bg-zinc-950/60 backdrop-blur-xl p-3 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
          <form onSubmit={addTodo} className="flex flex-col gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={user ? `Add to ${categoryLabel}…` : "Sign in to add tasks…"}
              className="w-full rounded-2xl bg-zinc-900/50 border border-white/10 px-4 py-3 outline-none focus:border-white/20 text-base"
              disabled={!user}
            />

            <div className="flex gap-2">
              {(category === "work" || category === "workout") ? (
                <input
                  type="date"
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                  className="flex-1 rounded-2xl bg-zinc-900/50 border border-white/10 px-3 py-3 outline-none focus:border-white/20 text-zinc-200"
                  disabled={!user}
                />
              ) : (
                <div className="flex-1 rounded-2xl bg-white/[0.04] border border-white/10 px-3 py-3 text-zinc-400 text-sm flex items-center">
                  No date (Daily)
                </div>
              )}

              <PrimaryButton type="submit" disabled={!user} className="px-5">
                Add
              </PrimaryButton>
            </div>

            {category === "workout" && (
              <div className="flex flex-wrap gap-2">
                {(Object.keys(partLabel) as WorkoutPart[]).map((p) => (
                  <Chip
                    key={p}
                    active={workoutPart === p}
                    label={partLabel[p]}
                    onClick={() => setWorkoutPart(p)}
                  />
                ))}
              </div>
            )}
          </form>
        </div>
      </div>

      {/* Bottom Nav (MOBILE): Tasks/Stats */}
      <div className="sm:hidden fixed left-0 right-0 bottom-0 px-4 pb-4">
        <div className="rounded-3xl border border-white/10 bg-zinc-950/60 backdrop-blur-xl p-2 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setTab("tasks")}
              className={[
                "rounded-2xl py-3 font-semibold border transition",
                tab === "tasks"
                  ? "bg-gradient-to-r from-sky-300 via-violet-300 to-rose-300 text-zinc-950 border-white/0"
                  : "bg-white/[0.05] text-zinc-200 border-white/10",
              ].join(" ")}
            >
              Tasks
            </button>
            <button
              onClick={() => setTab("stats")}
              className={[
                "rounded-2xl py-3 font-semibold border transition",
                tab === "stats"
                  ? "bg-gradient-to-r from-sky-300 via-violet-300 to-rose-300 text-zinc-950 border-white/0"
                  : "bg-white/[0.05] text-zinc-200 border-white/10",
              ].join(" ")}
            >
              Stats
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
