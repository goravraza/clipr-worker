// server.js — Clipper worker (YouTube → FFmpeg 9:16 → Supabase upload → callback)
import express from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { spawn } from "child_process";
import fs from "fs";
import { mkdir, rm, stat } from "fs/promises";
import path from "path";
import os from "os";

const PORT = process.env.PORT || 10000;
const SHARED_SECRET = (process.env.WORKER_SHARED_SECRET || "").trim();

const SECRET_COOKIES_PATH =
  process.env.YOUTUBE_COOKIES_PATH || "/etc/secrets/youtube-cookies.txt";
const RUNTIME_COOKIES_PATH = "/tmp/youtube-cookies.txt";

function getWritableCookiesPath() {
  if (!fs.existsSync(SECRET_COOKIES_PATH)) return null;
  try {
    fs.copyFileSync(SECRET_COOKIES_PATH, RUNTIME_COOKIES_PATH);
    fs.chmodSync(RUNTIME_COOKIES_PATH, 0o600);
    return RUNTIME_COOKIES_PATH;
  } catch (err) {
    console.error("[boot] failed to copy cookies to /tmp", err);
    return null;
  }
}

const app = express();

// Capture raw body for HMAC verification
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);

function safeEqual(a, b) {
  const A = Buffer.from(a || "");
  const B = Buffer.from(b || "");
  return A.length === B.length && timingSafeEqual(A, B);
}

function verifyAuth(req) {
  if (!SHARED_SECRET) return false;
  const sig = req.header("x-signature") || "";
  const raw = req.rawBody || "";
  const expected = createHmac("sha256", SHARED_SECRET).update(raw).digest("hex");
  if (sig && safeEqual(sig, expected)) return true;

  const shared =
    req.header("x-shared-secret") ||
    req.header("x-worker-secret") ||
    (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  return safeEqual(shared, SHARED_SECRET);
}

app.get("/health", (req, res) => {
  if (!verifyAuth(req)) return res.status(200).json({ ok: true, auth: false });
  res.json({ ok: true, auth: true });
});

function runCmd(cmd, args, label) {
  return new Promise((resolve, reject) => {
    console.log(`[${label}] ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(`[${label}] ${d}`);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exit ${code}: ${stderr.trim().slice(-400)}`));
    });
  });
}

