const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const DB_FILE = path.join(__dirname, 'db.json');
let useLocalJson = false;
let localDb = { users: [], logs: [], telemetry: [] };

// Default user details to seed
const DEFAULT_EMAIL = 'admin@smarthub.io';
const DEFAULT_PASS = 'admin123'; // will be hashed

// Local JSON File Helper Functions
function loadJsonDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      localDb = JSON.parse(data);
    } else {
      saveJsonDb();
    }
  } catch (err) {
    console.error('Error loading JSON DB, using empty store:', err);
  }
}

function saveJsonDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(localDb, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving JSON DB:', err);
  }
}

function seedLocalDefaultUser() {
  const existing = localDb.users.find(u => u.email === DEFAULT_EMAIL);
  if (!existing) {
    const hashedPassword = bcrypt.hashSync(DEFAULT_PASS, 10);
    localDb.users.push({
      id: 'default-admin-id',
      email: DEFAULT_EMAIL,
      password: hashedPassword,
      createdAt: new Date().toISOString()
    });
    saveJsonDb();
    console.log('[JSON DB] Seeded default user:', DEFAULT_EMAIL);
  }
}

// MongoDB Schemas
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const logSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  type: { type: String, required: true },
  message: { type: String, required: true },
  source: { type: String, required: true } // 'Website', 'Bluetooth', 'Autonomous'
});

const telemetrySchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  ldr: { type: Number, required: true }, // Ambient brightness
  pirCount: { type: Number, default: 0 }, // PIR trigger counts in this interval
  power: { type: Number, required: true }, // Power consumption (W)
  energySaved: { type: Number, required: true } // Energy savings (Wh)
});

let User, Log, Telemetry;

async function connect() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/smart_lighting';
  
  console.log('Attempting connection to MongoDB...');
  try {
    // Attempt connecting to MongoDB with a short timeout
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 3000
    });
    console.log('Successfully connected to MongoDB!');
    User = mongoose.model('User', userSchema);
    Log = mongoose.model('Log', logSchema);
    Telemetry = mongoose.model('Telemetry', telemetrySchema);
    
    // Seed default user if not exists
    const adminCount = await User.countDocuments({ email: DEFAULT_EMAIL });
    if (adminCount === 0) {
      const hashedPassword = bcrypt.hashSync(DEFAULT_PASS, 10);
      await User.create({ email: DEFAULT_EMAIL, password: hashedPassword });
      console.log('[MongoDB] Seeded default user:', DEFAULT_EMAIL);
    }
  } catch (error) {
    console.warn('MongoDB connection failed. Falling back to local JSON database storage...');
    useLocalJson = true;
    loadJsonDb();
    seedLocalDefaultUser();
  }
}

// Unified API Methods
async function getUserByEmail(email) {
  if (useLocalJson) {
    return localDb.users.find(u => u.email === email);
  } else {
    return await User.findOne({ email });
  }
}

async function addLog(type, message, source) {
  const logItem = {
    timestamp: new Date().toISOString(),
    type,
    message,
    source
  };
  
  if (useLocalJson) {
    localDb.logs.unshift(logItem); // add to start of array
    // Cap logs at 200 items to prevent huge file sizes
    if (localDb.logs.length > 200) localDb.logs = localDb.logs.slice(0, 200);
    saveJsonDb();
    return logItem;
  } else {
    const newLog = new Log(logItem);
    return await newLog.save();
  }
}

async function getLogs(limit = 50) {
  if (useLocalJson) {
    return localDb.logs.slice(0, limit);
  } else {
    return await Log.find().sort({ timestamp: -1 }).limit(limit);
  }
}

async function addTelemetry(ldr, pirCount, power, energySaved) {
  const telemetryItem = {
    timestamp: new Date().toISOString(),
    ldr,
    pirCount,
    power,
    energySaved
  };
  
  if (useLocalJson) {
    localDb.telemetry.push(telemetryItem);
    // Keep telemetry records to last 100 entries for lightweight storage
    if (localDb.telemetry.length > 100) localDb.telemetry.shift();
    saveJsonDb();
    return telemetryItem;
  } else {
    const newTel = new Telemetry(telemetryItem);
    return await newTel.save();
  }
}

async function getAnalytics() {
  if (useLocalJson) {
    // Generate some mock history if database is completely empty
    if (localDb.telemetry.length === 0) {
      console.log('Seeding mock telemetry for analytics charts...');
      const now = new Date();
      for (let i = 24; i >= 0; i--) {
        const time = new Date(now.getTime() - i * 60 * 60 * 1000);
        // Daylight variations: brighter midday, dark night
        const hour = time.getHours();
        const isDay = hour >= 6 && hour < 18;
        const baseLdr = isDay ? 600 + Math.random() * 300 : 100 + Math.random() * 100;
        const pirTrig = !isDay && Math.random() > 0.4 ? Math.floor(Math.random() * 8) : 0;
        const powerDraw = pirTrig > 0 ? 40 : 5; // 40W active bulb, 5W standby
        const savedKwh = isDay ? 0.045 : (pirTrig === 0 ? 0.035 : 0.005);
        
        localDb.telemetry.push({
          timestamp: time.toISOString(),
          ldr: Math.round(baseLdr),
          pirCount: pirTrig,
          power: powerDraw,
          energySaved: parseFloat(savedKwh.toFixed(4))
        });
      }
      saveJsonDb();
    }
    return localDb.telemetry;
  } else {
    // Fetch telemetry from Mongo
    const items = await Telemetry.find().sort({ timestamp: 1 }).limit(100);
    // If mongo is empty, seed it
    if (items.length === 0) {
      console.log('Seeding MongoDB with mock telemetry...');
      const now = new Date();
      const mockItems = [];
      for (let i = 24; i >= 0; i--) {
        const time = new Date(now.getTime() - i * 60 * 60 * 1000);
        const hour = time.getHours();
        const isDay = hour >= 6 && hour < 18;
        const baseLdr = isDay ? 600 + Math.random() * 300 : 100 + Math.random() * 100;
        const pirTrig = !isDay && Math.random() > 0.4 ? Math.floor(Math.random() * 8) : 0;
        const powerDraw = pirTrig > 0 ? 40 : 5;
        const savedKwh = isDay ? 0.045 : (pirTrig === 0 ? 0.035 : 0.005);
        mockItems.push({
          timestamp: time,
          ldr: Math.round(baseLdr),
          pirCount: pirTrig,
          power: powerDraw,
          energySaved: parseFloat(savedKwh.toFixed(4))
        });
      }
      await Telemetry.insertMany(mockItems);
      return await Telemetry.find().sort({ timestamp: 1 }).limit(100);
    }
    return items;
  }
}

module.exports = {
  connect,
  getUserByEmail,
  addLog,
  getLogs,
  addTelemetry,
  getAnalytics
};
