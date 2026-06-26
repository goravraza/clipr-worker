// server.js — Clipper worker (YouTube → FFmpeg 9:16 → Supabase upload → callback)
import express from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { spawn } from "child_process";
import { mkdir, rm, stat, copyFile, chmod } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";

const PORT = process.env.PORT || 10000;
const SHARED_SECRET = process.env.WORKER_SHARED_SECRET || process.env.CLIPPER_WORKER_SHARED_SECRET || "";
const SECRET_COOKIES_PATH = process.env.YOUTUBE_COOKIES_PATH || "/etc/secrets/youtube-cookies.txt";
const RUNTIME_COOKIES_PATH = "/tmp/youtube-cookies.txt";
const WORK_ROOT = "/tmp/clipper";

if (!SHARED_SECRET) {
  console.error("[boot] FATAL: WORKER_SHARED_SECRET is not set");
  process.exit(1);
}

const app = express();
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);

// ---------- cookies ----------
async function ensureWritableCookies() {
  if (!existsSync(SECRET_COOKIES_PATH)) return null;
  try {
    await copyFile(SECRET_COOKIES_PATH, RUNTIME_COOKIES_PATH);
    await chmod(RUNTIME_COOKIES_PATH, 0o600);
    return RUNTIME_COOKIES_PATH;
  } catch (e) {
    console.error("[boot] cookies copy failed:", e.message);
    return null;
  }
}
let COOKIES_PATH = null;
ensureWritableCookies().then((p) => {
  COOKIES_PATH = p;
  console.log("[boot] cookies:", p || "not provided");
});

// ---------- auth ----------
function safeEq(a, b) {
  const A = Buffer.from(a || ""), B = Buffer.from(b || "");
  return A.length === B.length && timingSafeEqual(A, B);
}
function authOk(req) {
  const sig = req.header("x-signature") || req.header("x-worker-signature") || "";
  const raw = req.header("x-shared-secret")
    || req.header("x-worker-secret")
    || (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  if (raw && safeEq(raw, SHARED_SECRET)) return true;
  if (sig && req.rawBody) {
    const exp = createHmac("sha256", SHARED_SECRET).update(req.rawBody).digest("hex");
    if (safeEq(sig, exp)) return true;
  }
  return false;
}

// ---------- helpers ----------
function run(cmd, args, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd} timeout`)); }, timeoutMs);
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} exit ${code}: ${err.slice(-800) || out.slice(-800)}`));
    });
  });
}

async function ytdlpDownload({ sourceUrl, start, end, outPath }) {
  // Pad 1s on each side so keyframes align cleanly.
  const padStart = Math.max(0, Number(start) - 1);
  const padEnd = Number(end) + 1;
 const ytdlpArgs = [
  "--no-warnings",
  "--no-playlist",
  "--no-cache-dir",

  // Important: avoid strict unavailable formats
  "-f",
  "bestvideo*+bestaudio/best",

  // Prefer mp4/1080p, but allow fallback if unavailable
  "-S",
  "res:1080,ext:mp4:m4a",

  "--merge-output-format",
  "mp4",

  "--download-sections",
  `*${start}-${end}`,

  "--force-keyframes-at-cuts",

 "-o", srcFile,   // ✅ use srcFile here
];

if (cookiesPath) {
  ytdlpArgs.push("--cookies", cookiesPath);
}

ytdlpArgs.push(sourceUrl);

  await run("yt-dlp", args, { timeoutMs: 12 * 60 * 1000 });
}

async function ffmpegCrop916({ inPath, outPath, start, end }) {
  const duration = Math.max(1, Number(end) - Number(start));
  // Re-cut from the padded download, then crop to 9:16 1080x1920 with blurred bg.
  const vf = [
    "split[base][bg]",
    "[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:1[bgblur]",
    "[base]scale=1080:-2[fg]",
    "[bgblur][fg]overlay=(W-w)/2:(H-h)/2,setsar=1",
  ].join(";");
  const args = [
    "-y",
    "-ss", "1",
    "-i", inPath,
    "-t", String(duration),
    "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outPath,
  ];
  await run("ffmpeg", args, { timeoutMs: 12 * 60 * 1000 });
}

