# ГдеКод — Parser
# Образ для Azure Container Instances
# Используем готовый официальный образ Playwright — там уже Chromium + все зависимости

FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app

# Устанавливаем зависимости
COPY package*.json ./
RUN npm ci --omit=dev

# Копируем исходники
COPY checker.js     ./
COPY reporter.js    ./
COPY queue.js       ./
COPY scheduler.js   ./
COPY merchants/     ./merchants/

# Не root для безопасности
RUN groupadd -r parser && useradd -r -g parser parser \
    && chown -R parser:parser /app
USER parser

# Запускаем scheduler — tier передаётся через ENV
ENV PARSER_TIER=1
ENV NODE_ENV=production

CMD ["node", "scheduler.js"]
