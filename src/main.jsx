import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { supabase } from "./lib/supabase";

// FreeMedTrain: all questions come from Supabase. No questions are embedded here.
// Student history, notes, and preferences are stored only in this browser.
const STORAGE_PREFIX = "freemedtrain:student:v1:";
const PAGE_SIZE = 200;
const MAX_LOADED_QUESTIONS = 1000; // Initial safety limit; add server-side pagination as the bank grows.
const EMPTY_STORE = { ownerId: null, displayName: "", records: {}, history: [], session: null };

// Student-generated batches are stored as compact JSON files in Supabase Storage.
// The database stores only one lightweight metadata row per batch.
const BATCH_BUCKET = "question-batches";
const MAX_BATCH_QUESTIONS = 50;
const MAX_BATCH_BYTES = 512 * 1024;
const MAX_APPROVED_BATCHES = 30;
const CHATGPT_BATCH_PROMPT = "You are helping me contribute original, high-quality medical education questions to FreeMedTrain, a free community study platform.\n\nSOURCE RULES\n- Use only materials I have uploaded to this ChatGPT Project and specifically authorized for this purpose. If a fact is not supported by the material, do not invent it. You may indicate a limitation rather than guessing.\n- Do not reproduce copyrighted textbook passages, commercial question-bank questions, instructor exam questions, recalled USMLE/COMLEX questions, or illustrations. Create original questions in your own wording.\n- Do not include any patient-identifying information. Never use confidential exam content.\n- Use the lecture or document names as source_reference, but do not invent page numbers, citations, or other sources.\n- Prefer clinically meaningful vignettes and explanations. Use accurate and plausible distractors. One unambiguously correct answer per question.\n- Avoid duplicates, ambiguous wording, trick questions, and unsupported clinical claims.\n\nTASK\nPrepare 25 original, single-best-answer multiple-choice questions based on the materials in this Project (or a smaller number if coverage is insufficient). Aim for 4 or 5 answer choices per question and vary the position of the correct answer. The medical material must be checked for accuracy; if you are unsure, omit that concept. Organize questions by their actual subjects and topics.\n\nOUTPUT FORMAT (STRICT)\nCreate a downloadable UTF-8 JSON file named FreeMedTrain_questions.json. Do not use Markdown code fences or add explanation outside the file. The JSON must be one object with these keys:\n\nschema_version: the number 1\ntitle: short title of the contribution, maximum 120 characters\nsource_notes: short summary of allowed source documents, maximum 500 characters\nquestions: an array of up to 50 question objects\n\nEach question object must contain exactly these keys:\nsubject: discipline such as Anatomy, Physiology, Pathology, Pharmacology\ntopic: narrow topic name\nquestion_type: \"multiple_choice\"\nquestion_text: original question stem or clinical vignette\nanswer_choices: array of 4 or 5 distinct answer strings, no A/B/C/D letters\ncorrect_choice_index: zero-based integer index of the correct answer (0 means first choice)\nexplanation: clear clinical/biological rationale and why key distractors are wrong\nsource_reference: specific uploaded lecture/file name(s) actually used\n\nUse standard JSON string syntax with double quotes. Never put the correct answer or answer index inside question_text. Every question must be independently answerable. Verify the answer index points to the intended choice. Ensure the finished JSON parses successfully. If you cannot create a downloadable file, output the raw JSON alone so I can save it with a .json extension. Do not copy any lectures into the JSON file.";

