import { useState, useRef, useEffect, useCallback } from 'react';

const STEP_LABELS = ['Setup', 'Record', 'Processing', 'Review & Send'];

function formatTime(secs) {
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// ─── Step Indicator ──────────────────────────────────────────────────────────
function StepIndicator({ current }) {
  return (
    <div className="step-indicator">
      {STEP_LABELS.map((label, i) => (
        <div key={i} className="step-item">
          <div className={`step-circle ${i === current ? 'active' : i < current ? 'done' : ''}`}>
            {i < current ? '✓' : i + 1}
          </div>
          <span className={`step-label ${i === current ? 'active' : i < current ? 'done' : ''}`}>
            {label}
          </span>
          {i < STEP_LABELS.length - 1 && (
            <div className={`step-line ${i < current ? 'done' : ''}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Step 1 – Meeting Setup ──────────────────────────────────────────────────
function SetupStep({ meetingTitle, setMeetingTitle, meetingDate, setMeetingDate, attendees, setAttendees, onNext }) {
  const update = (i, field, val) =>
    setAttendees(prev => prev.map((a, idx) => idx === i ? { ...a, [field]: val } : a));

  const canProceed = meetingTitle.trim() && attendees.some(a => a.email.trim());

  return (
    <div className="step-content">
      <div className="step-header">
        <h2>Set up your meeting</h2>
        <p>Fill in the details before you start recording</p>
      </div>

      <div className="card">
        <div className="form-group">
          <label>Meeting title *</label>
          <input
            className="input"
            type="text"
            value={meetingTitle}
            onChange={e => setMeetingTitle(e.target.value)}
            placeholder="e.g. Q2 Product Review"
            autoFocus
          />
        </div>

        <div className="form-group">
          <label>Date</label>
          <input
            className="input"
            type="date"
            value={meetingDate}
            onChange={e => setMeetingDate(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label>
            Attendees *{' '}
            <span className="label-hint">at least one email is required to send the MOM</span>
          </label>
          {attendees.map((a, i) => (
            <div key={i} className="attendee-row">
              <input
                className="input"
                type="text"
                value={a.name}
                onChange={e => update(i, 'name', e.target.value)}
                placeholder="Full name"
              />
              <input
                className="input"
                type="email"
                value={a.email}
                onChange={e => update(i, 'email', e.target.value)}
                placeholder="email@example.com"
              />
              {attendees.length > 1 && (
                <button
                  className="btn-remove"
                  onClick={() => setAttendees(prev => prev.filter((_, idx) => idx !== i))}
                  title="Remove"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button
            className="btn-ghost-sm"
            onClick={() => setAttendees(prev => [...prev, { name: '', email: '' }])}
          >
            + Add attendee
          </button>
        </div>
      </div>

      <div className="step-actions">
        <button className="btn-primary" onClick={onNext} disabled={!canProceed}>
          Continue to recording →
        </button>
      </div>
    </div>
  );
}

// ─── Step 2 – Recording ───────────────────────────────────────────────────────
function RecordStep({ meetingTitle, meetingDate, onComplete, onBack }) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [audioBlob, setAudioBlob] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [bars, setBars] = useState(Array(28).fill(4));
  const [micError, setMicError] = useState('');

  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const streamRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const audioCtxRef = useRef(null);

  const startRecording = async () => {
    setMicError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;

      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const src = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      src.connect(analyser);
      analyserRef.current = analyser;

      const animate = () => {
        if (!analyserRef.current) return;
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        setBars(Array.from({ length: 28 }, (_, i) => {
          const v = data[Math.floor(i * data.length / 28)] / 255;
          return Math.max(4, v * 64);
        }));
        rafRef.current = requestAnimationFrame(animate);
      };
      animate();

      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find(t => MediaRecorder.isTypeSupported(t)) || '';

      // 32 kbps keeps speech quality while fitting ~2 hrs under Whisper's 25 MB limit
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 32000,
      });
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
      };

      recorder.start(500);
      setIsRecording(true);
      timerRef.current = setInterval(() => setElapsed(t => t + 1), 1000);
    } catch (err) {
      setMicError(`Could not access microphone: ${err.message}`);
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
    clearInterval(timerRef.current);
    cancelAnimationFrame(rafRef.current);
    audioCtxRef.current?.close();
    analyserRef.current = null;
    setIsRecording(false);
    setBars(Array(28).fill(4));
  };

  const reset = () => {
    setAudioBlob(null);
    setAudioUrl(null);
    setElapsed(0);
  };

  return (
    <div className="step-content">
      <div className="step-header">
        <h2>{meetingTitle}</h2>
        <p>{meetingDate}</p>
      </div>

      {micError && <div className="banner banner-error">{micError}</div>}

      <div className="card recorder-card">
        <div className="waveform" aria-hidden>
          {bars.map((h, i) => (
            <div
              key={i}
              className={`wave-bar ${isRecording ? 'live' : ''}`}
              style={{ height: h }}
            />
          ))}
        </div>

        <div className={`timer-display ${isRecording ? 'recording' : ''}`}>
          {isRecording && <span className="rec-dot" />}
          {formatTime(elapsed)}
        </div>

        {!audioBlob ? (
          <div className="rec-controls">
            {!isRecording ? (
              <button className="btn-record" onClick={startRecording}>
                <span className="rec-icon" />
                Start Recording
              </button>
            ) : (
              <button className="btn-stop" onClick={stopRecording}>
                <span className="stop-icon" />
                Stop Recording
              </button>
            )}
          </div>
        ) : (
          <div className="playback-wrap">
            <div className="playback-success">✓ Recording complete — {formatTime(elapsed)}</div>
            <audio controls src={audioUrl} className="audio-player" />
            <div className="playback-actions">
              <button className="btn-secondary" onClick={reset}>Re-record</button>
              <button className="btn-primary" onClick={() => onComplete(audioBlob)}>
                Process recording →
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="step-actions">
        <button className="btn-ghost" onClick={onBack}>← Back to setup</button>
      </div>
    </div>
  );
}

// ─── Step 3 – Processing ──────────────────────────────────────────────────────
function ProcessingStep({ audioBlob, meetingTitle, meetingDate, attendees, onComplete, onBack }) {
  const INITIAL_STEPS = [
    { id: 'upload', label: 'Uploading audio file' },
    { id: 'transcribe', label: 'Transcribing speech to text' },
    { id: 'generate', label: 'Generating minutes & action items' },
  ];

  const [stepStates, setStepStates] = useState(() =>
    Object.fromEntries(INITIAL_STEPS.map(s => [s.id, 'pending']))
  );
  const [error, setError] = useState('');
  const hasRun = useRef(false);

  const setStatus = (id, status) =>
    setStepStates(prev => ({ ...prev, [id]: status }));

  const run = useCallback(async () => {
    setError('');
    setStepStates(Object.fromEntries(INITIAL_STEPS.map(s => [s.id, 'pending'])));

    try {
      setStatus('upload', 'active');
      const form = new FormData();
      form.append('audio', audioBlob, 'recording.webm');
      form.append('mimeType', audioBlob.type);

      const tRes = await fetch('/api/transcribe', { method: 'POST', body: form });
      if (!tRes.ok) throw new Error((await tRes.json()).error || 'Transcription failed');
      const { transcript } = await tRes.json();
      setStatus('upload', 'done');

      setStatus('transcribe', 'active');
      await new Promise(r => setTimeout(r, 300));
      setStatus('transcribe', 'done');

      setStatus('generate', 'active');
      const mRes = await fetch('/api/generate-mom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, meetingTitle, date: meetingDate, attendees }),
      });
      if (!mRes.ok) throw new Error((await mRes.json()).error || 'MOM generation failed');
      const { mom, tasks } = await mRes.json();
      setStatus('generate', 'done');

      setTimeout(() => onComplete({ transcript, mom, tasks }), 400);
    } catch (err) {
      setError(err.message);
      setStepStates(prev => {
        const updated = { ...prev };
        Object.keys(updated).forEach(k => { if (updated[k] === 'active') updated[k] = 'error'; });
        return updated;
      });
    }
  }, [audioBlob, meetingTitle, meetingDate, attendees, onComplete]);

  useEffect(() => {
    if (!hasRun.current) { hasRun.current = true; run(); }
  }, [run]);

  const icon = (id) => {
    const st = stepStates[id];
    if (st === 'done') return <span className="p-icon done">✓</span>;
    if (st === 'active') return <span className="p-icon active"><span className="spinner" /></span>;
    if (st === 'error') return <span className="p-icon err">✕</span>;
    return <span className="p-icon">&nbsp;</span>;
  };

  return (
    <div className="step-content">
      <div className="step-header">
        <h2>Processing your meeting</h2>
        <p>Sit tight — this usually takes 20–60 seconds</p>
      </div>

      <div className="card processing-card">
        {INITIAL_STEPS.map(s => (
          <div key={s.id} className={`p-step ${stepStates[s.id]}`}>
            {icon(s.id)}
            <span>{s.label}</span>
          </div>
        ))}
      </div>

      {error && (
        <div className="processing-error">
          <div className="banner banner-error">{error}</div>
          <div className="step-actions">
            <button className="btn-primary" onClick={run}>Retry</button>
            <button className="btn-ghost" onClick={onBack}>← Back to recording</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Step 4 – Review & Send ───────────────────────────────────────────────────
function ReviewStep({ transcript, mom: initMom, tasks: initTasks, attendees, meetingTitle, meetingDate }) {
  const [tab, setTab] = useState('mom');
  const [mom, setMom] = useState(initMom);
  const [tasks, setTasks] = useState(initTasks);
  const [emailSending, setEmailSending] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [emailError, setEmailError] = useState('');

  const updateMom = (key, val) => setMom(prev => ({ ...prev, [key]: val }));
  const updateDiscussion = (i, val) => setMom(prev => {
    const pts = [...prev.discussion_points]; pts[i] = val;
    return { ...prev, discussion_points: pts };
  });
  const updateDecision = (i, val) => setMom(prev => {
    const d = [...prev.decisions]; d[i] = val;
    return { ...prev, decisions: d };
  });
  const updateTask = (i, field, val) => setTasks(prev => prev.map((t, idx) => idx === i ? { ...t, [field]: val } : t));

  const sendEmail = async () => {
    setEmailSending(true);
    setEmailError('');
    try {
      const res = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendees, meetingTitle, date: meetingDate, mom, tasks, transcript }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to send email');
      setEmailSent(true);
    } catch (err) {
      setEmailError(err.message);
    } finally {
      setEmailSending(false);
    }
  };

  const PRIORITY_CLASS = { High: 'badge-high', Medium: 'badge-medium', Low: 'badge-low' };

  const recipients = attendees.filter(a => a.email?.includes('@'));

  return (
    <div className="step-content">
      <div className="step-header">
        <h2>Meeting minutes ready</h2>
        <p>{meetingTitle} · {meetingDate}</p>
      </div>

      <div className="tabs">
        {[
          { id: 'mom', label: '📋 Minutes' },
          { id: 'tasks', label: `✅ Tasks (${tasks.length})` },
          { id: 'transcript', label: '📝 Transcript' },
        ].map(t => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── MOM tab ── */}
      {tab === 'mom' && (
        <div className="card tab-card">
          <div className="mom-section">
            <div className="section-title">Summary</div>
            <textarea
              className="editable-area"
              rows={3}
              value={mom.summary}
              onChange={e => updateMom('summary', e.target.value)}
            />
          </div>

          {mom.discussion_points?.length > 0 && (
            <div className="mom-section">
              <div className="section-title">Discussion Points</div>
              {mom.discussion_points.map((pt, i) => (
                <div key={i} className="list-row">
                  <span className="bullet">•</span>
                  <input
                    className="editable-line"
                    value={pt}
                    onChange={e => updateDiscussion(i, e.target.value)}
                  />
                </div>
              ))}
            </div>
          )}

          {mom.decisions?.length > 0 && (
            <div className="mom-section">
              <div className="section-title">Decisions Made</div>
              {mom.decisions.map((d, i) => (
                <div key={i} className="list-row">
                  <span className="bullet check">✓</span>
                  <input
                    className="editable-line"
                    value={d}
                    onChange={e => updateDecision(i, e.target.value)}
                  />
                </div>
              ))}
            </div>
          )}

          {mom.next_steps && (
            <div className="mom-section">
              <div className="section-title">Next Steps</div>
              <textarea
                className="editable-area"
                rows={2}
                value={mom.next_steps}
                onChange={e => updateMom('next_steps', e.target.value)}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Tasks tab ── */}
      {tab === 'tasks' && (
        <div className="card tab-card">
          {tasks.length === 0 ? (
            <p className="empty-state">No action items were identified in this meeting.</p>
          ) : (
            <div className="tasks-list">
              {tasks.map((task, i) => (
                <div key={i} className="task-item">
                  <div className="task-top">
                    <input
                      className="task-title-input"
                      value={task.title}
                      onChange={e => updateTask(i, 'title', e.target.value)}
                    />
                    <span className={`priority-badge ${PRIORITY_CLASS[task.priority] || 'badge-medium'}`}>
                      {task.priority}
                    </span>
                  </div>
                  <p className="task-desc">{task.description}</p>
                  <div className="task-meta">
                    <span>👤 {task.owner}</span>
                    <span>📅 {task.deadline}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Transcript tab ── */}
      {tab === 'transcript' && (
        <div className="card tab-card">
          <pre className="transcript-body">{transcript}</pre>
        </div>
      )}

      {/* ── Email panel ── */}
      <div className="email-panel">
        <div className="email-recipients">
          <span className="recipients-label">Recipients:</span>
          {recipients.length ? (
            recipients.map((a, i) => (
              <span key={i} className="chip">{a.name || a.email}</span>
            ))
          ) : (
            <span className="no-recipients">No email addresses set — go back to Setup to add them</span>
          )}
        </div>

        {emailError && <div className="banner banner-error" style={{ marginBottom: 14 }}>{emailError}</div>}

        {emailSent ? (
          <div className="banner banner-success">
            ✓ Minutes emailed successfully to {recipients.length} attendee{recipients.length !== 1 ? 's' : ''}!
          </div>
        ) : (
          <button
            className="btn-primary btn-full"
            onClick={sendEmail}
            disabled={emailSending || !recipients.length}
          >
            {emailSending ? 'Sending…' : '📧 Send MOM to attendees'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── App Shell ────────────────────────────────────────────────────────────────
export default function App() {
  const [step, setStep] = useState(0);

  const [meetingTitle, setMeetingTitle] = useState('');
  const [meetingDate, setMeetingDate] = useState(new Date().toISOString().slice(0, 10));
  const [attendees, setAttendees] = useState([{ name: '', email: '' }]);

  const [audioBlob, setAudioBlob] = useState(null);
  const [results, setResults] = useState(null);

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">
          <span className="logo-emoji">📋</span>
          <span className="logo-name">MeetingMind</span>
        </div>
        <StepIndicator current={step} />
      </header>

      <main className="app-main">
        {step === 0 && (
          <SetupStep
            meetingTitle={meetingTitle}
            setMeetingTitle={setMeetingTitle}
            meetingDate={meetingDate}
            setMeetingDate={setMeetingDate}
            attendees={attendees}
            setAttendees={setAttendees}
            onNext={() => setStep(1)}
          />
        )}

        {step === 1 && (
          <RecordStep
            meetingTitle={meetingTitle}
            meetingDate={meetingDate}
            onComplete={blob => { setAudioBlob(blob); setStep(2); }}
            onBack={() => setStep(0)}
          />
        )}

        {step === 2 && (
          <ProcessingStep
            audioBlob={audioBlob}
            meetingTitle={meetingTitle}
            meetingDate={meetingDate}
            attendees={attendees}
            onComplete={data => { setResults(data); setStep(3); }}
            onBack={() => setStep(1)}
          />
        )}

        {step === 3 && results && (
          <ReviewStep
            transcript={results.transcript}
            mom={results.mom}
            tasks={results.tasks}
            attendees={attendees}
            meetingTitle={meetingTitle}
            meetingDate={meetingDate}
          />
        )}
      </main>
    </div>
  );
}
