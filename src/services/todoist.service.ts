type TodoistTask = {
  id: string;
  content: string;
  description?: string;
  is_completed?: boolean;
  checked?: boolean;
  priority?: number;
  due?: { datetime?: string; date?: string; string?: string } | null;
  labels?: string[];
  project_id?: string;
  url?: string;
};

export type AppTask = {
  id: string | number;
  title: string;
  notes: string;
  status: 'open' | 'in_progress' | 'done' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  dueAt: string | null;
  category: string;
  tags: string[];
  source: 'todoist' | 'local';
  externalId?: string;
  projectId?: string;
  url?: string;
  assigneeId?: number | null;
  linkedUserId?: number | null;
  linkedPhone?: string | null;
  createdBy?: number | null;
  createdAt?: string;
  updatedAt?: string;
  comments?: any[];
};

let cache: { expiresAt: number; value: AppTask[] } | null = null;

function getTodoistToken(): string {
  return String(process.env.TODOIST_API_TOKEN || '').trim();
}

export function isTodoistConfigured(): boolean {
  return Boolean(getTodoistToken());
}

export function clearTodoistCache(): void {
  cache = null;
}

function mapTodoistPriorityToApp(priority?: number): 'low' | 'medium' | 'high' | 'urgent' {
  if (priority === 4) return 'urgent';
  if (priority === 3) return 'high';
  if (priority === 2) return 'medium';
  return 'low';
}

function mapAppPriorityToTodoist(priority?: string): number {
  if (priority === 'urgent') return 4;
  if (priority === 'high') return 3;
  if (priority === 'medium') return 2;
  return 1;
}

function mapToAppTask(task: TodoistTask): AppTask {
  return {
    id: `todoist-${task.id}`,
    title: task.content,
    notes: task.description || '',
    status: (task.checked !== undefined ? task.checked : task.is_completed) ? 'done' : 'open',
    priority: mapTodoistPriorityToApp(task.priority),
    dueAt: task.due?.datetime || task.due?.date || null,
    category: 'Todoist',
    tags: task.labels || [],
    source: 'todoist',
    externalId: task.id,
    projectId: task.project_id,
    url: task.url,
  };
}

export async function listTodoistTasks(): Promise<AppTask[]> {
  const token = getTodoistToken();
  if (!token) throw new Error('TODOIST_API_TOKEN не настроен');
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  const allTasks: TodoistTask[] = [];
  let nextCursor: string | null = null;

  do {
    const url = new URL('https://api.todoist.com/api/v1/tasks');
    url.searchParams.set('limit', '200');
    if (nextCursor) {
      url.searchParams.set('cursor', nextCursor);
    }

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = (await response.json().catch(() => ({}))) as { results?: TodoistTask[]; next_cursor?: string | null; message?: string };
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      throw new Error(
        response.status === 429
          ? `Todoist временно ограничил запросы${retryAfter ? `, повторите через ${retryAfter} сек.` : ''}`
          : data.message || 'Todoist API недоступен'
      );
    }

    if (Array.isArray(data.results)) {
      allTasks.push(...data.results);
    }

    nextCursor = data.next_cursor || null;
  } while (nextCursor);

  const tasks = allTasks.map(mapToAppTask);
  cache = { expiresAt: Date.now() + 45_000, value: tasks };
  return tasks;
}

export async function createTodoistTask(input: {
  title?: string;
  content?: string;
  notes?: string;
  description?: string;
  priority?: string | number;
  dueAt?: string | null;
  dueString?: string | null;
  tags?: string[];
  labels?: string[];
  projectId?: string;
}): Promise<AppTask> {
  const token = getTodoistToken();
  if (!token) throw new Error('TODOIST_API_TOKEN не настроен');

  const content = String(input.content || input.title || '').trim();
  if (!content) throw new Error('title / content is required');

  const payload: any = {
    content,
    description: input.description ?? input.notes ?? '',
  };

  if (typeof input.priority === 'number') {
    payload.priority = input.priority;
  } else if (typeof input.priority === 'string') {
    payload.priority = mapAppPriorityToTodoist(input.priority);
  }

  if (input.dueAt) {
    payload.due_datetime = new Date(input.dueAt).toISOString();
  } else if (input.dueString) {
    payload.due_string = input.dueString;
  }

  const labels = input.labels || input.tags;
  if (Array.isArray(labels) && labels.length > 0) {
    payload.labels = labels;
  }

  if (input.projectId) {
    payload.project_id = input.projectId;
  }

  const response = await fetch('https://api.todoist.com/api/v1/tasks', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || `Ошибка создания задачи Todoist: ${response.status}`);
  }

  clearTodoistCache();
  return mapToAppTask(data as TodoistTask);
}

export async function closeTodoistTask(id: string | number): Promise<boolean> {
  const token = getTodoistToken();
  if (!token) throw new Error('TODOIST_API_TOKEN не настроен');

  const rawId = String(id).replace(/^todoist-/, '');
  const response = await fetch(`https://api.todoist.com/api/v1/tasks/${encodeURIComponent(rawId)}/close`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 204 || response.ok) {
    clearTodoistCache();
    return true;
  }

  if (response.status === 404 || response.status === 409) return false;
  const data = await response.json().catch(() => ({}));
  throw new Error(data?.message || `Ошибка закрытия задачи Todoist: ${response.status}`);
}

export async function deleteTodoistTask(id: string | number): Promise<boolean> {
  const token = getTodoistToken();
  if (!token) throw new Error('TODOIST_API_TOKEN не настроен');

  const rawId = String(id).replace(/^todoist-/, '');
  const response = await fetch(`https://api.todoist.com/api/v1/tasks/${encodeURIComponent(rawId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 204 || response.ok) {
    clearTodoistCache();
    return true;
  }

  if (response.status === 404) return false;
  const data = await response.json().catch(() => ({}));
  throw new Error(data?.message || `Ошибка удаления задачи Todoist: ${response.status}`);
}

export function todoistStatus() {
  return {
    configured: isTodoistConfigured(),
    cached: Boolean(cache && cache.expiresAt > Date.now()),
  };
}
