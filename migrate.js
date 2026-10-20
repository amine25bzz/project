require('dotenv').config();
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const APPS_FILE = path.join(__dirname, 'apps.json');
const STATS_FILE = path.join(__dirname, 'stats.json');

const uri = process.argv[2] || process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'linkapp';
const collectionName = process.env.COLLECTION_NAME || 'linkapppro';

async function migrate() {
  if (!uri || uri.trim() === '' || uri.includes('<username>')) {
    console.error('❌ خطأ: لم يتم تحديد رابط الاتصال بـ MongoDB (MONGODB_URI).');
    process.exit(1);
  }

  console.log('🚀 بدء عملية ترحيل البيانات إلى MongoDB...');
  console.log(`📁 قاعدة البيانات: ${dbName}`);
  console.log(`📂 المجموعة: ${collectionName}`);

  let apps = [];
  try {
    const rawApps = fs.readFileSync(APPS_FILE, 'utf8');
    const parsed = JSON.parse(rawApps);
    apps = parsed.apps || [];
    console.log(`✅ تم قراءة ${apps.length} تطبيق من apps.json`);
  } catch (err) {
    console.error('❌ تعذر قراءة apps.json:', err.message);
    process.exit(1);
  }

  let stats = { downloads: {}, reviews: {} };
  try {
    if (fs.existsSync(STATS_FILE)) {
      stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      console.log('✅ تم قراءة إحصائيات التحميل من stats.json');
    }
  } catch (err) {}

  const preparedApps = apps.map(app => {
    const copy = { ...app };
    delete copy._id;
    const key = String(copy.id);
    const fromStats = Number(stats.downloads?.[key]);
    const fromApp = Number(copy.downloads);

    copy.downloads = Number.isFinite(fromStats) ? fromStats
                  : Number.isFinite(fromApp) ? fromApp
                  : 0;

    copy.rating = Number(copy.rating) || 0;
    copy.reviews = Number(copy.reviews) || 0;
    if (!Array.isArray(copy.reviewsList)) copy.reviewsList = [];
    return copy;
  });

  const client = new MongoClient(uri);

  try {
    console.log('🔄 جاري الاتصال بـ MongoDB Atlas...');
    await client.connect();
    console.log('✅ تم الاتصال بنجاح!');

    const db = client.db(dbName);
    const col = db.collection(collectionName);

    // تنظيف المجموعة قبل النقل
    await col.deleteMany({});
    console.log('🧹 تم تهيئة المجموعة بنجاح.');

    // نقل التطبيقات واحداً تلو الآخر لتفادي مشاكل الاتصال وحجم البيانات
    let count = 0;
    for (let i = 0; i < preparedApps.length; i++) {
      const app = preparedApps[i];
      const sz = (Buffer.byteLength(JSON.stringify(app), 'utf8') / 1024 / 1024).toFixed(2);
      process.stdout.write(`⏳ جاري رفع تطبيق (${i + 1}/${preparedApps.length}): "${app.name}" (${sz} MB)... `);
      await col.insertOne(app);
      count++;
      console.log('✅');
    }

    // إنشاء فهرس على الحقل id
    await col.createIndex({ id: 1 }, { unique: true });
    console.log('⚡ تم إنشاء Index على الحقل id.');

    console.log(`\n🎉 تم بنجاح نقل كافة التطبيقات (${count}/${preparedApps.length}) إلى MongoDB (${dbName}.${collectionName})!`);
  } catch (err) {
    console.error('\n❌ حدث خطأ أثناء الترحيل:', err.message);
  } finally {
    await client.close();
    console.log('🔌 تم إغلاق الاتصال.');
  }
}

migrate();
