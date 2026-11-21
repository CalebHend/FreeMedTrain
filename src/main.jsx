
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { supabase } from "./lib/supabase";
import PracticeQuestion from "./PracticeQuestion";

const inputStyle = {
  width: "100%",
  padding: "13px",
  marginTop: "7px",
  borderRadius: "8px",
  border: "1px solid #6e8996",
  background: "#102c3b",
  color: "white",
  boxSizing: "border-box",
  fontSize: "16px"
};

const buttonStyle = {
  width: "100%",
  padding: "13px",
  background: "#82d9c0",
  color: "#102c3b",
  border: "none",
  borderRadius: "8px",
  fontWeight: "bold",
  fontSize: "16px",
  cursor: "pointer"
};

function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      setUser(data.session?.user ?? null);
      if (error) setError(error.message);
      setChecking(false);
    }).catch((err) => {
      if (active) {
        setError(err.message);
        setChecking(false);
      }
    });

    const { data: { subscription } } =
      supabase.auth.onAuthStateChange((_event, session) => {
        if (active) setUser(session?.user ?? null);
      });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setMessage("");
    setBusy(true);

    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo:
              window.location.origin + import.meta.env.BASE_URL
          }
        });

        if (error) throw error;

        if (data.session) {
          setUser(data.session.user);
        } else {
          setMessage(
            "If your registration is accepted, check your email " +
            "for a confirmation link."
          );
        }
      } else {
        const { data, error } =
          await supabase.auth.signInWithPassword({
            email,
            password
          });

        if (error) throw error;
        setUser(data.user);
      }

      setPassword("");
    } catch (err) {
      setError(err.message || "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    setError("");
    const { error } = await supabase.auth.signOut();
    if (error) setError(error.message);
    else setUser(null);
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "#102c3b",
      color: "white",
      fontFamily: "Arial, sans-serif",
      padding: "50px 20px",
      boxSizing: "border-box"
    }}>
      <main style={{
        maxWidth: "600px",
        margin: "0 auto",
        textAlign: "center"
      }}>
        <h1 style={{ fontSize: "48px", marginBottom: "10px" }}>
          FreeMedTrain
        </h1>

        <h2 style={{
          color: "#82d9c0",
          fontWeight: "normal"
        }}>
          Medical Education, Accessible to Everyone.
        </h2>

        <p style={{ lineHeight: "1.7", color: "#d4e3e9" }}>
          Free, open-source medical exam preparation,
          community-generated questions, anatomy identification,
          and AI-assisted learning.
        </p>

        <section style={{
          background: "#193a4a",
          border: "1px solid #365767",
          borderRadius: "16px",
          padding: "30px",
          marginTop: "35px",
          textAlign: "left"
        }}>
          {checking ? (
            <p>Checking your session...</p>
          ) : user ? (
            <div>
              <h2>Welcome to FreeMedTrain!</h2>
              <p>Signed in as:</p>
              <p style={{ color: "#82d9c0" }}>{user.email}</p>
              <p>Your student dashboard is coming next.</p>

              <button style={buttonStyle} onClick={handleSignOut}>
                Sign Out
              </button>
            </div>
          ) : (
            <>
              <h2 style={{ marginTop: 0 }}>
                {mode === "signup"
                  ? "Create your free account"
                  : "Student Login"}
              </h2>

              <form onSubmit={handleSubmit}>
                <label htmlFor="email">Email address</label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={inputStyle}
                />

                <div style={{ marginTop: "20px" }}>
                  <label htmlFor="password">Password</label>
                  <input
                    id="password"
                    type="password"
                    required
                    minLength={mode === "signup" ? 12 : undefined}
                    autoComplete={
                      mode === "signup"
                        ? "new-password"
                        : "current-password"
                    }
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={inputStyle}
                  />
                </div>

                {mode === "signup" && (
                  <p style={{ color: "#b5cbd5", fontSize: "13px" }}>
                    Use at least 12 characters and follow the
                    password requirements configured in Supabase.
                  </p>
                )}

                <div style={{ marginTop: "25px" }}>
                  <button
                    type="submit"
                    disabled={busy}
                    style={buttonStyle}
                  >
                    {busy
                      ? "Processing..."
                      : mode === "signup"
                        ? "Create Account"
                        : "Sign In"}
                  </button>
                </div>
              </form>

              <p style={{ textAlign: "center", marginTop: "25px" }}>
                {mode === "signup"
                  ? "Already have an account?"
                  : "Don't have an account?"}
              </p>

              <button
                type="button"
                onClick={() => {
                  setMode(mode === "signup" ? "signin" : "signup");
                  setError("");
                  setMessage("");
                  setPassword("");
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "#82d9c0",
                  cursor: "pointer",
                  display: "block",
                  margin: "0 auto",
                  fontSize: "16px"
                }}
              >
                {mode === "signup"
                  ? "Sign In"
                  : "Create a Free Account"}
              </button>
            </>
          )}

          {error && (
            <p role="alert" style={{ color: "#ffb4a9" }}>
              {error}
            </p>
          )}

          {message && (
            <p role="status" style={{ color: "#82d9c0" }}>
              {message}
            </p>
          )}
        </section>

        <PracticeQuestion />

        <p style={{
          color: "#a3b8c4",
          marginTop: "40px",
          fontSize: "14px"
        }}>
          An independent, open-source medical education project.
        </p>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
