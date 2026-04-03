const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
require('dotenv').config();
const client = require('prom-client');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Collect default metrics (CPU, memory, etc.)
client.collectDefaultMetrics();

// Custom metrics
const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP Requests',
  labelNames: ['method', 'route', 'status']
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5]
});

// Middleware to track metrics
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;

    httpRequestCounter
      .labels(req.method, req.route?.path || req.path, res.statusCode)
      .inc();

    httpRequestDuration
      .labels(req.method, req.route?.path || req.path, res.statusCode)
      .observe(duration);
  });

  next();
});


const pool = mysql.createPool({
  host: process.env.DB_HOST || 'trainee-mysql',
  user: process.env.DB_USER || 'trainee_user',
  password: process.env.DB_PASSWORD || 'trainee_pass',
  database: process.env.DB_NAME || 'trainee_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function initializeDatabase() {
  try {
    const connection = await pool.getConnection();

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS employees (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE,
        position VARCHAR(100),
        salary DECIMAL(10, 2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    connection.release();
    console.log('✅ Database initialized');

  } catch (error) {
    console.error('❌ DB init error:', error);
    throw error;
  }
}

// GET employees
app.get('/api/employees', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.execute('SELECT * FROM employees');
    connection.release();

    res.json({
      success: true,
      data: rows
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST employee
app.post('/api/employees', async (req, res) => {
  try {
    const { name, email, position, salary } = req.body;

    if (!name || !email) {
      return res.status(400).json({ success: false, message: 'Missing fields' });
    }

    const connection = await pool.getConnection();

    const [result] = await connection.execute(
      'INSERT INTO employees (name, email, position, salary) VALUES (?, ?, ?, ?)',
      [name, email, position, salary]
    );

    connection.release();

    res.status(201).json({
      success: true,
      id: result.insertId
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK' });
});



app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});



const PORT = process.env.PORT || 5000;

async function waitForDB(retries = 10, delay = 3000) {
  while (retries) {
    try {
      const connection = await pool.getConnection();
      console.log("✅ MySQL Connected");
      connection.release();
      return;
    } catch {
      console.log("⏳ Waiting for MySQL...");
      retries--;
      await new Promise(res => setTimeout(res, delay));
    }
  }
  throw new Error("❌ MySQL not available");
}

async function startServer() {
  try {
    await waitForDB();
    await initializeDatabase();

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
}

startServer();