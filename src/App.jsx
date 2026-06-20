import { useState, useMemo, useEffect, useRef } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceDot, ReferenceLine, Legend,
} from "recharts";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { open as openFolder, ask, message } from "@tauri-apps/plugin-dialog";

// ---- palettes --------------------------------------------------------------
// Two themes; the active one is selected at render time and threaded through
// both inline styles and the Recharts components as `C`.
const THEMES = {
  light: {
    page: "#F4F6F5",
    card: "#FFFFFF",
    ink: "#16241F",
    inkSoft: "#4A5953",
    hair: "#D8DDDA",
    inputBg: "#F4F6F5",
    highlight: "#FBF7EE",   // milestone row hit
    brass: "#A87C3C",       // the target — the number you're aiming at
    avg: "#2F6F5E",         // average market
    low: "#5A6B82",         // below-average market
    saved: "#B8487E",       // income plan: saved per year
    coverLine: "#6E59C7",   // income plan: salary to cover spending
    shadow: "0 -2px 14px rgba(0,0,0,.06)",
  },
  dark: {
    page: "#121212",
    card: "#1D1D1F",
    ink: "#ECECED",
    inkSoft: "#A0A0A2",
    hair: "#333335",
    inputBg: "#171718",
    highlight: "#2A2417",
    brass: "#D2A459",
    avg: "#52B79A",
    low: "#8BA0C6",
    saved: "#E083B0",       // income plan: saved per year
    coverLine: "#9E8AE0",   // income plan: salary to cover spending
    shadow: "0 -2px 16px rgba(0,0,0,.4)",
  },
};
const serif = "'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif";
const sans = "ui-sans-serif,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const mono = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

const usd = (n) =>
  n == null || isNaN(n) ? "—" : "$" + Math.round(n).toLocaleString("en-US");
const compact = (n) => {
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return "$" + Math.round(n / 1e3) + "k";
  return "$" + Math.round(n);
};

// ---- 2026 tax model (single filer, Oregon resident, no local income tax) ----
const FED_STD = 16100;
const FED_BRACKETS = [
  [12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24],
  [256225, 0.32], [640600, 0.35], [Infinity, 0.37],
];
const OR_STD = 2745;
const OR_CREDIT = 236;        // personal exemption credit
const OR_FED_SUB_CAP = 8750;  // subtraction for federal tax paid
const OR_BRACKETS = [
  [4050, 0.0475], [10200, 0.0675], [125000, 0.0875], [Infinity, 0.099],
];
const FICA = 0.0765;

function bracketTax(taxable, brackets) {
  if (taxable <= 0) return 0;
  let tax = 0, lo = 0;
  for (const [cap, rate] of brackets) {
    if (taxable > lo) { tax += (Math.min(taxable, cap) - lo) * rate; lo = cap; }
    else break;
  }
  return tax;
}
function netTakeHome(gross, pretax, roth) {
  const fica = gross * FICA;
  const fedTax = bracketTax(gross - pretax - FED_STD, FED_BRACKETS);
  const orTaxable = (gross - pretax) - OR_STD - Math.min(fedTax, OR_FED_SUB_CAP);
  const orTax = Math.max(0, bracketTax(orTaxable, OR_BRACKETS) - OR_CREDIT);
  return gross - fica - fedTax - orTax - pretax - roth;
}
// Smallest gross salary whose take-home (after tax + the given savings) = targetCash.
function solveGross(targetCash, pretax, roth) {
  let lo = 1000, hi = 800000;
  for (let i = 0; i < 90; i++) {
    const mid = (lo + hi) / 2;
    if (netTakeHome(mid, pretax, roth) < targetCash) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---- projection model ------------------------------------------------------
// Inflation multiplier for a working age. Each period's entered values are taken
// as-is at the period's start — current income at today's age, post-change income
// at the change age — and only grow with inflation from there.
function inflFactor(s, age) {
  if (!s.growIncome) return 1;
  const base = s.jobChange && age >= s.changeAge ? s.changeAge : s.currentAge;
  return Math.pow(1 + s.inflation, age - base);
}

// Gross income at a given working age, in that year's (nominal) dollars.
function incomeAt(s, age) {
  const base = s.jobChange && age >= s.changeAge ? s.incomeAfter : s.income;
  return base * inflFactor(s, age);
}

// Annual contribution for a working year, in that year's (nominal) dollars.
// Each account has a current-job and an after-change value; the $/% toggle
// decides whether they're read as dollars or as a fraction of income.
function contributionFor(s, age) {
  const after = s.jobChange && age >= s.changeAge;
  const mode = after ? s.contribModeAfter : s.contribModeBefore;
  if (mode === "percent") {
    const pct = after ? s.pct401kAfter + s.pctRothAfter : s.pct401kBefore + s.pctRothBefore;
    return incomeAt(s, age) * pct;
  }
  const amt = after ? s.amt401kAfter + s.amtRothAfter : s.amt401kBefore + s.amtRothBefore;
  return amt * inflFactor(s, age);
}

// One person's projection indexed by year-offset t (0..T), so multiple people on
// a shared timeline can be summed into a household. Social Security offsets the
// spending you must self-fund, lowering the target across the whole projection.
function projectPerson(s, T) {
  const spend0 = (s.monthlyNeed + s.monthlyExtra) * 12;
  const targetAt = (t) => {
    const spend = spend0 * Math.pow(1 + s.inflation, t);
    const ss = s.includeSS ? s.ssAnnual * Math.pow(1 + s.inflation, t) : 0;
    return Math.max(0, spend - ss) / s.wr;
  };
  const avg = [s.balance], low = [s.balance], target = [targetAt(0)];
  let a = s.balance, l = s.balance;
  for (let t = 1; t <= T; t++) {
    const workAge = s.currentAge + t - 1;            // age during the year saved
    const working = workAge < s.retireAge;
    const contrib = working ? contributionFor(s, workAge) : 0;
    a = a * (1 + s.avgRet) + contrib;
    l = l * (1 + s.lowRet) + contrib;
    avg.push(a); low.push(l); target.push(targetAt(t));
  }
  return { avg, low, target, spend0, grossCoast: solveGross(spend0, 0, 0) };
}

// Saving for a person in a given period, as a today's-$ total and a label.
function savedTodayOf(st, when) {
  const pct = when === "after" ? st.pct401kAfter + st.pctRothAfter : st.pct401kBefore + st.pctRothBefore;
  const amt = when === "after" ? st.amt401kAfter + st.amtRothAfter : st.amt401kBefore + st.amtRothBefore;
  const mode = when === "after" ? st.contribModeAfter : st.contribModeBefore;
  return mode === "percent" ? (when === "after" ? st.incomeAfter : st.income) * pct : amt;
}

// ---- small UI atoms --------------------------------------------------------
function NumField({ label, value, onChange, step = 1, prefix, c }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", fontSize: 11, letterSpacing: ".06em",
        textTransform: "uppercase", color: c.inkSoft, marginBottom: 6 }}>{label}</span>
      <span style={{ display: "flex", alignItems: "center", border: `1px solid ${c.hair}`,
        borderRadius: 8, background: c.inputBg, overflow: "hidden" }}>
        {prefix && <span style={{ padding: "0 4px 0 10px", color: c.inkSoft, fontFamily: mono }}>{prefix}</span>}
        <input type="number" value={value} step={step}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          onWheel={(e) => e.currentTarget.blur()}
          style={{ width: "100%", border: "none", outline: "none", background: "transparent",
            padding: prefix ? "9px 10px 9px 2px" : "9px 10px", fontFamily: mono,
            fontSize: 15, color: c.ink }} />
      </span>
    </label>
  );
}

