require('dotenv').config();
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const APPS_FILE = path.join(__dirname, 'apps.json');
const STATS_FILE = path.join(__dirname, 'stats.json');

// URI can be passed as a command-line argument or from .env
const uri = process.argv[2] || process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'linkapp';
const collectionName = process.env.COLLECTION_NAME || 'linkapppro';

async function migrate() {
  if (!uri || uri.trim() === '' || uri.includes('<username>')) {
    console.error('❌ خطأ: لم يتم تحديد رابط الاتصال بـ MongoDB (MONGODB_URI).');
    console.error('يرجى وضع الرابط في ملف .env أو تمريره كمعامل:');
    console.error('مثال: node migrate.js "mongodb+srv://user:pass@cluster0.xxx.mongodb.net/?retryWrites=true&w=majority"\n');
    process.exit(1);
  }

  console.log('🚀 بدء عملية ترحيل البيانات إلى MongoDB...');
  console.log(`📁 قاعدة البيانات: ${dbName}`);
  console.log(`📂 المجموعة (Collection): ${collectionName}`);

  // 1. قراءة الملفات الحالية
  let apps = [];
  try {
    const rawApps = fs.readFileSync(APPS_FILE, 'utf8');
    const parsed = JSON.parse(rawApps);
    apps = parsed.apps || [];
    console.log(`✅ تم قراءة ${apps.length} تطبيق من apps.json`);
  } catch (err) {
    console.error('❌ تعذر قراءة ملف apps.json:', err.message);
    process.exit(1);
  }

  let stats = { downloads: {}, reviews: {} };
  try {
    if (fs.existsSync(STATS_FILE)) {
      stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      console.log('✅ تم قراءة إحصائيات التحميل من stats.json');
    }
  } catch (err) {
    console.warn('⚠️ تعذر قراءة stats.json، سيتم استخدام التحميلات الافتراضية.');
  }

  // 2. دمج التحميلات والتقييمات من stats.json
  const preparedApps = apps.map(app => {
    const copy = { ...app };
    delete copy._id; // تجنب أي تعارض في معرفات MongoDB
    const key = String(copy.id);
    const fromStats = Number(stats.downloads?.[key]);
    const fromApp = Number(copy.downloads);

    copy.downloads = Number.isFinite(fromStats) ? fromStats
                  : Number.isFinite(fromApp) ? fromApp
                  : 0;

    copy.rating = Number(copy.rating) || 0;
    copy.reviews = Number(copy.reviews) || 0;
    if (!Array.isArray(copy.reviewsList)) {
      copy.reviewsList = [];
    }
    return copy;
  });

  // 3. الاتصال بقاعدة البيانات
  const client = new MongoClient(uri);

  try {
    console.log('🔄 جاري الاتصال بـ MongoDB...');
    await client.connect();
    console.log('✅ تم الاتصال بنجاح بـ MongoDB!');

    const db = client.db(dbName);
    const col = db.collection(collectionName);

    // تفريغ البيانات القديمة في المجموعة لمنع التكرار
    const deleteResult = await col.deleteMany({});
    console.log(`🧹 تم تنظيف المجموعة (تم حذف ${deleteResult.deletedCount} مستند قديم إن وجد)`);

    // إدراج التطبيقات
    if (preparedApps.length > 0) {
      const insertResult = await col.insertMany(preparedApps);
      console.log(`🎉 تم بنجاح نقل ${insertResult.insertedCount} تطبيق إلى ${dbName}.${collectionName}!`);

      // إنشاء فهرس على الحقل id لتسريع البحث
      await col.createIndex({ id: 1 }, { unique: true });
      console.log('⚡ تم إنشاء Index على الحقل id لتسريع البحث.');
    } else {
      console.log('ℹ️ لا توجد تطبيقات في apps.json لنقلها.');
    }

    console.log('\n✨ تمت عملية الترحيل بنجاح كامل!');
  } catch (err) {
    console.error('❌ حدث خطأ أثناء الترحيل:', err.message);
  } finally {
    await client.close();
    console.log('🔌 تم إغلاق الاتصال بقاعدة البيانات.');
  }
}

migrate();
