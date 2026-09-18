const { pool, isPgConnected, inMemoryStore } = require('../db');

function normalize(row) {
  return {
    id: Number(row.id),
    title: row.title,
    notes: row.notes || '',
    status: row.status || 'open',
    dueAt: row.due_at || row.dueAt || null,
    linkedPhone: row.linked_phone || row.linkedPhone || null,
    linkedUserId: row.linked_user_id ?? row.linkedUserId ?? null,
    createdBy: row.created_by ?? row.createdBy ?? null,
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt,
  };
}

async function listTasks({ userId, status, period }: any = {}) {
  if (isPgConnected() && pool) {
    const params = []; const where = [];
    if (userId) { params.push(Number(userId)); where.push(`(linked_user_id = $${params.length} OR created_by = $${params.length})`); }
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (period === 'today') where.push(`due_at >= CURRENT_DATE AND due_at < CURRENT_DATE + INTERVAL '1 day'`);
    if (period === 'yesterday') where.push(`due_at >= CURRENT_DATE - INTERVAL '1 day' AND due_at < CURRENT_DATE`);
    if (period === 'upcoming') where.push(`due_at >= CURRENT_DATE + INTERVAL '1 day'`);
    const result = await pool.query(`SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY due_at NULLS LAST, id DESC`, params);
    return result.rows.map(normalize);
  }
  return inMemoryStore.tasks
    .filter((task) => !userId || task.linkedUserId === Number(userId) || task.createdBy === Number(userId))
    .filter((task) => !status || task.status === status)
    .filter((task) => {
      if (!period) return true;
      const d = task.dueAt ? new Date(task.dueAt) : null;
      if (!d || Number.isNaN(d.getTime())) return false;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const day = new Date(d); day.setHours(0, 0, 0, 0);
      const diff = Math.round((day.getTime() - today.getTime()) / 86400000);
      return period === 'today' ? diff === 0 : period === 'yesterday' ? diff === -1 : diff >= 1;
    }).map(normalize);
}

async function createTask(input) {
  const data = { title: String(input.title || '').trim(), notes: input.notes || '', status: input.status || 'open', dueAt: input.dueAt || null, linkedPhone: input.linkedPhone || null, linkedUserId: input.linkedUserId ? Number(input.linkedUserId) : null, createdBy: input.createdBy ? Number(input.createdBy) : null };
  if (!data.title) throw new Error('title is required');
  if (isPgConnected() && pool) {
    const r = await pool.query(`INSERT INTO tasks (title,notes,status,due_at,linked_phone,linked_user_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [data.title, data.notes, data.status, data.dueAt, data.linkedPhone, data.linkedUserId, data.createdBy]);
    return normalize(r.rows[0]);
  }
  const now = new Date().toISOString();
  const task = { ...data, id: inMemoryStore.tasks.length + 1, createdAt: now, updatedAt: now };
  inMemoryStore.tasks.push(task);
  return normalize(task);
}

async function updateTask(id, input) {
  const allowed = ['title', 'notes', 'status', 'dueAt', 'linkedPhone', 'linkedUserId'];
  if (isPgConnected() && pool) {
    const sets = []; const values = [];
    for (const key of allowed) if (input[key] !== undefined) {
      const column = { dueAt: 'due_at', linkedPhone: 'linked_phone', linkedUserId: 'linked_user_id' }[key] || key;
      values.push(key === 'linkedUserId' ? (input[key] ? Number(input[key]) : null) : input[key]);
      sets.push(`${column} = $${values.length}`);
    }
    if (!sets.length) return getTask(id);
    values.push(Number(id)); const r = await pool.query(`UPDATE tasks SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`, values);
    return r.rows[0] ? normalize(r.rows[0]) : null;
  }
  const task = inMemoryStore.tasks.find((item) => item.id === Number(id));
  if (!task) return null;
  Object.assign(task, input, { updatedAt: new Date().toISOString() });
  return normalize(task);
}

async function getTask(id) {
  const items = await listTasks();
  return items.find((task) => task.id === Number(id)) || null;
}
async function deleteTask(id) {
  if (isPgConnected() && pool) return (await pool.query('DELETE FROM tasks WHERE id = $1 RETURNING id', [Number(id)])).rowCount > 0;
  const index = inMemoryStore.tasks.findIndex((task) => task.id === Number(id));
  if (index < 0) return false; inMemoryStore.tasks.splice(index, 1); return true;
}
module.exports = { listTasks, getTask, createTask, updateTask, deleteTask };
