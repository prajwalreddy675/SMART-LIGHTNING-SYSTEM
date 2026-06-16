require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const db = require('./db');
const { router } = require('./routes');
const mqttBroker = require('./mqttBroker');

const PORT = process.env.PORT || 5000;
const app = express();

app.use(cors());
app.use(express.json());

// Main Router
app.use('/api', router);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

const server = http.createServer(app);

// WebSocket Setup
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// System settings cache
let systemConfig = {
  ldrThreshold: 500, // 0 - 1023 LDR scale
  nightDuration: 30  // Countdown in seconds (30s / 60s)
};

// System connections cache
let connectionStates = {
  website: 'Online',      // Website is running if backend is running
  bluetooth: 'Disconnected', // HC-05 module/mobile connection state
  hardware: 'Offline',    // ESP32 device online state
  internet: 'Connected'   // Internet connectivity
};

// Last telemetry state cache
let lastTelemetry = {
  ldr: 720,
  motion: false,
  state: 'OFF',
  rtc: '12:00 PM',
  power: 5,
  mode: 'Daytime Energy Saving',
  source: 'Autonomous Control'
};

// Periodic telemetry saver state
let sensorLogTimer = null;

// Socket IO Logic
io.on('connection', (socket) => {
  console.log(`[Socket.IO] New Dashboard/Client Connected: ${socket.id}`);
  
  // Send initial statuses on connection
  socket.emit('config-update', systemConfig);
  socket.emit('connection-update', connectionStates);
  socket.emit('telemetry-update', lastTelemetry);

  // Handle client controlling the light from Website
  socket.on('device-control', async (data) => {
    const { state, source } = data; // state = "ON" | "OFF" | "AUTO"
    console.log(`[Socket.IO] Command received from ${source}: ${state}`);
    
    // Determine the control mode
    let displayMode = '';
    let logMessage = '';
    
    if (state === 'AUTO') {
      displayMode = 'Autonomous Smart Mode Active';
      logMessage = 'Switched system to Autonomous Smart Mode';
      lastTelemetry.source = 'Autonomous Control';
    } else {
      displayMode = state === 'ON' ? 'Manual Override ON' : 'Manual Override OFF';
      lastTelemetry.source = `${source} Control Active`;
      logMessage = `${source} sent manual override command: Turn Light ${state}`;
      
      // Update local state cache
      lastTelemetry.state = state;
      lastTelemetry.power = state === 'ON' ? 40 : 5;
    }

    lastTelemetry.mode = displayMode;
    
    // Log the event in database
    const savedLog = await db.addLog('manual_control', logMessage, source);
    io.emit('system-log', savedLog);
    io.emit('telemetry-update', lastTelemetry);

    // Forward the command to MQTT (so ESP32 or simulator gets it)
    mqtt.publish('hub/light/control', JSON.stringify({ state, source }));
  });

  // Handle manual mock triggers from the dashboard's BLE/Simulator
  socket.on('connection-state-change', async (data) => {
    const { key, value } = data; // e.g. { key: 'bluetooth', value: 'Connected' }
    if (connectionStates[key] !== value) {
      connectionStates[key] = value;
      console.log(`[Socket.IO] Connection change: ${key} = ${value}`);
      
      // Add log entries for connection events
      const logType = `${key}_${value.toLowerCase()}`;
      const logMsg = `${key.charAt(0).toUpperCase() + key.slice(1)} connection status changed to: ${value}`;
      const savedLog = await db.addLog(logType, logMsg, 'System');
      
      io.emit('system-log', savedLog);
      io.emit('connection-update', connectionStates);
    }
  });

  // Handle telemetry updates from the browser-based ESP32 simulator
  socket.on('telemetry-update-sim', async (payload) => {
    // Sync local cache
    lastTelemetry = {
      ldr: payload.ldr,
      motion: payload.motion,
      state: payload.state,
      rtc: payload.rtc || new Date().toLocaleTimeString(),
      power: payload.power || (payload.state === 'ON' ? 40 : 5),
      mode: payload.mode || lastTelemetry.mode,
      source: payload.source || lastTelemetry.source
    };
    
    // Broadcast to website dashboards
    io.emit('telemetry-update', lastTelemetry);
  });

  // Handle hardware event logs from the simulator
  socket.on('event-log-sim', async (payload) => {
    const eventType = payload.type || 'hardware_event';
    const eventMsg = payload.message || '';
    const eventSrc = payload.source || 'Autonomous';
    
    const savedLog = await db.addLog(eventType, eventMsg, eventSrc);
    io.emit('system-log', savedLog);
  });

  // Handle dashboard resetting logs or requesting manual logs
  socket.on('request-telemetry-save', async (data) => {
    // Force save the current telemetry state to database
    const { ldr, pirCount, power, energySaved } = data;
    await db.addTelemetry(ldr, pirCount, power, energySaved);
    console.log('[Socket.IO] Telemetry entry saved to database.');
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.IO] Client Disconnected: ${socket.id}`);
  });
});

// Update config handler via routes
app.post('/api/config', async (req, res, next) => {
  // We hook into the Express routing to update live server parameters
  const { ldrThreshold, nightDuration } = req.body;
  if (ldrThreshold !== undefined) systemConfig.ldrThreshold = Number(ldrThreshold);
  if (nightDuration !== undefined) systemConfig.nightDuration = Number(nightDuration);
  
  // Broadcast update to Socket.IO dashboards
  io.emit('config-update', systemConfig);
  
  // Publish configuration to ESP32 MQTT
  mqtt.publish('hub/light/config', JSON.stringify(systemConfig));
  
  res.json({ success: true, config: systemConfig });
});

// MQTT Topic Handlers
function handleMqttMessage(topic, payloadString, clientId) {
  try {
    const payload = JSON.parse(payloadString);
    
    if (topic === 'hub/light/telemetry') {
      // Sync local cache
      lastTelemetry = {
        ldr: payload.ldr,
        motion: payload.motion,
        state: payload.state,
        rtc: payload.rtc || new Date().toLocaleTimeString(),
        power: payload.power || (payload.state === 'ON' ? 40 : 5),
        mode: payload.mode || lastTelemetry.mode,
        source: payload.source || lastTelemetry.source
      };
      
      // Broadcast to website UI in real-time
      io.emit('telemetry-update', lastTelemetry);
      
    } else if (topic === 'hub/light/event') {
      // Hardware reports an event (e.g. PIR motion, manual override)
      const eventType = payload.type || 'hardware_event';
      const eventMsg = payload.message || '';
      const eventSrc = payload.source || 'Autonomous';
      
      db.addLog(eventType, eventMsg, eventSrc).then(savedLog => {
        io.emit('system-log', savedLog);
      });
    }
  } catch (err) {
    // If payload is not JSON, handle as plain string
    if (topic === 'hub/light/event') {
      db.addLog('hardware_log', payloadString, 'Autonomous').then(savedLog => {
        io.emit('system-log', savedLog);
      });
    }
  }
}

function handleMqttClientConnect(clientId) {
  // If client is hardware or simulator, mark hardware as Online
  if (clientId.includes('esp32') || clientId.includes('simulator') || clientId.includes('hardware')) {
    connectionStates.hardware = 'Online';
    io.emit('connection-update', connectionStates);
    
    db.addLog('hardware_online', 'Hardware node connected to MQTT broker', 'System').then(savedLog => {
      io.emit('system-log', savedLog);
    });
    
    // Push current configurations to the newly connected hardware
    mqtt.publish('hub/light/config', JSON.stringify(systemConfig));
  }
}

function handleMqttClientDisconnect(clientId) {
  if (clientId.includes('esp32') || clientId.includes('simulator') || clientId.includes('hardware')) {
    connectionStates.hardware = 'Offline';
    io.emit('connection-update', connectionStates);
    
    db.addLog('hardware_offline', 'Hardware node disconnected from MQTT broker', 'System').then(savedLog => {
      io.emit('system-log', savedLog);
    });
  }
}

// Start MQTT Broker
const mqtt = mqttBroker.startBroker(
  handleMqttMessage,
  handleMqttClientConnect,
  handleMqttClientDisconnect
);

// Connect to Database and start Server
db.connect().then(() => {
  server.listen(PORT, () => {
    console.log(`[Express Gateway] Server listening on port ${PORT}`);
    
    // Start periodic telemetry log saver (every 60 seconds)
    sensorLogTimer = setInterval(async () => {
      // Calculate a mock dynamic energy saving parameter based on state
      const energySaved = lastTelemetry.state === 'OFF' ? 0.045 : 0.005; // kWh saved vs full consumption
      await db.addTelemetry(
        lastTelemetry.ldr,
        lastTelemetry.motion ? 1 : 0,
        lastTelemetry.power,
        energySaved
      );
    }, 60000);
  });
});
