# 📋 MeetingMind

> **Record your meeting. Get the minutes. Email everyone. Automatically.**

MeetingMind is a full-stack web application that records audio from your browser, transcribes it using AI, generates structured Minutes of Meeting (MOM) and action items, then emails them to all attendees — in the language you spoke.

---

## ✨ Features

| Feature | Details |
|---|---|
| 🎙️ **Browser Recording** | One-click recording with live waveform visualisation |
| 🌍 **15 Languages** | English, French, Arabic, Persian, Chinese, and more |
| 📝 **AI Transcription** | AssemblyAI `universal-2` model |
| 🤖 **Smart MOM** | Groq (Llama 3.3 70B) extracts summary, decisions, discussion points, and tasks |
| 📧 **Auto Email** | Beautiful HTML email sent to all attendees via Gmail |
| ✅ **Task Extraction** | Owner, deadline, and priority — only when explicitly spoken |
| 🔐 **Auth** | Email/password signup & login with JWT (7-day sessions) |
| 📊 **Usage Limits** | Free plan: 3 MOMs per user |
| 🗃️ **Meeting Log** | Every sent MOM is saved to SQLite with recipients & summary |
| ⏱️ **90-min Guard** | Auto-stops recording at 90 minutes; 25 MB file size limit |

---

## 🛠 Tech Stack

### Backend
- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** SQLite (`better-sqlite3`)
- **Auth:** `bcryptjs` + `jsonwebtoken`
- **Transcription:** AssemblyAI SDK
- **MOM Generation:** Groq SDK (Llama 3.3 70B)
- **Email:** Nodemailer (Gmail SMTP)

### Frontend
- **Framework:** React 18
- **Build Tool:** Vite
- **Audio Recording:** Browser `MediaRecorder` API
- **Waveform:** Browser `Web Audio API`
- **HTTP:** Browser `fetch` API
- **Styling:** Plain CSS (no UI library)

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18+
- A free [AssemblyAI](https://www.assemblyai.com) account
- A free [Groq](https://console.groq.com) account
- A Gmail account with an [App Password](https://myaccount.google.com/apppasswords)

### 1. Clone the repo

```bash
git clone https://github.com/AzinBarghdoust/meetingmind.git
cd meetingmind
```

### 2. Install dependencies

```bash
npm run install:all
```

### 3. Configure environment variables

```bash
cp .env.example backend/.env
```

Edit `backend/.env`:

```env
# AssemblyAI — free tier: 100 hours/month
# https://www.assemblyai.com → Dashboard → API Keys
ASSEMBLYAI_API_KEY=your_assemblyai_key

# Groq — completely free with generous rate limits
# https://console.groq.com → API Keys
GROQ_API_KEY=gsk_your_groq_key

# Gmail — must use an App Password (not your regular password)
# https://myaccount.google.com/apppasswords
EMAIL_USER=you@gmail.com
EMAIL_PASS=xxxx xxxx xxxx xxxx

# Generate your own: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JWT_SECRET=your_random_secret_here

PORT=3001
```

### 4. Run the app

```bash
npm run dev
```

- Frontend → [http://localhost:5173](http://localhost:5173)
- Backend  → [http://localhost:3001](http://localhost:3001)

---

## 📱 How It Works

```
1. Setup      → Enter meeting title, date, language, and attendees
2. Record     → Click record — browser captures audio with live waveform
3. Processing → Audio uploaded → AssemblyAI transcribes → Groq generates MOM
4. Review     → Edit minutes and tasks, then send email to all attendees
```

### Data Flow

```
Browser mic
    │  MediaRecorder API (32 kbps, max 90 min / 25 MB)
    ▼
Audio Blob
    │  POST /api/transcribe  (multipart)
    ▼
AssemblyAI  ──────────────────────────────►  Transcript (text)
                                                    │
                                         POST /api/generate-mom
                                                    │
                                                    ▼
                                             Groq Llama 3.3
                                       (MOM + tasks as JSON)
                                                    │
                                         POST /api/send-email
                                                    │
                                            ┌───────┴────────┐
                                            ▼                ▼
                                      Gmail SMTP        SQLite log
                                   (attendee emails)   (meeting record)
```

---

## 🔌 API Reference

### Auth

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/auth/register` | `{ name, email, password }` | Create account |
| `POST` | `/api/auth/login` | `{ email, password }` | Sign in, get JWT |

### Meetings *(require `Authorization: Bearer <token>`)*

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/transcribe` | Upload audio → get transcript |
| `POST` | `/api/generate-mom` | Transcript → MOM + tasks JSON |
| `POST` | `/api/send-email` | Email MOM to attendees + log to DB |
| `GET`  | `/api/usage` | Get MOM usage count for current user |

---

## 🌍 Supported Languages

English · French · German · Spanish · Italian · Portuguese · Arabic · Persian · Chinese · Japanese · Korean · Russian · Turkish · Hindi · Dutch

---

## 📁 Project Structure

```
meetingmind/
├── backend/
│   ├── server.js          # Express app — all routes & business logic
│   ├── meetingmind.db     # SQLite database (auto-created, git-ignored)
│   ├── uploads/           # Temp audio files (auto-cleaned, git-ignored)
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx        # Entire React app (auth + 4-step wizard)
│   │   ├── index.css      # All styles
│   │   └── main.jsx       # React entry point
│   ├── index.html
│   └── package.json
├── .env.example           # Environment variable template
└── package.json           # Root — runs both servers with concurrently
```

---

## 🗄️ Database Schema

```sql
-- Users
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    UNIQUE NOT NULL,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    DEFAULT (datetime('now'))
);

-- Meeting log (saved after each email send)
CREATE TABLE meetings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  title       TEXT    NOT NULL,
  date        TEXT    NOT NULL,
  summary     TEXT,
  tasks       TEXT,   -- JSON array
  recipients  TEXT,   -- JSON array
  sent_at     TEXT    DEFAULT (datetime('now'))
);
```

---

## ⚙️ Free Tier Limits

| Service | Free Allowance |
|---|---|
| AssemblyAI | 100 hours / month |
| Groq (Llama 3.3) | ~14,400 requests / day |
| MeetingMind | 3 MOMs per user account |

---

## 📜 License

MIT — free to use, modify, and distribute.

---

<p align="center">
  Built with ❤️ · <a href="https://meetingmind.net">meetingmind.net</a>
</p>
