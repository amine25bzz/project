require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
// دعم البورت من متغيرات البيئة (مهم لـ Vercel والتشغيل السحابي) مع جعل 5000 كقيمة افتراضية
const PORT = process.env.PORT || 5000;

const APPS_FILE = path.join(__dirname, 'apps.json');
const STATS_FILE = path.join(__dirname, 'stats.json');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'linkapp';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'linkapppro';

// إدارة الاتصال المتكرر بـ MongoDB (مناسب لبيئة Serverless على Vercel)
let cachedClient = null;
let cachedDb = null;
let appsCollection = null;

async function getCollection() {
  if (appsCollection) return appsCollection;
  if (!MONGODB_URI || MONGODB_URI.trim() === '' || MONGODB_URI.includes('<username>')) {
    return null;
  }

  try {
    if (!cachedClient) {
      cachedClient = new MongoClient(MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
      });
      await cachedClient.connect();
      cachedDb = cachedClient.db(DB_NAME);
      console.log(`✅ [MongoDB] متصل بنجاح! قاعدة البيانات: ${DB_NAME} | المجموعة: ${COLLECTION_NAME}`);
    }
    appsCollection = cachedDb.collection(COLLECTION_NAME);
    return appsCollection;
  } catch (err) {
    console.error('❌ [MongoDB] خطأ في الاتصال:', err.message);
    return null;
  }
}

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// وسيط للتأكد من جاهزية الاتصال بقاعدة البيانات قبل معالجة الطلبات
app.use(async (req, res, next) => {
  if (!appsCollection) {
    await getCollection();
  }
  next();
});

app.get('/17041704', (req, res) => res.sendFile(path.join(__dirname, '17041704.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ─────────── دوال الملفات المحلية (احتياطية عند عدم توفر MongoDB) ─────────── */
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

function readAppsFile() {
  try {
    return JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
  } catch (e) {
    return { apps: [] };
  }
}

/* ─────────── GET /api/apps : جلب البيانات من MongoDB ─────────── */
app.get('/api/apps', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  if (appsCollection) {
    try {
      const apps = await appsCollection.find({}, { projection: { _id: 0 } }).toArray();
      apps.forEach(app => {
        app.downloads = Number(app.downloads) || 0;
        app.rating = Number(app.rating) || 0;
        app.reviews = Number(app.reviews) || 0;
      });
      return res.json({ apps });
    } catch (err) {
      console.error('[GET /api/apps] خطأ أثناء القراءة من MongoDB:', err);
    }
  }

  // وضع احتياطي (البيانات المحلية)
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
  res.json(parsed);
});

/* ─────────── POST /api/apps : حفظ من لوحة التحكم في MongoDB ─────────── */
app.post('/api/apps', async (req, res) => {
  const incoming = req.body.apps || [];
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ ok: false, error: 'apps must be an array' });
  }

  if (appsCollection) {
    try {
      const cleaned = incoming.map(a => {
        const copy = { ...a };
        delete copy._id;
        copy.id = Number(copy.id) || copy.id;
        copy.downloads = Number(copy.downloads) || 0;
        copy.rating = Number(copy.rating) || 0;
        copy.reviews = Number(copy.reviews) || 0;
        if (!Array.isArray(copy.reviewsList)) copy.reviewsList = [];
        return copy;
      });

      await appsCollection.deleteMany({});
      if (cleaned.length > 0) {
        await appsCollection.insertMany(cleaned);
      }

      // محاولة حفظ نسخة احتياطية في apps.json
      try {
        fs.writeFile(APPS_FILE, JSON.stringify({ apps: cleaned }, null, 2), 'utf8', () => {});
      } catch (e) {}

      return res.json({ ok: true, source: 'mongodb' });
    } catch (err) {
      console.error('[POST /api/apps] خطأ أثناء الحفظ في MongoDB:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // وضع احتياطي (البيانات المحلية)
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
    res.json({ ok: true, source: 'local' });
  });
});

