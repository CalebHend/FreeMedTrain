
import React, { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";

export default function PracticeQuestion() {
  const [questions, setQuestions] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selected, setSelected] = useState(null);
  const [showAnswer, setShowAnswer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function loadQuestions() {
      const { data, error } = await supabase
        .from("questions")
        .select(
          "id, subject, topic, question_text, answer_choices, correct_choice_index, explanation"
        )
        .eq("review_status", "approved")
        .eq("question_type", "multiple_choice")
        .order("created_at", { ascending: false })
        .limit(20);

      if (!active) return;

      if (error) setError(error.message);
      else setQuestions(data || []);

      setLoading(false);
    }

    loadQuestions();
    return () => { active = false; };
  }, []);

  if (loading) return <p>Loading questions...</p>;

  if (error) {
    return <p role="alert">Unable to load questions: {error}</p>;
  }

  if (!questions.length) {
    return <p>No approved questions are available yet.</p>;
  }

  const q = questions[currentIndex];
  const correct = selected === q.correct_choice_index;

  function nextQuestion() {
    setCurrentIndex((i) => i + 1);
    setSelected(null);
    setShowAnswer(false);
  }

  return (
    <section style={{
      background: "#193a4a",
      border: "1px solid #365767",
      borderRadius: "16px",
      padding: "25px",
      marginTop: "30px",
      textAlign: "left"
    }}>
      <h2>Practice Questions</h2>

      <p style={{ color: "#82d9c0" }}>
        {q.subject} — {q.topic}
      </p>

      <p style={{ color: "#b5cbd5" }}>
        Question {currentIndex + 1} of {questions.length}
      </p>

      <h3 style={{ lineHeight: "1.6" }}>
        {q.question_text}
      </h3>

      {q.answer_choices.map((choice, index) => {
        const isCorrect = index === q.correct_choice_index;

        let background = "#102c3b";
        let border = "#547282";

        if (showAnswer && isCorrect) {
          background = "#17634f";
          border = "#82d9c0";
        } else if (showAnswer && selected === index) {
          background = "#793c43";
          border = "#ffb4a9";
        } else if (selected === index) {
          border = "#82d9c0";
        }

        return (
          <button
            key={index}
            disabled={showAnswer}
            onClick={() => setSelected(index)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "15px",
              marginBottom: "10px",
              background,
              color: "white",
              border: `2px solid ${border}`,
              borderRadius: "10px",
              cursor: showAnswer ? "default" : "pointer"
            }}
          >
            {String.fromCharCode(65 + index)}. {choice}
          </button>
        );
      })}

      {!showAnswer ? (
        <button
          disabled={selected === null}
          onClick={() => setShowAnswer(true)}
          style={{
            padding: "13px 20px",
            background: "#82d9c0",
            color: "#102c3b",
            border: "none",
            borderRadius: "8px",
            fontWeight: "bold",
            cursor: "pointer",
            marginTop: "15px"
          }}
        >
          Submit Answer
        </button>
      ) : (
        <div style={{ marginTop: "20px" }}>
          <h3 style={{ color: correct ? "#82d9c0" : "#ffb4a9" }}>
            {correct ? "Correct!" : "Incorrect"}
          </h3>

          <p>{q.explanation}</p>

          {currentIndex < questions.length - 1 ? (
            <button onClick={nextQuestion}>
              Next Question
            </button>
          ) : (
            <p>You've reached the end of the available questions.</p>
          )}
        </div>
      )}
    </section>
  );
}
