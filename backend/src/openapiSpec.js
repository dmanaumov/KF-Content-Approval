// OpenAPI (Swagger) description of the API surface an external automation
// (n8n, or anything else) actually touches: the public read-only routes
// already documented in docs/N8N_AUTOMATION.md, plus the whole
// /api/automation/* write surface (see index.js, gated by
// requireAutomationAuth / config.automationApiKey).
//
// Deliberately NOT a full dump of every route in this app — the internal
// staff (staffAuth) and team-cabinet (teamAuth, real Mattermost login)
// routes aren't meant for a third-party integrator and are left out on
// purpose, so this stays a clean, minimal "here's what your automation can
// call" document rather than exposing this app's internal shape.
//
// Served at GET /api/ceo/openapi.json and rendered at GET /ceo/api-docs —
// both behind teamAuth.requireCeoAuth (see index.js), same gate as the /ceo
// dashboard itself. Update this file whenever an /api/automation/* route
// changes shape — nothing regenerates it automatically.

const config = require('./config');

function buildOpenApiSpec() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'КонтентФерма — API для автоматизации публикаций',
      version: '1.0.0',
      description:
        'Эндпоинты, которые реально нужны внешней автоматизации (n8n и подобным): ' +
        'чтение задач/медиа без авторизации (та же публичная выдача, что видит клиент в кабинете), ' +
        'и запись — создание карточек, добавление медиа, перестановка порядка, отметка "опубликовано" — ' +
        'под ключом automationApiKey. Внутренние страницы приложения (стафф, /team) сюда не входят.',
    },
    // No fixed "servers" entry — Swagger UI defaults to the origin it was
    // loaded from, which is correct both on the real domain and if this
    // page is ever opened through a different hostname.
    components: {
      securitySchemes: {
        automationApiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Api-Key',
          description: 'Значение AUTOMATION_API_KEY, заданное в Dokploy. См. комментарий в backend/src/config.js.',
        },
      },
      schemas: {
        Media: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            source: { type: 'string', enum: ['mattermost', 'disk'] },
            shareUrl: { type: 'string', nullable: true },
            fileId: { type: 'string', nullable: true },
            kind: { type: 'string', enum: ['image', 'video', 'file'], nullable: true },
            name: { type: 'string' },
          },
        },
        Task: {
          type: 'object',
          description: 'Нормализованный объект карточки — то же самое, что отдаёт кабинет клиента/команды.',
          properties: {
            id: { type: 'string', description: 'id карточки в Mattermost' },
            title: { type: 'string' },
            status: { type: 'string', enum: ['waiting', 'approved', 'changes', 'published', 'archived'], nullable: true },
            statusLabel: { type: 'string', description: 'сырой текст опции "Статус" в Mattermost' },
            network: { type: 'string', enum: ['ig', 'tg', 'vk', 'ok', 'max'], nullable: true, description: 'только в GET /api/automation/tasks — разобрано из префикса названия' },
            recommendedPublishTime: { type: 'string', nullable: true, example: '10:00', description: 'только в GET /api/automation/tasks — из project_settings.publish_time_msk' },
            publishDate: { type: 'string', format: 'date', nullable: true },
            caption: { type: 'string', description: 'текст поста' },
            media: { type: 'array', items: { $ref: '#/components/schemas/Media' } },
            feedback: { type: 'string', nullable: true, description: 'текст последней правки клиента — только пока status=changes' },
            clientComments: {
              type: 'array',
              description: 'вся переписка с клиентом по карточке (согласовал/правки/сообщения агентства), по возрастанию времени',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  kind: { type: 'string', enum: ['approved', 'feedback', 'agency', 'correction'] },
                  text: { type: 'string' },
                  imageUrl: { type: 'string', nullable: true },
                  createdAt: { type: 'integer', description: 'epoch ms' },
                },
              },
            },
            projectId: { type: 'string', nullable: true },
            projectLabel: { type: 'string', nullable: true },
            url: { type: 'string', description: 'ссылка на опубликованный пост, если уже проставлена' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
      responses: {
        Unauthorized: {
          description: 'Неверный или отсутствующий X-Api-Key',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
    paths: {
      '/api/boards/{boardId}/tasks': {
        get: {
          summary: 'Задачи проекта (публично, без авторизации)',
          description:
            'Та же выдача, что видит клиент в своём кабинете — по одному проекту за раз. ' +
            `boardId для этого проекта всегда один и тот же: ${config.mattermostBoardId || '(не задан в MATTERMOST_BOARD_ID)'}.`,
          parameters: [
            { name: 'boardId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'project', in: 'query', required: true, schema: { type: 'string' }, description: 'id опции свойства "Проект"' },
          ],
          responses: {
            200: {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object', properties: { tasks: { type: 'array', items: { $ref: '#/components/schemas/Task' } } } } } },
            },
          },
        },
      },
      '/api/disk-embed': {
        get: {
          summary: 'Скачать байты медиа с disk.kontentferma (публично)',
          parameters: [{ name: 'u', in: 'query', required: true, schema: { type: 'string' }, description: 'shareUrl из media[].shareUrl, URL-encoded' }],
          responses: { 200: { description: 'Байты файла (поддерживает Range)' } },
        },
      },
      '/api/files/{boardId}/{fileId}': {
        get: {
          summary: 'Скачать байты медиа, прикреплённого прямо в Mattermost (публично)',
          parameters: [
            { name: 'boardId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'fileId', in: 'path', required: true, schema: { type: 'string' }, description: 'media[].fileId' },
          ],
          responses: { 200: { description: 'Байты файла (поддерживает Range)' } },
        },
      },
      '/api/automation/projects': {
        get: {
          summary: 'Список проектов (клиентов) + их параметры для автоматизации',
          security: [{ automationApiKey: [] }],
          responses: {
            200: {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      projects: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            label: { type: 'string' },
                            publishTimeMsk: { type: 'string', nullable: true, example: '10:00' },
                            postsPerMonth: { type: 'string', nullable: true },
                            projectManager: { type: 'string', nullable: true },
                            startDate: { type: 'string', nullable: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/api/automation/tasks': {
        get: {
          summary: 'Карточки по проекту и статусу',
          description:
            'Общий метод выборки — не только "на публикацию". status обязателен: либо один из коротких кодов ' +
            '(waiting/changes/approved/published/archived), либо точный текст опции "Статус" в Mattermost (для ' +
            'внутренних стадий вроде "В процессе"). project — необязателен (без него — по всем клиентам). ' +
            'date — необязательная доп. фильтрация по дате публикации ("today" или YYYY-MM-DD); например ' +
            'status=approved&date=today даёт ровно то, что нужно для ежедневной публикации. Каждая карточка ' +
            'всегда приходит полностью укомплектованной: network + recommendedPublishTime (для публикации), ' +
            'clientComments + feedback — вся переписка с клиентом (для статуса "на редактировании"/changes).',
          security: [{ automationApiKey: [] }],
          parameters: [
            { name: 'project', in: 'query', required: false, schema: { type: 'string' }, description: 'id опции свойства "Проект"; без параметра — по всем' },
            { name: 'status', in: 'query', required: true, schema: { type: 'string' }, example: 'changes', description: 'waiting/changes/approved/published/archived, либо точный текст статуса Mattermost' },
            { name: 'date', in: 'query', required: false, schema: { type: 'string' }, example: 'today', description: '"today" или YYYY-MM-DD — фильтр по дате публикации' },
          ],
          responses: {
            200: {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'object', properties: { tasks: { type: 'array', items: { $ref: '#/components/schemas/Task' } } } } } },
            },
            400: { description: 'status не указан или date некорректна', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
        post: {
          summary: 'Создать новую карточку с нуля',
          security: [{ automationApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title', 'projectId'],
                  properties: {
                    title: { type: 'string', description: 'без префикса соцсети' },
                    network: { type: 'string', enum: ['ig', 'tg', 'vk', 'ok', 'max'] },
                    projectId: { type: 'string', description: 'id опции свойства "Проект", см. GET /api/automation/projects' },
                    text: { type: 'string', description: 'текст поста' },
                    publishDate: { type: 'string', format: 'date' },
                    status: { type: 'string', description: 'точный текст опции "Статус"; если не задан — статус остаётся пустым' },
                    media: { type: 'array', items: { type: 'string' }, description: 'готовые ссылки disk.kontentferma' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Создано', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' } } } } } },
            400: { description: 'Неверные параметры', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/api/automation/tasks/{taskId}/media-link': {
        post: {
          summary: 'Прикрепить уже готовую ссылку disk.kontentferma к карточке',
          security: [{ automationApiKey: [] }],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } } } } },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' } } } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/api/automation/tasks/{taskId}/media-upload': {
        post: {
          summary: 'Загрузить файл напрямую (multipart) — требует DISK_WEBDAV_* в Dokploy',
          security: [{ automationApiKey: [] }],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' } } } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
            501: { description: 'DISK_WEBDAV_* не настроены' },
          },
        },
      },
      '/api/automation/tasks/{taskId}/media-order': {
        post: {
          summary: 'Задать порядок показа медиа',
          security: [{ automationApiKey: [] }],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['order'], properties: { order: { type: 'array', items: { type: 'string' }, description: 'ПОЛНЫЙ список id из текущего media[], в нужном порядке' } } } } },
          },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' } } } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
            409: { description: 'order устарел (медиа на карточке изменилось) — перечитайте карточку и повторите' },
          },
        },
      },
      '/api/automation/tasks/{taskId}/publish': {
        post: {
          summary: 'Отметить карточку опубликованной + записать ссылку на пост',
          security: [{ automationApiKey: [] }],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } } } } },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' } } } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
    },
  };
}

module.exports = { buildOpenApiSpec };
