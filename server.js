const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const archiver = require('archiver');
const { execFile } = require('child_process');
const QRCode   = require('qrcode');

const { S3Client, GetObjectCommand, DeleteObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app  = express();
const PORT = process.env.PORT || 3333;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Data dirs (DATA_DIR env var for Railway persistent volume) ─────────────────
const DATA_DIR     = process.env.DATA_DIR || __dirname;
const CAPTURES_DIR = path.join(DATA_DIR, 'captures');
const CHUNKS_DIR   = path.join(DATA_DIR, 'chunks');
[CAPTURES_DIR, CHUNKS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function getSessionDir(s) {
  const d = path.join(CAPTURES_DIR, s);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

// ── R2 — supports both r2.config.json (local) and env vars (cloud) ────────────
let r2 = null, r2cfg = null;

function loadR2() {
  // Prefer env vars (Railway / Vercel)
  if (process.env.R2_ACCOUNT_ID && !process.env.R2_ACCOUNT_ID.startsWith('TVOJE')) {
    r2cfg = {
      accountId:       process.env.R2_ACCOUNT_ID,
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      bucketName:      process.env.R2_BUCKET_NAME || 'head-capture',
    };
  } else {
    // Fallback to local file
    const cfgPath = path.join(__dirname, 'r2.config.json');
    if (!fs.existsSync(cfgPath)) return;
    try {
      r2cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (!r2cfg.accountId || r2cfg.accountId.startsWith('TVOJE')) {
        console.log('⚠️  Vyplň r2.config.json nebo nastav env vars R2_*');
        return;
      }
    } catch (e) { console.error('R2 config parse error:', e.message); return; }
  }

  r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${r2cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: r2cfg.accessKeyId, secretAccessKey: r2cfg.secretAccessKey },
  });
  console.log('✅ R2 připojen — bucket:', r2cfg.bucketName);
}
loadR2();

// ── Job tracking ──────────────────────────────────────────────────────────────
const jobs = {};

function initJob(session) {
  if (!jobs[session]) jobs[session] = {
    v1: { status: 'idle', frames: 0 },
    v2: { status: 'idle', frames: 0 },
    v3: { status: 'idle', frames: 0 },
  };
}
function setVJob(session, v, update) {
  initJob(session);
  jobs[session][v] = { ...jobs[session][v], ...update };
}

app.get('/jobs/:session', (req, res) => {
  initJob(req.params.session);
  const j = jobs[req.params.session];
  const totalFrames = ['v1','v2','v3'].reduce((s, k) => s + (j[k]?.frames || 0), 0);
  res.json({ ...j, totalFrames });
});

// ── Network ───────────────────────────────────────────────────────────────────
function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces()).flat())
    if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  return 'localhost';
}

// Public URL: prefer RAILWAY_PUBLIC_DOMAIN / APP_URL env, else local IP
function getPublicBase(req) {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.APP_URL) return process.env.APP_URL;
  // Use request host if available (works behind proxy)
  const host = req?.headers?.host;
  if (host && !host.startsWith('localhost') && !host.startsWith('127.')) return `https://${host}`;
  return `http://${getLocalIP()}:${PORT}`;
}

