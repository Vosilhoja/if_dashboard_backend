const express = require('express');
const router = express.Router();
const RoleController = require('../controllers/roleController');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

// Все маршруты требуют JWT авторизацию
router.use(authenticateToken);

// Просмотр ролей (доступно менеджеру, админу, суперадмину)
router.get('/roles', authorizeRoles('manager', 'admin', 'super_admin'), RoleController.getRoles);

// Просмотр пользователей (доступно админу, суперадмину)
router.get('/users', authorizeRoles('admin', 'super_admin'), RoleController.getUsers);

// Создание нового оператора / пользователя (только admin, super_admin)
router.post('/users', authorizeRoles('admin', 'super_admin'), RoleController.createUser);

// Назначение роли (только admin, super_admin)
router.patch('/users/:userId/role', authorizeRoles('admin', 'super_admin'), RoleController.assignRole);

// Активация / деактивация пользователя (только admin, super_admin)
router.patch('/users/:userId/active', authorizeRoles('admin', 'super_admin'), RoleController.toggleUserActive);

// Обновление прав (разрешенных страниц) пользователя (только admin, super_admin)
router.patch('/users/:userId/permissions', authorizeRoles('admin', 'super_admin'), RoleController.updatePermissions);

// Удаление пользователя (только admin, super_admin)
router.delete('/users/:userId', authorizeRoles('admin', 'super_admin'), RoleController.deleteUser);

module.exports = router;