/* ─────────── POST /api/apps/:id/review : إضافة تقييم ─────────── */
app.post('/api/apps/:id/review', async (req, res) => {
  const idParam = String(req.params.id);
  const rating = parseFloat(req.body.rating);
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ ok: false, error: 'rating must be between 1 and 5' });
  }
  const name = (req.body.name || '').toString().trim().slice(0, 60) || 'Anonymous';
  const comment = (req.body.comment || '').toString().trim().slice(0, 500);

  if (appsCollection) {
    try {
      const query = { $or: [{ id: Number(idParam) }, { id: idParam }] };
      const app = await appsCollection.findOne(query);
      if (!app) {
        return res.status(404).json({ ok: false, error: 'App not found: id=' + idParam });
      }

      const oldReviews = Number(app.reviews) || 0;
      const oldRating = Number(app.rating) || 0;
      const newReviews = oldReviews + 1;
      const newRating = Math.round((((oldRating * oldReviews) + rating) / newReviews) * 10) / 10;
      const newReview = { rating, name, comment, date: new Date().toISOString() };
      const reviewsList = Array.isArray(app.reviewsList) ? [newReview, ...app.reviewsList].slice(0, 100) : [newReview];

      await appsCollection.updateOne(query, {
        $set: {
          rating: newRating,
          reviews: newReviews,
          reviewsList: reviewsList
        }
      });

      const updated = await appsCollection.findOne(query, { projection: { _id: 0 } });
      return res.json({ ok: true, app: updated });
    } catch (err) {
      console.error(`[review] FAILED Mongo id=${idParam}:`, err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // وضع احتياطي (البيانات المحلية)
  let writeChain = Promise.resolve();
  const run = writeChain.then(() => new Promise((resolve, reject) => {
    const data = readAppsFile();
    const app = (data.apps || []).find(a => String(a.id) === String(idParam));
    if (!app) return reject(Object.assign(new Error('App not found: id=' + idParam), { code: 404 }));

    const oldReviews = Number(app.reviews) || 0;
    const oldRating = Number(app.rating) || 0;
    const newReviews = oldReviews + 1;
    const newRating = ((oldRating * oldReviews) + rating) / newReviews;
    app.rating = Math.round(newRating * 10) / 10;
    app.reviews = newReviews;
    if (!Array.isArray(app.reviewsList)) app.reviewsList = [];
    app.reviewsList.unshift({ rating, name, comment, date: new Date().toISOString() });
    if (app.reviewsList.length > 100) app.reviewsList.length = 100;

    fs.writeFile(APPS_FILE, JSON.stringify(data, null, 2), 'utf8', (err) => {
      if (err) return reject(err);
      resolve(app);
    });
  }));

  run
    .then(app => res.json({ ok: true, app }))
    .catch(err => res.status(err.code || 500).json({ ok: false, error: err.message }));
});

/* ─────────── POST /api/apps/:id/download : زيادة عداد التحميل ─────────── */
app.post('/api/apps/:id/download', async (req, res) => {
  const idParam = String(req.params.id);

  if (appsCollection) {
    try {
      const query = { $or: [{ id: Number(idParam) }, { id: idParam }] };
      const updated = await appsCollection.findOneAndUpdate(
        query,
        { $inc: { downloads: 1 } },
        { returnDocument: 'after' }
      );

      if (!updated) {
        return res.status(404).json({ ok: false, error: 'App not found: id=' + idParam });
      }

      const count = updated.downloads;
      return res.json({ ok: true, downloads: count });
    } catch (err) {
      console.error(`[download] FAILED Mongo id=${idParam}:`, err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // وضع احتياطي (البيانات المحلية)
  const stats = readStats();
  const current = Number(stats.downloads[idParam]) || 0;
  stats.downloads[idParam] = current + 1;
  writeStats(stats);
  res.json({ ok: true, downloads: stats.downloads[idParam] });
});

/* ─────────── GET /api/ping ─────────── */
app.get('/api/ping', (req, res) => {
  res.json({
    ok: true,
    message: 'server.js is running',
    mongodb: {
      connected: appsCollection !== null,
      database: DB_NAME,
      collection: COLLECTION_NAME
    },
    port: PORT,
    environment: process.env.VERCEL ? 'vercel' : 'local',
    time: new Date().toISOString()
  });
});

app.use((err, req, res, next) => {
  console.error('[server error]', err);
  res.status(500).json({ ok: false, error: err.message });
});

// إذا كان التشغيل محلياً (وليس كـ Serverless على Vercel)
if (!process.env.VERCEL) {
  getCollection().then(() => {
    app.listen(PORT, () => {
      console.log(`\n✅ DevStore server running on port ${PORT}`);
      console.log(`   Store:     http://localhost:${PORT}`);
      console.log(`   Admin:     http://localhost:${PORT}/17041704.html`);
      console.log(`   Health:    http://localhost:${PORT}/api/ping\n`);
    });
  });
}

// تصدير app ليعمل مع Vercel Serverless Functions
module.exports = app;
