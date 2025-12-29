import express from "express";
import cors from "cors";
import http from "http";
import https from "https";
import { pipeline } from "stream/promises";

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(cors());
app.use(express.raw({ type: "*/*", limit: "20mb" }));

/* ============================
   KEEP-ALIVE AGENTS
============================ */
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 500,
  keepAliveMsecs: 30000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 500,
  keepAliveMsecs: 30000,
});

/* ============================
   ORIGINS
============================ */
const ORIGINS = [
  "http://143.44.136.67:6060",
];

/* ============================
   SESSION STORE (TTL)
============================ */
const sessions = new Map();
const SESSION_TTL = 10 * 60 * 1000;

function createSession(channelId) {
  return {
    origin: Math.floor(Math.random() * ORIGINS.length),
    startNumber: 46489952 + (Math.random() * 100000 | 0) * 6,
    IAS: `RR${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
    userSession: crypto.randomUUID(),
    ztecid: `ch0000009099000000${channelId}${Math.random() * 9000 | 0}`,
    ts: Date.now(),
  };
}

function getSession(channelId) {
  let s = sessions.get(channelId);
  if (!s || Date.now() - s.ts > SESSION_TTL) {
    s = createSession(channelId);
    sessions.set(channelId, s);
  }
  s.ts = Date.now();
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.ts > SESSION_TTL) sessions.delete(k);
  }
}, 60_000);

/* ============================
   ORIGIN ROTATION
============================ */
function rotate(session) {
  session.origin = (session.origin + 1) % ORIGINS.length;
}

/* ============================
   FETCH WITH RETRIES
============================ */
async function fetchSticky(buildUrl, req, session) {
  let delay = 200;

  for (let i = 0; i < ORIGINS.length; i++) {
    const origin = ORIGINS[session.origin];
    const url = buildUrl(origin);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      const res = await fetch(url, {
        agent: url.startsWith("https") ? httpsAgent : httpAgent,
        signal: controller.signal,
        headers: {
          "User-Agent": req.headers["user-agent"] || "OTT",
          "Accept": req.headers["accept"] || "*/*",
          "Range": req.headers["range"],
          "Connection": "keep-alive",
        },
      });

      clearTimeout(timeout);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;

    } catch (err) {
      clearTimeout(timeout);
      rotate(session);
      await new Promise(r => setTimeout(r, delay));
      delay *= 1.5;
    }
  }

  throw new Error("All origins failed");
}

/* ============================
   ROUTES
============================ */
app.get("/", (_, res) => res.send("Enjoy your life"));

app.get("/:channelId/*", async (req, res) => {
  const { channelId } = req.params;
  const path = req.params[0];
  const session = getSession(channelId);

  const auth =
    `JITPDRMType=Widevine` +
    `&virtualDomain=001.live_hls.zte.com` +
    `&m4s_min=1&NeedJITP=1&isjitp=0` +
    `&startNumber=${session.startNumber}` +
    `&filedura=6&ispcode=55` +
    `&IASHttpSessionId=${session.IAS}` +
    `&usersessionid=${session.userSession}` +
    `&ztecid=${session.ztecid}`;

  try {
    const upstream = await fetchSticky(origin => {
      const base = `${origin}/001/2/ch0000009099000000${channelId}/`;
      return path.includes("?")
        ? `${base}${path}&${auth}`
        : `${base}${path}?${auth}`;
    }, req, session);

    /* ===== MPD ===== */
    if (path.endsWith(".mpd")) {
      let mpd = await upstream.text();
      const base = `${req.protocol}://${req.get("host")}/${channelId}/`;

      mpd = mpd
        .replace(/<BaseURL>.*?<\/BaseURL>/gs, "")
        .replace(/<MPD([^>]*)>/, `<MPD$1><BaseURL>${base}</BaseURL>`);

      res.set({
        "Content-Type": "application/dash+xml",
        "Cache-Control": "no-store",
      });

      return res.send(mpd);
    }

    /* ===== SEGMENTS ===== */
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    await pipeline(upstream.body, res);

  } catch (err) {
    console.error("Proxy error:", err.message);
    res.sendStatus(502);
  }
});

/* ============================
   START
============================ */
app.listen(PORT, () =>
  console.log(`✅ Optimized DASH/HLS proxy running on ${PORT}`)
);
