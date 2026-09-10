const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

// Тестовое хранилище данных / записей дашборда
let dashboardItems = [
  { id: 1, title: 'Реестр обращений колл-центра', category: 'calls', total: 1540, status: 'active' },
  { id: 2, title: 'Воронка SMS верификаций', category: 'sms', total: 1280, status: 'synced' },
  { id: 3, title: 'Региональная база респондентов', category: 'respondents', total: 890, status: 'ready' }
];

/**
 * GET /api/data
 * Получение списка данных (доступно всем авторизованным пользователям)
 */
router.get('/', authenticateToken, (req, res) => {
  res.status(200).json({
    status: 'success',
    user: {
      username: req.user.username,
      role: req.user.role
    },
    count: dashboardItems.length,
    items: dashboardItems
  });
});

/**
 * POST /api/data
 * Добавление новой записи (доступно менеджеру, админу, суперадмину)
 */
router.post('/', authenticateToken, authorizeRoles('manager', 'admin', 'super_admin'), (req, res) => {
  const { title, category, total } = req.body;
  if (!title) {
    return res.status(400).json({ status: 'fail', error: 'Поле title обязательно' });
  }

  const newItem = {
    id: dashboardItems.length + 1,
    title,
    category: category || 'general',
    total: Number(total) || 0,
    status: 'new',
    createdAt: new Date()
  };

  dashboardItems.push(newItem);

  res.status(201).json({
    status: 'success',
    message: 'Запись успешно создана',
    item: newItem
  });
});

/**
 * DELETE /api/data/:id
 * Удаление записи (доступно только admin и super_admin)
 */
router.delete('/:id', authenticateToken, authorizeRoles('admin', 'super_admin'), (req, res) => {
  const id = Number(req.params.id);
  const index = dashboardItems.findIndex(item => item.id === id);

  if (index === -1) {
    return res.status(404).json({ status: 'fail', error: 'Запись не найдена' });
  }

  const deleted = dashboardItems.splice(index, 1);
  res.status(200).json({
    status: 'success',
    message: `Запись с id ${id} удалена`,
    item: deleted[0]
  });
});

module.exports = router;
