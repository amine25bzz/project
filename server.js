require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 5000;

const APPS_FILE = path.join(__dirname, 'apps.json');
const STATS_FILE = path.join(__dirname, 'stats.json');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'linkapp';
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'linkapppro';

let cachedClient = null;
let cachedDb = null;
let appsCollection = null;

// ذاكرة سريعة جداً في الرام لخدمة الطلبات في أجزاء من الثانية ومنع تعليق المتصفح
let memoryApps = null;

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

// دالة جلب التطبيقات مع التخزين في الذاكرة (Memory Cache)
async function loadAppsData() {
  if (memoryApps && memoryApps.length > 0) {
    return memoryApps;
  }

  const col = await getCollection();
  if (col) {
    try {
      console.log('⚡ [MongoDB] جاري تحميل البيانات من السحابة إلى الذاكرة...');
      const apps = await col.find({}, { projection: { _id: 0 } }).toArray();
      if (apps && apps.length > 0) {
        memoryApps = apps.map(app => {
          app.downloads = Number(app.downloads) || 0;
          app.rating = Number(app.rating) || 0;
          app.reviews = Number(app.reviews) || 0;
          if (!Array.isArray(app.reviewsList)) app.reviewsList = [];
          return app;
        });
        console.log(`✅ [MongoDB] تم تحميل ${memoryApps.length} تطبيق في الذاكرة بنجاح!`);
        return memoryApps;
      }
    } catch (e) {
      console.error('❌ [MongoDB] تعذر القراءة من السحابة:', e.message);
    }
  }

  // وضع احتياطي من الملفات المحلية إن تعذر الاتصال بـ MongoDB
  try {
    const raw = fs.readFileSync(APPS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const stats = fs.existsSync(STATS_FILE) ? JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) : { downloads: {} };
    memoryApps = (parsed.apps || []).map(app => {
      const key = String(app.id);
      const fromStats = Number(stats.downloads?.[key]);
      const fromApp = Number(app.downloads);
      app.downloads = Number.isFinite(fromStats) ? fromStats : (Number.isFinite(fromApp) ? fromApp : 0);
      app.rating = Number(app.rating) || 0;
      app.reviews = Number(app.reviews) || 0;
      if (!Array.isArray(app.reviewsList)) app.reviewsList = [];
      return app;
    });
    return memoryApps;
  } catch (e) {
    memoryApps = [];
    return memoryApps;
  }
}

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

app.get('/17041704', (req, res) => res.sendFile(path.join(__dirname, '17041704.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ─────────── GET /api/apps : استجابة فائقة السرعة من الذاكرة ─────────── */
app.get('/api/apps', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const apps = await loadAppsData();
  res.json({ apps });
});

/* ─────────── POST /api/apps : حفظ فوري دون تعليق المتصفح ─────────── */
app.post('/api/apps', async (req, res) => {
  const incoming = req.body.apps || [];
  if (!Array.isArray(incoming)) {
    return res.status(400).json({ ok: false, error: 'apps must be an array' });
  }

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

  // تحديث الذاكرة فوراً ليرد السيرفر في غضون ملّي ثوانٍ دون انتظار
  memoryApps = cleaned;
  res.json({ ok: true });

  // حفظ نسخة احتياطية في apps.json
  try {
    fs.writeFile(APPS_FILE, JSON.stringify({ apps: cleaned }, null, 2), 'utf8', () => {});
  } catch (e) {}

  // حفظ في MongoDB في الخلفية بشكل آمن دون إبطاء المتصفح
  const col = await getCollection();
  if (col) {
    (async () => {
      try {
        await col.deleteMany({});
        for (const app of cleaned) {
          await col.insertOne(app);
        }
        console.log('✅ [MongoDB] تم مزامنة كافة التطبيقات بنجاح في قاعدة البيانات!');
      } catch (err) {
        console.error('❌ [MongoDB] خطأ أثناء الحفظ في الخلفية:', err.message);
      }
    })();
  }
});

/* ─────────── POST /api/apps/:id/review : إضافة تقييم فوري ─────────── */
app.post('/api/apps/:id/review', async (req, res) => {
  const idParam = String(req.params.id);
  const rating = parseFloat(req.body.rating);
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ ok: false, error: 'rating must be between 1 and 5' });
  }
  const name = (req.body.name || '').toString().trim().slice(0, 60) || 'Anonymous';
  const comment = (req.body.comment || '').toString().trim().slice(0, 500);

  const apps = await loadAppsData();
  const app = apps.find(a => String(a.id) === idParam);
  if (!app) {
    return res.status(404).json({ ok: false, error: 'App not found: id=' + idParam });
  }

  const oldReviews = Number(app.reviews) || 0;
  const oldRating = Number(app.rating) || 0;
  const newReviews = oldReviews + 1;
  const newRating = Math.round((((oldRating * oldReviews) + rating) / newReviews) * 10) / 10;
  const newReview = { rating, name, comment, date: new Date().toISOString() };

  app.rating = newRating;
  app.reviews = newReviews;
  if (!Array.isArray(app.reviewsList)) app.reviewsList = [];
  app.reviewsList.unshift(newReview);
  if (app.reviewsList.length > 100) app.reviewsList.length = 100;

  // إرسال الرد فوراً للمتصفح حتى لا يتجمد زر الإرسال
  res.json({ ok: true, app });
  console.log(`[review] OK — "${app.name}" now ${app.rating} (${app.reviews})`);

  // حفظ في MongoDB في الخلفية
  const col = await getCollection();
  if (col) {
    const query = { $or: [{ id: Number(idParam) }, { id: idParam }] };
    col.updateOne(query, {
      $set: {
        rating: newRating,
        reviews: newReviews,
        reviewsList: app.reviewsList
      }
    }).catch(err => console.error('MongoDB review update error:', err.message));
  }
});

/* ─────────── POST /api/apps/:id/download : زيادة عداد التحميل ─────────── */
app.post('/api/apps/:id/download', async (req, res) => {
  const idParam = String(req.params.id);
  const apps = await loadAppsData();
  const app = apps.find(a => String(a.id) === idParam);
  if (app) {
    app.downloads = (Number(app.downloads) || 0) + 1;
  }
  const count = app ? app.downloads : 1;
  res.json({ ok: true, downloads: count });

  const col = await getCollection();
  if (col) {
    const query = { $or: [{ id: Number(idParam) }, { id: idParam }] };
    col.updateOne(query, { $inc: { downloads: 1 } })
      .catch(err => console.error('MongoDB download increment error:', err.message));
  }
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

if (!process.env.VERCEL) {
  getCollection().then(async () => {
    await loadAppsData();
    app.listen(PORT, () => {
      console.log(`\n✅ DevStore server running on port ${PORT}`);
      console.log(`   Store:     http://localhost:${PORT}`);
      console.log(`   Admin:     http://localhost:${PORT}/17041704.html`);
      console.log(`   Health:    http://localhost:${PORT}/api/ping\n`);
    });
  });
}

module.exports = app;
