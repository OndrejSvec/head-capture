const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const crypto   = require('crypto');
const archiver = require('archiver');
const { execFile } = require('child_process');
const QRCode   = require('qrcode');

const { S3Client, GetObjectCommand, DeleteObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app  = express();
const PORT = process.env.PORT || 3333;

// Secret pro upload — bez něj nelze nahrát video
// Nastav jako env var UPLOAD_SECRET na Railway
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || null;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Data dirs ─────────────────────────────────────────────────────────────────
const DATA_DIR     = process.env.DATA_DIR || __dirname;
const CAPTURES_DIR = path.join(DATA_DIR, 'captures');
const CHUNKS_DIR   = path.join(DATA_DIR, 'chunks');
[CAPTURES_DIR, CHUNKS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function getSessionDir(s) {
  const d = path.join(CAPTURES_DIR, s);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

// ── R2 ────────────────────────────────────────────────────────────────────────
let r2 = null, r2cfg = null;

function loadR2() {
  if (process.env.R2_ACCOUNT_ID && !process.env.R2_ACCOUNT_ID.startsWith('TVOJE')) {
    r2cfg = {
      accountId:       process.env.R2_ACCOUNT_ID,
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      bucketName:      process.env.R2_BUCKET_NAME || 'head-capture',
    };
  } else {
    const cfgPath = path.join(__dirname, 'r2.config.json');
    if (!fs.existsSync(cfgPath)) return;
    try {
      r2cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (!r2cfg.accountId || r2cfg.accountId.startsWith('TVOJE')) { console.log('⚠️  Vyplň r2.config.json'); return; }
    } catch (e) { console.error('R2 config error:', e.message); return; }
  }
  r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${r2cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: r2cfg.accessKeyId, secretAccessKey: r2cfg.secretAccessKey },
  });
  console.log('✅ R2:', r2cfg.bucketName);
}
loadR2();

// ── Session registry ──────────────────────────────────────────────────────────
// Mapa sessionId (UUID) → { label, createdAt, token }
// Token = UPLOAD_SECRET (nebo náhodný pokud není nastaven)
const sessions = {};

function createSession(label) {
  const id    = crypto.randomUUID();
  const token = UPLOAD_SECRET || crypto.randomBytes(8).toString('hex');
  sessions[id] = { id, label: label || id.slice(0, 8), createdAt: Date.now(), token };
  return sessions[id];
}

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
  if (!UPLOAD_SECRET) return next(); // Vypnuto pokud není nastaven secret
  const token = req.query.secret || req.body?.secret || req.headers['x-upload-secret'];
  if (token !== UPLOAD_SECRET) return res.status(401).json({ error: 'Neplatný přístupový kód' });
  next();
}

// ── Job tracking ──────────────────────────────────────────────────────────────
const jobs = {};
function initJob(session) {
  if (!jobs[session]) jobs[session] = { v1: { status:'idle', frames:0 }, v2: { status:'idle', frames:0 }, v3: { status:'idle', frames:0 } };
}
function setVJob(session, v, update) {
  initJob(session);
  jobs[session][v] = { ...jobs[session][v], ...update };
}

app.get('/jobs/:session', (req, res) => {
  initJob(req.params.session);
  const j = jobs[req.params.session];
  const totalFrames = ['v1','v2','v3'].reduce((s,k) => s + (j[k]?.frames||0), 0);
  res.json({ ...j, totalFrames });
});

// ── Public URL ────────────────────────────────────────────────────────────────
function getPublicBase(req) {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.APP_URL) return process.env.APP_URL;
  const host = req?.headers?.host;
  if (host && !host.startsWith('localhost') && !host.startsWith('127.')) return `https://${host}`;
  const ifaces = os.networkInterfaces();
  for (const i of Object.values(ifaces).flat()) if (i.family === 'IPv4' && !i.internal) return `http://${i.address}:${PORT}`;
  return `http://localhost:${PORT}`;
}

