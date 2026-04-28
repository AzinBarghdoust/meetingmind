require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { AssemblyAI } = require('assemblyai');
const Groq = require('groq-sdk');
const fs = require('fs');

const app = express();
app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:4173'] }));
app.use(express.json({ limit: '10mb' }));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 },
});

const assembly = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── POST /api/transcribe ──────────────────────────────────────────────────────
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file received' });

  const mimeType = req.body.mimeType || 'audio/webm';
  const ext = mimeType.includes('mp4') || mimeType.includes('m4a') ? '.mp4'
    : mimeType.includes('ogg') ? '.ogg'
    : '.webm';

  const namedPath = req.file.path + ext;
  try {
    fs.renameSync(req.file.path, namedPath);

    // AssemblyAI handles upload + transcription + polling automatically
    const transcript = await assembly.transcripts.transcribe({
      audio: namedPath,
      speech_models: ['universal-2'],
    });

    fs.unlinkSync(namedPath);

    if (transcript.status === 'error') {
      throw new Error(transcript.error || 'Transcription failed');
    }

    res.json({ transcript: transcript.text });
  } catch (err) {
    console.error('[transcribe]', err.message);
    if (fs.existsSync(namedPath)) fs.unlinkSync(namedPath);
    else if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/generate-mom ────────────────────────────────────────────────────
app.post('/api/generate-mom', async (req, res) => {
  const { transcript, meetingTitle, date, attendees } = req.body;
  if (!transcript?.trim()) return res.status(400).json({ error: 'Transcript is required' });

  const attendeeNames = (attendees || []).map(a => a.name).filter(Boolean).join(', ') || 'Not specified';

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a professional meeting secretary. You produce concise, accurate meeting minutes from transcripts. Always respond with valid JSON only — no markdown, no code fences.',
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
      "owner": "Person name or TBD",
      "deadline": "Date or TBD",
      "priority": "High"
    }
  ]
}

Rules:
- discussion_points: 3-8 concise bullet points covering main topics discussed
- decisions: only include if a clear decision was made; empty array if none
- tasks: extract every action item mentioned; empty array if none
- priority: must be exactly "High", "Medium", or "Low"`,
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
app.post('/api/send-email', async (req, res) => {
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
            <td style="padding:12px 14px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;vertical-align:top">${t.owner}</td>
            <td style="padding:12px 14px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;vertical-align:top">${t.deadline}</td>
            <td style="padding:12px 14px;border-bottom:1px solid #f1f5f9;vertical-align:top">
              <span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;color:white;background:${PRIORITY_COLOR[t.priority] || '#94a3b8'}">${t.priority || 'N/A'}</span>
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

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:14px 14px 0 0;padding:36px 40px">
          <div style="font-size:13px;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Minutes of Meeting</div>
          <div style="font-size:26px;font-weight:700;color:white;margin-bottom:4px">📋 ${meetingTitle}</div>
          <div style="font-size:14px;color:rgba(255,255,255,0.8)">${date}</div>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:white;padding:36px 40px;border:1px solid #e2e8f0;border-top:none">

          <div style="margin-bottom:28px">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:10px">Attendees</div>
            <div>${attendeeChips}</div>
          </div>

          <div style="margin-bottom:28px">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:10px">Summary</div>
            <div style="background:#f8fafc;border-left:4px solid #6366f1;padding:16px;border-radius:0 8px 8px 0;font-size:14px;color:#334155;line-height:1.7">${mom.summary}</div>
          </div>

          ${discussionHtml ? `
          <div style="margin-bottom:28px">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:10px">Discussion Points</div>
            ${discussionHtml}
          </div>` : ''}

          ${decisionsHtml ? `
          <div style="margin-bottom:28px">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:10px">Decisions Made</div>
            ${decisionsHtml}
          </div>` : ''}

          ${mom.next_steps ? `
          <div style="margin-bottom:28px">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:10px">Next Steps</div>
            <p style="font-size:14px;color:#334155;margin:0">${mom.next_steps}</p>
          </div>` : ''}

          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:10px">Action Items</div>
            ${tasksHtml}
          </div>

        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;padding:16px 40px;text-align:center">
          <p style="margin:0;font-size:12px;color:#94a3b8">Generated by <strong style="color:#6366f1">MeetingMind</strong> · ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}</p>
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

    res.json({ success: true, sent: recipients.length });
  } catch (err) {
    console.error('[send-email]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`MeetingMind backend → http://localhost:${PORT}`));
