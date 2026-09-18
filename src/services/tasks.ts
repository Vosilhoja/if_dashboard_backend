const { pool, isPgConnected, inMemoryStore } = require('../db');

function normalize(row) {
  const tagsRaw = row.tags || row.tagsRaw || [];
  const commentsRaw = row.comments || row.commentsRaw || [];
  return {
    id: Number(row.id),
    title: row.title,
    notes: row.notes || '',
    status: row.status || 'open',
    priority: row.priority || 'medium',
    assigneeId: row.assignee_id ?? row.assigneeId ?? null,
    category: row.category || null,
    tags: Array.isArray(tagsRaw) ? tagsRaw : [],
    comments: Array.isArray(commentsRaw) ? commentsRaw : [],
    dueAt: row.due_at || row.dueAt || null,
    linkedPhone: row.linked_phone || row.linkedPhone || null,
    linkedUserId: row.linked_user_id ?? row.linkedUserId ?? null,
    createdBy: row.created_by ?? row.createdBy ?? null,
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt,
  };
}

async function listTasks({ userId, status, period, priority, category, assignee, q, tags, sort, sortDir }: any = {}) {
  if (isPgConnected() && pool) {
    const params = [];
    const where = [];
    if (userId) {
      params.push(Number(userId));
      where.push(`(linked_user_id = $${params.length} OR created_by = $${params.length})`);
    }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (priority) { params.push(priority); where.push(`priority = $${params.length}`); }
    if (category) { params.push(category); where.push(`category = $${params.length}`); }
    if (assignee) { params.push(Number(assignee)); where.push(`assignee_id = $${params.length}`); }
    if (q) {
      params.push(`%${String(q).replace(/%/g, '%%')}%`);
      where.push(`(title ILIKE $${params.length} OR notes ILIKE $${params.length} OR linked_phone ILIKE $${params.length} OR category ILIKE $${params.length})`);
    }
    if (tags && tags.length) {
      params.push(Array.isArray(tags) ? tags : [tags]);
      where.push(`tags && $${params.length}::text[]`);
    }
    if (period === 'today') where.push(`due_at >= CURRENT_DATE AND due_at < CURRENT_DATE + INTERVAL '1 day'`);
    if (period === 'yesterday') where.push(`due_at >= CURRENT_DATE - INTERVAL '1 day' AND due_at < CURRENT_DATE`);
    if (period === 'upcoming') where.push(`due_at >= CURRENT_DATE + INTERVAL '1 day'`);
    if (period === 'overdue') where.push(`due_at < CURRENT_TIMESTAMP AND status NOT IN ('done','cancelled')`);

    const allowedSorts = { id: 'id', dueAt: 'due_at', createdAt: 'created_at', priority: "CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END", status: 'status', category: 'category' };
    const orderExpr = allowedSorts[sort as string] || 'due_at';
    const dir = (sortDir || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    const priorityExpr = `CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END`;

    const result = await pool.query(
      `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderExpr} ${dir} NULLS LAST, ${priorityExpr} ASC, id DESC`,
      params
    );
    return result.rows.map(normalize);
  }
  return inMemoryStore.tasks
    .filter((task) => !userId || task.linkedUserId === Number(userId) || task.createdBy === Number(userId))
    .filter((task) => !status || task.status === status)
    .filter((task) => !priority || task.priority === priority)
    .filter((task) => !category || task.category === category)
    .filter((task) => !assignee || task.assigneeId === Number(assignee))
    .filter((task) => {
      if (!q) return true;
      const query = String(q).toLowerCase();
      return [task.title, task.notes, task.linkedPhone, task.category].some(v => v && String(v).toLowerCase().includes(query));
    })
    .filter((task) => {
      if (!tags || !tags.length) return true;
      const arr = Array.isArray(tags) ? tags : [tags];
      return arr.some((t) => (task.tags || []).includes(t));
    })
    .filter((task) => {
      if (!period) return true;
      const d = task.dueAt ? new Date(task.dueAt) : null;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (period === 'overdue') {
        if (!d || Number.isNaN(d.getTime())) return false;
        return d.getTime() < Date.now() && !['done', 'cancelled'].includes(task.status);
      }
      if (!d || Number.isNaN(d.getTime())) return false;
      const day = new Date(d); day.setHours(0, 0, 0, 0);
      const diff = Math.round((day.getTime() - today.getTime()) / 86400000);
      return period === 'today' ? diff === 0 : period === 'yesterday' ? diff === -1 : diff >= 1;
    })
    .sort((a, b) => {
      const prOrder = { urgent: 0, high: 1, medium: 2, low: 3 } as const;
      const sortDirection = (sortDir || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      if (sort === 'priority') {
        const d = (prOrder[a.priority as keyof typeof prOrder] ?? 5) - (prOrder[b.priority as keyof typeof prOrder] ?? 5);
        return sortDirection === 'DESC' ? -d : d;
      }
      if (sort === 'id') return sortDirection === 'DESC' ? b.id - a.id : a.id - b.id;
      const aT = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
      const bT = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
      const d = sortDirection === 'DESC' ? bT - aT : aT - bT;
      return d || (prOrder[a.priority as keyof typeof prOrder] ?? 5) - (prOrder[b.priority as keyof typeof prOrder] ?? 5) || b.id - a.id;
    })
    .map(normalize);
}

async function createTask(input) {
  const data = {
    title: String(input.title || '').trim(),
    notes: input.notes || '',
    status: input.status || 'open',
    priority: input.priority || 'medium',
    assigneeId: input.assigneeId ? Number(input.assigneeId) : null,
    category: input.category || null,
    tags: Array.isArray(input.tags) ? input.tags : [],
    comments: Array.isArray(input.comments) ? input.comments : [],
    dueAt: input.dueAt || null,
    linkedPhone: input.linkedPhone || null,
    linkedUserId: input.linkedUserId ? Number(input.linkedUserId) : null,
    createdBy: input.createdBy ? Number(input.createdBy) : null,
  };
  if (!data.title) throw new Error('title is required');
  if (isPgConnected() && pool) {
    const r = await pool.query(
      `INSERT INTO tasks (title,notes,status,priority,assignee_id,category,tags,comments,due_at,linked_phone,linked_user_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::jsonb,$9,$10,$11,$12) RETURNING *`,
      [data.title, data.notes, data.status, data.priority, data.assigneeId, data.category, data.tags, JSON.stringify(data.comments), data.dueAt, data.linkedPhone, data.linkedUserId, data.createdBy]
    );
    return normalize(r.rows[0]);
  }
  const now = new Date().toISOString();
  const task = { ...data, id: inMemoryStore.tasks.length + 1, createdAt: now, updatedAt: now };
  inMemoryStore.tasks.push(task);
  return normalize(task);
}

async function updateTask(id, input) {
  const allowed = ['title', 'notes', 'status', 'priority', 'assigneeId', 'category', 'tags', 'comments', 'dueAt', 'linkedPhone', 'linkedUserId'];
  if (isPgConnected() && pool) {
    const sets = []; const values = [];
    for (const key of allowed) if (input[key] !== undefined) {
      const columnMap: any = { dueAt: 'due_at', linkedPhone: 'linked_phone', linkedUserId: 'linked_user_id', assigneeId: 'assignee_id' };
      const column = columnMap[key] || key;
      let val = input[key];
      if (key === 'linkedUserId' || key === 'assigneeId') val = val ? Number(val) : null;
      if (key === 'tags') { values.push(Array.isArray(val) ? val : []); sets.push(`${column} = $${values.length}::text[]`); continue; }
      if (key === 'comments') { values.push(JSON.stringify(Array.isArray(val) ? val : [])); sets.push(`${column} = $${values.length}::jsonb`); continue; }
      values.push(val);
      sets.push(`${column} = $${values.length}`);
    }
    if (!sets.length) return getTask(id);
    values.push(Number(id));
    const r = await pool.query(`UPDATE tasks SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`, values);
    return r.rows[0] ? normalize(r.rows[0]) : null;
  }
  const task = inMemoryStore.tasks.find((item) => item.id === Number(id));
  if (!task) return null;
  Object.assign(task, input, { updatedAt: new Date().toISOString() });
  return normalize(task);
}

async function bulkUpdate(ids: number[], patch: any) {
  if (!ids || !ids.length) return { updated: 0 };
  if (isPgConnected() && pool) {
    const values = []; const sets = []; const allowed = ['status', 'priority', 'assigneeId', 'category'];
    for (const key of allowed) if (patch[key] !== undefined) {
      const columnMap: any = { assigneeId: 'assignee_id' };
      const column = columnMap[key] || key;
      let val = patch[key];
      if (key === 'assigneeId') val = val ? Number(val) : null;
      values.push(val); sets.push(`${column} = $${values.length}`);
    }
    if (!sets.length) return { updated: 0 };
    const placeholders = ids.map((_, i) => `$${values.length + 1 + i}`).join(',');
    ids.forEach((id) => values.push(Number(id)));
    const r = await pool.query(
      `UPDATE tasks SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      values
    );
    return { updated: r.rowCount || 0 };
  }
  let count = 0;
  for (const id of ids) {
    const task = inMemoryStore.tasks.find((t) => t.id === Number(id));
    if (task) { Object.assign(task, patch, { updatedAt: new Date().toISOString() }); count++; }
  }
  return { updated: count };
}

async function addComment(id, comment: { authorId: number; text: string }) {
  const task = await getTask(id);
  if (!task) return null;
  const newComment = { id: Date.now(), authorId: comment.authorId, text: comment.text, createdAt: new Date().toISOString() };
  const comments = [...(task.comments || []), newComment];
  return updateTask(id, { comments });
}

async function getTask(id) {
  const items = await listTasks({});
  return items.find((task) => task.id === Number(id)) || null;
}

async function deleteTask(id) {
  if (isPgConnected() && pool) return (await pool.query('DELETE FROM tasks WHERE id = $1 RETURNING id', [Number(id)])).rowCount > 0;
  const index = inMemoryStore.tasks.findIndex((task) => task.id === Number(id));
  if (index < 0) return false; inMemoryStore.tasks.splice(index, 1); return true;
}

module.exports = { listTasks, getTask, createTask, updateTask, deleteTask, bulkUpdate, addComment };
