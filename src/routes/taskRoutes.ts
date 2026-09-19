const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const tasks = require('../services/tasks');
const { listTodoistTasks } = require('../services/todoist.service');
const router = express.Router();

router.use(authenticateToken);

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
    });
    res.json({ tasks: result });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const created = await tasks.createTask({
      ...req.body,
      createdBy: req.user.id,
      linkedUserId: req.body.linkedUserId || req.user.id,
    });
    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.post('/bulk', async (req, res, next) => {
  try {
    const { ids, patch } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    const result = await tasks.bulkUpdate(ids, patch || {});
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const task = await tasks.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const task = await tasks.updateTask(req.params.id, req.body);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const task = await tasks.updateTask(req.params.id, req.body);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (e) { next(e); }
});

router.post('/:id/comments', async (req, res, next) => {
  try {
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
    const task = await tasks.addComment(req.params.id, { authorId: req.user.id, text: String(text).trim() });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!(await tasks.deleteTask(req.params.id))) return res.status(404).json({ error: 'Task not found' });
    res.status(204).end();
  } catch (e) { next(e); }
});

module.exports = router;
