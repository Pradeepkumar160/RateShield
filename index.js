/**
 * ╔════════════════════════════════════════════════════╗
 * ║               🛡️  RateShield  🛡️                  ║
 * ║    Distributed Rate Limiter — Full Single File     ║
 * ║    Token Bucket + Sliding Window via Redis + Lua   ║
 * ║    Port: 6000                                      ║
 * ╚════════════════════════════════════════════════════╝
 *
 * Combined from:
 *  - Zip 1: app-single.js, server.js, app.js, api.js,
 *           redisClient.js, tokenBucket.js, slidingWindow.js,
 *           tokenBucket.lua, slidingWindow.lua
 *  - Zip 2: index.js (RateShield), package.json, .env,
 *           .gitignore, README.md
 */

const express = require("express");
const morgan  = require("morgan");
const redis   = require("redis");
const dotenv  = require("dotenv");

// ─── Load Environment Variables ───────────────────────────────────────────────
dotenv.config();

const app        = express();
const PORT       = process.env.PORT       || 6000;
const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = parseInt(process.env.REDIS_PORT) || 6379;

// ─── Redis Client Setup ───────────────────────────────────────────────────────
// Source: redisClient.js (Zip 1) + reconnect logic (Zip 2)
const redisClient = redis.createClient({
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT,
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error("❌ Redis: Too many reconnect attempts. Giving up.");
        return new Error("Too many retries");
      }
      return Math.min(retries * 100, 3000); // exponential backoff, max 3s
    },
  },
});

let redisReady = false;

redisClient.on("connect",      ()    => { console.log("✅ Connected to Redis");           redisReady = true;  });
redisClient.on("error",        (err) => { console.error("❌ Redis Error:", err.message);  redisReady = false; });
redisClient.on("reconnecting", ()    => { console.warn("🔄 Redis reconnecting...");        redisReady = false; });
redisClient.on("end",          ()    => { console.warn("⚠️  Redis connection closed");     redisReady = false; });

(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.error("❌ Failed to connect to Redis:", err.message);
    console.log("⚠️  Server will start — rate limiting requires Redis to be running.");
  }
})();

// ─── Lua Scripts ──────────────────────────────────────────────────────────────
// Source: tokenBucket.lua + slidingWindow.lua (Zip 1), refined in Zip 2

/**
 * TOKEN BUCKET — Lua Script (tokenBucket.lua)
 *
 * Algorithm:
 *  - Each IP gets a bucket with a max capacity of tokens.
 *  - Tokens refill at `refill_rate` tokens per second.
 *  - Each request consumes 1 token.
 *  - If no tokens remain → request is denied (429).
 *
 * Atomic: runs entirely inside Redis — no race conditions.
 */
const TOKEN_BUCKET_LUA = `
local key          = KEYS[1]
local capacity     = tonumber(ARGV[1])
local refill_rate  = tonumber(ARGV[2])
local current_time = tonumber(ARGV[3])
local requested    = tonumber(ARGV[4])

local bucket      = redis.call("HMGET", key, "tokens", "timestamp")
local tokens      = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

if tokens == nil then
    tokens      = capacity
    last_refill = current_time
end

local delta  = math.max(0, current_time - last_refill)
local refill = delta * refill_rate
tokens       = math.min(capacity, tokens + refill)

local allowed = tokens >= requested
if allowed then
    tokens = tokens - requested
end

redis.call("HMSET", key,
    "tokens",    tokens,
    "timestamp", current_time
)
redis.call("EXPIRE", key, 3600)

return { allowed and 1 or 0, tokens }
`;

/**
 * SLIDING WINDOW — Lua Script (slidingWindow.lua)
 *
 * Algorithm:
 *  - Uses a Redis sorted set to store request timestamps per IP.
 *  - On each request, removes timestamps older than the window.
 *  - Counts remaining entries — if >= limit → deny (429).
 *  - Unique member keys prevent ZADD collisions.
 *
 * Atomic: runs entirely inside Redis — no race conditions.
 */
const SLIDING_WINDOW_LUA = `
local key     = KEYS[1]
local window  = tonumber(ARGV[1])
local limit   = tonumber(ARGV[2])
local current = tonumber(ARGV[3])

redis.call("ZREMRANGEBYSCORE", key, 0, current - window)

local count = redis.call("ZCARD", key)

if count >= limit then
    return { 0, count }
end

redis.call("ZADD", key, current, current .. "-" .. math.random(1, 999999))
redis.call("EXPIRE", key, math.ceil(window / 1000))

return { 1, count + 1 }
`;

// ─── Middleware: Token Bucket ─────────────────────────────────────────────────
// Source: tokenBucket.js (Zip 1) + improvements from Zip 2
/**
 * @param {number} options.capacity   - Max tokens (default: 10)
 * @param {number} options.refillRate - Tokens/second (default: 1)
 */
