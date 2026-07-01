import React, { useState, useEffect } from 'react';

const TEMPLATES = [
  {
    label: "🌟 Outstanding Service",
    text: "Last night I dined at Bistro Royale in downtown Seattle. The complimentary chocolate lava cake was outstanding! The waiter was incredibly attentive, though the host was a bit slow to seat us."
  },
  {
    label: "⚖️ Mixed Experience",
    text: "The new smart watch has a stunning OLED screen and the battery life is excellent. However, the heart rate tracker is highly inaccurate during high-intensity workouts and the setup app keeps crashing."
  },
  {
    label: "❌ Disastrous Stay",
    text: "The room at Grand Plaza was extremely dirty and smelled like wet dog. I complained to the receptionist but she was very rude. The view of the brick wall was depressing."
  }
];

// Read Azure credentials dynamically from environment variables (supports multiple naming conventions)
const AZURE_KEY = import.meta.env.VITE_AZURE_KEY || import.meta.env.VITE_AZURE_COGNITIVE_API_KEY || "";
const AZURE_ENDPOINT = (import.meta.env.VITE_AZURE_ENDPOINT || import.meta.env.VITE_AZURE_COGNITIVE_ENDPOINT || "").replace(/\/$/, "");

export default function App() {
  const [reviewText, setReviewText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState(null);
  const [apiOnline, setApiOnline] = useState(true);

  // Check endpoint connectivity on mount
  useEffect(() => {
    async function checkApiHealth() {
      try {
        // Send a simple request or pre-flight to verify endpoint is online
        const response = await fetch(`${AZURE_ENDPOINT}/language/:analyze-text?api-version=2022-05-01`, {
          method: 'OPTIONS'
        });
        if (response.ok || response.status === 200 || response.status === 204) {
          setApiOnline(true);
        } else {
          setApiOnline(false);
        }
      } catch (err) {
        setApiOnline(false);
      }
    }
    checkApiHealth();
  }, []);

  // Helper function to query Azure Cognitive Service directly
  const queryAzureService = async (kind, text, enableOpinionMining = false) => {
    const url = `${AZURE_ENDPOINT}/language/:analyze-text?api-version=2022-05-01`;
    const payload = {
      kind: kind,
      analysisInput: {
        documents: [
          {
            id: "1",
            language: "en",
            text: text
          }
        ]
      },
      parameters: {
        modelVersion: "latest"
      }
    };

    if (enableOpinionMining) {
      payload.parameters.opinionMining = true;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let message = `API error status: ${response.status}`;
      try {
        const errorJson = await response.json();
        if (errorJson?.error?.message) {
          message = errorJson.error.message;
        }
      } catch (e) {}
      throw new Error(message);
    }

    return response.json();
  };

  const handleAnalyze = async (e) => {
    e.preventDefault();
    if (!reviewText.trim()) return;

    setLoading(true);
    setError(null);
    setResults(null);

    try {
      // Query all three cognitive analysis tasks in parallel from the browser
      const [sentimentRes, phrasesRes, entitiesRes] = await Promise.allSettled([
        queryAzureService("SentimentAnalysis", reviewText, true),
        queryAzureService("KeyPhraseExtraction", reviewText),
        queryAzureService("EntityRecognition", reviewText)
      ]);

      const data = {
        sentiment: null,
        keyPhrases: [],
        entities: [],
        opinions: [],
        errors: null
      };

      let hasWarning = false;
      const errorsObj = {};

      // 1. Parse Sentiment & Opinions
      if (sentimentRes.status === "fulfilled") {
        const sentimentDoc = sentimentRes.value.results?.documents?.[0];
        if (sentimentDoc) {
          data.sentiment = {
            label: sentimentDoc.sentiment,
            confidenceScores: sentimentDoc.confidenceScores
          };

          // Parse sentence opinions (aspect-based sentiment)
          const opinionsList = [];
          sentimentDoc.sentences?.forEach(sentence => {
            if (sentence.targets) {
              sentence.targets.forEach(target => {
                const assessments = [];
                if (target.relations) {
                  target.relations.forEach(relation => {
                    if (relation.relationType === 'assessment') {
                      const refParts = relation.ref.split('/');
                      const assessIdx = parseInt(refParts[refParts.length - 1], 10);
                      if (sentence.assessments && sentence.assessments[assessIdx]) {
                        assessments.push(sentence.assessments[assessIdx].text);
                      }
                    }
                  });
                }
                opinionsList.push({
                  target: target.text,
                  sentiment: target.sentiment,
                  assessments: assessments
                });
              });
            }
          });
          data.opinions = opinionsList;
        }
      } else {
        hasWarning = true;
        errorsObj.sentiment = { error: sentimentRes.reason.message };
      }

      // 2. Parse Key Phrases
      if (phrasesRes.status === "fulfilled") {
        const phrasesDoc = phrasesRes.value.results?.documents?.[0];
        if (phrasesDoc) {
          data.keyPhrases = phrasesDoc.keyPhrases || [];
        }
      } else {
        hasWarning = true;
        errorsObj.keyPhrases = { error: phrasesRes.reason.message };
      }

      // 3. Parse Named Entities
      if (entitiesRes.status === "fulfilled") {
        const entitiesDoc = entitiesRes.value.results?.documents?.[0];
        if (entitiesDoc) {
          data.entities = (entitiesDoc.entities || []).map(entity => ({
            text: entity.text,
            category: entity.category,
            subcategory: entity.subcategory,
            confidenceScore: entity.confidenceScore
          }));
        }
      } else {
        hasWarning = true;
        errorsObj.entities = { error: entitiesRes.reason.message };
      }

      // Trigger error if all calls failed
      if (!data.sentiment && data.keyPhrases.length === 0 && data.entities.length === 0) {
        throw new Error("All analysis attempts failed. Check credentials and endpoint URL.");
      }

      if (hasWarning) {
        data.errors = errorsObj;
      }

      setResults(data);
      setApiOnline(true);
    } catch (err) {
      console.error("Direct Azure API call failed:", err);
      setError(err.message || "Unable to connect to Azure Cognitive Services. Check network settings and credentials.");
      setApiOnline(false);
    } finally {
      setLoading(false);
    }
  };

  const getSentimentIcon = (label) => {
    switch (label?.toLowerCase()) {
      case 'positive': return '✨';
      case 'neutral': return '⚖️';
      case 'negative': return '💥';
      default: return '❔';
    }
  };

  const getConfidenceScores = () => {
    if (!results || !results.sentiment) return { positive: 0, neutral: 0, negative: 0 };
    return results.sentiment.confidenceScores || { positive: 0, neutral: 0, negative: 0 };
  };

  const scores = getConfidenceScores();

  return (
    <div className="app-container">
      <header>
        <h1>AI Sentiment Badge Form</h1>
        <p>Extract aspects, entities, key phrases, and dynamically assign sentiment badges using Azure AI</p>
      </header>

      <div className="dashboard-grid">
        {/* LEFT PANEL: INPUT FORM */}
        <div className="glass-panel form-section">
          <h2 className="section-title">Review Input</h2>
          <form onSubmit={handleAnalyze}>
            <div className="textarea-container">
              <textarea
                placeholder="Type or paste a customer review here (e.g. 'The food was excellent, but the service was terrible...')"
                value={reviewText}
                onChange={(e) => setReviewText(e.target.value)}
                disabled={loading}
              />
            </div>

            <div className="button-row" style={{ marginTop: '1rem' }}>
              <button
                type="submit"
                className="submit-btn"
                disabled={loading || !reviewText.trim()}
              >
                {loading && <span className="spinner"></span>}
                {loading ? "Analyzing..." : "Analyze Review"}
              </button>
            </div>
          </form>

          {/* TEMPLATE SECTION */}
          <div className="templates-container" style={{ marginTop: '1rem' }}>
            <span className="templates-header">Load Template Review</span>
            <div className="template-chips">
              {TEMPLATES.map((tmpl, idx) => (
                <button
                  key={idx}
                  className="template-chip"
                  onClick={() => setReviewText(tmpl.text)}
                  disabled={loading}
                  type="button"
                >
                  {tmpl.label}
                </button>
              ))}
            </div>
          </div>

          {/* ERROR DISPLAY */}
          {error && (
            <div className="error-card">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <div className="error-content">
                <strong>An error occurred</strong>
                <span>{error}</span>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT PANEL: ANALYSIS DASHBOARD */}
        <div className="glass-panel">
          {/* 1. INITIAL PLACEHOLDER STATE */}
          {!loading && !results && (
            <div className="placeholder-panel">
              <span className="placeholder-icon">📊</span>
              <h3>No Review Loaded</h3>
              <p>Type a review on the left and click analyze to see aspect details and sentiment badges.</p>
            </div>
          )}

          {/* 2. SKELETON LOADER STATE */}
          {loading && (
            <div className="skeleton-panel">
              <div className="skeleton-item skeleton-header"></div>
              <div className="skeleton-item skeleton-badge"></div>
              <div className="skeleton-item skeleton-line"></div>
              <div className="skeleton-item skeleton-line"></div>
              <div className="skeleton-item skeleton-line" style={{ width: '70%' }}></div>
            </div>
          )}

          {/* 3. RESULTS OUTPUT */}
          {!loading && results && (
            <div className="results-container">
              {/* Partial Warnings Box */}
              {results.errors && (
                <div className="error-card" style={{ background: 'rgba(245, 158, 11, 0.1)', borderColor: 'rgba(245, 158, 11, 0.3)', marginTop: 0 }}>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" style={{ color: 'var(--color-neutral)' }}>
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  <div className="error-content">
                    <strong style={{ color: 'var(--color-neutral)' }}>Analysis Partially Succeeded</strong>
                    {Object.entries(results.errors).map(([key, val]) => (
                      <span key={key}>• {key.toUpperCase()}: {val.error || JSON.stringify(val)}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Sentiment Badge & Metric Progress Bars */}
              <div className="sentiment-widget">
                <div className={`sentiment-badge ${results.sentiment?.label?.toLowerCase() || 'neutral'}`}>
                  <span className="badge-icon">{getSentimentIcon(results.sentiment?.label)}</span>
                  <span className="badge-label">{results.sentiment?.label || 'Neutral'}</span>
                  <span className="badge-confidence">
                    Confidence: {Math.round((results.sentiment?.confidenceScores?.[results.sentiment.label.toLowerCase()] || 0) * 100)}%
                  </span>
                </div>

                <div className="confidence-meters">
                  <div className="score-row">
                    <div className="score-info">
                      <span>Positive</span>
                      <span>{Math.round(scores.positive * 100)}%</span>
                    </div>
                    <div className="progress-bar-bg">
                      <div 
                        className="progress-bar-fill positive" 
                        style={{ width: `${Math.round(scores.positive * 100)}%` }}
                      ></div>
                    </div>
                  </div>

                  <div className="score-row">
                    <div className="score-info">
                      <span>Neutral</span>
                      <span>{Math.round(scores.neutral * 100)}%</span>
                    </div>
                    <div className="progress-bar-bg">
                      <div 
                        className="progress-bar-fill neutral" 
                        style={{ width: `${Math.round(scores.neutral * 100)}%` }}
                      ></div>
                    </div>
                  </div>

                  <div className="score-row">
                    <div className="score-info">
                      <span>Negative</span>
                      <span>{Math.round(scores.negative * 100)}%</span>
                    </div>
                    <div className="progress-bar-bg">
                      <div 
                        className="progress-bar-fill negative" 
                        style={{ width: `${Math.round(scores.negative * 100)}%` }}
                      ></div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Key Phrases Section */}
              <div className="phrases-section">
                <h3 className="section-title">Key Phrases</h3>
                <div className="tags-container">
                  {results.keyPhrases && results.keyPhrases.length > 0 ? (
                    results.keyPhrases.map((phrase, idx) => (
                      <span key={idx} className="phrase-tag">{phrase}</span>
                    ))
                  ) : (
                    <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                      No key phrases extracted.
                    </span>
                  )}
                </div>
              </div>

              {/* Aspect Sentiments (Opinion Mining) Section */}
              <div className="opinions-section">
                <h3 className="section-title">Aspect Sentiments (Opinion Mining)</h3>
                <div className="tags-container">
                  {results.opinions && results.opinions.length > 0 ? (
                    results.opinions.map((op, idx) => (
                      <span key={idx} className={`opinion-badge ${op.sentiment}`}>
                        {op.target} {op.assessments?.length > 0 ? `(${op.assessments.join(', ')})` : ''}
                      </span>
                    ))
                  ) : (
                    <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                      No aspect-based sentiments extracted.
                    </span>
                  )}
                </div>
              </div>

              {/* Named Entities Section */}
              <div className="entities-section">
                <h3 className="section-title">Named Entities</h3>
                <div className="entities-grid">
                  {results.entities && results.entities.length > 0 ? (
                    results.entities.map((entity, idx) => (
                      <div key={idx} className="entity-card">
                        <div className="entity-main">
                          <span className="entity-text">{entity.text}</span>
                          <div className="entity-meta">
                            <span className="entity-category">{entity.category}</span>
                            {entity.subcategory && <span style={{ opacity: 0.6 }}>• {entity.subcategory}</span>}
                          </div>
                        </div>
                        <span className="entity-confidence">
                          {Math.round(entity.confidenceScore * 100)}%
                        </span>
                      </div>
                    ))
                  ) : (
                    <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '1rem 0', color: 'var(--text-muted)' }}>
                      No named entities recognized.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* FOOTER */}
      <footer>
        <span>AI Review Analyser &copy; 2026</span>
        <div className="api-status">
          <span className={`status-dot ${apiOnline ? 'connected' : 'offline'}`}></span>
          <span>API Status: {apiOnline ? 'Connected' : 'Offline / Error'}</span>
        </div>
      </footer>
    </div>
  );
}
