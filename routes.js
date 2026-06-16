const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_lighting_hub_key';

// JWT Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ message: 'No authentication token provided' });
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// 1. Auth Login Route
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  try {
    const user = await db.getUserByEmail(email);
    if (!user) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    const validPassword = bcrypt.compareSync(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    // Generate JWT Token
    const token = jwt.sign({ userId: user.id || user._id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, email: user.email });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

// 2. Fetch Activity Logs
router.get('/logs', authenticateToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = await db.getLogs(limit);
    res.json(logs);
  } catch (error) {
    console.error('Fetch logs error:', error);
    res.status(500).json({ message: 'Error fetching logs' });
  }
});

// 3. Fetch Analytics Telemetry
router.get('/analytics', authenticateToken, async (req, res) => {
  try {
    const telemetryData = await db.getAnalytics();
    res.json(telemetryData);
  } catch (error) {
    console.error('Fetch analytics error:', error);
    res.status(500).json({ message: 'Error fetching analytics' });
  }
});

// 4. Update System Config Settings (e.g. Day threshold, Night timer duration)
router.post('/config', authenticateToken, async (req, res) => {
  const { ldrThreshold, nightDuration } = req.body;
  
  if (ldrThreshold === undefined && nightDuration === undefined) {
    return res.status(400).json({ message: 'No configuration fields to update' });
  }

  try {
    // Save configuration change to logs
    const msg = `System configuration updated: ${ldrThreshold !== undefined ? `LDR Threshold=${ldrThreshold} ` : ''}${nightDuration !== undefined ? `Night Duration=${nightDuration}s` : ''}`;
    await db.addLog('config_change', msg, 'Website');

    // Return updated config state to trigger real-time updates via Socket/MQTT in server.js
    res.json({
      message: 'Configuration updated successfully',
      config: { ldrThreshold, nightDuration }
    });
  } catch (error) {
    console.error('Update config error:', error);
    res.status(500).json({ message: 'Error updating configuration' });
  }
});

module.exports = { router, authenticateToken };
