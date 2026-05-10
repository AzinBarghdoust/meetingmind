require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { AssemblyAI } = require('assemblyai');
const Groq = require('groq-sdk');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  process.env.FRONTEND_URL?.replace(/\/$/, ''),
].filter(Boolean);

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '10mb' }));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 },
});

// ── Database ──────────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'meetingmind.db');
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    email         TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    title       TEXT    NOT NULL,
    date        TEXT    NOT NULL,
    summary     TEXT,
    tasks       TEXT,
    recipients  TEXT,
    sent_at     TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ── AI clients ────────────────────────────────────────────────────────────────
const assembly = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token — please log in again' });
  }
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name?.trim())  return res.status(400).json({ error: 'Name is required' });
  if (!email?.trim()) return res.status(400).json({ error: 'Email is required' });
  if (!password)      return res.status(400).json({ error: 'Password is required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const emailLower = email.trim().toLowerCase();

  try {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(emailLower);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

    const hash = await bcrypt.hash(password, 12);
    let result;
    try {
      result = db.prepare(
        'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)'
      ).run(name.trim(), emailLower, hash);
    } catch (dbErr) {
      // SQLite UNIQUE constraint fires if two requests slip through simultaneously
      if (dbErr.message?.includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }
      throw dbErr;
    }

    const user = { id: result.lastInsertRowid, name: name.trim(), email: emailLower };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });

    const ts = new Date().toISOString();
    console.log(`[${ts}] 🆕 NEW USER  id=${user.id}  name="${user.name}"  email=${user.email}`);

    res.status(201).json({ token, user });
  } catch (err) {
    console.error('[register]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email?.trim()) return res.status(400).json({ error: 'Email is required' });
  if (!password)      return res.status(400).json({ error: 'Password is required' });

  try {
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
    if (!row) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const user = { id: row.id, name: row.name, email: row.email };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user });
  } catch (err) {
    console.error('[login]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/transcribe ──────────────────────────────────────────────────────
app.post('/api/transcribe', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file received' });

  const MAX_BYTES = 25 * 1024 * 1024; // 25 MB hard limit
  if (req.file.size > MAX_BYTES) {
    fs.unlinkSync(req.file.path);
    const mb = (req.file.size / 1024 / 1024).toFixed(1);
    return res.status(413).json({
      error: `Recording is ${mb} MB — the maximum is 25 MB (≈ 90 minutes). Please shorten your recording.`,
    });
  }

  const mimeType = req.body.mimeType || 'audio/webm';
  const ext = mimeType.includes('mp4') || mimeType.includes('m4a') ? '.mp4'
    : mimeType.includes('ogg') ? '.ogg'
    : '.webm';

  const namedPath = req.file.path + ext;
  try {
    fs.renameSync(req.file.path, namedPath);

    const langCode = req.body.language_code || 'en';

    const transcript = await assembly.transcripts.transcribe({
      audio: namedPath,
      speech_models: ['universal-2'],
      language_code: langCode,
    });

    fs.unlinkSync(namedPath);

    if (transcript.status === 'error') {
      throw new Error(transcript.error || 'Transcription failed');
    }

    res.json({ transcript: transcript.text, language_code: langCode });
  } catch (err) {
    console.error('[transcribe]', err.message);
    if (fs.existsSync(namedPath)) fs.unlinkSync(namedPath);
    else if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/generate-mom ────────────────────────────────────────────────────
app.post('/api/generate-mom', requireAuth, async (req, res) => {
  const { transcript, meetingTitle, date, attendees, language_code } = req.body;
  if (!transcript?.trim()) return res.status(400).json({ error: 'Transcript is required' });

  const languageName = new Intl.DisplayNames(['en'], { type: 'language' }).of(language_code || 'en');

  // ── Free plan: 3 MOM limit ───────────────────────────────────────────────
  const FREE_LIMIT = 3;
  const { count } = db.prepare('SELECT COUNT(*) as count FROM meetings WHERE user_id = ?').get(req.user.id);
  if (count >= FREE_LIMIT) {
    return res.status(403).json({
      error: `Free plan limit reached — you have used all ${FREE_LIMIT} of your free MOMs.`,
      limitReached: true,
    });
  }

  const attendeeNames = (attendees || []).map(a => a.name).filter(Boolean).join(', ') || 'Not specified';

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a professional meeting secretary. You produce concise, accurate meeting minutes from transcripts. Always respond with valid JSON only — no markdown, no code fences. IMPORTANT: Read the transcript and detect its language. Write every single field of your response (summary, discussion_points, decisions, next_steps, task titles, descriptions) in that EXACT same language. Do NOT translate anything — if the transcript is in English, respond in English; if French, respond in French; if Persian, respond in Persian. Mirror the language of the transcript precisely.`,
        },
        {
          role: 'user',
          content: `Analyze this meeting transcript and produce structured minutes.

Meeting: ${meetingTitle}
Date: ${date}
Attendees: ${attendeeNames}

TRANSCRIPT:
${transcript}

Respond with this exact JSON structure:
{
  "mom": {
    "summary": "2-3 sentence executive summary",
    "discussion_points": ["point 1", "point 2"],
    "decisions": ["decision 1"],
    "next_steps": "Brief next steps"
  },
  "tasks": [
    {
      "title": "Task title",
      "description": "What needs to be done",
      "owner": "Person name, or null if not mentioned",
      "deadline": "Exact date or timeframe spoken, or null if not mentioned",
      "priority": "High, Medium, or Low only if explicitly stated, or null if not mentioned"
    }
  ]
}

Rules:
- discussion_points: 3-8 concise bullet points covering main topics discussed
- decisions: only include if a clear decision was made; empty array if none
- tasks: extract every action item mentioned; empty array if none
- owner: use null if no person was assigned — do NOT guess or default to TBD
- deadline: use null if no date or timeframe was mentioned — do NOT invent one
- priority: use null if priority was never stated — do NOT assign a default`,
        },
      ],
    });

    let raw = completion.choices[0].message.content.trim();
    raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

    const result = JSON.parse(raw);
    if (!result.mom || !Array.isArray(result.tasks)) {
      throw new Error('Unexpected response structure from AI');
    }

    res.json(result);
  } catch (err) {
    console.error('[generate-mom]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/send-email ──────────────────────────────────────────────────────
app.post('/api/send-email', requireAuth, async (req, res) => {
  const { attendees, meetingTitle, date, mom, tasks } = req.body;

  const recipients = (attendees || []).filter(a => a.email?.includes('@'));
  if (!recipients.length) return res.status(400).json({ error: 'No valid recipient emails provided' });

  const PRIORITY_COLOR = { High: '#dc2626', Medium: '#d97706', Low: '#16a34a' };

  const tasksHtml = tasks?.length
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px">
        <thead>
          <tr style="background:#f1f5f9">
            <th style="padding:10px 14px;text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">TASK</th>
            <th style="padding:10px 14px;text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">OWNER</th>
            <th style="padding:10px 14px;text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">DEADLINE</th>
            <th style="padding:10px 14px;text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0">PRIORITY</th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map(t => `
          <tr>
            <td style="padding:12px 14px;border-bottom:1px solid #f1f5f9;vertical-align:top">
              <div style="font-weight:600;font-size:14px;color:#1e293b">${t.title}</div>
              <div style="font-size:13px;color:#64748b;margin-top:2px">${t.description}</div>
            </td>
            <td style="padding:12px 14px;border-bottom:1px solid #f1f5f9;font-size:14px;color:${t.owner ? '#334155' : '#94a3b8'};vertical-align:top">${t.owner || '—'}</td>
            <td style="padding:12px 14px;border-bottom:1px solid #f1f5f9;font-size:14px;color:${t.deadline ? '#334155' : '#94a3b8'};vertical-align:top">${t.deadline || '—'}</td>
            <td style="padding:12px 14px;border-bottom:1px solid #f1f5f9;vertical-align:top">
              ${t.priority
                ? `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;color:white;background:${PRIORITY_COLOR[t.priority] || '#94a3b8'}">${t.priority}</span>`
                : `<span style="color:#94a3b8;font-size:13px">—</span>`}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`
    : '<p style="color:#64748b;font-size:14px">No action items identified.</p>';

  const discussionHtml = mom.discussion_points?.length
    ? `<ul style="margin:0;padding-left:20px">${mom.discussion_points.map(p => `<li style="margin-bottom:6px;font-size:14px;color:#334155">${p}</li>`).join('')}</ul>`
    : '';

  const decisionsHtml = mom.decisions?.length
    ? `<ul style="margin:0;padding-left:20px">${mom.decisions.map(d => `<li style="margin-bottom:6px;font-size:14px;color:#334155">${d}</li>`).join('')}</ul>`
    : '';

  const attendeeChips = recipients.map(a =>
    `<span style="display:inline-block;background:#ede9fe;color:#6d28d9;padding:4px 12px;border-radius:999px;font-size:13px;margin:2px">${a.name || a.email}</span>`
  ).join('');

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px">
    <tr><td align="center">
      <table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%">
        <tr><td style="background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:14px 14px 0 0;padding:36px 40px">
          <div style="font-size:13px;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Minutes of Meeting</div>
          <div style="font-size:26px;font-weight:700;color:white;margin-bottom:4px">📋 ${meetingTitle}</div>
          <div style="font-size:14px;color:rgba(255,255,255,0.8)">${date}</div>
        </td></tr>
        <tr><td style="background:white;padding:36px 40px;border:1px solid #e2e8f0;border-top:none">
          <div style="margin-bottom:28px">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:10px">Attendees</div>
            <div>${attendeeChips}</div>
          </div>
          <div style="margin-bottom:28px">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:10px">Summary</div>
            <div style="background:#f8fafc;border-left:4px solid #6366f1;padding:16px;border-radius:0 8px 8px 0;font-size:14px;color:#334155;line-height:1.7">${mom.summary}</div>
          </div>
          ${discussionHtml ? `<div style="margin-bottom:28px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:10px">Discussion Points</div>${discussionHtml}</div>` : ''}
          ${decisionsHtml ? `<div style="margin-bottom:28px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:10px">Decisions Made</div>${decisionsHtml}</div>` : ''}
          ${mom.next_steps ? `<div style="margin-bottom:28px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:10px">Next Steps</div><p style="font-size:14px;color:#334155;margin:0">${mom.next_steps}</p></div>` : ''}
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:10px">Action Items</div>
            ${tasksHtml}
          </div>
        </td></tr>
        <tr><td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;padding:16px 40px;text-align:center">
          <p style="margin:0;font-size:12px;color:#94a3b8">Generated by <a href="https://meetingmind.net" style="color:#6366f1;font-weight:700;text-decoration:none">MeetingMind.net</a> · ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });

    await transporter.sendMail({
      from: `"MeetingMind" <${process.env.EMAIL_USER}>`,
      to: recipients.map(a => a.email).join(', '),
      subject: `[MOM] ${meetingTitle} — ${date}`,
      html: htmlBody,
    });

    // Save meeting log
    db.prepare(`
      INSERT INTO meetings (user_id, title, date, summary, tasks, recipients)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      meetingTitle,
      date,
      mom.summary,
      JSON.stringify(tasks || []),
      JSON.stringify(recipients)
    );

    const { count: used } = db.prepare('SELECT COUNT(*) as count FROM meetings WHERE user_id = ?').get(req.user.id);
    res.json({ success: true, sent: recipients.length, usage: { used, limit: 3, remaining: Math.max(0, 3 - used) } });
  } catch (err) {
    console.error('[send-email]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/usage ────────────────────────────────────────────────────────────
app.get('/api/usage', requireAuth, (req, res) => {
  const { count: used } = db.prepare('SELECT COUNT(*) as count FROM meetings WHERE user_id = ?').get(req.user.id);
  const limit = 3;
  res.json({ used, limit, remaining: Math.max(0, limit - used) });
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`MeetingMind backend → http://localhost:${PORT}`));
