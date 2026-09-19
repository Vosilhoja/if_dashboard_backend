type TodoistTask = {
  id: string;
  content: string;
  description?: string;
  is_completed?: boolean;
  priority?: number;
  due?: { datetime?: string; date?: string } | null;
  labels?: string[];
  project_id?: string;
  url?: string;
};

let cache: { expiresAt: number; value: unknown[] } | null = null;

export async function listTodoistTasks() {
  const token = String(process.env.TODOIST_API_TOKEN || '').trim();
  if (!token) throw new Error('TODOIST_API_TOKEN не настроен');
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const response = await fetch('https://api.todoist.com/rest/v2/tasks', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await response.json().catch(() => [])) as TodoistTask[] | { message?: string };
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    throw new Error(response.status === 429 ? `Todoist временно ограничил запросы${retryAfter ? `, повторите через ${retryAfter} сек.` : ''}` : (data as { message?: string }).message || 'Todoist API недоступен');
  }
  const tasks = (Array.isArray(data) ? data : []).map((task) => ({
    id: `todoist-${task.id}`,
    title: task.content,
    notes: task.description || '',
    status: task.is_completed ? 'done' : 'open',
    priority: task.priority === 4 ? 'urgent' : task.priority === 3 ? 'high' : task.priority === 2 ? 'medium' : 'low',
    dueAt: task.due?.datetime || task.due?.date || null,
    category: 'Todoist',
    tags: task.labels || [],
    source: 'todoist',
    externalId: task.id,
    projectId: task.project_id,
    url: task.url,
  }));
  cache = { expiresAt: Date.now() + 45_000, value: tasks };
  return tasks;
}

export function todoistStatus() {
  return {
    configured: Boolean(String(process.env.TODOIST_API_TOKEN || '').trim()),
    cached: Boolean(cache && cache.expiresAt > Date.now()),
  };
}
