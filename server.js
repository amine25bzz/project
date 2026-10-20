const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const APPS_FILE = path.join(__dirname, 'apps.json');
const STATS_FILE = path.join(__dirname, 'stats.json');

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

app.get('/17041704', (req, res) => res.sendFile(path.join(__dirname, '17041704.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ─────────── stats.json : عدادات التحميل ─────────── */
function readStats() {
  try {
    const s = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    if (!s.downloads) s.downloads = {};
    if (!s.reviews) s.reviews = {};
    return s;
  } catch (e) {
    return { downloads: {}, reviews: {} };
  }
}

function writeStats(stats) {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf8');
  } catch (e) {
    console.error('[stats] write failed', e);
  }
}

/* ─────────── قراءة apps.json ─────────── */
function readAppsFile() {
  try {
    return JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
  } catch (e) {
    return { apps: [] };
  }
}

/* ─────────── GET /api/apps : يدمج العدادات الحقيقية ─────────── */
app.get('/api/apps', (req, res) => {
  const parsed = readAppsFile();
  const stats = readStats();
  (parsed.apps || []).forEach(app => {
    const key = String(app.id);
    const fromStats = Number(stats.downloads[key]);
    const fromApp = Number(app.downloads);
    app.downloads = Number.isFinite(fromStats) ? fromStats
                  : Number.isFinite(fromApp) ? fromApp
                  : 0;
    app.rating = Number(app.rating) || 0;
    app.reviews = Number(app.reviews) || 0;
  });
  res.set('Cache-Control', 'no-store');
  res.json(parsed);
});

/* ─────────── POST /api/apps : حفظ من لوحة التحكم ─────────── */
app.post('/api/apps', (req, res) => {
  const incoming = req.body.apps || [];
  const stats = readStats();
  const cleaned = incoming.map(a => {
    const copy = { ...a };
    const key = String(copy.id);
    const n = Number(copy.downloads);
    if (Number.isFinite(n)) stats.downloads[key] = n;
    copy.downloads = 0;
    return copy;
  });
  writeStats(stats);
  const payload = JSON.stringify({ apps: cleaned }, null, 2);
  fs.writeFile(APPS_FILE, payload, 'utf8', (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true });
  });
});

/* ─────────── طابور الكتابة الآمن ─────────── */
let writeChain = Promise.resolve();

function queuedAppEdit(id, mutator) {
  const run = writeChain.then(() => new Promise((resolve, reject) => {
    const data = readAppsFile();
    const app = (data.apps || []).find(a => String(a.id) === String(id));
    if (!app) return reject(Object.assign(new Error('App not found: id=' + id), { code: 404 }));
    try {
      mutator(app);
    } catch (e) {
      return reject(e);
    }
    fs.writeFile(APPS_FILE, JSON.stringify(data, null, 2), 'utf8', (err) => {
      if (err) return reject(err);
      resolve(app);
    });
  }));
  writeChain = run.catch(() => {});
  return run;
}

/* ─────────── POST /api/apps/:id/review ─────────── */
app.post('/api/apps/:id/review', (req, res) => {
  const idParam = String(req.params.id);
  const rating = parseFloat(req.body.rating);
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ ok: false, error: 'rating must be between 1 and 5' });
  }
  const name = (req.body.name || '').toString().trim().slice(0, 60) || 'Anonymous';
  const comment = (req.body.comment || '').toString().trim().slice(0, 500);
  console.log(`[review] app id=${idParam}, rating=${rating}`);

  queuedAppEdit(idParam, (app) => {
    const oldReviews = Number(app.reviews) || 0;
    const oldRating = Number(app.rating) || 0;
    const newReviews = oldReviews + 1;
    const newRating = ((oldRating * oldReviews) + rating) / newReviews;
    app.rating = Math.round(newRating * 10) / 10;
    app.reviews = newReviews;
    if (!Array.isArray(app.reviewsList)) app.reviewsList = [];
    app.reviewsList.unshift({ rating, name, comment, date: new Date().toISOString() });
    if (app.reviewsList.length > 100) app.reviewsList.length = 100;
  })
    .then(app => {
      console.log(`[review] OK — "${app.name}" now ${app.rating} (${app.reviews})`);
      res.json({ ok: true, app });
    })
    .catch(err => {
      console.error(`[review] FAILED id=${idParam}:`, err.message);
      res.status(err.code || 500).json({ ok: false, error: err.message });
    });
});

/* ─────────── POST /api/apps/:id/download : عداد في stats.json ─────────── */
app.post('/api/apps/:id/download', (req, res) => {
  const idParam = String(req.params.id);
  const stats = readStats();
  const current = Number(stats.downloads[idParam]) || 0;
  stats.downloads[idParam] = current + 1;
  writeStats(stats);
  console.log(`[download] app ${idParam} → ${stats.downloads[idParam]}`);
  res.json({ ok: true, downloads: stats.downloads[idParam] });
});

/* ─────────── GET /api/ping ─────────── */
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, message: 'server.js is running', time: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  console.error('[server error]', err);
  res.status(500).json({ ok: false, error: err.message });
});

app.listen(PORT, () => {
  console.log(`\n✅ DevStore server running`);
  console.log(`   Store:  http://localhost:${PORT}`);
  console.log(`   17041704:  http://localhost:${PORT}/17041704.html`);
  console.log(`   Health: http://localhost:${PORT}/api/ping\n`);
});