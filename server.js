const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const http = require("http");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const ORIGINS = [
  "http://143.44.136.67:6060"
];

/* =========================
   HOME
========================= */
app.get("/", (_, res) => res.send("OK"));

/* =========================
   DASH PROXY (CLEAN)
========================= */
app.get("/:channelId/*", async (req, res) => {
  const { channelId } = req.params;
  const path = req.params[0];

  const isMPD = path.endsWith(".mpd");

  const origin = ORIGINS[0]; // fixed (no rotation)

  const baseUrl = `${origin}/001/2/ch0000009099000000${channelId}/${path}`;

  const upstreamUrl = isMPD
    ? `${baseUrl}?virtualDomain=001.live_hls.zte.com&JITPDRMType=Widevine&m4s_min=1`
    : baseUrl;

  try {
    const upstream = await fetch(upstreamUrl, {
      agent: upstreamUrl.startsWith("https") ? httpsAgent : httpAgent,
      headers: {
        "User-Agent": req.headers["user-agent"] || "OTT",
        "Accept": "*/*"
      }
    });

    if (!upstream.ok) {
      return res.sendStatus(upstream.status);
    }

    /* ===== MPD REWRITE ===== */
    if (isMPD) {
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

    /* ===== SEGMENTS ===== */
    res.set({
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });

    upstream.body.pipe(res);

  } catch (err) {
    console.error("Proxy error:", err.message);
    res.sendStatus(502);
  }
});

/* =========================
   START
========================= */
app.listen(PORT, () =>
  console.log(`✅ Clean DASH proxy running on ${PORT}`)
);
