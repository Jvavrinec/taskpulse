"use client";

import { useEffect, useMemo, useState } from "react";
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
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { auth, db } from "./lib/firebase";

type Todo = {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;

  doneAt?: number;
  doneDay?: string; // YYYY-MM-DD (local)

  dueDay?: string; // YYYY-MM-DD
};

type Tab = "tasks" | "stats";
type Filter = "all" | "today" | "tomorrow" | "week" | "active" | "done";

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
  const day = x.getDay(); // 0=Sun,1=Mon,...6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

function weekKeysMonSun(d: Date) {
  const start = startOfWeekMonday(d);
  const keys: string[] = [];
  for (let i = 0; i < 7; i++) keys.push(dayKey(addDays(start, i)));
  return keys;
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

const LS_KEY = "taskpulse_cache_v9";

function toFirestoreTodo(t: Todo) {
  return {
    text: t.text,
    done: t.done,
    createdAt: t.createdAt,
    doneAt: t.doneAt ?? null,
    doneDay: t.doneDay ?? null,
    dueDay: t.dueDay ?? null,
    updatedAt: serverTimestamp(),
  };
}

function fromFirestoreTodo(id: string, data: any): Todo {
  return {
    id,
    text: String(data?.text ?? ""),
    done: Boolean(data?.done ?? false),
    createdAt: Number(data?.createdAt ?? Date.now()),
    doneAt: data?.doneAt == null ? undefined : Number(data.doneAt),
    doneDay: data?.doneDay == null ? undefined : String(data.doneDay),
    dueDay: data?.dueDay == null ? undefined : String(data.dueDay),
  };
}

/* ----------------- GRAPH HELPERS ----------------- */

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

/* ----------------- SVG AREA CHART (NO LIBS) ----------------- */

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
    <div className="rounded-3xl border border-white/10 bg-zinc-950/30 p-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-zinc-200 font-semibold">Last 14 days</div>
          <div className="text-zinc-500 text-sm">Total done (cumulative)</div>
        </div>

        <div className="text-zinc-500 text-sm">
          scale <span className="text-zinc-200">0–{yMax}</span>
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
              <stop offset="0%" stopColor="#8b5cf6" />
              <stop offset="100%" stopColor="#ec4899" />
            </linearGradient>

            <linearGradient id="gradFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgba(139,92,246,0.32)" />
              <stop offset="100%" stopColor="rgba(236,72,153,0.04)" />
            </linearGradient>
          </defs>
        </svg>
      </div>

      <div className="mt-2 text-xs text-zinc-600">
        data max: <span className="text-zinc-300">{dataMax}</span>
      </div>
    </div>
  );
}

/* ----------------------------- APP ----------------------------- */

