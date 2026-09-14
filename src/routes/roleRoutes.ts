const express = require('express');
const router = express.Router();
const RoleController = require('../controllers/roleController');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

// Все маршруты требуют JWT авторизацию
router.use(authenticateToken);

// Раздел управления пользователями доступен только главному администратору.
router.get('/roles', authorizeRoles('super_admin'), RoleController.getRoles);

// Просмотр пользователей (доступно админу, суперадмину)
router.get('/users', authorizeRoles('super_admin'), RoleController.getUsers);

// Создание пользователя (только главный администратор)
router.post('/users', authorizeRoles('super_admin'), RoleController.createUser);

// Назначение роли (только главный администратор)
router.patch('/users/:userId/role', authorizeRoles('super_admin'), RoleController.assignRole);

// Активация / деактивация пользователя (только главный администратор)
router.patch('/users/:userId/active', authorizeRoles('super_admin'), RoleController.toggleUserActive);

// Обновление прав (разрешенных страниц) пользователя (только главный администратор)
router.patch('/users/:userId/permissions', authorizeRoles('super_admin'), RoleController.updatePermissions);

// Удаление пользователя (только главный администратор)
router.delete('/users/:userId', authorizeRoles('super_admin'), RoleController.deleteUser);

module.exports = router;