// ── QR — vygeneruje unikátní link s embedded secret ──────────────────────────
app.get('/qr', async (req, res) => {
  const base = getPublicBase(req);
  const sess = createSession(req.query.label || '');
  // URL obsahuje session ID + secret → QR funguje jako jednorázový přístup
  const params = new URLSearchParams({ session: sess.id });
  if (UPLOAD_SECRET) params.set('secret', UPLOAD_SECRET);
  const url = `${base}/upload.html?${params}`;

  try {
    const qr = await QRCode.toDataURL(url, { width: 300, margin: 2, color: { dark: '#6c63ff', light: '#0d0d0f' } });
    res.json({ qr, url, sessionId: sess.id, r2Ready: !!r2 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── R2 presigned PUT ──────────────────────────────────────────────────────────
app.get('/r2/presign', requireSecret, async (req, res) => {
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
app.post('/r2/process', requireSecret, async (req, res) => {
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
    setVJob(session, v, { status: 'downloading' });
    const obj = await r2.send(new GetObjectCommand({ Bucket: r2cfg.bucketName, Key: key }));
    await streamToFile(obj.Body, videoPath);

    setVJob(session, v, { status: 'extracting' });
    const pattern = path.join(sessionDir, `v${videoNum}_frame_%04d.jpg`);
    await extractFrames(videoPath, pattern, fps);

    const frames = fs.readdirSync(sessionDir).filter(f => f.startsWith(`v${videoNum}_frame_`)).length;
    setVJob(session, v, { status: 'done', frames });
    console.log(`✅ [${session.slice(0,8)}] v${videoNum}: ${frames} snímků`);

    await r2.send(new DeleteObjectCommand({ Bucket: r2cfg.bucketName, Key: key }));
    try { fs.unlinkSync(videoPath); } catch {}
  } catch (e) {
    console.error(`❌ v${videoNum}:`, e.message);
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
    execFile('ffmpeg', ['-i', videoPath, '-vf', `fps=${fps}`, '-q:v', '2', pattern], err => err ? reject(err) : resolve());
  });
}

// ── Local chunked upload (WiFi fallback) ──────────────────────────────────────
const chunkUpload = multer({ dest: CHUNKS_DIR });

app.post('/upload/chunk', requireSecret, chunkUpload.single('chunk'), (req, res) => {
  const { session, chunkIndex, videoNum = '1' } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No chunk' });
  fs.renameSync(req.file.path, path.join(CHUNKS_DIR, `${session}_v${videoNum}_${chunkIndex}`));
  res.json({ received: parseInt(chunkIndex) });
});

app.post('/upload/assemble', requireSecret, async (req, res) => {
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
    if (err) { setVJob(session, v, { status: 'error', error: err.message }); return res.status(500).json({ error: 'ffmpeg selhal' }); }
    const frames = fs.readdirSync(sessionDir).filter(f => f.startsWith(`v${videoNum}_frame_`)).length;
    setVJob(session, v, { status: 'done', frames });
    try { fs.unlinkSync(videoPath); } catch {}
    const total = ['v1','v2','v3'].reduce((s,k) => s + (jobs[session]?.[k]?.frames||0), 0);
    res.json({ session, frames, totalFrames: total });
  });
});

// ── Download ZIP ──────────────────────────────────────────────────────────────
app.get('/sessions/:session/download', (req, res) => {
  const sessionDir = getSessionDir(req.params.session);
  const files      = fs.readdirSync(sessionDir).filter(f => /frame_\d+\.jpg$/.test(f)).sort();
  if (!files.length) return res.status(404).json({ error: 'Žádné snímky' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.session.slice(0,8)}_frames.zip"`);

  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.pipe(res);
  files.forEach(f => archive.file(path.join(sessionDir, f), { name: f }));
  archive.finalize();
});

// ── Sessions (PC dashboard) ───────────────────────────────────────────────────
app.get('/sessions', (req, res) => {
  if (!fs.existsSync(CAPTURES_DIR)) return res.json([]);
  const list = fs.readdirSync(CAPTURES_DIR)
    .filter(f => fs.statSync(path.join(CAPTURES_DIR, f)).isDirectory())
    .map(name => ({ name, frames: fs.readdirSync(path.join(CAPTURES_DIR, name)).filter(f => /frame_\d+\.jpg$/.test(f)).length }));
  res.json(list);
});

app.get('/sessions/:session', (req, res) => {
  const dir   = getSessionDir(req.params.session);
  const files = fs.readdirSync(dir).filter(f => /frame_\d+\.jpg$/.test(f)).sort();
  res.json({ session: req.params.session, frames: files.length, files });
});

// NEPOSKYTUJ statický přístup k /captures přes veřejný URL
// Snímky jsou dostupné jen přes /sessions/:session/download (ZIP)

// ── Auto-delete sessions starší než 24h ──────────────────────────────────────
function cleanupOldSessions() {
  if (!fs.existsSync(CAPTURES_DIR)) return;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  fs.readdirSync(CAPTURES_DIR).forEach(name => {
    const dir  = path.join(CAPTURES_DIR, name);
    const stat = fs.statSync(dir);
    if (stat.isDirectory() && stat.mtimeMs < cutoff) {
      fs.rmSync(dir, { recursive: true, force: true });
      delete jobs[name];
      console.log(`🗑  Auto-delete: ${name.slice(0,8)}… (>24h)`);
    }
  });
}
// Spusť cleanup každou hodinu
setInterval(cleanupOldSessions, 60 * 60 * 1000);
cleanupOldSessions(); // Spusť hned při startu

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const isCloud = !!(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.APP_URL);
  const base    = isCloud ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN || process.env.APP_URL}` : `http://localhost:${PORT}`;
  console.log(`\n🎭 Head Capture — ${isCloud ? '☁️  Railway' : '💻 lokální'}`);
  console.log(`   ${base}`);
  if (UPLOAD_SECRET) console.log(`   🔒 Upload secret: nastaven`);
  else               console.log(`   ⚠️  UPLOAD_SECRET není nastaven — upload je otevřený`);
  console.log();
});