function Slider({ label, value, onChange, min, max, step, c }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "flex", justifyContent: "space-between",
        fontSize: 11, letterSpacing: ".06em", textTransform: "uppercase",
        color: c.inkSoft, marginBottom: 6 }}>
        <span>{label}</span>
        <span style={{ fontFamily: mono, color: c.ink }}>{(value * 100).toFixed(1)}%</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onWheel={(e) => e.currentTarget.blur()}
        style={{ width: "100%", accentColor: c.avg }} />
    </label>
  );
}

// ---- main ------------------------------------------------------------------
// Illustrative defaults loosely reflecting a typical US worker (median-ish
// figures). Overridden by whatever you've saved in the app.
const DEFAULTS = {
  currentAge: 40,
  balance: 60000,
  income: 60000,       // current annual gross income (today's $)
  jobChange: true,     // model a mid-career income drop
  incomeAfter: 40000,  // income after the change (today's $)
  changeAge: 50,       // age the income change happens
  growIncome: true,    // does income keep pace with inflation?
  contribModeBefore: "amount", // "amount" ($) or "percent" (% of income) — current job
  contribModeAfter: "amount",  // input mode for the after-change set
  // contributions per account, current job vs. after the job change
  amt401kBefore: 5000, amtRothBefore: 2000,    // $/yr — amount mode
  amt401kAfter: 2000,  amtRothAfter: 1000,
  pct401kBefore: 0.07, pctRothBefore: 0.03,     // fraction of income — percent mode
  pct401kAfter: 0.04,  pctRothAfter: 0.02,
  retireAge: 65,       // age you stop working entirely
  monthlyNeed: 3000,
  monthlyExtra: 1000,
  inflation: 0.03,
  avgRet: 0.07,
  lowRet: 0.05,
  wr: 0.04,
  includeSS: false,
  ssAnnual: 22000,
  horizonAge: 80,
};
const STORAGE_KEY = "retirement-crossover-settings";
const THEME_KEY = "retirement-crossover-theme";
const DATADIR_KEY = "retirement-crossover-datadir";
const DATA_FILENAME = "retirement-planner-data.json";

const isTauri = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
const dataFilePath = (dir) => `${dir.replace(/\/+$/, "")}/${DATA_FILENAME}`;

// Persisted shape: { people: [{ name, settings }], activeIndex }. Older builds
// stored a single flat settings object — migrate that into one person.
function coerceStore(parsed) {
  if (parsed && Array.isArray(parsed.people) && parsed.people.length) {
    const people = parsed.people.map((p, i) => ({
      name: typeof p.name === "string" ? p.name : `Person ${i + 1}`,
      settings: { ...DEFAULTS, ...(p.settings || {}) },
    }));
    const activeIndex = Math.min(Math.max(0, parsed.activeIndex | 0), people.length - 1);
    return { people, activeIndex };
  }
  if (parsed && typeof parsed === "object") {
    return { people: [{ name: "Person 1", settings: { ...DEFAULTS, ...parsed } }], activeIndex: 0 };
  }
  return { people: [{ name: "Person 1", settings: DEFAULTS }], activeIndex: 0 };
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return coerceStore(JSON.parse(raw));
  } catch (e) { /* ignore */ }
  return { people: [{ name: "Person 1", settings: DEFAULTS }], activeIndex: 0 };
}
function loadDataDir() {
  try { return localStorage.getItem(DATADIR_KEY) || null; } catch (e) { return null; }
}
function loadTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "light" || t === "dark") return t;
  } catch (e) { /* ignore */ }
  return "dark"; // dark by default
}

