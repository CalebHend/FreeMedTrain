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
        {[ ["dashboard","Dashboard"], ["practice","Practice"], ["library","Question Bank"], ["progress","Progress"], ["backup","Backup"] ].map(([key,label]) => <button key={key} className={page === key ? "active" : ""} onClick={() => navigate(key)}>{label}</button>)}
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
      {page === "progress" && Progress()}
      {page === "backup" && Backup()}
    </main>}
    <footer className="footer">FreeMedTrain is an independent medical education project. Approved practice questions are retrieved from Supabase. Not affiliated with USMLE, NBME, or NBOME; not a substitute for clinical guidance.</footer>
  </div></>;
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode><App /></React.StrictMode>
);
