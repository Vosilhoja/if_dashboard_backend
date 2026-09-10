FROM node:20-alpine

WORKDIR /app

# Копируем зависимости
COPY package*.json ./

# Устанавливаем production зависимости
RUN npm ci --only=production

# Копируем исходный код
COPY . .

# Переменные окружения
ENV NODE_ENV=production
ENV PORT=5000

# Открываем порт
EXPOSE 5000

# Запуск безопасного сервера
CMD ["node", "src/server.js"]