async function processClip(clip, common) {
  const { sourceUrl, callbackUrl, callbackSecret } = common;
  const clipId = clip.clip_id || clip.clipId || clip.id;
  const jobId = clip.job_id || clip.jobId || common.jobId;
  const start = Number(clip.start ?? clip.start_time_seconds ?? 0);
  const end = Number(clip.end ?? clip.end_time_seconds ?? 0);
  const storagePath = clip.storage_path || clip.storagePath || common.storagePath;
  const uploadUrl = clip.upload?.url || common.uploadUrl;

  const workDir = path.join(os.tmpdir(), `clip-${clipId}`);
  await mkdir(workDir, { recursive: true });
  const sourcePath = path.join(workDir, "src.mp4");
  const finalPath = path.join(workDir, "out.mp4");

  try {
    console.log(`[clip ${clipId}] download ${start}-${end}`);

    const cookiesPath = getWritableCookiesPath();
    const sourceTemplate = path.join(tmpDir, `${clipId}.%(ext)s`);

const args = [
  "--no-playlist",
  "--force-overwrites",
  "--no-warnings",

  // IMPORTANT: broad fallback, avoids "Requested format is not available"
  "-f", "bv*+ba/b",
  "-S", "res:720,fps,br",
  "--merge-output-format", "mkv",

  "--download-sections", `*${start}-${end}`,
  "-o", sourceTemplate,
];

if (cookiesPath) {
  args.push("--cookies", cookiesPath);
}

args.push(sourceUrl);

await run("yt-dlp", args);

// Find actual downloaded file because extension may be mp4/webm/mkv
const downloaded = fs
  .readdirSync(tmpDir)
  .map((name) => path.join(tmpDir, name))
  .find((file) => file.includes(clipId) && !file.endsWith(".part"));

if (!downloaded) {
  throw new Error(`yt-dlp finished but no downloaded source file found for ${clipId}`);
}

// Then pass `downloaded` into FFmpeg
await ffmpegCrop916(downloaded, finalPath);

    await runCmd("yt-dlp", ytdlpArgs, `clip ${clipId}`);

    console.log(`[clip ${clipId}] ffmpeg 9:16 crop`);
    await runCmd(
      "ffmpeg",
      [
        "-y",
        "-i", sourcePath,
        "-vf",
        "crop=ih*9/16:ih,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        finalPath,
      ],
      `clip ${clipId}`,
    );

    const stats = await stat(finalPath);
    console.log(`[clip ${clipId}] upload ${stats.size} bytes`);

    if (!uploadUrl) throw new Error("missing upload url");
    const fileBuf = fs.readFileSync(finalPath);
    const up = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: fileBuf,
    });
    if (!up.ok) {
      const txt = await up.text().catch(() => "");
      throw new Error(`upload ${up.status}: ${txt.slice(0, 200)}`);
    }

    await sendCallback(callbackUrl, callbackSecret, {
      job_id: jobId,
      clip_id: clipId,
      storage_path: storagePath,
      status: "done",
    });
  } catch (err) {
    console.error(`[clip ${clipId}] error:`, err.message);
    await sendCallback(callbackUrl, callbackSecret, {
      job_id: jobId,
      clip_id: clipId,
      storage_path: storagePath,
      status: "error",
      error: err.message?.slice(0, 400) || "unknown",
    }).catch(() => {});
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function sendCallback(url, secret, payload) {
  if (!url) return;
  const body = JSON.stringify(payload);
  const sig = createHmac("sha256", secret || SHARED_SECRET).update(body).digest("hex");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-signature": sig,
      "x-worker-secret": secret || SHARED_SECRET,
    },
    body,
  });
  console.log(`[callback] ${res.status} → ${url}`);
}

app.post("/render", async (req, res) => {
  if (!verifyAuth(req)) return res.status(401).json({ error: "unauthorized" });

  const body = req.body || {};
  const sourceUrl = body.source_url || body.sourceUrl;
  const callbackUrl = body.callback_url || body.callbackUrl || body.webhook_url || body.webhookUrl;
  const callbackSecret = body.callback_secret || body.callbackSecret || SHARED_SECRET;

  let clips = Array.isArray(body.clips) ? body.clips : null;
  if (!clips || clips.length === 0) {
    if (body.clip_id || body.clipId || body.id) {
      clips = [
        {
          job_id: body.job_id || body.jobId || body.id,
          clip_id: body.clip_id || body.clipId,
          start: body.start ?? body.start_time_seconds,
          end: body.end ?? body.end_time_seconds,
          storage_path: body.storage_path || body.storagePath,
          upload: body.upload,
        },
      ];
    }
  }

  if (!sourceUrl) return res.status(400).json({ error: "missing source_url" });
  if (!clips || clips.length === 0) return res.status(400).json({ error: "missing clips" });

  const common = {
    sourceUrl,
    callbackUrl,
    callbackSecret,
    jobId: body.job_id || body.jobId || body.id,
    storagePath: body.storage_path || body.storagePath,
    uploadUrl: body.upload?.url || body.upload_url || body.uploadUrl,
  };

  res.status(202).json({ accepted: true, count: clips.length });

  // Process in background (parallel)
  Promise.all(clips.map((c) => processClip(c, common))).catch((err) =>
    console.error("[render] batch error:", err),
  );
});

app.listen(PORT, () => {
  console.log(`[boot] worker listening on ${PORT}`);
  console.log(`[boot] tmp=${os.tmpdir()} secret_len=${SHARED_SECRET.length}`);
  console.log(`[boot] cookies secret: ${SECRET_COOKIES_PATH}`);
  console.log(`[boot] cookies runtime: ${getWritableCookiesPath() || "not found"}`);
});
