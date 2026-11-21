
import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#102c3b",
        color: "#ffffff",
        fontFamily: "Arial, sans-serif",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "30px"
      }}
    >
      <main style={{ maxWidth: "800px", textAlign: "center" }}>
        <h1 style={{ fontSize: "52px", marginBottom: "15px" }}>
          FreeMedTrain
        </h1>

        <h2 style={{ color: "#82d9c0", fontWeight: "normal" }}>
          Medical Education, Accessible to Everyone.
        </h2>

        <p style={{ fontSize: "18px", lineHeight: "1.8" }}>
          A free, open-source platform for medical students
          featuring community-generated practice questions,
          anatomy identification, and AI-assisted learning.
        </p>

        <p style={{ color: "#a3b8c4", marginTop: "40px" }}>
          Building the future of collaborative medical education.
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
