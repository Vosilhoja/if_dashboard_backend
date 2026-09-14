const express = require('express');
const router = express.Router();
const AuthController = require('../controllers/authController');
const { authenticateToken } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimiter');

// POST /api/auth/login (с защитой от подбора паролей Rate Limiter)
router.post('/login', loginLimiter, AuthController.login);

// GET /api/auth/me (получение данных текущего пользователя по JWT)
router.get('/me', authenticateToken, AuthController.getMe);

// POST /api/auth/logout
router.post('/logout', authenticateToken, AuthController.logout);

module.exports = router;