export default function App() {
  const [store, setStore] = useState(loadState); // { people, activeIndex }
  const [saveState, setSaveState] = useState("idle");
  const [theme, setTheme] = useState(loadTheme);
  const [viewMode, setViewMode] = useState("combined"); // "combined" | "perPerson"
  const [dataDir, setDataDir] = useState(loadDataDir); // external folder, or null = localStorage
  const C = THEMES[theme];

  const { people, activeIndex } = store;
  const s = people[activeIndex].settings; // active person's settings (left column)

  const storeRef = useRef(store);
  storeRef.current = store;
  const fileReady = useRef(!(isTauri && dataDir)); // gate file writes until first load done
  const writeTimer = useRef(null);

  // On launch, if a data folder is set, load the store from its file.
  useEffect(() => {
    if (!isTauri || !dataDir) { fileReady.current = true; return; }
    let cancelled = false;
    invoke("read_data", { path: dataFilePath(dataDir) })
      .then((text) => { if (!cancelled && text) setStore(coerceStore(JSON.parse(text))); })
      .catch((e) => console.error("Could not read data folder", e))
      .finally(() => { fileReady.current = true; });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist on every change: always to localStorage (cache + pointer), and to the
  // chosen data folder (debounced) when one is set.
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) { console.error("Could not save settings", e); }
    setSaveState("saved");
    const t = setTimeout(() => setSaveState("idle"), 1400);
    if (isTauri && dataDir && fileReady.current) {
      if (writeTimer.current) clearTimeout(writeTimer.current);
      writeTimer.current = setTimeout(() => {
        invoke("write_data", { path: dataFilePath(dataDir), contents: JSON.stringify(store) })
          .catch((e) => console.error("Could not write to data folder", e));
      }, 500);
    }
    return () => clearTimeout(t);
  }, [store, dataDir]);

  // Native "File → Choose Data Folder…" menu item drives this flow.
  const chooseDataFolder = async () => {
    try {
      const dir = await openFolder({ directory: true, multiple: false,
        title: "Choose a folder to store your data",
        defaultPath: dataDir || undefined });
      if (!dir || typeof dir !== "string") return;
      const path = dataFilePath(dir);
      const exists = await invoke("data_exists", { path });
      if (exists) {
        const useExisting = await ask(
          "This folder already contains Retirement Planner data.\n\nUse the data that's already there? Choosing “No” overwrites it with your current data.",
          { title: "Existing data found", kind: "warning", okLabel: "Use existing", cancelLabel: "Overwrite" });
        if (useExisting) {
          const text = await invoke("read_data", { path });
          setStore(coerceStore(JSON.parse(text)));
        } else {
          await invoke("write_data", { path, contents: JSON.stringify(storeRef.current) });
        }
      } else {
        const ok = await ask(
          `Store your data in:\n${dir}\n\nYour current data will be copied here and the app will use it from now on.`,
          { title: "Use this folder?", okLabel: "Store here", cancelLabel: "Cancel" });
        if (!ok) return;
        await invoke("write_data", { path, contents: JSON.stringify(storeRef.current) });
      }
      fileReady.current = true;
      setDataDir(dir);
      try { localStorage.setItem(DATADIR_KEY, dir); } catch (e) { /* ignore */ }
      await message(`Now storing data in:\n${dir}`, { title: "Data location set" });
    } catch (e) {
      console.error("Choose data folder failed", e);
      try { await message("Could not set the data folder.\n\n" + e, { title: "Error", kind: "error" }); } catch (_) { /* ignore */ }
    }
  };

  useEffect(() => {
    if (!isTauri) return;
    const unlisten = listen("menu-choose-data-folder", () => chooseDataFolder());
    return () => { unlisten.then((f) => f()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- people (tabs) ---
  const selectPerson = (index) => setStore((st) => ({ ...st, activeIndex: index }));
  const addPerson = () => setStore((st) => ({
    people: [...st.people, { name: `Person ${st.people.length + 1}`, settings: DEFAULTS }],
    activeIndex: st.people.length,
  }));
  const renamePerson = (index, name) => setStore((st) => ({
    ...st, people: st.people.map((p, i) => (i === index ? { ...p, name } : p)),
  }));
  const removePerson = (index) => setStore((st) => {
    if (st.people.length <= 1) return st;
    const people = st.people.filter((_, i) => i !== index);
    let activeIndex = index < st.activeIndex ? st.activeIndex - 1 : st.activeIndex;
    activeIndex = Math.max(0, Math.min(activeIndex, people.length - 1));
    return { people, activeIndex };
  });

  useEffect(() => {
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
    // Cover overscroll / areas the root div doesn't paint.
    document.body.style.background = C.page;
    // Render native controls (number-input spinners, scrollbars) for the theme.
    document.documentElement.style.colorScheme = theme;
  }, [theme, C.page]);

  // Update the active person's settings (accepts a value or an updater fn).
  const setS = (upd) => setStore((st) => ({
    ...st,
    people: st.people.map((p, i) =>
      i === st.activeIndex
        ? { ...p, settings: typeof upd === "function" ? upd(p.settings) : upd }
        : p),
  }));

  const set = (k) => (v) => setS((p) => ({ ...p, [k]: v }));

  // Flip a contribution set between $ and % mode, converting the values so the
  // dollar amount carries over (using that period's income) — no data loss.
  const toggleContribMode = (period) => {
    const after = period === "after";
    const incKey = after ? "incomeAfter" : "income";
    const modeKey = after ? "contribModeAfter" : "contribModeBefore";
    const a401 = after ? "amt401kAfter" : "amt401kBefore";
    const aRoth = after ? "amtRothAfter" : "amtRothBefore";
    const p401 = after ? "pct401kAfter" : "pct401kBefore";
    const pRoth = after ? "pctRothAfter" : "pctRothBefore";
    setS((p) => {
      const inc = p[incKey] || 0;
      if (p[modeKey] === "amount") {
        const div = inc > 0 ? inc : 1; // avoid divide-by-zero
        return { ...p, [modeKey]: "percent", [p401]: p[a401] / div, [pRoth]: p[aRoth] / div };
      }
      return { ...p, [modeKey]: "amount",
        [a401]: Math.round(p[p401] * inc), [aRoth]: Math.round(p[pRoth] * inc) };
    });
  };

  // What the right column shows: the whole household (combined) or just the
  // active tab's person (per person). Switching tabs re-points the per-person view.
  const multi = people.length > 1;
  const combined = !multi || viewMode === "combined";
  const viewSettings = combined ? people.map((p) => p.settings) : [people[activeIndex].settings];
  const refAge = viewSettings[0].currentAge; // x-axis anchored to the viewed person(s)
  const viewName = combined ? "Household" : people[activeIndex].name;
  const singleView = viewSettings.length === 1; // one person on the charts
  const refName = combined ? people[0].name : people[activeIndex].name; // whose age anchors the axis
  const scopeLabel = !multi ? "" : combined ? "Household " : viewName + " "; // footer prefix

  const { rows, avgCross, lowCross, annualSpendToday } = useMemo(() => {
    const T = Math.max(1, ...viewSettings.map((st) => st.horizonAge - st.currentAge));
    const per = viewSettings.map((st) => projectPerson(st, T));
    const rows = [];
    for (let t = 0; t <= T; t++) {
      let avg = 0, low = 0, target = 0;
      for (const pp of per) { avg += pp.avg[t]; low += pp.low[t]; target += pp.target[t]; }
      rows.push({ t, age: refAge + t, avg, low, target });
    }
    const cross = (key) => {
      const r = rows.find((row) => row[key] >= row.target);
      return r ? { age: r.age, t: r.t, value: r[key], target: r.target } : null;
    };
    return {
      rows,
      avgCross: cross("avg"),
      lowCross: cross("low"),
      annualSpendToday: viewSettings.reduce((sum, st) => sum + (st.monthlyNeed + st.monthlyExtra) * 12, 0),
    };
  }, [store, viewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const chartRows = rows.filter((r) => r.age <= 76);

  // Income plan for the current view: income, salary-to-cover-spending, saving.
  const grossCoastList = viewSettings.map((st) => solveGross((st.monthlyNeed + st.monthlyExtra) * 12, 0, 0));
  const grossCoastNow = grossCoastList.reduce((a, b) => a + b, 0);
  const incomeRows = chartRows.map((r) => {
    let income = 0, cover = 0, contrib = 0, working = false;
    viewSettings.forEach((st, idx) => {
      const age = st.currentAge + r.t;
      if (age < st.retireAge) {
        working = true;
        income += incomeAt(st, age);
        contrib += contributionFor(st, age);
        cover += grossCoastList[idx] * Math.pow(1 + st.inflation, r.t);
      }
    });
    return { age: r.age, income: working ? income : null, cover: working ? cover : null, contrib: working ? contrib : null };
  });

  // "Now" figures for the footer, summed over whatever's in view.
  const incomeNow = viewSettings.reduce((sum, st) => sum + st.income, 0);
  const savedNow = viewSettings.reduce((sum, st) => sum + savedTodayOf(st, "before"), 0);
  const targetToday = rows[0].target;
  const disposable = viewSettings.reduce(
    (sum, st) => sum + (netTakeHome(st.jobChange ? st.incomeAfter : st.income, 0, 0) - (st.monthlyNeed + st.monthlyExtra) * 12), 0);
  const effectiveContrib = viewSettings.reduce((sum, st) => sum + savedTodayOf(st, st.jobChange ? "after" : "before"), 0);
  const savingStatus =
    disposable >= effectiveContrib ? { text: "fully funded", color: C.avg }
    : disposable >= 0 ? { text: "saving is a stretch", color: C.brass }
    : { text: "income below spending", color: C.low };

  // Shared Recharts tooltip styling so it tracks the active theme.
  const tooltip = {
    contentStyle: { background: C.card, border: `1px solid ${C.hair}`, borderRadius: 8,
      fontFamily: mono, fontSize: 12, color: C.ink },
    labelStyle: { color: C.ink },
  };
  const card = { background: C.card, border: `1px solid ${C.hair}`, borderRadius: 12 };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden",
      background: C.page, color: C.ink, fontFamily: sans }}>
      <style>{`
        .rc-main{display:grid;grid-template-columns:340px 1fr;gap:24px;flex:1 1 auto;
          min-height:0;width:100%;max-width:1180px;margin:0 auto;padding:0 20px;}
        .rc-pane{display:flex;flex-direction:column;gap:16px;overflow-y:auto;min-height:0;height:100%;
          padding:22px 6px 26px 0;}
        .rc-col{display:flex;flex-direction:column;gap:16px;}
        .rc-tabs{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
        input[type=number]::-webkit-outer-spin-button,
        input[type=number]::-webkit-inner-spin-button{opacity:.4;}
        @media (max-width:860px){
          .rc-main{display:block;overflow-y:auto;padding:0 14px;}
          .rc-pane{overflow:visible;height:auto;padding:16px 0;}
        }
        @media (prefers-reduced-motion: reduce){*{transition:none!important;}}
      `}</style>

      {/* draggable title bar — sits in the same strip as the native window controls
          (the macOS traffic lights close / zoom-expand the window). */}
      <div data-tauri-drag-region style={{ flexShrink: 0, height: 44, display: "flex",
        alignItems: "center", justifyContent: "space-between", gap: 12,
        padding: "0 14px 0 84px", borderBottom: `1px solid ${C.hair}`, userSelect: "none" }}>
        <div data-tauri-drag-region style={{ fontSize: 11, letterSpacing: ".18em",
          textTransform: "uppercase", color: C.brass, fontWeight: 600 }}>
          Retirement projection
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontFamily: mono, fontSize: 11, color: C.avg,
            opacity: saveState === "saved" ? 1 : 0, transition: "opacity .3s" }}>
            ✓ saved
          </span>
          {multi && (
            <button onClick={() => setViewMode((m) => (m === "combined" ? "perPerson" : "combined"))}
              title="Combined household vs. per-person curves"
              style={{ fontFamily: sans, fontSize: 12, color: C.inkSoft, background: "transparent",
                border: `1px solid ${C.hair}`, borderRadius: 7, padding: "5px 11px", cursor: "pointer" }}>
              {viewMode === "combined" ? "Combined" : "Per person"}
            </button>
          )}
          <button onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title="Toggle light / dark"
            style={{ fontFamily: sans, fontSize: 12, color: C.inkSoft, background: "transparent",
              border: `1px solid ${C.hair}`, borderRadius: 7, padding: "5px 11px", cursor: "pointer" }}>
            {theme === "dark" ? "☀ Light" : "☾ Dark"}
          </button>
        </div>
      </div>

      {/* two-panel layout: controls left, charts right — each scrolls independently */}
      <div className="rc-main">
        {/* ---- left: controls ---- */}
        <div className="rc-pane" style={{ paddingTop: 0 }}>
          {/* person tabs — each tab is one person's inputs; charts combine them */}
          <div className="rc-tabs" style={{ position: "sticky", top: 0, zIndex: 5,
            background: C.page, padding: "8px 0", borderBottom: `1px solid ${C.hair}` }}>
            {people.map((p, i) => (
              i === activeIndex ? (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 2, height: 30,
                  border: `1px solid ${C.brass}`, borderRadius: 8, background: C.card, padding: "0 4px 0 8px" }}>
                  <input value={p.name} onChange={(e) => renamePerson(i, e.target.value)}
                    size={Math.max(4, p.name.length)} aria-label="Tab name"
                    style={{ border: "none", outline: "none", background: "transparent", color: C.ink,
                      fontFamily: sans, fontSize: 13, fontWeight: 600 }} />
                  {people.length > 1 && (
                    <button onClick={() => removePerson(i)} title="Remove person"
                      style={{ border: "none", background: "transparent", color: C.inkSoft,
                        cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 2px" }}>×</button>
                  )}
                </span>
              ) : (
                <button key={i} onClick={() => selectPerson(i)}
                  style={{ display: "inline-flex", alignItems: "center", height: 30, border: `1px solid ${C.hair}`,
                    borderRadius: 8, background: "transparent", color: C.inkSoft, fontFamily: sans,
                    fontSize: 13, padding: "0 10px", cursor: "pointer" }}>
                  {p.name || "Untitled"}
                </button>
              )
            ))}
            <button onClick={addPerson} title="Add person"
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", height: 30,
                border: `1px dashed ${C.hair}`, borderRadius: 8, background: "transparent",
                color: C.inkSoft, fontFamily: sans, fontSize: 15, lineHeight: 1, padding: "0 11px", cursor: "pointer" }}>+</button>
          </div>

          <div style={{ ...card, padding: 16 }}>
              <div className="rc-col">
                <div style={{ fontFamily: serif, fontSize: 18 }}>You today</div>
                <NumField c={C} label="Current age" value={s.currentAge} onChange={set("currentAge")} />
                <NumField c={C} label="Current balance" value={s.balance} onChange={set("balance")} step={1000} prefix="$" />
                <NumField c={C} label="Planned retirement age" value={s.retireAge} onChange={set("retireAge")} />
              </div>
            </div>

            <div style={{ ...card, padding: 16 }}>
              <div className="rc-col">
                <div style={{ fontFamily: serif, fontSize: 18 }}>Income & job change</div>
                <NumField c={C} label="Annual gross income" value={s.income} onChange={set("income")} step={1000} prefix="$" />
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.inkSoft }}>
                  <input type="checkbox" checked={s.jobChange}
                    onChange={(e) => set("jobChange")(e.target.checked)}
                    style={{ accentColor: C.avg }} />
                  Plan for a job change
                </label>
                {s.jobChange && (
                  <>
                    <NumField c={C} label="Income after change" value={s.incomeAfter} onChange={set("incomeAfter")} step={1000} prefix="$" />
                    <NumField c={C} label="Change happens at age" value={s.changeAge} onChange={set("changeAge")} />
                    <p style={{ fontSize: 12, color: C.inkSoft, lineHeight: 1.45, margin: 0 }}>
                      Model losing the high-paying job.
                    </p>
                  </>
                )}
                <div style={{ fontSize: 12, fontWeight: 600, color: C.inkSoft, marginTop: 2 }}>Current job</div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.inkSoft }}>
                  <input type="checkbox" checked={s.contribModeBefore === "percent"}
                    onChange={() => toggleContribMode("before")}
                    style={{ accentColor: C.avg }} />
                  Enter as % of income
                </label>
                {s.contribModeBefore === "percent" ? (
                  <>
                    <Slider c={C} label="401(k)" value={s.pct401kBefore} onChange={set("pct401kBefore")} min={0} max={0.6} step={0.01} />
                    <Slider c={C} label="Roth IRA" value={s.pctRothBefore} onChange={set("pctRothBefore")} min={0} max={0.6} step={0.01} />
                  </>
                ) : (
                  <>
                    <NumField c={C} label="401(k) — pre-tax" value={s.amt401kBefore} onChange={set("amt401kBefore")} step={500} prefix="$" />
                    <NumField c={C} label="Roth IRA — after-tax" value={s.amtRothBefore} onChange={set("amtRothBefore")} step={500} prefix="$" />
                  </>
                )}

                {s.jobChange && (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.inkSoft, marginTop: 2 }}>After job change</div>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.inkSoft }}>
                      <input type="checkbox" checked={s.contribModeAfter === "percent"}
                        onChange={() => toggleContribMode("after")}
                        style={{ accentColor: C.avg }} />
                      Enter as % of income
                    </label>
                    {s.contribModeAfter === "percent" ? (
                      <>
                        <Slider c={C} label="401(k)" value={s.pct401kAfter} onChange={set("pct401kAfter")} min={0} max={0.6} step={0.01} />
                        <Slider c={C} label="Roth IRA" value={s.pctRothAfter} onChange={set("pctRothAfter")} min={0} max={0.6} step={0.01} />
                      </>
                    ) : (
                      <>
                        <NumField c={C} label="401(k) — pre-tax" value={s.amt401kAfter} onChange={set("amt401kAfter")} step={500} prefix="$" />
                        <NumField c={C} label="Roth IRA — after-tax" value={s.amtRothAfter} onChange={set("amtRothAfter")} step={500} prefix="$" />
                      </>
                    )}
                  </>
                )}
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.inkSoft }}>
                  <input type="checkbox" checked={s.growIncome}
                    onChange={(e) => set("growIncome")(e.target.checked)}
                    style={{ accentColor: C.avg }} />
                  Grow income with inflation
                </label>
              </div>
            </div>

            <div style={{ ...card, padding: 16 }}>
              <div className="rc-col">
                <div style={{ fontFamily: serif, fontSize: 18 }}>Your spending</div>
                <NumField c={C} label="Monthly necessities" value={s.monthlyNeed} onChange={set("monthlyNeed")} step={100} prefix="$" />
                <NumField c={C} label="Monthly non-essential" value={s.monthlyExtra} onChange={set("monthlyExtra")} step={100} prefix="$" />
                <Slider c={C} label="Safe withdrawal rate" value={s.wr} onChange={set("wr")} min={0.025} max={0.06} step={0.0025} />
                <p style={{ fontSize: 12, color: C.inkSoft, lineHeight: 1.45, margin: 0 }}>
                  4% is the classic rule of thumb; lower is more conservative.
                </p>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.inkSoft }}>
                  <input type="checkbox" checked={s.includeSS}
                    onChange={(e) => set("includeSS")(e.target.checked)}
                    style={{ accentColor: C.avg }} />
                  Include Social Security
                </label>
                {s.includeSS && (
                  <>
                    <NumField c={C} label="Est. annual benefit (today’s $)" value={s.ssAnnual} onChange={set("ssAnnual")} step={1000} prefix="$" />
                    <p style={{ fontSize: 12, color: C.inkSoft, lineHeight: 1.45, margin: 0 }}>
                      Treated as a permanent income stream that lowers the savings target across the
                      whole projection.
                    </p>
                  </>
                )}
              </div>
            </div>

            <div style={{ ...card, padding: 16 }}>
              <div className="rc-col">
                <div style={{ fontFamily: serif, fontSize: 18 }}>Market & inflation</div>
                <Slider c={C} label="Average return (nominal)" value={s.avgRet} onChange={set("avgRet")} min={0.03} max={0.11} step={0.0025} />
                <Slider c={C} label="Below-average return" value={s.lowRet} onChange={set("lowRet")} min={0.02} max={0.09} step={0.0025} />
                <Slider c={C} label="Inflation" value={s.inflation} onChange={set("inflation")} min={0.01} max={0.05} step={0.0025} />
                <p style={{ fontSize: 12, color: C.inkSoft, lineHeight: 1.45, margin: 0 }}>
                  Returns are nominal (before inflation). A diversified stock-heavy
                  portfolio has historically averaged ~10% nominal; lower figures build in caution.
                </p>
              </div>
            </div>
          </div>

          {/* ---- right: title, charts + table ---- */}
          <div className="rc-pane">
            <h1 style={{ fontFamily: serif, fontWeight: 600, fontSize: 34, margin: 0,
              letterSpacing: "-.01em" }}>When the money outlasts the work</h1>
            <p style={{ color: C.inkSoft, margin: 0, lineHeight: 1.5 }}>
              The <b style={{ color: C.brass }}>crossover</b> is the first age your savings can fund your
              spending indefinitely. Until then you earn enough to keep contributing; after it you can
              downshift to a job that just covers spending and coast to retirement. The second chart shows
              the salary each phase needs. Inputs are saved automatically.
            </p>

            {multi && (
              <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 8,
                borderTop: `1px solid ${C.hair}`, paddingTop: 12 }}>
                <span style={{ fontFamily: serif, fontSize: 22, color: C.ink }}>{viewName}</span>
                <span style={{ fontFamily: sans, fontSize: 12, color: C.inkSoft }}>
                  {combined ? "combined household" : "individual plan — switch tabs to compare people"}
                </span>
              </div>
            )}

            {/* chart 1: the crossover */}
            <div style={{ ...card, padding: "18px 14px 8px" }}>
              <div style={{ fontFamily: serif, fontSize: 18, padding: "0 6px 6px" }}>The crossover</div>
              <div style={{ height: 360, width: "100%" }}>
                <ResponsiveContainer>
                  <LineChart data={chartRows} margin={{ top: 10, right: 18, bottom: 4, left: 6 }}>
                    <CartesianGrid stroke={C.hair} vertical={false} />
                    <XAxis dataKey="age" tick={{ fontSize: 12, fill: C.inkSoft, fontFamily: mono }}
                      tickLine={false} axisLine={{ stroke: C.hair }} interval={4} />
                    <YAxis tickFormatter={compact} width={56} domain={[0, "auto"]}
                      tick={{ fontSize: 12, fill: C.inkSoft, fontFamily: mono }}
                      tickLine={false} axisLine={false} />
                    <Tooltip {...tooltip} formatter={(v, n) => [usd(v), n]} labelFormatter={(a) => `Age ${a}`} />
                    <Legend wrapperStyle={{ fontFamily: sans, fontSize: 12, paddingTop: 6 }} />
                    <Line type="monotone" dataKey="target" name="Target needed" stroke={C.brass}
                      strokeWidth={2} strokeDasharray="5 4" dot={false} />
                    <Line type="monotone" dataKey="avg" name="Average market" stroke={C.avg}
                      strokeWidth={2.5} dot={false} />
                    <Line type="monotone" dataKey="low" name="Below-average" stroke={C.low}
                      strokeWidth={2.5} dot={false} />
                    {avgCross && avgCross.age <= 76 && (
                      <ReferenceDot x={avgCross.age} y={avgCross.value} r={6} fill={C.avg}
                        stroke={C.card} strokeWidth={2}
                        label={{ value: `age ${avgCross.age}`, position: "top", fill: C.avg, fontSize: 12, fontFamily: mono }} />
                    )}
                    {lowCross && lowCross.age <= 76 && (
                      <ReferenceDot x={lowCross.age} y={lowCross.value} r={6} fill={C.low}
                        stroke={C.card} strokeWidth={2}
                        label={{ value: `age ${lowCross.age}`, position: "bottom", fill: C.low, fontSize: 12, fontFamily: mono }} />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* chart 2: the income plan */}
            <div style={{ ...card, padding: "18px 14px 8px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
                flexWrap: "wrap", gap: 8, padding: "0 6px 2px" }}>
                <div style={{ fontFamily: serif, fontSize: 18 }}>The income plan</div>
                <div style={{ fontFamily: mono, fontSize: 12, color: C.inkSoft }}>
                  cover spending ≈ {usd(grossCoastNow)}/yr (today’s $)
                </div>
              </div>
              <div style={{ fontSize: 12, color: C.inkSoft, padding: "0 6px 8px", lineHeight: 1.45 }}>
                Your income (bold) versus the salary needed to cover spending (slate), with what you save
                each year (teal). When income drops at the job change, watch whether it stays above the
                cover-spending line and how much saving you can keep up. Vertical lines mark each crossover.
              </div>
              <div style={{ height: 300, width: "100%" }}>
                <ResponsiveContainer>
                  <LineChart data={incomeRows} margin={{ top: 10, right: 18, bottom: 4, left: 6 }}>
                    <CartesianGrid stroke={C.hair} vertical={false} />
                    <XAxis dataKey="age" type="number" domain={[refAge, 76]}
                      tick={{ fontSize: 12, fill: C.inkSoft, fontFamily: mono }}
                      tickLine={false} axisLine={{ stroke: C.hair }}
                      ticks={[40, 45, 50, 55, 60, 65, 70, 75].filter((t) => t >= refAge)} />
                    <YAxis tickFormatter={compact} width={56} domain={[0, "auto"]}
                      tick={{ fontSize: 12, fill: C.inkSoft, fontFamily: mono }}
                      tickLine={false} axisLine={false} />
                    <Tooltip {...tooltip} formatter={(v, n) => [usd(v), n]} labelFormatter={(a) => `Age ${a}`} />
                    <Legend wrapperStyle={{ fontFamily: sans, fontSize: 12, paddingTop: 6 }} />
                    {singleView && s.retireAge <= 76 && s.retireAge >= refAge && (
                      <ReferenceLine x={s.retireAge} stroke={C.brass} strokeDasharray="4 4"
                        label={{ value: `retire ${s.retireAge}`, position: "insideTopRight",
                          fill: C.brass, fontSize: 11, fontFamily: mono }} />
                    )}
                    {singleView && s.jobChange && s.changeAge <= 76 && s.changeAge >= refAge && (
                      <ReferenceLine x={s.changeAge} stroke={C.brass} strokeDasharray="4 4"
                        label={{ value: `job change ${s.changeAge}`, position: "insideTopLeft",
                          fill: C.brass, fontSize: 11, fontFamily: mono }} />
                    )}
                    {avgCross && avgCross.age <= 76 && (
                      <ReferenceLine x={avgCross.age} stroke={C.avg} strokeDasharray="3 3"
                        label={{ value: `crossover ${avgCross.age}`, position: "insideBottomRight",
                          fill: C.avg, fontSize: 11, fontFamily: mono }} />
                    )}
                    {lowCross && lowCross.age <= 76 && (
                      <ReferenceLine x={lowCross.age} stroke={C.low} strokeDasharray="3 3"
                        label={{ value: `crossover ${lowCross.age}`, position: "insideBottomLeft",
                          fill: C.low, fontSize: 11, fontFamily: mono }} />
                    )}
                    <Line type="monotone" dataKey="cover" name="Salary to cover spending"
                      stroke={C.coverLine} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} />
                    <Line type="monotone" dataKey="contrib" name="Saved per year"
                      stroke={C.saved} strokeWidth={2} dot={false} connectNulls={false} />
                    <Line type="monotone" dataKey="income" name={singleView ? "Income" : "Household income"}
                      stroke={C.ink} strokeWidth={2.75} dot={false} connectNulls={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* milestone table */}
            <div>
              <div style={{ fontFamily: serif, fontSize: 18, marginBottom: 10 }}>Milestones</div>
              <div style={{ overflowX: "auto", border: `1px solid ${C.hair}`, borderRadius: 10 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: mono, fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: C.page, textAlign: "right", color: C.inkSoft }}>
                      {["Age", "Average", "Below-avg", "Target needed"].map((h, i) => (
                        <th key={h} style={{ padding: "10px 16px", textAlign: i === 0 ? "left" : "right",
                          fontWeight: 600, borderBottom: `1px solid ${C.hair}`,
                          fontFamily: sans, fontSize: 11, letterSpacing: ".05em", textTransform: "uppercase" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.filter((r) => r.t % 3 === 0 && r.age <= 76).map((r) => {
                      const hit = (avgCross && r.age === avgCross.age) || (lowCross && r.age === lowCross.age);
                      return (
                        <tr key={r.age} style={{ background: hit ? C.highlight : "transparent" }}>
                          <td style={{ padding: "9px 16px", borderBottom: `1px solid ${C.hair}` }}>{r.age}</td>
                          <td style={{ padding: "9px 16px", textAlign: "right", color: C.avg, borderBottom: `1px solid ${C.hair}` }}>{usd(r.avg)}</td>
                          <td style={{ padding: "9px 16px", textAlign: "right", color: C.low, borderBottom: `1px solid ${C.hair}` }}>{usd(r.low)}</td>
                          <td style={{ padding: "9px 16px", textAlign: "right", color: C.brass, borderBottom: `1px solid ${C.hair}` }}>{usd(r.target)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <p style={{ fontSize: 11.5, color: C.inkSoft, lineHeight: 1.5, marginTop: 4 }}>
              Estimate only — not financial or tax advice. Salary figures assume a single filer, Oregon
              resident (no local income tax), 2026 federal + state brackets and standard deduction, and a
              W-2 job. Each working year you save take-home income minus spending, up to your 401(k)/Roth
              targets; if income falls short of spending the portfolio is drawn down to make up the gap.
              Portfolio figures assume steady annual returns (real markets are bumpy) and pre-tax balances.
              The crossover is where savings can fund your inflation-adjusted spending indefinitely.
            </p>
          </div>
        </div>

      {/* summary bar — always visible at the bottom while you adjust settings */}
      <div style={{ flexShrink: 0, background: C.card, borderTop: `1px solid ${C.hair}`,
        boxShadow: C.shadow }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", display: "flex", alignItems: "stretch",
          gap: 10, padding: "10px 12px" }}>
          <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", alignItems: "flex-start" }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: C.avg, margin: "5px 7px 0 0", flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, letterSpacing: ".05em", textTransform: "uppercase", color: C.inkSoft }}>Average market</div>
              {avgCross ? (
                <>
                  <div style={{ fontFamily: serif, fontSize: 17, color: C.ink, lineHeight: 1.15 }}>in {avgCross.t} yrs</div>
                  <div style={{ fontFamily: mono, fontSize: 11, color: C.inkSoft, lineHeight: 1.3 }}>~{compact(avgCross.value)} saved · {refName} age {avgCross.age}</div>
                  <div style={{ fontFamily: mono, fontSize: 11, color: C.inkSoft, lineHeight: 1.3 }}>funds {usd(annualSpendToday / 12)}/mo today</div>
                </>
              ) : (
                <div style={{ fontFamily: serif, fontSize: 15, color: C.ink }}>Not reached</div>
              )}
            </div>
          </div>
          <div style={{ width: 1, alignSelf: "stretch", background: C.hair, flexShrink: 0 }} />
          <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", alignItems: "flex-start" }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: C.low, margin: "5px 7px 0 0", flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, letterSpacing: ".05em", textTransform: "uppercase", color: C.inkSoft }}>Below-average</div>
              {lowCross ? (
                <>
                  <div style={{ fontFamily: serif, fontSize: 17, color: C.ink, lineHeight: 1.15 }}>in {lowCross.t} yrs</div>
                  <div style={{ fontFamily: mono, fontSize: 11, color: C.inkSoft, lineHeight: 1.3 }}>~{compact(lowCross.value)} saved · {refName} age {lowCross.age}</div>
                  <div style={{ fontFamily: mono, fontSize: 11, color: C.inkSoft, lineHeight: 1.3 }}>funds {usd(annualSpendToday / 12)}/mo today</div>
                </>
              ) : (
                <div style={{ fontFamily: serif, fontSize: 15, color: C.ink }}>Not reached</div>
              )}
            </div>
          </div>
          <div style={{ width: 1, alignSelf: "stretch", background: C.hair, flexShrink: 0 }} />
          <div style={{ flex: "1 1 0", minWidth: 0 }}>
            <div style={{ fontSize: 10, letterSpacing: ".05em", textTransform: "uppercase", color: C.inkSoft }}>Spending</div>
            <div style={{ fontFamily: serif, fontSize: 17, color: C.ink, lineHeight: 1.15 }}>{usd(annualSpendToday)}/yr</div>
            <div style={{ fontFamily: mono, fontSize: 11, color: C.inkSoft, lineHeight: 1.3 }}>target ≈ {compact(targetToday)} today</div>
          </div>
          <div style={{ width: 1, alignSelf: "stretch", background: C.hair, flexShrink: 0 }} />
          <div style={{ flex: "1 1 0", minWidth: 0 }}>
            <div style={{ fontSize: 10, letterSpacing: ".05em", textTransform: "uppercase", color: C.inkSoft }}>
              {scopeLabel}income & saving
            </div>
            <div style={{ fontFamily: serif, fontSize: 17, color: C.ink, lineHeight: 1.15 }}>{compact(incomeNow)}/yr</div>
            <div style={{ fontFamily: mono, fontSize: 11, color: C.inkSoft, lineHeight: 1.3 }}>save {compact(savedNow)}/yr now</div>
            <div style={{ fontFamily: mono, fontSize: 11, color: savingStatus.color, lineHeight: 1.3 }}>{savingStatus.text}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
