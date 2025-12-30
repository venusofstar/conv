"use strict";

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");
const { pipeline, PassThrough } = require("stream");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(cors());
app.use(express.raw({ type: "*/*", limit: "50mb" }));

// =========================
// KEEP-ALIVE AGENTS
// =========================
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 500,
  maxFreeSockets: 100,
  keepAliveMsecs: 60000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 500,
  maxFreeSockets: 100,
  keepAliveMsecs: 60000
});

// =========================
// ORIGINS
// =========================
const ORIGINS = [
  "http://143.44.136.67:6060",
  "http://136.239.158.18:6610"
];

// =========================
// SESSION STORE
// =========================
const sessions = new Map();

function newSession(channelId) {
  return {
    idx: Math.floor(Math.random() * ORIGINS.length),
    startNumber: 46489952,
    IAS: "RR" + cryptoRandom(),
    userSession: cryptoRandom(15),
    ztecid: `ch0000009099000000${channelId}${Math.floor(1000 + Math.random() * 9000)}`,
    started: false,
    failCount: 0,
    lastFail: 0
  };
}

function getSession(channelId) {
  if (!sessions.has(channelId)) {
    sessions.set(channelId, newSession(channelId));
  }
  return sessions.get(channelId);
}

function rotate(session, hard = false) {
  session.idx = (session.idx + 1) % ORIGINS.length;
  if (hard) session.failCount = 0;
}

// cleanup
setInterval(() => sessions.clear(), 10 * 60 * 1000);

// =========================
// FAST FETCH WITH ROTATION
// =========================
async function fetchWithRotation(buildUrl, req, session) {
  const maxAttempts = ORIGINS.length;

  for (let i = 0; i < maxAttempts; i++) {
    const origin = ORIGINS[session.idx];
    const url = buildUrl(origin);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

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

      session.failCount = 0;
      return res;

    } catch (err) {
      clearTimeout(timeout);
      session.failCount++;
      session.lastFail = Date.now();
      rotate(session, true);
    }
  }

  throw new Error("ALL_ORIGINS_FAILED");
}

// =========================
// ROUTES
// =========================
app.get("/", (_, res) => res.send("OK"));

app.get("/:channelId/*", async (req, res) => {
  const { channelId } = req.params;
  const path = req.params[0];
  const session = getSession(channelId);

  const isMPD = path.endsWith(".mpd");

  if (!isMPD) {
    if (!session.started) session.started = true;
    session.startNumber += 6;
  }

  const auth =
    `JITPDRMType=Widevine&virtualDomain=001.live_hls.zte.com&m4s_min=1&NeedJITP=1&isjitp=0` +
    `&startNumber=${session.startNumber}&filedura=6&ispcode=55` +
    `&IASHttpSessionId=${session.IAS}&usersessionid=${session.userSession}&ztecid=${session.ztecid}`;

  try {
    const upstream = await fetchWithRotation(origin => {
      const base = `${origin}/001/2/ch0000009099000000${channelId}/`;
      return path.includes("?")
        ? `${base}${path}&${auth}`
        : `${base}${path}?${auth}`;
    }, req, session);

    // =========================
    // MPD REWRITE
    // =========================
    if (isMPD) {
      let mpd = await upstream.text();
      const proxyBase = `${req.protocol}://${req.get("host")}/${channelId}/`;

      mpd = mpd.replace(/<BaseURL>.*?<\/BaseURL>/gs, "");
      mpd = mpd.replace(/<MPD([^>]*)>/, `<MPD$1><BaseURL>${proxyBase}</BaseURL>`);

      res.set({
        "Content-Type": "application/dash+xml",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      });

      return res.end(mpd);
    }

    // =========================
    // SEGMENT STREAM
    // =========================
    res.set({
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Connection": "keep-alive"
    });

    const pass = new PassThrough();
    let lastData = Date.now();

    const stallWatch = setInterval(() => {
      if (Date.now() - lastData > 2500) {
        rotate(session, true);
        upstream.body.destroy();
      }
    }, 400);

    upstream.body.on("data", chunk => {
      lastData = Date.now();
      pass.write(chunk);
    });

    upstream.body.on("end", () => {
      clearInterval(stallWatch);
      pass.end();
    });

    upstream.body.on("error", () => {
      clearInterval(stallWatch);
      rotate(session, true);
      pass.end();
    });

    pipeline(pass, res, () => {});

  } catch (e) {
    res.status(502).end();
  }
});

// =========================
// START
// =========================
app.listen(PORT, () => {
  console.log(`🚀 Optimized DASH/HLS proxy on ${PORT}`);
});

// =========================
// UTILS
// =========================
function cryptoRandom(len = 12) {
  return Math.random().toString(36).slice(2, 2 + len) + Date.now();
}
