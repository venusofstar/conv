"use strict";

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");
const { pipeline } = require("stream");

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   EXPRESS OPTIMIZATION
========================= */
app.disable("x-powered-by");
app.use(cors({ origin: "*" }));
app.use(express.raw({ type: "*/*", limit: "50mb" }));

/* =========================
   KEEP-ALIVE AGENTS
========================= */
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 500,
  maxFreeSockets: 100,
  keepAliveMsecs: 60000,
  timeout: 15000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 500,
  maxFreeSockets: 100,
  keepAliveMsecs: 60000,
  timeout: 15000
});

/* =========================
   ORIGINS
========================= */
const ORIGINS = [
  "http://136.239.158.18:6610",
  "http://136.239.158.20:6610",
  "http://136.239.158.30:6610",
  "http://136.239.173.3:6610",
  "http://136.158.97.2:6610",
  "http://136.239.173.10:6610",
  "http://136.239.158.10:6610",
  "http://136.239.159.20:6610"
];

/* =========================
   SESSION STORE (STICKY)
========================= */
const channelSessions = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

function createSession() {
  return {
    originIndex: Math.floor(Math.random() * ORIGINS.length),
    startNumber: 46489952 + Math.floor(Math.random() * 100000) * 6,
    IAS: "RR" + Date.now() + Math.random().toString(36).slice(2, 10),
    userSession: Math.floor(Math.random() * 1e15).toString(),
    lastAccess: Date.now()
  };
}

function getSession(channelId) {
  let session = channelSessions.get(channelId);
  if (!session) {
    session = createSession();
    channelSessions.set(channelId, session);
  }
  session.lastAccess = Date.now();
  return session;
}

function rotateOrigin(session) {
  session.originIndex = (session.originIndex + 1) % ORIGINS.length;
}

/* cleanup expired sessions */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of channelSessions.entries()) {
    if (now - v.lastAccess > SESSION_TTL) {
      channelSessions.delete(k);
    }
  }
}, 5 * 60 * 1000);

/* =========================
   FETCH WITH FAILOVER
========================= */
async function fetchSticky(buildUrl, req, session) {
  for (let i = 0; i < ORIGINS.length; i++) {
    const origin = ORIGINS[session.originIndex];
    const url = buildUrl(origin);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      const res = await fetch(url, {
        agent: url.startsWith("https") ? httpsAgent : httpAgent,
        signal: controller.signal,
        headers: {
          "User-Agent": req.headers["user-agent"] || "OTT",
          "Accept": "*/*",
          "Connection": "keep-alive"
        }
      });

      clearTimeout(timeout);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;

    } catch (e) {
      clearTimeout(timeout);
      rotateOrigin(session);
    }
  }
  throw new Error("All origins failed");
}

/* =========================
   HOME
========================= */
app.get("/", (_, res) => {
  res.send("✅ DASH Reverse Proxy – Optimized");
});

/* =========================
   DASH HANDLER
========================= */
app.get("/:channelId/*", async (req, res) => {
  const { channelId } = req.params;
  const path = req.params[0];
  const session = getSession(channelId);

  const auth =
    `JITPDRMType=Widevine` +
    `&virtualDomain=001.live_hls.zte.com` +
    `&m4s_min=1` +
    `&NeedJITP=1` +
    `&isjitp=0` +
    `&startNumber=${session.startNumber}` +
    `&filedura=6` +
    `&ispcode=55` +
    `&IASHttpSessionId=${session.IAS}` +
    `&usersessionid=${session.userSession}`;

  try {
    const upstream = await fetchSticky(origin => {
      const base = `${origin}/001/2/ch0000009099000000${channelId}/`;
      return path.includes("?")
        ? `${base}${path}&${auth}`
        : `${base}${path}?${auth}`;
    }, req, session);

    /* =========================
       MPD
    ========================= */
    if (path.endsWith(".mpd")) {
      let mpd = await upstream.text();
      const proxyBase = `${req.protocol}://${req.get("host")}/${channelId}/`;

      mpd = mpd.replace(/<BaseURL>.*?<\/BaseURL>/gs, "");
      mpd = mpd.replace(
        /<MPD([^>]*)>/,
        `<MPD$1><BaseURL>${proxyBase}</BaseURL>`
      );

      res.set({
        "Content-Type": "application/dash+xml",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      });

      return res.end(mpd);
    }

    /* =========================
       SEGMENTS (TRUE STREAM)
    ========================= */
    res.set({
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Connection": "keep-alive"
    });

    let lastChunk = Date.now();
    const STALL_LIMIT = 5000;

    const stallWatch = setInterval(() => {
      if (Date.now() - lastChunk > STALL_LIMIT) {
        rotateOrigin(session);
        upstream.body.destroy();
        res.destroy();
      }
    }, 1000);

    upstream.body.on("data", () => {
      lastChunk = Date.now();
    });

    pipeline(upstream.body, res, () => {
      clearInterval(stallWatch);
    });

  } catch (err) {
    res.status(502).end();
  }
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`✅ Optimized DASH proxy running on ${PORT}`);
});
