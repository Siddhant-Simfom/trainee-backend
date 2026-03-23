# Trainee Backend API

Node.js Express backend with MySQL database for managing employees.

## Setup Instructions

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Set up MySQL Database**
   ```bash
   ./setup-db.sh
   ```
   This will create:
   - Database: `trainee_db`
   - User: `trainee_user`
   - Password: `TraineePass123!`

3. **Start Server**
   ```bash
   npm start
   ```
   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

## API Endpoints

### GET /api/employees
Retrieve all employees.

**Response:**
```json
{
  "success": true,
  "message": "Employees retrieved successfully",
  "data": [
    {
      "id": 1,
      "name": "John Doe",
      "email": "john@example.com",
      "position": "Developer",
      "salary": 50000,
      "created_at": "2024-01-01T12:00:00.000Z",
      "updated_at": "2024-01-01T12:00:00.000Z"
    }
  ]
}
```

### POST /api/employees
Create a new employee.

**Request Body:**
```json
{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "position": "Designer",
  "salary": 45000
}
```

**Response:**
```json
{
  "success": true,
  "message": "Employee created successfully",
  "data": {
    "id": 2,
    "name": "Jane Smith",
    "email": "jane@example.com",
    "position": "Designer",
    "salary": 45000
  }
}
```

### PUT /api/employees/:id
Update an existing employee by ID.

**Request Body:**
```json
{
  "name": "Jane Smith Updated",
  "email": "jane.updated@example.com",
  "position": "Senior Designer",
  "salary": 55000
}
```

**Response:**
```json
{
  "success": true,
  "message": "Employee updated successfully",
  "data": {
    "id": 2,
    "name": "Jane Smith Updated",
    "email": "jane.updated@example.com",
    "position": "Senior Designer",
    "salary": 55000
  }
}
```

## Database Schema

**employees table:**
- `id` - Auto-increment primary key
- `name` - Employee name (required)
- `email` - Employee email (unique)
- `position` - Job position
- `salary` - Annual salary
- `created_at` - Creation timestamp
- `updated_at` - Last update timestamp