const tokenBucketMiddleware = (options = {}) => {
  const capacity   = options.capacity   || 10;
  const refillRate = options.refillRate || 1;

  return async (req, res, next) => {
    if (!redisReady) {
      return res.status(503).json({
        success: false,
        message: "⚠️ Rate limiter unavailable: Redis not connected",
      });
    }

    try {
      const key    = `rateshield:tb:${req.ip}`;
      const result = await redisClient.eval(TOKEN_BUCKET_LUA, {
        keys: [key],
        arguments: [
          capacity.toString(),
          refillRate.toString(),
          (Date.now() / 1000).toString(),
          "1",
        ],
      });

      const allowed         = result[0] === 1;
      const remainingTokens = Math.floor(result[1]);

      res.setHeader("X-RateLimit-Limit",     capacity);
      res.setHeader("X-RateLimit-Remaining", remainingTokens);
      res.setHeader("X-RateLimit-Algorithm", "token-bucket");

      if (!allowed) {
        return res.status(429).json({
          success:    false,
          algorithm:  "token-bucket",
          message:    "🚫 Rate limit exceeded — tokens exhausted.",
          remaining:  0,
          retryAfter: Math.ceil(1 / refillRate),
        });
      }

      next();
    } catch (err) {
      console.error("TokenBucket error:", err.message);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  };
};

// ─── Middleware: Sliding Window ───────────────────────────────────────────────
// Source: slidingWindow.js (Zip 1) + improvements from Zip 2
/**
 * @param {number} options.windowSize - Window in ms (default: 60000)
 * @param {number} options.limit      - Max requests per window (default: 10)
 */
const slidingWindowMiddleware = (options = {}) => {
  const windowSize = options.windowSize || 60000;
  const limit      = options.limit      || 10;

  return async (req, res, next) => {
    if (!redisReady) {
      return res.status(503).json({
        success: false,
        message: "⚠️ Rate limiter unavailable: Redis not connected",
      });
    }

    try {
      const key    = `rateshield:sw:${req.ip}`;
      const result = await redisClient.eval(SLIDING_WINDOW_LUA, {
        keys: [key],
        arguments: [
          windowSize.toString(),
          limit.toString(),
          Date.now().toString(),
        ],
      });

      const allowed = result[0] === 1;
      const count   = result[1];

      res.setHeader("X-RateLimit-Limit",     limit);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, limit - count));
      res.setHeader("X-RateLimit-Algorithm", "sliding-window");
      res.setHeader("X-RateLimit-Window-Ms", windowSize);

      if (!allowed) {
        return res.status(429).json({
          success:       false,
          algorithm:     "sliding-window",
          message:       "🚫 Too many requests in the current window.",
          windowSeconds: windowSize / 1000,
          limit,
        });
      }

      next();
    } catch (err) {
      console.error("SlidingWindow error:", err.message);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  };
};

// ─── Express App Setup ────────────────────────────────────────────────────────
// Source: app.js (Zip 1) + Zip 2
app.use(express.json());
app.use(morgan("dev"));

// ─── Routes ───────────────────────────────────────────────────────────────────
// Source: api.js + app.js (Zip 1), expanded in Zip 2

