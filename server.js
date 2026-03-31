const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());


const pool = mysql.createPool({
  host: process.env.DB_HOST || 'trainee-mysql',
  user: process.env.DB_USER || 'trainee_user',
  password: process.env.DB_PASSWORD || 'trainee_pass',
  database: process.env.DB_NAME || 'trainee_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Initialize database table
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
    console.log('Database initialized successfully');

  } catch (error) {
    console.error('Database initialization error:', error);
    throw error; // IMPORTANT → fail startup if DB fails
  }
}

// GET endpoint - Retrieve all employees
app.get('/api/employees', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.execute('SELECT * FROM employees');
    connection.release();

    res.json({
      success: true,
      message: 'Employees retrieved successfully',
      data: rows
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving employees',
      error: error.message
    });
  }
});

// POST endpoint - Create new employee
app.post('/api/employees', async (req, res) => {
  try {
    const { name, email, position, salary } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        message: 'Name and email are required'
      });
    }

    const connection = await pool.getConnection();
    const [result] = await connection.execute(
      'INSERT INTO employees (name, email, position, salary) VALUES (?, ?, ?, ?)',
      [name, email, position, salary]
    );
    connection.release();

    res.status(201).json({
      success: true,
      message: 'Employee created successfully',
      data: {
        id: result.insertId,
        name,
        email,
        position,
        salary
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error creating employee',
      error: error.message
    });
  }
});

// PUT endpoint - Update employee
app.put('/api/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, position, salary } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Employee ID is required'
      });
    }

    const connection = await pool.getConnection();

    const [checkRows] = await connection.execute(
      'SELECT * FROM employees WHERE id = ?',
      [id]
    );

    if (checkRows.length === 0) {
      connection.release();
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    await connection.execute(
      'UPDATE employees SET name = ?, email = ?, position = ?, salary = ? WHERE id = ?',
      [name, email, position, salary, id]
    );

    connection.release();

    res.json({
      success: true,
      message: 'Employee updated successfully',
      data: { id, name, email, position, salary }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: 'Error updating employee',
      error: error.message
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Backend is running'
  });
});

const PORT = process.env.PORT || 5000;

async function waitForDB(retries = 10, delay = 3000) {
  while (retries) {
    try {
      const connection = await pool.getConnection();
      console.log("✅ MySQL Connected");
      connection.release();
      return;
    } catch (err) {
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