// server.js — clipr-worker (fast: per-clip range download + parallel processing)
import express from "express";
import crypto from "crypto";
import { spawn } from "child_process";
import { mkdtemp, rm, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const app = express();
const PORT = process.env.PORT || 10000;
const SECRET =
  process.env.CLIPPER_WORKER_SHARED_SECRET ||
  process.env.WORKER_SHARED_SECRET ||
  "";

// Capture raw body for HMAC verification
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

function verifySig(req) {
  if (!SECRET) return true; // dev only
  const sig =
    req.get("x-signature") ||
    req.get("x-shared-secret") ||
    req.get("x-worker-secret") ||
    (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!sig) return false;
  // Accept either HMAC-sha256(rawBody) or raw shared secret
  const hmac = crypto
    .createHmac("sha256", SECRET)
    .update(req.rawBody || "")
    .digest("hex");
  try {
    if (
      sig.length === hmac.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac))
    )
      return true;
  } catch {}
  try {
    if (
      sig.length === SECRET.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(SECRET))
    )
      return true;
  } catch {}
  return false;
}

function pexec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "",
      err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`));
    });
  });
}

function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(2);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(5, "0")}`;
}

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.post("/render", async (req, res) => {
  if (!verifySig(req)) {
    console.warn("[render] bad signature");
    return res.status(401).json({ error: "bad signature" });
  }

  const body = req.body || {};
  const source_url = body.source_url || body.sourceUrl;
  const upload = body.upload || {};
  const uploadUrl =
    upload.url ||
    upload.signed_upload_url ||
    body.upload_url ||
    body.signed_upload_url;
  const callback_url = body.callback_url || body.callbackUrl || body.webhook_url;
  const callback_secret = body.callback_secret || SECRET;
  const clipsInput = Array.isArray(body.clips)
    ? body.clips
    : body.clip_id
      ? [body]
      : [];

  if (!source_url || clipsInput.length === 0 || !uploadUrl) {
    return res
      .status(400)
      .json({ error: "missing source_url, clips[] or upload.url" });
  }

  // Respond immediately, process async
  res.status(202).json({ accepted: true, count: clipsInput.length });

  console.info(
    `[render] accepted ${clipsInput.length} clip(s) from ${source_url.slice(0, 80)}`
  );

  // Process all clips in parallel
  await Promise.all(
    clipsInput.map((c) => processClip({ clip: c, source_url, uploadUrl, callback_url, callback_secret }))
  );
});

async function processClip({ clip, source_url, uploadUrl, callback_url, callback_secret }) {
  const jobId = clip.job_id || clip.jobId || clip.id;
  const clipId = clip.clip_id || clip.clipId || clip.id;
  const start = Number(clip.start ?? clip.start_time_seconds ?? 0);
  const end = Number(clip.end ?? clip.end_time_seconds ?? start + 30);
  const duration = Math.max(1, end - start);
  const burnCaptions = !!clip.caption || !!clip.ass;

  const dir = await mkdtemp(path.join(tmpdir(), `clip-${clipId}-`));
  const src = path.join(dir, "src.mp4");
  const out = path.join(dir, "out.mp4");
  const started = Date.now();

  try {
    console.info(`[${clipId}] download range ${start}-${end}s`);
    // yt-dlp: download ONLY the needed seconds (with small padding for keyframes)
    const pad = 1.0;
    const sectionStart = Math.max(0, start - pad);
    const sectionEnd = end + pad;
    await pexec("yt-dlp", [
      "-f",
      "mp4/bv*+ba/best",
      "--download-sections",
      `*${sectionStart}-${sectionEnd}`,
      "--force-keyframes-at-cuts",
      "-o",
      src,
      "--no-playlist",
      "--no-warnings",
      "-q",
      source_url,
    ]);

    console.info(`[${clipId}] ffmpeg → 9:16 ${duration.toFixed(1)}s`);
    // Vertical 9:16 crop, re-encode only when needed
    const vf =
      "crop=ih*9/16:ih,scale=1080:1920:flags=lanczos" +
      (burnCaptions
        ? `,drawtext=text='${String(clip.caption || "").replace(/'/g, "\\'")}':fontsize=64:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h-th-160`
        : "");

    await pexec("ffmpeg", [
      "-y",
      "-ss",
      String(pad),
      "-i",
      src,
      "-t",
      String(duration),
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      out,
    ]);

    const buf = await readFile(out);
    const size = (await stat(out)).size;
    console.info(`[${clipId}] uploading ${(size / 1024 / 1024).toFixed(1)}MB`);

    const up = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "x-upsert": "true",
      },
      body: buf,
    });
    if (!up.ok) {
      const t = await up.text().catch(() => "");
      throw new Error(`upload ${up.status}: ${t.slice(0, 200)}`);
    }

    const took = ((Date.now() - started) / 1000).toFixed(1);
    console.info(`[${clipId}] done in ${took}s`);

    if (callback_url) {
      await sendCallback(callback_url, callback_secret, {
        job_id: jobId,
        clip_id: clipId,
        status: "done",
        duration_seconds: duration,
      });
    }
  } catch (err) {
    console.error(`[${clipId}] FAILED:`, err.message);
    if (callback_url) {
      await sendCallback(callback_url, callback_secret, {
        job_id: jobId,
        clip_id: clipId,
        status: "error",
        error: err.message.slice(0, 500),
      }).catch(() => {});
    }
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function sendCallback(url, secret, payload) {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-signature": sig,
      "x-worker-signature": sig,
      "x-webhook-signature": sig,
      "x-shared-secret": secret,
    },
    body,
  });
  console.info(`[callback] ${payload.clip_id} → ${res.status}`);
}

app.listen(PORT, () => console.log(`worker listening on ${PORT}`));