// ── QR ────────────────────────────────────────────────────────────────────────
app.get('/qr', async (req, res) => {
  const base = getPublicBase(req);
  const url  = `${base}/upload.html`;
  try {
    const qr = await QRCode.toDataURL(url, { width: 300, margin: 2, color: { dark: '#6c63ff', light: '#0d0d0f' } });
    res.json({ qr, url, r2Ready: !!r2 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── R2 presigned PUT ──────────────────────────────────────────────────────────
app.get('/r2/presign', async (req, res) => {
  if (!r2) return res.status(503).json({ error: 'R2 není nakonfigurován' });
  const { session, filename = 'video.mp4', videoNum = '1' } = req.query;
  if (!session) return res.status(400).json({ error: 'Chybí session' });

  const key = `sessions/${session}/v${videoNum}_${Date.now()}_${filename}`;
  try {
    const url = await getSignedUrl(r2, new PutObjectCommand({ Bucket: r2cfg.bucketName, Key: key }), { expiresIn: 7200 });
    setVJob(session, `v${videoNum}`, { status: 'idle', key, frames: 0, error: null });
    res.json({ url, key });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── R2 process ────────────────────────────────────────────────────────────────
app.post('/r2/process', async (req, res) => {
  const { session, key, fps = '1', videoNum = '1' } = req.body;
  if (!session || !key) return res.status(400).json({ error: 'Chybí session nebo key' });
  if (!r2) return res.status(503).json({ error: 'R2 není nakonfigurován' });

  setVJob(session, `v${videoNum}`, { status: 'downloading', frames: 0, error: null });
  res.json({ status: 'processing' });
  processR2Video(session, key, fps, videoNum);
});

async function processR2Video(session, key, fps, videoNum) {
  const v          = `v${videoNum}`;
  const sessionDir = getSessionDir(session);
  const videoPath  = path.join(sessionDir, `source_v${videoNum}.mp4`);

  try {
    // Download
    console.log(`⬇️  [${session}] v${videoNum}…`);
    const obj = await r2.send(new GetObjectCommand({ Bucket: r2cfg.bucketName, Key: key }));
    await streamToFile(obj.Body, videoPath);

    // Extract frames
    setVJob(session, v, { status: 'extracting' });
    const pattern = path.join(sessionDir, `v${videoNum}_frame_%04d.jpg`);
    await extractFrames(videoPath, pattern, fps);

    const frames = fs.readdirSync(sessionDir).filter(f => f.startsWith(`v${videoNum}_frame_`)).length;
    setVJob(session, v, { status: 'done', frames });
    console.log(`✅ [${session}] v${videoNum}: ${frames} snímků`);

    // Delete video from R2
    await r2.send(new DeleteObjectCommand({ Bucket: r2cfg.bucketName, Key: key }));
    // Delete local video to save disk (keep frames)
    fs.unlinkSync(videoPath);
  } catch (e) {
    console.error(`❌ [${session}] v${videoNum}:`, e.message);
    setVJob(session, v, { status: 'error', error: e.message });
  }
}

function streamToFile(stream, dest) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    stream.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
}

function extractFrames(videoPath, pattern, fps) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-i', videoPath, '-vf', `fps=${fps}`, '-q:v', '2', pattern], (err) => {
      err ? reject(err) : resolve();
    });
  });
}

// ── Local chunked upload (WiFi fallback) ──────────────────────────────────────
const chunkUpload = multer({ dest: CHUNKS_DIR });

app.post('/upload/chunk', chunkUpload.single('chunk'), (req, res) => {
  const { session, chunkIndex, videoNum = '1' } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No chunk' });
  fs.renameSync(req.file.path, path.join(CHUNKS_DIR, `${session}_v${videoNum}_${chunkIndex}`));
  res.json({ received: parseInt(chunkIndex) });
});

app.post('/upload/assemble', async (req, res) => {
  const { session, totalChunks, filename, fps = '1', videoNum = '1' } = req.body;
  const v          = `v${videoNum}`;
  const sessionDir = getSessionDir(session);
  const ext        = path.extname(filename || '.mp4') || '.mp4';
  const videoPath  = path.join(sessionDir, `source_v${videoNum}${ext}`);

  const ws = fs.createWriteStream(videoPath);
  for (let i = 0; i < totalChunks; i++) {
    const cp = path.join(CHUNKS_DIR, `${session}_v${videoNum}_${i}`);
    if (!fs.existsSync(cp)) return res.status(400).json({ error: `Chybí chunk ${i}` });
    ws.write(fs.readFileSync(cp));
    fs.unlinkSync(cp);
  }
  ws.end();
  await new Promise(r => ws.on('finish', r));

  setVJob(session, v, { status: 'extracting', frames: 0, error: null });

  const pattern = path.join(sessionDir, `v${videoNum}_frame_%04d.jpg`);
  execFile('ffmpeg', ['-i', videoPath, '-vf', `fps=${fps}`, '-q:v', '2', pattern], (err) => {
    if (err) {
      setVJob(session, v, { status: 'error', error: err.message });
      return res.status(500).json({ error: 'ffmpeg selhal', detail: err.message });
    }
    const frames = fs.readdirSync(sessionDir).filter(f => f.startsWith(`v${videoNum}_frame_`)).length;
    setVJob(session, v, { status: 'done', frames });
    const total = ['v1','v2','v3'].reduce((s,k) => s + (jobs[session]?.[k]?.frames || 0), 0);
    // Remove local video to save space
    try { fs.unlinkSync(videoPath); } catch {}
    res.json({ session, frames, totalFrames: total, dir: sessionDir });
  });
});

// ── Download session as ZIP ───────────────────────────────────────────────────
app.get('/sessions/:session/download', (req, res) => {
  const sessionDir = getSessionDir(req.params.session);
  const files      = fs.readdirSync(sessionDir).filter(f => /frame_\d+\.jpg$/.test(f)).sort();

  if (!files.length) return res.status(404).json({ error: 'Žádné snímky nenalezeny' });

  const zipName = `${req.params.session}_frames.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 1 } }); // level 1 = fast (JPEGs don't compress much)
  archive.pipe(res);

  files.forEach(f => {
    archive.file(path.join(sessionDir, f), { name: f });
  });

  archive.finalize();
  archive.on('error', err => { console.error('ZIP error:', err); });
});

// ── Sessions ──────────────────────────────────────────────────────────────────
app.get('/sessions', (req, res) => {
  if (!fs.existsSync(CAPTURES_DIR)) return res.json([]);
  const sessions = fs.readdirSync(CAPTURES_DIR)
    .filter(f => fs.statSync(path.join(CAPTURES_DIR, f)).isDirectory())
    .map(name => ({
      name,
      frames: fs.readdirSync(path.join(CAPTURES_DIR, name)).filter(f => /frame_\d+\.jpg$/.test(f)).length,
    }));
  res.json(sessions);
});

app.get('/sessions/:session', (req, res) => {
  const dir   = getSessionDir(req.params.session);
  const files = fs.readdirSync(dir).filter(f => /frame_\d+\.jpg$/.test(f)).sort();
  res.json({ session: req.params.session, frames: files.length, dir, files });
});

app.use('/captures', express.static(CAPTURES_DIR));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const isCloud = !!(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.APP_URL);
  console.log(`\n🎭 Head Capture — ${isCloud ? '☁️  cloud' : '💻 lokální'} režim`);
  if (isCloud) {
    console.log(`   URL: https://${process.env.RAILWAY_PUBLIC_DOMAIN || process.env.APP_URL}`);
  } else {
    const ip = getLocalIP();
    console.log(`   PC:    http://localhost:${PORT}`);
    console.log(`   Mobil: http://${ip}:${PORT}/upload.html\n`);
  }
});