async function uploadToSignedUrl(filePath, signedUrl) {
  const { readFile } = await import("fs/promises");
  const buf = await readFile(filePath);
  const r = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "x-upsert": "true" },
    body: buf,
  });
  if (!r.ok) throw new Error(`upload failed ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

async function postCallback(url, body) {
  const json = JSON.stringify(body);
  const sig = createHmac("sha256", SHARED_SECRET).update(json).digest("hex");
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-signature": sig,
      "x-shared-secret": SHARED_SECRET,
      "x-worker-secret": SHARED_SECRET,
      Authorization: `Bearer ${SHARED_SECRET}`,
    },
    body: json,
  });
  console.log(`[callback] ${url} -> ${r.status}`);
}

// ---------- pipeline ----------
async function processOne(clip, ctx) {
  const id = clip.clip_id || clip.clipId || clip.id || clip.job_id || clip.jobId;
  const start = clip.start ?? clip.start_time_seconds;
  const end = clip.end ?? clip.end_time_seconds;
  const workDir = path.join(WORK_ROOT, String(id));
  await mkdir(workDir, { recursive: true });
  const srcPath = path.join(workDir, "src.mp4");
  const outPath = path.join(workDir, "out.mp4");

  try {
    console.log(`[clip ${id}] download ${start}-${end}`);
    await ytdlpDownload({ sourceUrl: ctx.sourceUrl, start, end, outPath: srcPath });
    const s = await stat(srcPath);
    console.log(`[clip ${id}] downloaded ${(s.size / 1024 / 1024).toFixed(1)}MB`);

    console.log(`[clip ${id}] ffmpeg 9:16`);
    await ffmpegCrop916({ inPath: srcPath, outPath, start, end });

    console.log(`[clip ${id}] upload`);
    const uploadUrl = clip.upload?.url || clip.upload_url || ctx.uploadUrl;
    const storagePath = clip.storage_path || clip.storagePath || ctx.storagePath;
    if (!uploadUrl) throw new Error("missing upload url");
    await uploadToSignedUrl(outPath, uploadUrl);

    if (ctx.callbackUrl) {
      await postCallback(ctx.callbackUrl, {
        status: "done",
        job_id: clip.job_id || clip.jobId || ctx.jobId,
        clip_id: id,
        storage_path: storagePath,
      });
    }
    console.log(`[clip ${id}] done`);
  } catch (e) {
    console.error(`[clip ${id}] error:`, e.message);
    if (ctx.callbackUrl) {
      await postCallback(ctx.callbackUrl, {
        status: "error",
        job_id: clip.job_id || clip.jobId || ctx.jobId,
        clip_id: id,
        error: e.message.slice(0, 500),
      }).catch(() => {});
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- routes ----------
app.get("/health", (_req, res) => res.json({ ok: true, cookies: !!COOKIES_PATH, ts: Date.now() }));

app.post("/render", async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: "unauthorized" });
  const b = req.body || {};
  const sourceUrl = b.source_url || b.sourceUrl;
  if (!sourceUrl) return res.status(400).json({ error: "missing source_url" });

  const list = Array.isArray(b.clips) && b.clips.length
    ? b.clips
    : [{
        job_id: b.job_id || b.jobId,
        clip_id: b.clip_id || b.clipId,
        start: b.start ?? b.start_time_seconds,
        end: b.end ?? b.end_time_seconds,
        storage_path: b.storage_path || b.storagePath,
        upload: b.upload,
        upload_url: b.upload_url || b.uploadUrl,
      }];

  const ctx = {
    sourceUrl,
    callbackUrl: b.callback_url || b.callbackUrl || b.webhook_url || b.webhookUrl,
    uploadUrl: b.upload?.url || b.upload_url || b.uploadUrl,
    storagePath: b.storage_path || b.storagePath,
    jobId: b.job_id || b.jobId,
  };

  res.status(202).json({ accepted: true, count: list.length });

  // Fire-and-forget, parallel
  Promise.all(list.map((c) => processOne(c, ctx))).catch((e) =>
    console.error("[render] batch error:", e.message),
  );
});

app.listen(PORT, () => {
  console.log(`[boot] listening on ${PORT}`);
  console.log(`[boot] tmp=${os.tmpdir()} secret_len=${SHARED_SECRET.length}`);
});
