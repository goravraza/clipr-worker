import express from "express";
import crypto from "crypto";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({
  limit: "10mb",
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

const PORT = process.env.PORT || 10000;
const SECRET =
  process.env.CLIPPER_WORKER_SHARED_SECRET ||
  process.env.WORKER_SHARED_SECRET ||
  "";
const COOKIES_PATH = fs.existsSync("/etc/secrets/youtube-cookies.txt")
  ? "/etc/secrets/youtube-cookies.txt"
  : (fs.existsSync("/etc/secrets/cookies.txt") ? "/etc/secrets/cookies.txt" : null);

console.log("[boot] secret configured:", SECRET ? "yes" : "NO");
console.log("[boot] cookies file:", COOKIES_PATH || "NONE (YouTube will block)");

function verifySig(req) {
  if (!SECRET) return true;
  const sig =
    req.header("x-signature") ||
    req.header("x-worker-signature") ||
    req.header("x-webhook-signature") ||
    "";
  if (!sig || !req.rawBody) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(req.rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch { return false; }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[exec] ${cmd} ${args.join(" ")}`);
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stderr = "";
    p.stdout.on("data", d => process.stdout.write(d));
    p.stderr.on("data", d => { stderr += d.toString(); process.stderr.write(d); });
    p.on("close", code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`)));
  });
}

app.get("/health", (_req, res) => res.json({ ok: true, cookies: !!COOKIES_PATH }));

app.post("/render", async (req, res) => {
  if (!verifySig(req)) {
    console.warn("[render] bad signature");
    return res.status(401).json({ error: "bad signature" });
  }

  const body = req.body || {};
  const sourceUrl = body.source_url || body.sourceUrl || body.url;
  const callbackUrl = body.callback_url || body.callbackUrl || body.webhook;
  const upload = body.upload || {};
  const uploadUrl = upload.url || body.signed_upload_url;
  const storagePath = upload.path || body.storage_path;
  let clips = body.clips || (body.clip ? [body.clip] : []);
  if (!Array.isArray(clips)) clips = [clips];

  if (!sourceUrl) return res.status(400).json({ error: "missing source_url" });
  if (!clips.length) return res.status(400).json({ error: "missing clips" });

  console.log(`[render] accepted ${clips.length} clip(s) from ${sourceUrl}`);
  res.status(202).json({ accepted: true, count: clips.length });

  // process in background
  processClips({ sourceUrl, clips, uploadUrl, storagePath, callbackUrl, body })
    .catch(err => console.error("[render] fatal", err));
});

async function processClips({ sourceUrl, clips, uploadUrl, storagePath, callbackUrl, body }) {
  await Promise.all(clips.map((clip, i) => processOne({ sourceUrl, clip, idx: i, uploadUrl, storagePath, callbackUrl, body })));
}

async function processOne({ sourceUrl, clip, idx, uploadUrl, storagePath, callbackUrl, body }) {
  const start = Number(clip.start_time_seconds ?? clip.start ?? 0);
  const end = Number(clip.end_time_seconds ?? clip.end ?? start + 30);
  const duration = Math.max(1, end - start);
  const clipId = clip.id || clip.clip_id || `clip-${idx}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `clip-${clipId}-`));
  const srcFile = path.join(tmp, "src.mp4");
  const outFile = path.join(tmp, "out.mp4");
  const t0 = Date.now();

  try {
    // 1. Download ONLY the clip range
    const ytArgs = [
      "--no-warnings",
      "--no-playlist",
      "-f", "bv*[height<=1080]+ba/b[height<=1080]/best",
      "--merge-output-format", "mp4",
      "--download-sections", `*${start}-${end}`,
      "--force-keyframes-at-cuts",
      "-o", srcFile,
    ];
    if (COOKIES_PATH) ytArgs.push("--cookies", COOKIES_PATH);
    ytArgs.push(sourceUrl);

    await run("yt-dlp", ytArgs);

    // 2. Crop to 9:16 + re-encode fast
    await run("ffmpeg", [
      "-y",
      "-i", srcFile,
      "-t", String(duration),
      "-vf", "crop=ih*9/16:ih,scale=1080:1920",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      outFile,
    ]);

    // 3. Upload
    const buf = fs.readFileSync(outFile);
    const finalPath = (storagePath || `clips/${clipId}.mp4`).replace(/^clips\//, "");

    if (uploadUrl) {
      const r = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4", "x-upsert": "true" },
        body: buf,
      });
      if (!r.ok) throw new Error(`upload failed ${r.status}: ${await r.text()}`);
    } else if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { error } = await sb.storage.from("clips").upload(finalPath, buf, {
        contentType: "video/mp4", upsert: true,
      });
      if (error) throw error;
    } else {
      throw new Error("no upload destination");
    }

    const ms = Date.now() - t0;
    console.log(`[clip ${clipId}] done in ${ms}ms`);

    await postback(callbackUrl, {
      status: "completed",
      clip_id: clipId,
      job_id: body.job_id,
      storage_path: `clips/${finalPath}`,
      duration_ms: ms,
    });
  } catch (err) {
    console.error(`[clip ${clipId}] failed:`, err.message);
    await postback(callbackUrl, {
      status: "error",
      clip_id: clipId,
      job_id: body.job_id,
      error: err.message,
    });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function postback(url, payload) {
  if (!url) return;
  try {
    const body = JSON.stringify(payload);
    const sig = SECRET ? crypto.createHmac("sha256", SECRET).update(body).digest("hex") : "";
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": sig,
        "x-worker-signature": sig,
      },
      body,
    });
    console.log(`[postback] ${url} -> ${r.status}`);
  } catch (e) {
    console.error("[postback] failed", e.message);
  }
}

app.listen(PORT, () => console.log(`[boot] listening on ${PORT}`));
