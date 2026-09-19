const express = require('express');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const tasks = require('../services/tasks');
const {
  isTodoistConfigured,
  listTodoistTasks,
  createTodoistTask,
  closeTodoistTask,
  deleteTodoistTask,
  clearTodoistCache,
} = require('../services/todoist.service');

const router = express.Router();

router.use(authenticateToken);

// Helper check for role permission to modify tasks
function canManageTasks(user) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  if (Array.isArray(user.permissions) && (user.permissions.includes('*') || user.permissions.includes('bot_manage_tasks') || user.permissions.includes('manage_operators'))) {
    return true;
  }
  return ['super_admin', 'admin', 'manager', 'operator'].includes(user.role);
}

// GET /api/tasks
router.get('/', async (req, res, next) => {
  try {
    if (req.query.source === 'todoist') {
      return res.json({ tasks: await listTodoistTasks() });
    }
    const tags = req.query.tags ? (Array.isArray(req.query.tags) ? req.query.tags : [req.query.tags]) : undefined;
    const result = await tasks.listTasks({
      userId: req.query.mine === '1' ? req.user.id : undefined,
      status: req.query.status,
      period: req.query.period || req.query.range,
      priority: req.query.priority,
      category: req.query.category,
      assignee: req.query.assignee,
      q: req.query.q,
      tags,
      sort: req.query.sort,
      sortDir: req.query.sortDir,
      source: req.query.source,
    });
    res.json({ tasks: result });
  } catch (e) {
    next(e);
  }
});

// POST /api/tasks
router.post('/', async (req, res, next) => {
  try {
    if (!canManageTasks(req.user)) {
      return res.status(403).json({ error: 'Доступ запрещен: недостаточно прав для создания задач' });
    }

    const isTodoist = req.body.source === 'todoist' || (!req.body.source && isTodoistConfigured());

    if (isTodoist) {
      const created = await createTodoistTask({
        title: req.body.title,
        content: req.body.content || req.body.title,
        notes: req.body.notes || req.body.description,
        priority: req.body.priority,
        dueAt: req.body.dueAt,
        tags: req.body.tags,
        projectId: req.body.projectId,
      });
      return res.status(201).json(created);
    }

    const created = await tasks.createTask({
      ...req.body,
      createdBy: req.user.id,
      linkedUserId: req.body.linkedUserId || req.user.id,
    });
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

// POST /api/tasks/:id/close
router.post('/:id/close', async (req, res, next) => {
  try {
    if (!canManageTasks(req.user)) {
      return res.status(403).json({ error: 'Доступ запрещен: недостаточно прав для закрытия задач' });
    }

    const id = req.params.id;
    const isTodoist = String(id).startsWith('todoist-') || req.query.source === 'todoist';

    if (isTodoist) {
      const success = await closeTodoistTask(id);
      if (!success) return res.status(404).json({ error: 'Todoist task not found' });
      return res.json({ success: true, id, status: 'done' });
    }

    const updated = await tasks.closeTask(id);
    if (!updated) return res.status(404).json({ error: 'Task not found' });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

// POST /api/tasks/bulk
router.post('/bulk', async (req, res, next) => {
  try {
    if (!canManageTasks(req.user)) {
      return res.status(403).json({ error: 'Доступ запрещен: недостаточно прав для обновления задач' });
    }
    const { ids, patch } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    const result = await tasks.bulkUpdate(ids, patch || {});
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// GET /api/tasks/:id
router.get('/:id', async (req, res, next) => {
  try {
    const task = await tasks.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/tasks/:id
router.patch('/:id', async (req, res, next) => {
  try {
    if (!canManageTasks(req.user)) {
      return res.status(403).json({ error: 'Доступ запрещен: недостаточно прав для изменения задач' });
    }
    const id = req.params.id;
    if (String(id).startsWith('todoist-') && req.body.status === 'done') {
      const success = await closeTodoistTask(id);
      if (!success) return res.status(404).json({ error: 'Todoist task not found' });
      return res.json({ id, ...req.body, status: 'done' });
    }
    const task = await tasks.updateTask(id, req.body);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (e) {
    next(e);
  }
});

// PUT /api/tasks/:id
router.put('/:id', async (req, res, next) => {
  try {
    if (!canManageTasks(req.user)) {
      return res.status(403).json({ error: 'Доступ запрещен: недостаточно прав для изменения задач' });
    }
    const task = await tasks.updateTask(req.params.id, req.body);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (e) {
    next(e);
  }
});

// POST /api/tasks/:id/comments
router.post('/:id/comments', async (req, res, next) => {
  try {
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
    const task = await tasks.addComment(req.params.id, { authorId: req.user.id, text: String(text).trim() });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res, next) => {
  try {
    if (!canManageTasks(req.user)) {
      return res.status(403).json({ error: 'Доступ запрещен: недостаточно прав для удаления задач' });
    }

    const id = req.params.id;
    const isTodoist = String(id).startsWith('todoist-') || req.query.source === 'todoist';

    if (isTodoist) {
      const success = await deleteTodoistTask(id);
      if (!success) return res.status(404).json({ error: 'Todoist task not found' });
      return res.status(204).end();
    }

    if (!(await tasks.deleteTask(id))) return res.status(404).json({ error: 'Task not found' });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;