function validateQuestionBatch(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schema_version !== 1) {
    throw new Error("Invalid FreeMedTrain JSON file: schema_version must be the number 1.");
  }
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const sourceNotes = typeof raw.source_notes === "string" ? raw.source_notes.trim() : "";
  if (title.length < 3 || title.length > 120) throw new Error("Batch title must be 3 to 120 characters.");
  if (sourceNotes.length > 500) throw new Error("Source notes are too long (maximum 500 characters).");
  if (!Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > MAX_BATCH_QUESTIONS) {
    throw new Error(`Please provide 1 to ${MAX_BATCH_QUESTIONS} questions per file.`);
  }
  const questions = raw.questions.map((item, i) => {
    const which = `Question ${i + 1}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${which} is not a JSON object.`);
    }
    function field(name, min, max) {
      const value = typeof item[name] === "string" ? item[name].trim() : "";
      if (value.length < min || value.length > max) {
        throw new Error(`${which}: ${name} must be ${min}–${max} characters.`);
      }
      return value;
    }
    if (item.question_type !== "multiple_choice") {
      throw new Error(`${which}: only multiple_choice is supported for this batch format.`);
    }
    const subject = field("subject", 2, 80);
    const topic = field("topic", 2, 120);
    const questionText = field("question_text", 20, 2000);
    const explanation = field("explanation", 20, 3000);
    const sourceReference = field("source_reference", 1, 350);
    if (!Array.isArray(item.answer_choices) || item.answer_choices.length < 2 || item.answer_choices.length > 8 ||
        item.answer_choices.some((c) => typeof c !== "string" || !c.trim() || c.length > 500)) {
      throw new Error(`${which}: answer_choices must contain 2–8 nonempty strings.`);
    }
    const answerChoices = item.answer_choices.map((c) => c.trim());
    if (new Set(answerChoices.map((c) => c.toLowerCase())).size !== answerChoices.length) {
      throw new Error(`${which}: duplicate answer choices are not allowed.`);
    }
    const answer = item.correct_choice_index;
    if (!Number.isInteger(answer) || answer < 0 || answer >= answerChoices.length) {
      throw new Error(`${which}: correct_choice_index must be a valid zero-based answer index.`);
    }
    return {
      subject, topic, question_type: "multiple_choice", question_text: questionText,
      answer_choices: answerChoices, correct_choice_index: answer,
      explanation, source_reference: sourceReference
    };
  });
  const document = { schema_version: 1, title, source_notes: sourceNotes, questions };
  const compactJSON = JSON.stringify(document);
  const sizeBytes = new Blob([compactJSON], { type: "application/json" }).size;
  if (sizeBytes > MAX_BATCH_BYTES) {
    throw new Error("Question batch is too large; split it into smaller files (maximum 512 KB).");
  }
  const counts = {};
  questions.forEach((q) => { counts[q.subject] = (counts[q.subject] || 0) + 1; });
  return { document, compactJSON, sizeBytes, counts };
}


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
  const [fileBatch, setFileBatch] = useState(null);
  const [batchRights, setBatchRights] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState("");
  const [batchNotice, setBatchNotice] = useState("");
  const [myBatches, setMyBatches] = useState([]);
  const [batchListError, setBatchListError] = useState("");
  const [batchRefresh, setBatchRefresh] = useState(0);
  const [batchLoadWarning, setBatchLoadWarning] = useState("");
  const [retryBatch, setRetryBatch] = useState(null);

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
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (active) setUser(newSession?.user || null);
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    setStore(userId ? loadLocal(userId) : EMPTY_STORE);
    setPage("dashboard");
    setSubject("All subjects");
    setLibrarySubject("All subjects");
    setFileBatch(null);
    setBatchRights(false);
    setBatchError("");
    setBatchNotice("");
    setMyBatches([]);
    setRetryBatch(null);
  }, [userId]);

  useEffect(() => {
    if (!localReady) return;
    try {
      localStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify({
        displayName: store.displayName,
        records: store.records,
        history: store.history,
        session: store.session
      }));
    } catch (error) {
      console.warn("FreeMedTrain local progress could not be saved:", error);
    }
  }, [store, userId, localReady]);

  useEffect(() => {
    if (!userId) { setQuestions([]); setLoadingBank(false); setBankError(""); setBatchLoadWarning(""); return; }
    let cancelled = false;
    async function fetchApprovedQuestions() {
      setLoadingBank(true);
      setBankError("");
      setLimitReached(false);
      const collected = [];
      try {
        // Read only approved multiple-choice items; Supabase RLS requires a signed-in user.
        for (let start = 0; start < MAX_LOADED_QUESTIONS; start += PAGE_SIZE) {
          const { data, error } = await supabase
            .from("questions")
            .select("id, subject, topic, question_text, answer_choices, correct_choice_index, explanation, source_reference, created_at")
            .eq("review_status", "approved")
            .eq("question_type", "multiple_choice")
            .order("created_at", { ascending: false })
            .range(start, start + PAGE_SIZE - 1);
          if (error) throw error;
          if (cancelled) return;
          const valid = (data || []).filter((q) =>
            Array.isArray(q.answer_choices) && q.answer_choices.length >= 2 &&
            Number.isInteger(q.correct_choice_index) &&
            q.correct_choice_index >= 0 && q.correct_choice_index < q.answer_choices.length
          );
          collected.push(...valid);
          if (!data || data.length < PAGE_SIZE) break;
          if (start + PAGE_SIZE >= MAX_LOADED_QUESTIONS) setLimitReached(true);
        }
        // Also load reviewed question files. These are kept as immutable objects in
        // the private question-batches Storage bucket, not as one database row per question.
        let skippedBatchFiles = 0;
        try {
          const { data: batches, error: metaError } = await supabase
            .from("question_batches")
            .select("id, storage_path, submitted_at")
            .eq("status", "approved")
            .order("approved_at", { ascending: false })
            .limit(MAX_APPROVED_BATCHES);
          if (metaError) throw metaError;
          for (let index = 0; index < (batches || []).length && collected.length < MAX_LOADED_QUESTIONS; index += 4) {
            const group = batches.slice(index, index + 4);
            const loaded = await Promise.all(group.map(async (batch) => {
              try {
                const { data: file, error: storageError } = await supabase.storage
                  .from(BATCH_BUCKET).download(batch.storage_path);
                if (storageError) throw storageError;
                const parsed = JSON.parse(await file.text());
                const valid = validateQuestionBatch(parsed);
                return valid.document.questions.map((q, position) => ({
                  ...q,
                  id: `${batch.id}:${position}`,
                  created_at: batch.submitted_at
                }));
              } catch (err) {
                console.warn("FreeMedTrain: skipped invalid or unavailable approved batch", batch.id, err);
                return null;
              }
            }));
            if (cancelled) return;
            for (const batchQuestions of loaded) {
              if (!batchQuestions) { skippedBatchFiles += 1; continue; }
              collected.push(...batchQuestions.slice(0, MAX_LOADED_QUESTIONS - collected.length));
              if (collected.length >= MAX_LOADED_QUESTIONS) break;
            }
          }
          if (!cancelled) setBatchLoadWarning(skippedBatchFiles
            ? `${skippedBatchFiles} approved question file(s) could not be loaded. Please notify a moderator.`
            : "");
        } catch (err) {
          if (!cancelled) setBatchLoadWarning("Batch question library is not configured or could not be reached. Existing questions remain available.");
          console.warn("FreeMedTrain: batch library unavailable", err);
        }
        if (!cancelled) {
          setLimitReached(collected.length >= MAX_LOADED_QUESTIONS);
          setQuestions(collected);
        }
      } catch (error) {
        if (!cancelled) { setBankError(error.message || "Could not load questions."); setQuestions([]); }
      } finally {
        if (!cancelled) setLoadingBank(false);
      }
    }
    fetchApprovedQuestions();
    return () => { cancelled = true; };
  }, [userId, refreshIndex]);

  useEffect(() => {
    if (page !== "contribute" || !userId) return;
    let active = true;
    async function loadMyBatches() {
      setBatchListError("");
      const { data, error } = await supabase
        .from("question_batches")
        .select("id, title, question_count, status, submitted_at, storage_path")
        .eq("submitted_by", userId)
        .order("submitted_at", { ascending: false })
        .limit(20);
      if (!active) return;
      if (error) setBatchListError(error.message);
      else setMyBatches(data || []);
    }
    loadMyBatches();
    return () => { active = false; };
  }, [userId, page, batchRefresh]);

  useEffect(() => {
    if (page !== "exam" || session?.mode !== "timed") return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [page, session?.startedAt, session?.mode]);

  const byId = useMemo(() => new Map(questions.map((q) => [q.id, q])), [questions]);
  const subjects = useMemo(() => [...new Set(questions.map((q) => q.subject))].sort(), [questions]);
  const displayName = (localReady && store.displayName.trim()) ||
    user?.user_metadata?.full_name || user?.email?.split("@")[0] || "Student";
  const attempted = Object.values(records).reduce((n, r) => n + (Number(r.attempts) || 0), 0);
  const correctTotal = Object.values(records).reduce((n, r) => n + (Number(r.right) || 0), 0);
  const dueCount = Object.values(records).filter((r) => r.dueAt && r.dueAt <= Date.now()).length;
  const studyCount = Object.values(records).filter((r) => r.attempts > 0).length;
  const available = subject === "All subjects" ? questions : questions.filter((q) => q.subject === subject);
  const filteredLibrary = questions.filter((q) => {
    const matchesSubject = librarySubject === "All subjects" || q.subject === librarySubject;
    const term = librarySearch.trim().toLowerCase();
    return matchesSubject && (!term || `${q.question_text} ${q.subject} ${q.topic}`.toLowerCase().includes(term));
  });

  async function submitAuth(event) {
    event.preventDefault();
    setAuthError(""); setAuthNotice(""); setAuthBusy(true);
    try {
      if (authMode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email, password,
          options: { emailRedirectTo: window.location.origin + import.meta.env.BASE_URL }
        });
        if (error) throw error;
        if (data.session) setUser(data.session.user);
        else setAuthNotice("If registration is accepted, check your email for a confirmation link.");
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setUser(data.user);
      }
      setPassword("");
    } catch (error) { setAuthError(error.message || "Authentication failed."); }
    finally { setAuthBusy(false); }
  }
  async function signOut() {
    setAuthError("");
    const { error } = await supabase.auth.signOut();
    if (error) setAuthError(error.message);
    else { setUser(null); setPage("dashboard"); }
  }
  function navigate(next) { setPage(next); setLibraryLimit(30); setImportMessage(""); }

  async function selectQuestionFile(event) {
    const file = event.target.files?.[0];
    setBatchError(""); setBatchNotice(""); setBatchRights(false); setRetryBatch(null); setFileBatch(null);
    if (!file) return;
    if (file.size > MAX_BATCH_BYTES) {
      setBatchError("File is too large; FreeMedTrain accepts a maximum of 512 KB per JSON file.");
      return;
    }
    try {
      const parsed = JSON.parse(await file.text());
      setFileBatch(validateQuestionBatch(parsed));
    } catch (error) {
      setBatchError(error.message || "Could not read your JSON file.");
    }
  }

  async function submitQuestionBatch() {
    if (!user || !fileBatch || !batchRights || batchBusy) return;
    setBatchBusy(true);
    setBatchError("");
    setBatchNotice("");
    try {
      const id = retryBatch?.id || crypto.randomUUID();
      const storagePath = retryBatch?.storagePath || `${user.id}/${id}.json`;
      if (!retryBatch) {
        // Metadata is created first. Storage upload requires matching pending metadata;
        // this prevents users from filling the bucket with arbitrary files.
        const { error: metadataError } = await supabase.from("question_batches").insert({
          id, submitted_by: user.id, storage_path: storagePath,
          title: fileBatch.document.title,
          source_notes: fileBatch.document.source_notes,
          question_count: fileBatch.document.questions.length,
          rights_confirmed: true
        });
        if (metadataError) throw metadataError;
        setRetryBatch({ id, storagePath });
      }
      const data = new Blob([fileBatch.compactJSON], { type: "application/json" });
      const { error: storageError } = await supabase.storage.from(BATCH_BUCKET)
        .upload(storagePath, data, { contentType: "application/json", upsert: false });
      if (storageError) throw new Error(`File upload failed: ${storageError.message}. Click Retry upload to try again.`);
      setBatchNotice(`Submitted ${fileBatch.document.questions.length} questions for moderator review (batch ${id}).`);
      setFileBatch(null);
      setBatchRights(false);
      setRetryBatch(null);
      setBatchRefresh((n) => n + 1);
    } catch (error) {
      setBatchError(error.message || "Upload failed.");
    } finally {
      setBatchBusy(false);
    }
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(CHATGPT_BATCH_PROMPT);
      setBatchNotice("Prompt copied! Paste it into your ChatGPT Project conversation.");
      setBatchError("");
    } catch {
      setBatchError("Your browser blocked copying. Download the prompt from FreeMedTrain instructions or select the text manually.");
    }
  }

  function editRecord(id, changes) {
    setStore((prev) => ({ ...prev, records: {
      ...prev.records, [id]: { ...(prev.records[id] || {}), ...changes }
    } }));
  }
  function startSession(presetIds = null, overrideMode = null) {
    const pool = presetIds ? presetIds.map((id) => byId.get(id)).filter(Boolean) : available;
    if (!pool.length) return;
    const ids = presetIds ? pool.map((q) => q.id) : shuffle(pool).slice(0, Number(questionCount)).map((q) => q.id);
    const mode = overrideMode || examMode;
    setStore((prev) => ({ ...prev, session: {
      ids, cursor: 0, answers: {}, checked: {}, eliminated: {}, flags: {},
      mode, subject: presetIds ? "Selected questions" : subject,
      startedAt: Date.now(), durationSeconds: Math.max(90, ids.length * 90)
    } }));
    setClock(Date.now());
    setPage("exam");
  }
  function changeSession(update) {
    setStore((prev) => prev.session ? ({ ...prev, session: { ...prev.session, ...update(prev.session) } }) : prev);
  }
  function finishSession() {
    if (!session) return;
    const ids = session.ids.filter((id) => byId.has(id));
    const graded = ids.filter((id) => Number.isInteger(session.answers[id]));
    const right = graded.filter((id) => session.answers[id] === byId.get(id).correct_choice_index).length;
    const now = Date.now();
    const result = {
      id: String(now), date: now,
      label: `${session.subject} · ${session.mode === "tutor" ? "Tutor" : "Timed"}`,
      mode: session.mode, count: ids.length, answered: graded.length, correct: right,
      durationMinutes: Math.max(1, Math.ceil((now - session.startedAt) / 60000)),
      details: ids.map((id) => ({ id, selected: Number.isInteger(session.answers[id]) ? session.answers[id] : null }))
    };
    setStore((prev) => {
      const nextRecords = { ...prev.records };
      graded.forEach((id) => {
        const q = byId.get(id);
        const wasCorrect = session.answers[id] === q.correct_choice_index;
        const old = nextRecords[id] || {};
        const streak = wasCorrect ? (old.streak || 0) + 1 : 0;
        const days = wasCorrect ? Math.min(30, Math.pow(2, streak)) : 1;
        nextRecords[id] = {
          ...old, subject: q.subject, topic: q.topic,
          attempts: (old.attempts || 0) + 1,
          right: (old.right || 0) + (wasCorrect ? 1 : 0),
          lastCorrect: wasCorrect, lastAnswered: now, streak,
          dueAt: now + days * 86400000
        };
      });
      return { ...prev, records: nextRecords, history: [result, ...prev.history].slice(0, 50), session: null };
    });
    setPage("results");
  }
  const remainingMs = session?.mode === "timed"
    ? Math.max(0, session.durationSeconds * 1000 - (clock - session.startedAt)) : null;
  useEffect(() => {
    if (page === "exam" && session?.mode === "timed" && remainingMs === 0 && questions.length) {
      finishSession();
    }
    // finishSession uses the current session; the clock drives automatic submission.
  }, [clock, page, remainingMs]);

  async function importBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) { setImportMessage("Backup is too large (maximum 1 MB)."); return; }
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== "FreeMedTrain" || data.version !== 1 ||
          !Array.isArray(data.history) || !data.records || typeof data.records !== "object" || Array.isArray(data.records)) {
        throw new Error("This isn't a FreeMedTrain v1 progress backup.");
      }
      if (!window.confirm("Replace progress saved in this browser with the imported backup?")) return;
      setStore((prev) => ({ ...prev, displayName: typeof data.displayName === "string" ? data.displayName.slice(0, 60) : "",
        records: data.records, history: data.history.slice(0, 50), session: null }));
      setImportMessage("Progress imported into this browser.");
    } catch (error) { setImportMessage(error.message || "Import failed."); }
    finally { event.target.value = ""; }
  }
  function exportBackup() {
    downloadJSON(`FreeMedTrain_Progress_${new Date().toISOString().slice(0, 10)}.json`, {
      app: "FreeMedTrain", version: 1, exportedAt: new Date().toISOString(),
      displayName: store.displayName, records, history, session
    });
  }

  function StatCard({ label, value }) {
    return <div className="panel stat"><div className="label">{label}</div><div className="num">{value}</div></div>;
  }
  function Dashboard() {
    const subjectCounts = subjects.map((name) => ({ name, count: questions.filter((q) => q.subject === name).length }));
    return <>
      <section className="panel hero">
        <div className="eyebrow">YOUR STUDY WORKSPACE</div>
        <h1>Welcome back, {displayName}.</h1>
        <p>Practice clinically relevant questions, review weak areas, and track your preparation—all for free.</p>
        <div className="row" style={{ marginTop: 22 }}>
          <button className="btn" onClick={() => navigate("practice")}>Create a practice exam</button>
          <button className="btn alt" onClick={() => navigate("library")}>Explore question bank</button>
          <button className="btn alt" onClick={() => navigate("contribute")}>Contribute a question file</button>
        </div>
      </section>
      <h2 className="sectionTitle">Your study snapshot</h2>
      <div className="grid4">
        <StatCard label="Approved questions loaded" value={questions.length} />
        <StatCard label="Answers submitted" value={attempted} />
        <StatCard label="Lifetime accuracy" value={`${percent(correctTotal, attempted)}%`} />
        <StatCard label="Completed exams" value={history.length} />
      </div>
      {session && <div className="notice" style={{ marginTop: 16 }}>
        You have an unfinished {session.mode} session ({session.ids.length} questions).{" "}
        <button className="btn sm" onClick={() => navigate("exam")}>Resume session</button>
      </div>}
      {bankError && <div className="error" style={{ marginTop: 16 }}>{bankError}</div>}
      {batchLoadWarning && <div className="notice" style={{ marginTop: 16 }}>{batchLoadWarning}</div>}
      {loadingBank && <p className="muted small">Loading approved questions from Supabase...</p>}
      <h2 className="sectionTitle">Study by subject</h2>
      <div className="grid">
        {subjectCounts.length ? subjectCounts.map((item) => (
          <div className="panel stack" key={item.name}>
            <span className="chip" style={{ justifySelf: "start" }}>{item.count} questions</span>
            <h3 className="cardTitle">{item.name}</h3>
            <p className="cardText">Practice approved questions in {item.name.toLowerCase()}.</p>
            <button className="btn alt" onClick={() => { setSubject(item.name); navigate("practice"); }}>Practice subject</button>
          </div>
        )) : <div className="panel"><p className="muted">No approved multiple-choice questions are available yet.</p></div>}
      </div>
      <div className="notice" style={{ marginTop: 18 }}>
        Approved questions come from the Supabase database and reviewed batch files. Scores, flags, notes, and study history are stored only in this browser.
      </div>
    </>;
  }
  function PracticeSetup() {
    return <>
      <div className="spread"><div><h1>Build a practice exam</h1><p className="muted">Configure a session from approved Supabase questions.</p></div><span className="chip green">Signed-in access</span></div>
      <div className="grid2">
        <section className="panel stack">
          <label className="field">Subject
            <select value={subject} onChange={(e) => setSubject(e.target.value)}>
              <option>All subjects</option>{subjects.map((name) => <option key={name}>{name}</option>)}
            </select>
          </label>
          <label className="field">Question count
            <select value={questionCount} onChange={(e) => setQuestionCount(e.target.value)}>
              {[5, 10, 20, 40].map((n) => <option key={n} value={n}>{n} questions</option>)}
            </select>
          </label>
          <label className="field">Mode
            <select value={examMode} onChange={(e) => setExamMode(e.target.value)}>
              <option value="tutor">Tutor — explanations after checking answers</option>
              <option value="timed">Timed — explanations at the end</option>
            </select>
          </label>
          <p className="muted small">{available.length} approved question{available.length === 1 ? "" : "s"} available for this selection. If fewer questions are available than requested, your session will use the available questions.</p>
          <button className="btn full" disabled={!available.length || loadingBank} onClick={() => startSession()}>Start exam</button>
        </section>
        <section className="panel stack">
          <h2 className="cardTitle">How practice works</h2>
          <p className="cardText"><b>Tutor mode:</b> Get explanations after checking each answer. Flag questions and add notes.</p>
          <p className="cardText"><b>Timed mode:</b> Answer without feedback until the exam ends. The timer uses 90 seconds per question.</p>
          <p className="cardText"><b>Progress:</b> Completed results are saved locally on this device.</p>
          <div className="notice">{dueCount} question{dueCount === 1 ? " is" : "s are"} due for review, based on your prior answers.</div>
          {session && <button className="btn alt" onClick={() => navigate("exam")}>Resume unfinished session</button>}
        </section>
      </div>
    </>;
  }
  function Exam() {
    if (!session) return <div className="panel"><p>No active session.</p><button className="btn" onClick={() => navigate("practice")}>Create exam</button></div>;
    const q = byId.get(session.ids[session.cursor]);
    if (!q) return <div className="panel">One of your saved questions is no longer available. <button className="btn" onClick={() => { setStore((prev) => ({ ...prev, session: null })); navigate("practice"); }}>Start a new session</button></div>;
    const answer = session.answers[q.id];
    const checked = !!session.checked[q.id];
    const reveal = session.mode === "tutor" && checked;
    const crossed = session.eliminated[q.id] || [];
    const answered = session.ids.filter((id) => Number.isInteger(session.answers[id])).length;
    const minutes = remainingMs === null ? null : Math.floor(remainingMs / 60000);
    const seconds = remainingMs === null ? null : Math.floor((remainingMs % 60000) / 1000);
    return <>
      <div className="spread" style={{ marginBottom: 14 }}>
        <div><h1 style={{ marginBottom: 4 }}>{session.mode === "tutor" ? "Tutor practice" : "Timed exam"}</h1><span className="muted small">{session.subject} · Question {session.cursor + 1} of {session.ids.length}</span></div>
        <div className="row"><button className="btn alt sm" onClick={() => navigate("dashboard")}>Save & exit</button><button className="btn sm" onClick={finishSession}>Finish exam</button></div>
      </div>
      <div className="examLayout">
        <section className="panel">
          <div className="spread"><span className="chip">{q.subject} · {q.topic}</span><button className="btn alt sm" onClick={() => editRecord(q.id, { flagged: !records[q.id]?.flagged })}>{records[q.id]?.flagged ? "★ Flagged" : "☆ Flag"}</button></div>
          <h2 className="questionText">{q.question_text}</h2>
          <div className="choices">
            {q.answer_choices.map((choice, index) => {
              const selected = answer === index;
              const correct = reveal && index === q.correct_choice_index;
              const wrong = reveal && selected && !correct;
              return <div key={index} className={`choice ${selected ? "selected" : ""} ${correct ? "correct" : ""} ${wrong ? "wrong" : ""}`}>
                <button type="button" disabled={reveal || crossed.includes(index)} style={{ flex: 1, display: "flex", gap: 10, alignItems: "start", border: 0, background: "transparent", textAlign: "left", color: "inherit", padding: 0, cursor: "inherit" }} onClick={() => changeSession((s) => ({ answers: { ...s.answers, [q.id]: index } }))}>
                  <span className="letter">{String.fromCharCode(65 + index)}</span><span className={crossed.includes(index) ? "crossed" : ""}>{choice}</span>
                </button>
                {!reveal && <button type="button" className="xbtn" title="Cross out answer" onClick={() => changeSession((s) => {
                  const old = s.eliminated[q.id] || [];
                  const next = old.includes(index) ? old.filter((x) => x !== index) : [...old, index];
                  const answers = { ...s.answers };
                  if (next.includes(answers[q.id])) delete answers[q.id];
                  return { eliminated: { ...s.eliminated, [q.id]: next }, answers };
                })}>×</button>}
              </div>;
            })}
          </div>
          {reveal && <div className={answer === q.correct_choice_index ? "success" : "error"} style={{ marginTop: 16 }}>
            <b>{answer === q.correct_choice_index ? "Correct!" : `Correct answer: ${String.fromCharCode(65 + q.correct_choice_index)}`}</b>
            <p>{q.explanation}</p>{q.source_reference && <p className="small">Reference: {q.source_reference}</p>}
          </div>}
          <div className="row" style={{ marginTop: 18 }}>
            <button className="btn alt" disabled={session.cursor === 0} onClick={() => changeSession(() => ({ cursor: Math.max(0, session.cursor - 1) }))}>Previous</button>
            {session.mode === "tutor" && !checked && <button className="btn" disabled={!Number.isInteger(answer)} onClick={() => changeSession((s) => ({ checked: { ...s.checked, [q.id]: true } }))}>Check answer</button>}
            <button className="btn alt" disabled={session.cursor === session.ids.length - 1} onClick={() => changeSession(() => ({ cursor: Math.min(session.ids.length - 1, session.cursor + 1) }))}>Next</button>
          </div>
          <hr className="divider" />
          <label className="field">My notes (saved on this device)
            <textarea value={records[q.id]?.note || ""} maxLength={2000} placeholder="Add a reminder or study note..." onChange={(e) => editRecord(q.id, { note: e.target.value })} />
          </label>
        </section>
        <aside className="panel stack">
          <h3 className="cardTitle">Exam navigator</h3>
          {remainingMs !== null && <span className="chip">⏱ {minutes}:{String(seconds).padStart(2, "0")} remaining</span>}
          <div className="questionNav">{session.ids.map((id, i) => <button key={id} title={`Question ${i + 1}`} className={`${i === session.cursor ? "active" : ""} ${Number.isInteger(session.answers[id]) ? "answered" : ""} ${records[id]?.flagged ? "flagged" : ""}`} onClick={() => changeSession(() => ({ cursor: i }))}>{i + 1}</button>)}</div>
          <div className="spread small"><span>Answered</span><b>{answered}/{session.ids.length}</b></div>
          <div className="spread small"><span>Flagged</span><b>{session.ids.filter((id) => records[id]?.flagged).length}</b></div>
          <button className="btn full" onClick={finishSession}>Submit all answers</button>
          <p className="muted small">This unfinished exam is saved locally. Export your progress for a portable backup.</p>
        </aside>
      </div>
    </>;
  }
  function Results() {
    const result = history[0];
    if (!result) return <div className="panel">No completed exam yet.</div>;
    const missed = (result.details || []).filter((entry) => {
      const q = byId.get(entry.id);
      return q && entry.selected !== q.correct_choice_index;
    }).map((entry) => entry.id);
    return <>
      <section className="panel" style={{ textAlign: "center" }}>
        <div className="eyebrow">EXAM RESULTS</div>
        <h1 style={{ margin: 0 }}>{result.label}</h1>
        <div className="bigScore">{percent(result.correct, result.count)}%</div>
        <p className="muted">{result.correct} of {result.count} correct · {result.answered} answered · {result.durationMinutes} min</p>
        <div className="row" style={{ justifyContent: "center" }}>
          <button className="btn" disabled={!missed.length} onClick={() => startSession(missed, "tutor")}>Review mistakes</button>
          <button className="btn alt" onClick={() => navigate("dashboard")}>Dashboard</button>
        </div>
      </section>
      <h2 className="sectionTitle">Answer review</h2>
      <div className="stack">{(result.details || []).map((entry, i) => {
        const q = byId.get(entry.id);
        if (!q) return <div className="panel" key={entry.id}>Question {i + 1} is no longer available in the approved bank.</div>;
        const correct = entry.selected === q.correct_choice_index;
        return <div className="panel" key={entry.id}>
          <div className="spread"><span className="chip">{i + 1} · {q.subject} · {q.topic}</span><b style={{ color: correct ? "#15805e" : "#b83f4a" }}>{correct ? "✓ Correct" : entry.selected === null ? "— Unanswered" : "✕ Incorrect"}</b></div>
          <h3 style={{ fontSize: 15 }}>{q.question_text}</h3>
          <p className="small">Your answer: {entry.selected === null ? "Unanswered" : q.answer_choices[entry.selected] || "Unavailable"}</p>
          <p className="small"><b>Correct:</b> {q.answer_choices[q.correct_choice_index]}</p>
          <p className="cardText">{q.explanation}</p>
        </div>;
      })}</div>
    </>;
  }
  function Library() {
    return <>
      <div className="spread"><div><h1>Question bank</h1><p className="muted">Browse approved database questions and moderator-approved JSON batches loaded from Supabase.</p></div><span className="chip">{filteredLibrary.length} matches</span></div>
      <section className="panel stack">
        <div className="grid2">
          <input className="search" aria-label="Search questions" placeholder="Search questions, topics, or subjects" value={librarySearch} onChange={(e) => { setLibrarySearch(e.target.value); setLibraryLimit(30); }} />
          <select className="search" aria-label="Subject" value={librarySubject} onChange={(e) => { setLibrarySubject(e.target.value); setLibraryLimit(30); }}><option>All subjects</option>{subjects.map((s) => <option key={s}>{s}</option>)}</select>
        </div>
        {filteredLibrary.slice(0, libraryLimit).map((q) => <div className="listItem" key={q.id}>
          <div style={{ flex: 1 }}><div className="small muted">{q.subject} · {q.topic} {records[q.id]?.lastCorrect === false && " · Previously missed"}</div><p><b>{q.question_text}</b></p></div>
          <button className="btn alt sm" onClick={() => startSession([q.id], "tutor")}>Practice</button>
        </div>)}
        {!filteredLibrary.length && <p className="muted">No matching approved questions.</p>}
        {libraryLimit < filteredLibrary.length && <button className="btn alt" onClick={() => setLibraryLimit((n) => n + 30)}>Show more</button>}
        {limitReached && <p className="notice">Showing only the first {MAX_LOADED_QUESTIONS} approved questions. Server-side pagination will be added when the bank grows.</p>}
      </section>
    </>;
  }

  function Contribute() {
    return <>
      <div className="spread">
        <div><h1>Contribute a question file</h1>
          <p className="muted">Make questions in your own ChatGPT Project, then upload one small JSON file for review.</p>
        </div>
        <span className="chip green">No FreeMedTrain AI charges</span>
      </div>
      <div className="grid" style={{ marginTop: 10 }}>
        <section className="panel stack">
          <span className="chip">1. Prepare</span>
          <h2 className="cardTitle">Your ChatGPT Project</h2>
          <p className="cardText">Add only course materials you may use. Never upload exam recalls, confidential questions, patient information, or unauthorized textbooks.</p>
        </section>
        <section className="panel stack">
          <span className="chip">2. Generate</span>
          <h2 className="cardTitle">Copy the prompt</h2>
          <p className="cardText">Paste our standard prompt into your Project and ask ChatGPT to produce a downloadable JSON question file.</p>
          <button className="btn alt" onClick={copyPrompt}>Copy ChatGPT question prompt</button>
        </section>
        <section className="panel stack">
          <span className="chip">3. Submit</span>
          <h2 className="cardTitle">Upload the JSON</h2>
          <p className="cardText">We save a single small file and a lightweight database record. A moderator reviews the full batch before anyone can practice it.</p>
        </section>
      </div>
      <section className="panel stack" style={{ marginTop: 16 }}>
        <div className="spread">
          <h2 className="cardTitle">Submit your question batch</h2>
          <span className="chip grey">JSON · Max 50 questions · 512 KB</span>
        </div>
        <label className="field">Choose your FreeMedTrain_questions.json file
          <input type="file" accept=".json,application/json" onChange={selectQuestionFile} disabled={batchBusy}/>
        </label>
        {fileBatch && <div className="notice">
          <b>{fileBatch.document.title}</b> · {fileBatch.document.questions.length} questions · {Math.round(fileBatch.sizeBytes / 1024)} KB
          <div className="tagRow" style={{ marginTop: 9 }}>
            {Object.entries(fileBatch.counts).map(([name, count]) => <span className="chip" key={name}>{name}: {count}</span>)}
          </div>
          <p style={{ marginBottom: 0 }} className="small">Review the questions in ChatGPT before uploading. A successful format check does not verify medical accuracy.</p>
        </div>}
        <label className="row" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={batchRights} disabled={!fileBatch || batchBusy} onChange={(e) => setBatchRights(e.target.checked)}/>
          <span>I have permission to contribute this original content, and it includes no confidential exam items or identifiable patient data.</span>
        </label>
        <div className="row">
          <button className="btn" disabled={!fileBatch || !batchRights || batchBusy} onClick={submitQuestionBatch}>
            {batchBusy ? "Uploading…" : retryBatch ? "Retry upload" : "Submit entire batch for review"}
          </button>
          <span className="muted small">Nothing becomes publicly available until a moderator approves it.</span>
        </div>
        {batchError && <div className="error" role="alert">{batchError}</div>}
        {batchNotice && <div className="success" role="status">{batchNotice}</div>}
      </section>
      <section className="panel stack" style={{ marginTop: 16 }}>
        <div className="spread"><h2 className="cardTitle">My submitted batches</h2>
          <button className="btn alt sm" onClick={() => setBatchRefresh((n) => n + 1)}>Refresh status</button>
        </div>
        {batchListError && <div className="error">{batchListError}. The administrator may need to run the batch setup SQL first.</div>}
        {myBatches.map((batch) => <div className="listItem" key={batch.id}>
          <div><b>{batch.title}</b><div className="small muted">{batch.question_count} questions · {dateLabel(batch.submitted_at)} · {batch.id}</div></div>
          <span className={`chip ${batch.status === "approved" ? "green" : batch.status === "rejected" ? "grey" : ""}`}>{batch.status}</span>
        </div>)}
        {!myBatches.length && !batchListError && <p className="muted small">No submitted batches yet.</p>}
      </section>
    </>;
  }

  function Progress() {
    const grouped = subjects.map((name) => {
      const group = questions.filter((q) => q.subject === name);
      const stats = group.map((q) => records[q.id] || {});
      return { name, total: group.length, seen: stats.filter((r) => r.attempts > 0).length,
        attempts: stats.reduce((n, r) => n + (r.attempts || 0), 0), right: stats.reduce((n, r) => n + (r.right || 0), 0) };
    });
    return <>
      <h1>Your learning progress</h1>
      <div className="grid4">
        <StatCard label="Total answers" value={attempted}/>
        <StatCard label="Lifetime accuracy" value={`${percent(correctTotal, attempted)}%`}/>
        <StatCard label="Unique questions practiced" value={studyCount}/>
        <StatCard label="Due for review" value={dueCount}/>
      </div>
      <div className="grid2" style={{ marginTop: 16 }}>
        <section className="panel"><h2 className="cardTitle">Subject coverage</h2>{grouped.map((g) => <div className="meterRow" key={g.name}><span>{g.name}</span><div className="progress"><span style={{ width: `${percent(g.seen,g.total)}%` }} /></div><b>{g.seen}/{g.total}</b></div>)}{!grouped.length && <p className="muted small">No questions loaded.</p>}</section>
        <section className="panel"><h2 className="cardTitle">Accuracy by subject</h2>{grouped.map((g) => <div className="meterRow" key={g.name}><span>{g.name}</span><div className="progress"><span style={{ width: `${percent(g.right,g.attempts)}%`, background: "#299b7a" }} /></div><b>{g.attempts ? percent(g.right, g.attempts) + "%" : "—"}</b></div>)}{!grouped.length && <p className="muted small">Complete a session to see analytics.</p>}</section>
      </div>
      <h2 className="sectionTitle">Recent exams</h2>
      <section className="panel" style={{ overflowX: "auto" }}>
        {history.length ? <table className="table"><thead><tr><th>Date</th><th>Session</th><th>Score</th><th>Questions</th></tr></thead><tbody>{history.map((h) => <tr key={h.id}><td>{dateLabel(h.date)}</td><td>{h.label}</td><td><b>{percent(h.correct, h.count)}%</b></td><td>{h.count}</td></tr>)}</tbody></table> : <p className="muted">No completed exams yet.</p>}
      </section>
    </>;
  }
  function Backup() {
    return <>
      <h1>Settings and backup</h1>
      <div className="grid">
        <section className="panel stack">
          <h2 className="cardTitle">Display name</h2>
          <p className="cardText">This name appears on your dashboard and is saved only in this browser.</p>
          <label className="field">Name
            <input maxLength={60} value={store.displayName} placeholder={user?.email?.split("@")[0] || "Student"} onChange={(e) => setStore((prev) => ({ ...prev, displayName: e.target.value }))} />
          </label>
        </section>
        <section className="panel stack">
          <h2 className="cardTitle">Export progress</h2>
          <p className="cardText">Download scores, history, personal notes, flags, and unfinished exams. No question bank data is included.</p>
          <button className="btn" onClick={exportBackup}>Download JSON backup</button>
        </section>
        <section className="panel stack">
          <h2 className="cardTitle">Import progress</h2>
          <p className="cardText">Restore a previous FreeMedTrain progress backup on this device.</p>
          <input type="file" accept=".json,application/json" onChange={importBackup} />
          {importMessage && <div className="notice">{importMessage}</div>}
        </section>
      </div>
      <section className="panel" style={{ marginTop: 14 }}>
        <h2 className="cardTitle">Data controls</h2>
        <div className="row">
          <button className="btn alt" onClick={() => setRefreshIndex((n) => n + 1)}>Refresh Supabase question bank</button>
          <button className="btn danger" onClick={() => {
            if (window.confirm("Delete all FreeMedTrain progress and notes stored in this browser?")) {
              setStore((prev) => ({ ...EMPTY_STORE, ownerId: prev.ownerId, displayName: prev.displayName }));
              navigate("dashboard");
            }
          }}>Reset local study progress</button>
        </div>
        <p className="footNote">Your account and approved questions remain in Supabase. Progress is not synchronized between devices; export backups before switching browsers or clearing browser storage.</p>
      </section>
    </>;
  }

  return <><style>{CSS}</style><div className="shell">
    <header className="top">
      <div className="brand"><span className="brandIcon">✳</span>FreeMedTrain</div>
      {user && <><nav className="nav" aria-label="Main navigation">
        {[ ["dashboard","Dashboard"], ["practice","Practice"], ["library","Question Bank"], ["contribute","Contribute"], ["progress","Progress"], ["backup","Backup"] ].map(([key,label]) => <button key={key} className={page === key ? "active" : ""} onClick={() => navigate(key)}>{label}</button>)}
      </nav><span className="userChip">{displayName}</span></>}
    </header>
    {checking ? <section className="panel">Checking your session...</section> : !user ? <>
      <section className="panel hero"><div className="eyebrow">FREE · OPEN SOURCE · COMMUNITY POWERED</div><h1>Medical education, accessible to everyone.</h1><p>Practice approved clinical and foundational questions, revisit weak areas, and contribute to an independent learning community.</p></section>
      <section className="panel authCard stack">
        <h2 className="cardTitle">{authMode === "signin" ? "Sign in to FreeMedTrain" : "Create your free account"}</h2>
        <p className="cardText">The question bank is available only to signed-in students.</p>
        <form onSubmit={submitAuth} className="stack">
          <label className="field">Email address<input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="field">Password<input type="password" required minLength={authMode === "signup" ? 12 : undefined} autoComplete={authMode === "signup" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {authMode === "signup" && <p className="small muted">Use 12+ characters and the complexity rules configured in Supabase.</p>}
          <button className="btn full" type="submit" disabled={authBusy}>{authBusy ? "Processing..." : authMode === "signin" ? "Sign in" : "Create account"}</button>
        </form>
        <button className="btn alt full" onClick={() => { setAuthMode(authMode === "signin" ? "signup" : "signin"); setAuthError(""); setAuthNotice(""); setPassword(""); }}>
          {authMode === "signin" ? "Create a free account" : "Already registered? Sign in"}
        </button>
        {authError && <div role="alert" className="error">{authError}</div>}
        {authNotice && <div role="status" className="success">{authNotice}</div>}
      </section>
    </> : !localReady ? <section className="panel">Loading your study workspace...</section> : <main className="stack">
      <div className="spread">
        <span className="small muted">Signed in as {user.email}</span>
        <button className="btn alt sm" onClick={signOut}>Sign out</button>
      </div>
      {page === "dashboard" && Dashboard()}
      {page === "practice" && PracticeSetup()}
      {page === "exam" && Exam()}
      {page === "results" && Results()}
      {page === "library" && Library()}
      {page === "contribute" && Contribute()}
      {page === "progress" && Progress()}
      {page === "backup" && Backup()}
    </main>}
    <footer className="footer">FreeMedTrain is an independent medical education project. Approved practice questions are retrieved from Supabase database and Storage. Not affiliated with USMLE, NBME, or NBOME; not a substitute for clinical guidance.</footer>
  </div></>;
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode><App /></React.StrictMode>
);
