const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');
require('dotenv').config();
const client = require('prom-client');

const app = express();

// =====================
// AZURE BLOB SETUP
// =====================
const AZURE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const AZURE_CONTAINER_NAME = process.env.AZURE_STORAGE_CONTAINER_NAME || 'employee-images';

if (!AZURE_CONNECTION_STRING) {
  console.warn('⚠️  AZURE_STORAGE_CONNECTION_STRING not set — image uploads will fail');
}

const blobServiceClient = AZURE_CONNECTION_STRING
  ? BlobServiceClient.fromConnectionString(AZURE_CONNECTION_STRING)
  : null;

// =====================
// MULTER — MEMORY STORAGE
// (files held in RAM briefly, then pushed to Azure)
// =====================
const fileFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|gif|webp/;
  const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
  const mimeOk = allowed.test(file.mimetype);
  if (extOk && mimeOk) cb(null, true);
  else cb(new Error('Only image files are allowed (jpeg, jpg, png, gif, webp)'));
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});

// =====================
// MIDDLEWARE
// =====================
app.use(cors({
  origin: '*',
  credentials: true
}));

app.use(express.json());

// =====================
// PROMETHEUS METRICS
// =====================
client.collectDefaultMetrics();

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

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    httpRequestCounter.labels(req.method, req.route?.path || req.path, res.statusCode).inc();
    httpRequestDuration.labels(req.method, req.route?.path || req.path, res.statusCode).observe(duration);
  });
  next();
});

// =====================
// DATABASE CONNECTION (PostgreSQL)
// =====================
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 5432,
  max: 10
});

// =====================
// INIT DB
// =====================
async function initializeDatabase() {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE,
        position VARCHAR(100),
        salary DECIMAL(10,2),
        profile_image VARCHAR(512) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Safe migration: add profile_image column if it doesn't exist
    const columnCheck = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'employees' AND column_name = 'profile_image'
    `);

    if (columnCheck.rows.length === 0) {
      await client.query(`ALTER TABLE employees ADD COLUMN profile_image VARCHAR(512) DEFAULT NULL`);
      console.log('✅ profile_image column added to employees table');
    }

    console.log('✅ Database initialized');
  } finally {
    client.release();
  }
}

// =====================
// AZURE BLOB HELPERS
// =====================

/**
 * Upload a file buffer to Azure Blob Storage.
 * Returns the full public URL of the uploaded blob.
 */
async function uploadToAzure(file) {
  if (!blobServiceClient) throw new Error('Azure Blob Storage not configured');

  const ext = path.extname(file.originalname).toLowerCase();
  const blobName = `employee-${crypto.randomUUID()}${ext}`;

  const containerClient = blobServiceClient.getContainerClient(AZURE_CONTAINER_NAME);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.uploadData(file.buffer, {
    blobHTTPHeaders: { blobContentType: file.mimetype }
  });

  console.log(`☁️  Uploaded to Azure: ${blobName}`);
  return blockBlobClient.url; // Full public HTTPS URL
}

/**
 * Delete a blob from Azure Blob Storage by its full URL.
 * Silently ignores if the blob doesn't exist.
 */
async function deleteFromAzure(blobUrl) {
  if (!blobUrl || !blobServiceClient) return;

  try {
    const url = new URL(blobUrl);
    // Extract blob name: path after /<container>/
    const pathParts = url.pathname.split('/');
    const containerIndex = pathParts.indexOf(AZURE_CONTAINER_NAME);
    if (containerIndex === -1) return;
    const blobName = pathParts.slice(containerIndex + 1).join('/');

    const containerClient = blobServiceClient.getContainerClient(AZURE_CONTAINER_NAME);
    await containerClient.getBlockBlobClient(blobName).deleteIfExists();
    console.log(`🗑️  Deleted from Azure: ${blobName}`);
  } catch (err) {
    console.error('Error deleting blob from Azure:', err.message);
  }
}

// =====================
// ROUTES
// =====================
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

// GET all employees
app.get('/employees', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM employees ORDER BY id DESC');
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET single employee by ID
app.get('/employees/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM employees WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST — Create employee (multipart/form-data)
app.post('/employees', upload.single('profile_image'), async (req, res) => {
  try {
    const { name, email, position, salary } = req.body;

    if (!name || !email) {
      return res.status(400).json({ success: false, message: 'Name and email are required' });
    }

    // Upload image to Azure if provided
    let imageUrl = null;
    if (req.file) {
      imageUrl = await uploadToAzure(req.file);
    }

    const result = await pool.query(
      'INSERT INTO employees (name, email, position, salary, profile_image) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, email, position || null, salary || null, imageUrl]
    );

    res.status(201).json({ success: true, data: result.rows[0], id: result.rows[0].id });

  } catch (error) {
    // PostgreSQL unique constraint violation error code: 23505
    if (error.code === '23505') {
      return res.status(400).json({ success: false, message: 'Email already exists' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT — Update employee (multipart/form-data)
app.put('/employees/:id', upload.single('profile_image'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, position, salary, remove_image } = req.body;

    if (!name || !email) {
      return res.status(400).json({ success: false, message: 'Name and email are required' });
    }

    // Fetch existing employee to get current image URL
    const existing = await pool.query('SELECT * FROM employees WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    const oldImageUrl = existing.rows[0].profile_image;
    let newImageUrl = oldImageUrl; // default: keep existing

    if (req.file) {
      // New image uploaded — delete old from Azure, upload new
      if (oldImageUrl) await deleteFromAzure(oldImageUrl);
      newImageUrl = await uploadToAzure(req.file);
    } else if (remove_image === 'true') {
      // Explicitly remove image
      if (oldImageUrl) await deleteFromAzure(oldImageUrl);
      newImageUrl = null;
    }

    const result = await pool.query(
      'UPDATE employees SET name = $1, email = $2, position = $3, salary = $4, profile_image = $5 WHERE id = $6 RETURNING *',
      [name, email, position || null, salary || null, newImageUrl, id]
    );

    res.json({ success: true, data: result.rows[0] });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE — Remove employee + their image from Azure
app.delete('/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query('SELECT * FROM employees WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    // Delete image from Azure Blob Storage
    if (existing.rows[0].profile_image) {
      await deleteFromAzure(existing.rows[0].profile_image);
    }

    await pool.query('DELETE FROM employees WHERE id = $1', [id]);

    res.json({ success: true, message: `Employee ${id} deleted successfully` });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE — Remove only the employee's image (keep the employee record)
app.delete('/employees/:id/image', async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query('SELECT * FROM employees WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    if (existing.rows[0].profile_image) {
      await deleteFromAzure(existing.rows[0].profile_image);
    }

    await pool.query('UPDATE employees SET profile_image = NULL WHERE id = $1', [id]);

    res.json({ success: true, message: 'Profile image removed successfully' });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 5000;

async function waitForDB(retries = 10) {
  while (retries) {
    try {
      const client = await pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      console.log('✅ PostgreSQL Connected');
      return;
    } catch {
      console.log('⏳ Waiting for PostgreSQL...');
      retries--;
      await new Promise(res => setTimeout(res, 3000));
    }
  }
  throw new Error('❌ PostgreSQL not available');
}

async function startServer() {
  try {
    await waitForDB();
    await initializeDatabase();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`☁️  Azure Blob Container: ${AZURE_CONTAINER_NAME}`);
    });

  } catch (err) {
    console.error('❌ Startup failed:', err);
    process.exit(1);
  }
}

startServer();