const express = require('express');
const router = express.Router();
const RoleController = require('../controllers/roleController');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

// Все маршруты требуют JWT авторизацию
router.use(authenticateToken);

// Раздел управления пользователями доступен администраторам
router.get('/roles', authorizeRoles('super_admin', 'admin'), RoleController.getRoles);

// Просмотр пользователей (доступно админу, суперадмину)
router.get('/users', authorizeRoles('super_admin', 'admin'), RoleController.getUsers);

// Создание пользователя
router.post('/users', authorizeRoles('super_admin', 'admin'), RoleController.createUser);

// Назначение роли
router.patch('/users/:userId/role', authorizeRoles('super_admin', 'admin'), RoleController.assignRole);

// Активация / деактивация пользователя
router.patch('/users/:userId/active', authorizeRoles('super_admin', 'admin'), RoleController.toggleUserActive);

// Обновление прав (разрешенных страниц) пользователя
router.patch('/users/:userId/permissions', authorizeRoles('super_admin', 'admin'), RoleController.updatePermissions);

// Удаление пользователя
router.delete('/users/:userId', authorizeRoles('super_admin', 'admin'), RoleController.deleteUser);

module.exports = router;
