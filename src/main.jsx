import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { supabase } from "./lib/supabase";

// FreeMedTrain: all questions come from Supabase. No questions are embedded here.
// Student history, notes, and preferences are stored only in this browser.
const STORAGE_PREFIX = "freemedtrain:student:v1:";
const PAGE_SIZE = 200;
const MAX_LOADED_QUESTIONS = 1000; // Initial safety limit; add server-side pagination as the bank grows.
const EMPTY_STORE = { ownerId: null, displayName: "", records: {}, history: [], session: null };

function loadLocal(userId) {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_PREFIX + userId) || "{}");
    return {
      ownerId: userId,
      displayName: typeof data.displayName === "string" ? data.displayName.slice(0, 60) : "",
      records: data.records && typeof data.records === "object" && !Array.isArray(data.records) ? data.records : {},
      history: Array.isArray(data.history) ? data.history.slice(0, 50) : [],
      session: data.session && typeof data.session === "object" ? data.session : null
    };
  } catch {
    return { ...EMPTY_STORE, ownerId: userId };
  }
}
function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function percent(a, b) { return b ? Math.round((100 * a) / b) : 0; }
function dateLabel(time) { return new Date(time).toLocaleDateString(); }
function downloadJSON(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const CSS = `
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#18243a;background:#f4f6fa;font-synthesis:none}
*{box-sizing:border-box}body{margin:0}button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{opacity:.48;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #8faaff;outline-offset:2px}
.shell{max-width:1200px;margin:auto;padding:20px 22px 58px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px}.brand{display:flex;align-items:center;gap:10px;font-weight:850;font-size:19px;letter-spacing:-.03em;color:#172b64}.brandIcon{width:42px;height:42px;border-radius:13px;background:linear-gradient(135deg,#375bc6,#8c6ed0);display:grid;place-items:center;font-size:24px;color:white}.nav{display:flex;gap:5px;flex-wrap:wrap}.nav button{background:transparent;border:0;border-radius:10px;padding:10px 12px;font-size:13px;color:#5a6982;font-weight:700}.nav button.active,.nav button:hover{background:#e4eafb;color:#2548a5}.userChip{background:#e9edff;color:#28459b;border-radius:40px;padding:8px 12px;font-size:12px;font-weight:750;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.panel{background:#fff;border:1px solid #dfe6ef;box-shadow:0 8px 32px rgba(29,47,86,.055);border-radius:17px;padding:22px}.hero{background:linear-gradient(115deg,#172b64,#365ac7 70%,#6279d0);color:#fff;border:0;padding:30px 33px}.hero h1{font-size:clamp(28px,4vw,39px);letter-spacing:-.035em;line-height:1.12;margin:0 0 12px}.hero p{max-width:720px;color:#e0e7ff;margin:0;font-size:14px}.eyebrow{text-transform:uppercase;font-weight:850;letter-spacing:.12em;font-size:11px;color:#6c82b5;margin-bottom:10px}.hero .eyebrow{color:#d7e3ff}.sectionTitle{font-size:20px;margin:28px 0 14px;letter-spacing:-.02em}.muted{color:#67748a}.small{font-size:12px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px}.grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px}.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.stack{display:grid;gap:12px}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.spread{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}.btn{background:#335ccf;color:white;border:0;border-radius:10px;padding:11px 15px;font-weight:750;font-size:13px}.btn:hover:not(:disabled){background:#2647a6}.btn.alt{background:#eff2ff;color:#294ba7}.btn.alt:hover{background:#e2e8ff}.btn.danger{background:#fff0f0;color:#b53c48}.btn.sm{padding:7px 10px;font-size:12px}.btn.full{width:100%}.chip{display:inline-block;border-radius:7px;padding:4px 9px;background:#eef2ff;color:#28469b;font-size:11px;font-weight:800}.chip.green{background:#ddf4ea;color:#126044}.chip.grey{background:#edf0f5;color:#53647a}.stat{padding:17px}.stat .num{font-size:28px;font-weight:850;letter-spacing:-.04em}.stat .label{font-size:12px;color:#67748a}.cardTitle{font-size:18px;margin:0 0 7px}.cardText{color:#67748a;font-size:13px;margin:0;line-height:1.55}.field{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:750;color:#445372}.field input,.field select,.field textarea,.search{padding:11px 12px;color:#18243a;background:#fff;border:1px solid #cdd7e7;border-radius:9px;min-width:0;width:100%;font-size:14px}.field textarea{min-height:85px;resize:vertical}.notice{background:#f1f5ff;border-left:4px solid #5978d6;padding:12px 14px;border-radius:7px;font-size:13px;color:#344b82}.error{background:#fff0f0;border-left:4px solid #bf5d64;padding:12px 14px;border-radius:7px;font-size:13px;color:#8c2b38}.success{background:#e7f7ee;border-left:4px solid #329470;padding:12px 14px;border-radius:7px;font-size:13px;color:#126044}.footer{font-size:12px;color:#78869b;padding-top:30px}.progress{background:#e8edf5;height:9px;border-radius:40px;overflow:hidden}.progress span{display:block;background:#4268d0;height:100%;border-radius:40px}.examLayout{display:grid;grid-template-columns:minmax(0,1fr) 260px;align-items:start;gap:15px}.questionText{font-size:18px;font-weight:650;line-height:1.6;margin:16px 0 22px}.choices{display:grid;gap:9px}.choice{display:flex;gap:10px;align-items:flex-start;width:100%;background:#fff;border:1px solid #dce2ed;border-radius:11px;padding:13px;text-align:left;color:#1c2a40}.choice:hover:not(:disabled){border-color:#7594d9;background:#f8faff}.choice.selected{border:2px solid #4266d1;padding:12px;background:#f0f4ff}.choice.correct{background:#e6f7ee;border-color:#389d77}.choice.wrong{background:#fff0f0;border-color:#c36a74}.letter{background:#edf1f8;min-width:27px;height:27px;border-radius:7px;display:grid;place-items:center;font-size:12px;font-weight:900}.crossed{text-decoration:line-through;opacity:.48}.xbtn{margin-left:auto;border:1px solid #d9dfeb;background:#fff;border-radius:7px;color:#6e7d92;font-size:11px;padding:4px 7px}.questionNav{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px}.questionNav button{background:#fff;border:1px solid #dfe6ef;border-radius:7px;padding:8px 0;font-size:12px;font-weight:750}.questionNav button.active{background:#335ccf;color:#fff}.questionNav button.answered:not(.active){background:#e5f6ec;border-color:#a2d8b8}.questionNav button.flagged{box-shadow:inset 0 0 0 2px #d6ac44}.table{width:100%;border-collapse:collapse;font-size:13px}.table th,.table td{text-align:left;padding:10px;border-bottom:1px solid #e7ecf3}.table th{font-size:11px;color:#718097;text-transform:uppercase}.listItem{display:flex;justify-content:space-between;gap:15px;align-items:flex-start;padding:14px 0;border-bottom:1px solid #e7ecf3}.listItem:last-child{border:0}.listItem p{margin:5px 0;font-size:13px}.tagRow{display:flex;flex-wrap:wrap;gap:6px}.bigScore{font-size:62px;color:#2d9376;font-weight:900;letter-spacing:-.06em;line-height:1.15}.meterRow{display:grid;grid-template-columns:125px 1fr 55px;gap:12px;align-items:center;font-size:12px;margin:12px 0}.authCard{max-width:500px;margin:20px auto}.navBar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}.footNote{padding:9px 0;font-size:12px;color:#67748a}.divider{border:0;border-top:1px solid #e6eaf1;margin:18px 0}
@media(max-width:930px){.grid4{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:repeat(2,1fr)}.examLayout{grid-template-columns:1fr}}
@media(max-width:630px){.shell{padding:14px 12px 40px}.top{align-items:flex-start}.brand{font-size:17px}.nav{width:100%}.nav button{padding:8px}.hero{padding:23px}.panel{padding:17px}.grid,.grid2{grid-template-columns:1fr}.grid4{grid-template-columns:repeat(2,minmax(0,1fr))}.questionText{font-size:16px}.questionNav{grid-template-columns:repeat(8,minmax(0,1fr))}.meterRow{grid-template-columns:90px 1fr 42px}.bigScore{font-size:50px}}
`;

function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [authMode, setAuthMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [store, setStore] = useState(EMPTY_STORE);
  const [questions, setQuestions] = useState([]);
  const [loadingBank, setLoadingBank] = useState(false);
  const [bankError, setBankError] = useState("");
  const [limitReached, setLimitReached] = useState(false);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [page, setPage] = useState("dashboard");
  const [subject, setSubject] = useState("All subjects");
  const [questionCount, setQuestionCount] = useState("10");
  const [examMode, setExamMode] = useState("tutor");
  const [librarySearch, setLibrarySearch] = useState("");
  const [librarySubject, setLibrarySubject] = useState("All subjects");
  const [libraryLimit, setLibraryLimit] = useState(30);
  const [clock, setClock] = useState(Date.now());
  const [importMessage, setImportMessage] = useState("");

  const userId = user?.id || null;
  const localReady = Boolean(userId && store.ownerId === userId);
  const session = localReady ? store.session : null;
  const records = localReady ? store.records : {};
  const history = localReady ? store.history : [];

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setAuthError(error.message);
      setUser(data.session?.user || null);
      setChecking(false);
    }).catch((error) => {
      if (active) { setAuthError(error.message); setChecking(false); }
    });
