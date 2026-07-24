# 🛡️ RateShield. 

> **Distributed Rate Limiting — done right. One file. Zero compromise.**

RateShield is a production-ready, single-file rate limiter built with **Node.js**, **Redis**, and **Lua scripts**. It implements two battle-tested algorithms — **Token Bucket** and **Sliding Window** — with atomic Redis operations and a live web dashboard.

---

## ✨ Features

| Feature | Details |
|---|---|
| 🪣 Token Bucket | Smooth rate limiting with burst support |
| 🪟 Sliding Window | Precise per-window request counting |
| ⚛️ Atomic Lua Scripts | Race-condition-free Redis operations |
| 🌐 Live Dashboard | Built-in HTML UI to test endpoints in browser |
| 🔁 Auto-reconnect | Redis reconnect with exponential backoff |
| 🛡️ Redis Guard | Returns 503 gracefully if Redis goes down |
| 📦 Single File | Everything in `index.js` — no folder mess |
| 📊 Rate Limit Headers | `X-RateLimit-Limit`, `Remaining`, `Algorithm` on every response |

---

## 🚀 Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) v18+
- [Redis](https://redis.io/) running locally (default: `127.0.0.1:6379`)

### 1. Install dependencies
```bash
npm install
```

### 2. Start Redis (separate terminal)
```bash
redis-server
```

### 3. Start RateShield
```bash
npm start
```

Open **http://localhost:6000** 🎉

---

## 📡 API Endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/` | Interactive live dashboard |
| `GET` | `/api/health` | Health check + Redis status |
| `GET` | `/api/token-bucket` | Token Bucket (10 tokens, refill 1/sec) |
| `GET` | `/api/sliding-window` | Sliding Window (10 req per 60s) |

### Response Headers
Every rate-limited response includes:
```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 7
X-RateLimit-Algorithm: token-bucket
```

### Rate Limit Exceeded — 429
```json
{
  "success": false,
  "algorithm": "token-bucket",
  "message": "🚫 Rate limit exceeded — tokens exhausted.",
  "remaining": 0,
  "retryAfter": 1
}
```

### Health Check Response
```json
{
  "success": true,
  "app": "🛡️ RateShield",
  "version": "1.0.0",
  "redis": "connected",
  "port": 6000,
  "uptime": "42s",
  "timestamp": "2026-05-14T07:00:00.000Z"
}
```

---

## 🧠 How It Works

### 🪣 Token Bucket
Each IP gets a "bucket" with a maximum capacity of tokens (default: 10). One token is consumed per request. Tokens refill at a set rate (default: 1/second). When the bucket is empty → `429 Too Many Requests`.

**Best for:** APIs that need to allow short bursts while maintaining average rate limits.

### 🪟 Sliding Window
All requests within a rolling time window (default: 60 seconds) are tracked using a Redis sorted set. If request count exceeds the limit → `429 Too Many Requests`. Old entries are cleaned up automatically.

**Best for:** Strict per-window request limits with no burst tolerance.

### ⚛️ Why Lua Scripts?
Both algorithms run as **atomic Lua scripts inside Redis**. This means:
- No race conditions under heavy concurrent load
- No need for distributed locks
- Single round-trip to Redis per request

---

## 🛠️ Run on Windows (PowerShell)

```powershell
# Step 1 — Install Redis (one-time, needs Chocolatey)
choco install redis-64 -y

# Step 2 — Start Redis in a separate PowerShell window
redis-server

# Step 3 — Install and run RateShield
cd path\to\RateShield
npm install
npm start
```

Then open: **http://localhost:6000**

---

## ⚙️ Configuration

Edit `.env` to customize:

```env
PORT=6000
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
```

---

## 📁 Project Structure

```
RateShield/
├── index.js        ← Full app — all code in one file
├── package.json    ← Dependencies & scripts
├── .env            ← Environment config (PORT=6000)
├── .gitignore      ← Excludes node_modules, .env, logs
└── README.md       ← This file
```

---

## 🚀 Deploy to GitHub

```powershell
cd path\to\RateShield
git init
git add .
git commit -m "🛡️ Initial commit — RateShield distributed rate limiter"
git remote add origin https://github.com/YOUR_USERNAME/RateShield.git
git branch -M main
git push -u origin main
```

---

## 📄 License

MIT — free to use, modify, and distribute.

---

<p align="center">Built with ❤️ using Node.js · Express · Redis · Lua</p>