// Home — Live Interactive Dashboard
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>🛡️ RateShield</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;padding:2rem}
    h1{font-size:2.5rem;text-align:center;color:#38bdf8;margin-bottom:.3rem}
    .subtitle{text-align:center;color:#94a3b8;margin-bottom:2rem;font-size:1rem}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;max-width:900px;margin:0 auto}
    .card{background:#1e293b;border-radius:12px;padding:1.5rem;border:1px solid #334155}
    .card h2{font-size:1.2rem;color:#7dd3fc;margin-bottom:.5rem}
    .card p{font-size:.88rem;color:#94a3b8;margin-bottom:1rem;line-height:1.6}
    button{background:#0ea5e9;color:#fff;border:none;padding:.6rem 1.2rem;border-radius:8px;cursor:pointer;font-size:.9rem;width:100%;transition:background .2s}
    button:hover{background:#0284c7}
    .result{margin-top:1rem;font-size:.82rem;background:#0f172a;border-radius:8px;padding:.8rem;white-space:pre-wrap;word-break:break-all;min-height:60px;color:#86efac;border:1px solid #1e3a5f}
    .result.error{color:#f87171}
    .badge{display:inline-block;background:#164e63;color:#38bdf8;font-size:.7rem;padding:.2rem .6rem;border-radius:999px;margin-bottom:.6rem}
    .status{text-align:center;margin-bottom:1.5rem}
    .status span{display:inline-block;padding:.3rem 1rem;border-radius:999px;font-size:.8rem}
    .online{background:#14532d;color:#86efac}
    .offline{background:#450a0a;color:#f87171}
    .section{max-width:900px;margin:1.5rem auto 0;background:#1e293b;border-radius:12px;padding:1.5rem;border:1px solid #334155}
    .section h2{color:#7dd3fc;margin-bottom:1rem}
    code{background:#0f172a;padding:.1rem .4rem;border-radius:4px;font-size:.85rem;color:#fbbf24}
    table{width:100%;border-collapse:collapse;font-size:.85rem}
    td,th{padding:.5rem .8rem;text-align:left;border-bottom:1px solid #334155}
    th{color:#94a3b8;font-weight:500}
    @media(max-width:600px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <h1>🛡️ RateShield</h1>
  <p class="subtitle">Distributed Rate Limiter &nbsp;·&nbsp; Redis + Lua &nbsp;·&nbsp; Token Bucket &amp; Sliding Window &nbsp;·&nbsp; Port ${PORT}</p>

  <div class="status" id="statusDiv"><span class="online">⬤ Checking Redis...</span></div>

  <div class="grid">
    <div class="card">
      <span class="badge">TOKEN BUCKET</span>
      <h2>🪣 Token Bucket</h2>
      <p>Capacity: 10 tokens · Refill: 1/sec<br/>Burst-friendly — smooth, flexible rate control.</p>
      <button onclick="hit('/api/token-bucket','r1')">Send Request</button>
      <div class="result" id="r1">Click to test →</div>
    </div>
    <div class="card">
      <span class="badge">SLIDING WINDOW</span>
      <h2>🪟 Sliding Window</h2>
      <p>Limit: 10 requests · Window: 60 sec<br/>Precise rolling-window request counting.</p>
      <button onclick="hit('/api/sliding-window','r2')">Send Request</button>
      <div class="result" id="r2">Click to test →</div>
    </div>
  </div>

  <div class="section">
    <h2>📡 API Endpoints</h2>
    <table>
      <tr><th>Method</th><th>Route</th><th>Description</th></tr>
      <tr><td>GET</td><td><code>/</code></td><td>This live dashboard</td></tr>
      <tr><td>GET</td><td><code>/api/health</code></td><td>Health check + Redis status</td></tr>
      <tr><td>GET</td><td><code>/api/token-bucket</code></td><td>Token Bucket rate limiter</td></tr>
      <tr><td>GET</td><td><code>/api/sliding-window</code></td><td>Sliding Window rate limiter</td></tr>
    </table>
  </div>

  <div class="section">
    <h2>📖 How It Works</h2>
    <table>
      <tr><th>Algorithm</th><th>Strategy</th><th>Best For</th></tr>
      <tr><td>🪣 Token Bucket</td><td>Tokens refill over time; burst allowed</td><td>APIs with occasional traffic spikes</td></tr>
      <tr><td>🪟 Sliding Window</td><td>Rolling time window with exact count</td><td>Strict per-window request limits</td></tr>
    </table>
  </div>

  <script>
    async function hit(url, id) {
      const el = document.getElementById(id);
      el.className = 'result';
      try {
        const res = await fetch(url);
        const headers = {};
        for (const [k,v] of res.headers) { if(k.startsWith('x-rate')) headers[k]=v; }
        const body = await res.json();
        el.textContent = JSON.stringify({ status: res.status, headers, body }, null, 2);
        if (res.status === 429) el.className = 'result error';
      } catch(e) {
        el.textContent = 'Error: ' + e.message;
        el.className = 'result error';
      }
    }
    async function checkHealth() {
      try {
        const res  = await fetch('/api/health');
        const data = await res.json();
        document.getElementById('statusDiv').innerHTML = data.redis === 'connected'
          ? '<span class="online">⬤ Redis Connected</span>'
          : '<span class="offline">⬤ Redis Disconnected — rate limiting inactive</span>';
      } catch(e) {}
    }
    checkHealth();
    setInterval(checkHealth, 10000);
  </script>
</body>
</html>`);
});

// Health Check — source: api.js (Zip 1) + Zip 2
app.get("/api/health", (req, res) => {
  res.json({
    success:   true,
    app:       "🛡️ RateShield",
    version:   "1.0.0",
    redis:     redisReady ? "connected" : "disconnected",
    port:      PORT,
    uptime:    `${Math.floor(process.uptime())}s`,
    timestamp: new Date().toISOString(),
  });
});

// Token Bucket Route — source: api.js + tokenBucket.js (Zip 1) + Zip 2
app.get(
  "/api/token-bucket",
  tokenBucketMiddleware({ capacity: 10, refillRate: 1 }),
  (req, res) => {
    res.json({
      success:   true,
      algorithm: "token-bucket",
      message:   "✅ Request allowed",
      remaining: res.getHeader("X-RateLimit-Remaining"),
    });
  }
);

// Sliding Window Route — source: api.js + slidingWindow.js (Zip 1) + Zip 2
app.get(
  "/api/sliding-window",
  slidingWindowMiddleware({ windowSize: 60000, limit: 10 }),
  (req, res) => {
    res.json({
      success:   true,
      algorithm: "sliding-window",
      message:   "✅ Request allowed",
      remaining: res.getHeader("X-RateLimit-Remaining"),
    });
  }
);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route '${req.path}' not found`,
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ success: false, message: "Internal server error" });
});

// ─── Start Server — source: server.js (Zip 1) + Zip 2 ────────────────────────
app.listen(PORT, () => {
  console.log(`\n🛡️  RateShield is running!`);
  console.log(`🌐  Dashboard:       http://localhost:${PORT}`);
  console.log(`🔗  Health:          http://localhost:${PORT}/api/health`);
  console.log(`🪣  Token Bucket:    http://localhost:${PORT}/api/token-bucket`);
  console.log(`🪟  Sliding Window:  http://localhost:${PORT}/api/sliding-window\n`);
});