export default function Home() {
  const APP_NAME = "TaskPulse";

  const [user, setUser] = useState<User | null>(null);
  const [tab, setTab] = useState<Tab>("tasks");
  const [filter, setFilter] = useState<Filter>("all");

  const [text, setText] = useState("");
  const [due, setDue] = useState<string>(dayKey(new Date()));

  const [inlineDay, setInlineDay] = useState<string | null>(null);
  const [inlineText, setInlineText] = useState("");

  const [todos, setTodos] = useState<Todo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

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

    await updateDoc(ref, data);
  }

  async function deleteRemote(id: string) {
    if (!user) return;
    const ref = doc(db, "users", user.uid, "todos", id);
    await deleteDoc(ref);
  }

  const totalCount = todos.length;
  const doneCount = useMemo(() => todos.filter((t) => t.done).length, [todos]);
  const activeCount = totalCount - doneCount;

  const points = doneCount;
  const progressPct = totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * 100);

  async function addTodo(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    const newTodo: Todo = {
      id: crypto.randomUUID(),
      text: trimmed,
      done: false,
      createdAt: Date.now(),
      dueDay: due,
    };

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

    const newTodo: Todo = {
      id: crypto.randomUUID(),
      text: trimmed,
      done: false,
      createdAt: Date.now(),
      dueDay: day,
    };

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
      await patchRemote(id, {
        done: next.done,
        doneAt: next.doneAt,
        doneDay: next.doneDay,
      });
    } catch {}
  }

  async function removeTodo(id: string) {
    setTodos((prev) => prev.filter((t) => t.id !== id));
    try {
      await deleteRemote(id);
    } catch {}
  }

  async function clearDone() {
    const ids = todos.filter((t) => t.done).map((t) => t.id);
    setTodos((prev) => prev.filter((t) => !t.done));
    try {
      for (const id of ids) await deleteRemote(id);
    } catch {}
  }

  const streak = useMemo(() => {
    const doneDays = new Set<string>();
    for (const t of todos) if (t.done && t.doneDay) doneDays.add(t.doneDay);

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
  }, [todos]);

  const visibleTodos = useMemo(() => {
    const today = dayKey(new Date());
    const tomorrow = dayKey(addDays(new Date(), 1));
    const weekSet = new Set(weekKeysMonSun(new Date()));

    let filtered = todos.slice();

    if (filter === "active") filtered = filtered.filter((t) => !t.done);
    if (filter === "done") filtered = filtered.filter((t) => t.done);

    if (filter === "today") filtered = filtered.filter((t) => (t.dueDay ?? today) === today);
    if (filter === "tomorrow")
      filtered = filtered.filter((t) => (t.dueDay ?? today) === tomorrow);
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
  }, [todos, filter]);

  const weekStats = useMemo(() => {
    const keys = weekKeysMonSun(new Date());
    const planned: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
    const done: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));

    for (const t of todos) {
      if (t.dueDay && t.dueDay in planned) planned[t.dueDay] += 1;
      if (t.done && t.doneDay && t.doneDay in done) done[t.doneDay] += 1;
    }

    const arr = keys.map((k) => ({
      key: k,
      wd: labelWeekdayEN(k),
      date: labelDate(k),
      planned: planned[k],
      done: done[k],
    }));

    return { arr };
  }, [todos]);

  const weekTasksByDay = useMemo(() => {
    const today = dayKey(new Date());
    const map: Record<string, Todo[]> = {};
    for (const k of weekKeysMonSun(new Date())) map[k] = [];

    for (const t of todos) {
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
  }, [todos]);

  const last14 = useMemo(() => {
    const end = new Date();
    const keys: string[] = [];
    for (let i = 13; i >= 0; i--) keys.push(dayKey(addDays(end, -i)));

    const perDay: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const t of todos) {
      if (t.done && t.doneDay && t.doneDay in perDay) perDay[t.doneDay] += 1;
    }

    let running = 0;
    const values = keys.map((k) => {
      running += perDay[k];
      return running;
    });

    const labels = keys.map((k) => labelDate(k));
    return { values, labels };
  }, [todos]);

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-4xl font-bold tracking-tight">{APP_NAME}</h1>
            <p className="text-zinc-500 mt-2 text-sm">
              Active <span className="text-zinc-200">{activeCount}</span> • Done{" "}
              <span className="text-zinc-200">{doneCount}</span> • Total{" "}
              <span className="text-zinc-200">{totalCount}</span>
              {user ? (
                <span className="ml-2">• {user.displayName ?? user.email ?? "user"}</span>
              ) : (
                <span className="ml-2">• Sign in to sync</span>
              )}
              {syncing ? <span className="ml-2">• Syncing…</span> : null}
            </p>
          </div>

          {!user ? (
            <button
              onClick={login}
              className="rounded-2xl px-5 py-3 font-semibold text-zinc-950 bg-zinc-100 hover:bg-white transition"
            >
              Continue with Google
            </button>
          ) : (
            <button
              onClick={logout}
              className="rounded-2xl px-5 py-3 font-semibold bg-zinc-900 border border-white/10 hover:border-white/20 transition"
            >
              Sign out
            </button>
          )}
        </div>

        <div className="mt-6 flex gap-2">
          <button
            onClick={() => setTab("tasks")}
            className={`rounded-2xl px-4 py-2 text-sm border transition ${
              tab === "tasks"
                ? "bg-white text-black border-white"
                : "bg-zinc-900 text-zinc-200 border-white/10 hover:border-white/20"
            }`}
          >
            Tasks
          </button>
          <button
            onClick={() => setTab("stats")}
            className={`rounded-2xl px-4 py-2 text-sm border transition ${
              tab === "stats"
                ? "bg-white text-black border-white"
                : "bg-zinc-900 text-zinc-200 border-white/10 hover:border-white/20"
            }`}
          >
            Stats
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-3xl border border-white/10 bg-zinc-950/30 p-5">
            <div className="text-zinc-400 text-sm">Points</div>
            <div className="text-3xl font-bold mt-1">{points}</div>
            <div className="text-xs text-zinc-500 mt-1">= done tasks</div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-zinc-950/30 p-5">
            <div className="text-zinc-400 text-sm">Streak</div>
            <div className="text-3xl font-bold mt-1">{streak} 🔥</div>
            <div className="text-xs text-zinc-500 mt-1">days in a row</div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-zinc-950/30 p-5">
            <div className="text-zinc-400 text-sm">Progress</div>
            <div className="text-3xl font-bold mt-1">{progressPct}%</div>
            <div className="mt-3 h-2 rounded-full bg-zinc-800/70 overflow-hidden">
              <div className="h-full bg-white transition-all duration-500" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        </div>

        {/* ✅ TASKS TAB (the add task area is back) */}
        {tab === "tasks" && (
          <>
            <div className="mt-6 rounded-3xl border border-white/10 bg-zinc-950/30 p-5">
              <form onSubmit={addTodo} className="flex flex-col sm:flex-row gap-2">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={user ? "Write a task…" : "Sign in to add tasks…"}
                  className="flex-1 rounded-2xl bg-zinc-900/40 border border-white/10 px-4 py-3 outline-none focus:border-white/20"
                  disabled={!user}
                />
                <input
                  type="date"
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                  className="rounded-2xl bg-zinc-900/40 border border-white/10 px-3 py-3 outline-none focus:border-white/20 text-zinc-200"
                  disabled={!user}
                />
                <button
                  type="submit"
                  disabled={!user}
                  className="rounded-2xl px-5 py-3 font-semibold text-black bg-white hover:bg-zinc-100 disabled:opacity-40 transition"
                >
                  Add
                </button>
              </form>

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
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      className={`rounded-2xl px-3 py-2 text-sm transition border ${
                        filter === f
                          ? "bg-white text-black border-white"
                          : "bg-zinc-900/30 border-white/10 text-zinc-200 hover:border-white/20"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <button
                  onClick={clearDone}
                  disabled={!user || doneCount === 0}
                  className="rounded-2xl px-3 py-2 text-sm bg-zinc-900/30 border border-white/10 text-zinc-200 hover:border-white/20 disabled:opacity-40 transition"
                >
                  Clear done
                </button>
              </div>
            </div>

            <ul className="mt-4 space-y-2">
              {visibleTodos.length === 0 ? (
                <li className="text-zinc-500">Nothing to show.</li>
              ) : (
                visibleTodos.map((t) => {
                  const planned = t.dueDay ?? dayKey(new Date());
                  return (
                    <li key={t.id} className="rounded-2xl border border-white/10 bg-zinc-950/30 px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <button
                          onClick={() => toggleTodo(t.id)}
                          className="flex items-start gap-3 text-left"
                          disabled={!user}
                        >
                          <span
                            className={`mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full border ${
                              t.done ? "bg-green-500/20 border-green-500 text-green-300" : "border-white/20 text-zinc-300"
                            }`}
                          >
                            {t.done ? "✓" : ""}
                          </span>

                          <div className="flex flex-col">
                            <span className={t.done ? "line-through text-zinc-400" : ""}>{t.text}</span>
                            <span className="text-xs text-zinc-400 mt-1">
                              planned <span className="text-zinc-200">{labelWeekdayEN(planned)}</span> ({labelDate(planned)})
                            </span>
                          </div>
                        </button>

                        <button
                          onClick={() => removeTodo(t.id)}
                          disabled={!user}
                          className="text-zinc-400 hover:text-white disabled:opacity-40"
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

        {/* ✅ STATS TAB */}
        {tab === "stats" && (
          <div className="mt-6 space-y-4">
            <AreaChart14Days values={last14.values} labels={last14.labels} />

            <div className="rounded-3xl border border-white/10 bg-zinc-950/30 p-5">
              <div>
                <div className="text-zinc-200 font-semibold">Weekly calendar</div>
                <div className="text-zinc-500 text-sm">
                  Tasks grouped by planned day (Mon–Sun). Add inline directly into a day.
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {weekStats.arr.map((d) => {
                  const list = weekTasksByDay[d.key] ?? [];
                  const doneInDay = list.filter((t) => t.done).length;
                  const totalInDay = list.length;

                  return (
                    <div key={d.key} className="rounded-2xl border border-white/10 bg-zinc-900/20 p-3">
                      <div className="flex items-baseline justify-between">
                        <div className="text-sm font-semibold text-zinc-200">
                          {d.wd} <span className="text-zinc-500 font-normal">({d.date})</span>
                        </div>
                        <div className="text-xs text-zinc-500">
                          {doneInDay}/{totalInDay}
                        </div>
                      </div>

                      <div className="mt-3 space-y-2">
                        {list.length === 0 ? (
                          <div className="text-sm text-zinc-600">No tasks.</div>
                        ) : (
                          list.map((t) => (
                            <div
                              key={t.id}
                              className="flex items-start justify-between gap-2 rounded-xl border border-white/10 bg-zinc-950/30 px-3 py-2"
                            >
                              <button
                                onClick={() => toggleTodo(t.id)}
                                disabled={!user}
                                className="flex items-start gap-2 text-left min-w-0"
                              >
                                <span
                                  className={`mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border ${
                                    t.done ? "bg-green-500/20 border-green-500 text-green-300" : "border-white/20 text-zinc-300"
                                  }`}
                                >
                                  {t.done ? "✓" : ""}
                                </span>

                                <span
                                  className={`text-sm break-words ${
                                    t.done ? "line-through text-zinc-400" : "text-zinc-200"
                                  }`}
                                >
                                  {t.text}
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
                            + add task to {d.wd}
                          </button>
                        ) : (
                          <div className="mt-2 flex flex-col gap-2">
                            <input
                              value={inlineText}
                              onChange={(e) => setInlineText(e.target.value)}
                              placeholder={`New task for ${d.wd}…`}
                              className="w-full rounded-xl bg-zinc-950/40 border border-white/10 px-3 py-2 text-sm outline-none focus:border-white/20"
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
                              <button
                                onClick={() => addTodoInline(d.key)}
                                className="flex-1 rounded-xl px-3 py-2 text-sm font-semibold text-black bg-white hover:bg-zinc-100"
                              >
                                Add
                              </button>
                              <button
                                onClick={() => {
                                  setInlineDay(null);
                                  setInlineText("");
                                }}
                                className="flex-1 rounded-xl px-3 py-2 text-sm font-semibold bg-zinc-950/40 border border-white/10 text-zinc-200 hover:border-white/20"
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

              <div className="mt-3 text-xs text-zinc-600">
                Tip: Press <span className="text-zinc-300">Enter</span> to add,{" "}
                <span className="text-zinc-300">Esc</span> to cancel.
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
