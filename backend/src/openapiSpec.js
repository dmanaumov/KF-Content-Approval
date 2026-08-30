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
        'Эндпоинты, которые реально нужны внешней автоматизации: ' +
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
        googleDocsApiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Google-Docs-Key',
          description: 'Значение GOOGLE_DOCS_API_KEY, заданное в Dokploy — отдельный секрет для Google-Docs-интеграции. См. комментарий в backend/src/config.js.',
        },
        botApiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Bot-Key',
          description: 'Значение BOT_API_KEY, заданное в Dokploy — отдельный секрет для ИИ/контент-бота, который регистрирует свои каналы. См. комментарий в backend/src/config.js.',
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
            caption: { type: 'string', description: 'текст поста (тело — не путать с keywords ниже)' },
            keywords: { type: 'string', description: 'ключевые слова/мысли — отдельное поле-бриф для команды, клиенту не показывается, не текст поста' },
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
        BotChat: {
          type: 'object',
          description: 'Один чат/канал, где когда-либо был или сейчас есть бот — см. POST /api/bot/channels.',
          properties: {
            chat_id: { type: 'string' },
            chat_type: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string' },
            added_by_user_id: { type: 'string' },
            added_by_name: { type: 'string' },
            added_by_username: { type: 'string' },
            first_seen_at: { type: 'string', format: 'date-time' },
            status_updated_at: { type: 'string', format: 'date-time' },
          },
        },
        BotMessage: {
          type: 'object',
          description: 'Одно сообщение в переписке бота — входящее или исходящее (см. POST /api/bot/messages и очередь /api/bot/messages/outgoing).',
          properties: {
            id: { type: 'integer' },
            chat_id: { type: 'string' },
            direction: { type: 'string', enum: ['in', 'out'] },
            status: { type: 'string', description: "in: всегда 'received'; out: 'pending' → 'sent'/'failed'" },
            telegram_message_id: { type: 'string' },
            from_user_id: { type: 'string' },
            from_name: { type: 'string' },
            from_username: { type: 'string' },
            text: { type: 'string' },
            sent_by: { type: 'string', description: 'для исходящих — имя CEO, поставившего сообщение в очередь' },
            error: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
            sent_at: { type: 'string', format: 'date-time', nullable: true },
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
                            isAiProject: { type: 'boolean', description: 'Staff-set "ИИ-проект" checkbox from the edit popup.' },
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
      '/api/automation/projects/{projectId}/credentials': {
        get: {
          summary: 'Реальные креды публикации соцсетей для ОДНОГО проекта (опционально — для ОДНОЙ сети)',
          description:
            'Единственный эндпоинт автоматизации, который отдаёт настоящие секреты (то, что заполнено в попапе ' +
            '"Редактировать" на /projects). Одна выдача — один проект: нельзя одним вызовом получить креды сразу ' +
            'всех клиентов. Без параметра network — отдаёт объект со всеми настроенными сетями сразу (ключи из ' +
            'ig/tg/vk/ok/max, только реально заполненные). С параметром network — отдаёт креды ТОЛЬКО этой сети ' +
            '(меньше данных за вызов, если публикатор и так уже знает, в какую сеть публикует). Формат содержимого ' +
            'каждой сети — на усмотрение разработчика автоматизации. Никогда не логируется даже при включённом ' +
            'DEBUG_MATTERMOST.',
          security: [{ automationApiKey: [] }],
          parameters: [
            { name: 'projectId', in: 'path', required: true, schema: { type: 'string' }, description: 'id опции свойства "Проект", см. GET /api/automation/projects' },
            { name: 'network', in: 'query', required: false, schema: { type: 'string', enum: ['ig', 'tg', 'vk', 'ok', 'max'] }, description: 'если задан — отдать креды только этой сети, а не всех сразу' },
          ],
          responses: {
            200: {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      projectId: { type: 'string' },
                      network: { type: 'string', enum: ['ig', 'tg', 'vk', 'ok', 'max'], description: 'присутствует в ответе, только если был передан в запросе' },
                      credentials: {
                        description:
                          'БЕЗ network в запросе — объект с ключами ig/tg/vk/ok/max (только заполненные). ' +
                          'С network в запросе — объект с кредами именно этой сети напрямую (не вложен под ключ сети ' +
                          'ещё раз), либо null, если для этой сети у проекта ничего не настроено.',
                        oneOf: [
                          { type: 'object', additionalProperties: true, example: { ig: { accessToken: '...', igUserId: '...' }, tg: { botToken: '...', chatId: '...' } } },
                          { type: 'object', additionalProperties: true, example: { accessToken: '...', igUserId: '...' } },
                          { type: 'null' },
                        ],
                      },
                    },
                  },
                },
              },
            },
            400: { description: 'projectId не указан/не найден, либо network не из списка ig/tg/vk/ok/max', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/api/automation/projects/{projectId}/settings': {
        get: {
          summary: 'Настройки и промты ОДНОГО проекта (не креды)',
          description:
            'isAiProject, projectManager, startDate, postsPerMonth, publishTimeMsk и четыре промта генерации ' +
            '(strategyPrompt/planningPrompt/postPrompt/imagePrompt) — то, что заполнено в попапе "Редактировать" ' +
            'на /projects. НЕ включает socialCredentials (отдельный эндпоинт /credentials выше) и logoUrl/токен ' +
            'ссылки (staff-only). Незаполненные текстовые поля приходят пустой строкой, это не ошибка.',
          security: [{ automationApiKey: [] }],
          parameters: [{ name: 'projectId', in: 'path', required: true, schema: { type: 'string' }, description: 'id опции свойства "Проект", см. GET /api/automation/projects' }],
          responses: {
            200: {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      projectId: { type: 'string' },
                      isAiProject: { type: 'boolean' },
                      projectManager: { type: 'string', nullable: true },
                      startDate: { type: 'string', nullable: true },
                      postsPerMonth: { type: 'string', nullable: true },
                      publishTimeMsk: { type: 'string', nullable: true, example: '10:00' },
                      strategyPrompt: { type: 'string' },
                      planningPrompt: { type: 'string' },
                      postPrompt: { type: 'string' },
                      imagePrompt: { type: 'string' },
                    },
                  },
                },
              },
            },
            400: { description: 'projectId не указан/не найден', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/api/automation/tasks/{taskId}': {
        get: {
          summary: 'Одна карточка по id, в её текущем полном составе',
          description:
            'title (тема/заголовок), caption (текст поста), keywords (ключевые слова/мысли), media[] (в порядке ' +
            'клиента), status/statusLabel, publishDate, projectId/projectLabel, url и т.д. — то же самое, что одна ' +
            'запись из GET /api/automation/tasks, но без необходимости знать заранее проект/статус/дату карточки. ' +
            'Ищет карточку в ЛЮБОМ статусе, включая внутренние производственные стадии.',
          security: [{ automationApiKey: [] }],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' } } } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
            404: { description: 'Карточка не найдена', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/api/automation/tasks/{taskId}/text': {
        post: {
          summary: 'Заменить ТЕКСТ поста (тело) на существующей карточке',
          description:
            'Перезаписывает caption (содержимое карточки — то же, что отдаёт GET .../tasks как caption). НЕ трогает ' +
            'title (тему) и НЕ трогает keywords (ключевые слова) — для них POST .../keywords ниже. Ответ включает ' +
            'bytesSaved — UTF-8 размер СОХРАНЁННОГО текста в байтах, посчитан после повторного чтения карточки, а ' +
            'не эхо запроса — так можно подтвердить, что сохранение реально прошло и ничего не обрезалось.',
          security: [{ automationApiKey: [] }],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string', description: 'новый текст поста, непустой' } } } } } },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' }, bytesSaved: { type: 'integer', description: 'UTF-8 размер task.caption в байтах после сохранения, из свежего чтения карточки' } } } } } },
            400: { description: 'text пустой', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
            502: { description: 'Сбой записи в Mattermost', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/api/automation/tasks/{taskId}/keywords': {
        post: {
          summary: 'Заменить ключевые слова/мысли на существующей карточке',
          description:
            'Перезаписывает отдельное свойство "Ключевые слова/мысли" — НЕ текст поста (caption) и не title. ' +
            'Пустая строка разрешена (способ очистить поле). Команда/агентство-only, клиенту не показывается.',
          security: [{ automationApiKey: [] }],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string', description: 'новые ключевые слова/мысли, может быть пустой строкой' } } } } } },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' } } } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
            502: { description: 'Сбой записи в Mattermost', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
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
                    text: { type: 'string', description: 'текст поста (тело)' },
                    keywords: { type: 'string', description: 'ключевые слова/мысли — отдельное поле-бриф, не текст поста' },
                    publishDate: { type: 'string', format: 'date' },
                    status: { type: 'string', description: 'точный текст опции "Статус"; если не задан — статус остаётся пустым' },
                    media: { type: 'array', items: { type: 'string' }, description: 'готовые ссылки disk.kontentferma' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Создано', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' }, bytesSaved: { type: 'integer', description: 'UTF-8 размер task.caption в байтах, посчитан ПОСЛЕ повторного чтения карточки — подтверждает, что текст поста реально сохранился, а не эхо запроса' } } } } } },
            400: { description: 'Неверные параметры', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/api/automation/tasks/{taskId}/status': {
        post: {
          summary: 'Перевести карточку в ЛЮБОЙ статус (не только 5 клиентских)',
          description:
            'Например, перевести только что сгенерированную карточку из внутренней стадии в "На согласование". ' +
            'Принимает точный текст ЛЮБОЙ опции свойства "Статус" в Mattermost — не только 5 клиентских ' +
            '(waiting/changes/approved/published/archived), но и внутренние производственные стадии ("В процессе" ' +
            'и т.п.), так же как статус-контрол в кабинете команды. Это ДРУГОЙ метод, чем POST .../text (текст ' +
            'поста) и POST .../publish (специальный одноразовый переход в "ОПУБЛИКОВАНО" + запись ссылки) — для ' +
            'любого ОСТАЛЬНОГО перехода статуса используйте именно этот.',
          security: [{ automationApiKey: [] }],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', description: 'точный текст опции свойства "Статус" в Mattermost, например "На согласование"' } } } } },
          },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' } } } } } },
            400: { description: 'status не указан', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
            502: { description: 'Опция не найдена на борде, либо сбой записи в Mattermost', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/api/automation/tasks/{taskId}/client-message': {
        post: {
          summary: 'Добавить сообщение в чат С КЛИЕНТОМ (по карточке)',
          description:
            'ДРУГОЕ, чем любой другой комментарий, который оставляет автоматизация (КАРТОЧКА СОЗДАНА/ТЕКСТ ОБНОВЛЁН/' +
            'СТАТУС ИЗМЕНЁН и т.п.) — те внутренние, staff-only, клиент их не видит. Этот метод пишет прямо в чат с ' +
            'клиентом (то же самое, что вкладка "Чат с клиентом" в кабинете команды) — сообщение появится в ' +
            'clientComments карточки с kind:"agency" и будет видно клиенту в его кабинете согласования. Нужен ' +
            'хотя бы один из text/imageUrl — можно отправить сообщение только с картинкой, без текста.',
          security: [{ automationApiKey: [] }],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', description: 'текст сообщения клиенту (может быть пустым, если задан imageUrl)' },
                    imageUrl: { type: 'string', description: 'опционально — ссылка disk.kontentferma на фото к сообщению' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' } } } } } },
            400: { description: 'text и imageUrl оба пустые', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
            502: { description: 'Сбой записи в Mattermost', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
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
      '/api/automation/tasks/{taskId}/media-import': {
        post: {
          summary: 'Сервер сам скачивает файл по внешней ссылке и заливает на disk.kontentferma — без multipart',
          description:
            'Альтернатива media-upload: вместо того чтобы автоматизация сама скачивала байты и слала multipart/form-data, ' +
            'достаточно прислать { url } обычным JSON — сервер скачает файл сам и приложит его к карточке ' +
            'точно так же, как media-upload. ОГРАНИЧЕНИЕ: это простой неавторизованный GET — если по ссылке ' +
            'файл доступен только залогиненной сессии/с cookies/по токену, сервер его скачать не сможет и ' +
            'вернёт 502 media_fetch_failed с upstreamStatus 401/403 — в этом случае нужен media-upload, а не ' +
            'media-import. При любой ошибке (таймаут 504, 4xx/5xx от источника, файл слишком большой 413) ' +
            'ничего не пишется на диск и ничего не прикрепляется к карточке — повторный вызов безопасен.',
          security: [{ automationApiKey: [] }],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'Публичная http(s) ссылка на файл (например, прямая CDN-ссылка)' } } } } },
          },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' } } } } } },
            400: { description: 'url отсутствует или некорректен', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
            404: { description: 'Карточка не найдена' },
            413: { description: 'Файл больше 80 МБ' },
            502: { description: 'Источник не отдал файл — см. upstreamStatus (401/403 = нужна авторизованная сессия, используйте media-upload)' },
            504: { description: 'Источник не ответил за 20 секунд' },
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
      '/api/google-docs/tasks/{taskId}/client-message': {
        post: {
          summary: 'Добавить комментарий в «Чат с клиентом» по карточке (под отдельным ключом Google Docs)',
          description:
            'Пишет сообщение от Агентства в чат с клиентом (маркер «СООБЩЕНИЕ», kind: agency) — появится в карточке ' +
            'и клиенту в его кабинете. Статус согласования не трогает. Гейтится ОТДЕЛЬНЫМ ключом GOOGLE_DOCS_API_KEY ' +
            '(header X-Google-Docs-Key), а не AUTOMATION_API_KEY.',
          security: [{ googleDocsApiKey: [] }],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', description: 'текст комментария (непустой, если нет imageUrl)' },
                    imageUrl: { type: 'string', description: 'необязательно: готовая ссылка disk.kontentferma — прикрепится к сообщению как картинка' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' } } } } } },
            400: { description: 'нет ни text, ни imageUrl', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { description: 'Неверный или отсутствующий X-Google-Docs-Key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/api/google-docs/tasks/{taskId}/title': {
        post: {
          summary: 'Править заголовок (тему) карточки (под ключом Google Docs)',
          description:
            'Заменяет человеко-читаемую часть названия карточки (title) — без префикса соцсети (ig:/tg:/vk:/ok:/max: ' +
            'сохраняется отдельно). Гейтится отдельным ключом GOOGLE_DOCS_API_KEY.',
          security: [{ googleDocsApiKey: [] }],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', description: 'новый заголовок (без префикса соцсети)' } } } } } },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' } } } } } },
            400: { description: 'title пустой', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { description: 'Неверный или отсутствующий X-Google-Docs-Key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/api/google-docs/tasks/{taskId}/date': {
        post: {
          summary: 'Поставить «Дедлайн (публикация)» карточки (под ключом Google Docs)',
          description:
            'Ставит дату публикации (config.publishDatePropertyName, по умолчанию "Дедлайн (публикация)"). Отдельное ' +
            'поле «Окончание работ» меняется методом /dates (workEndDate). Принимает YYYY-MM-DD.',
          security: [{ googleDocsApiKey: [] }],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['date'], properties: { date: { type: 'string', format: 'date', description: 'YYYY-MM-DD — дата публикации' } } } } } },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' } } } } } },
            400: { description: 'date отсутствует/некорректна', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { description: 'Неверный или отсутствующий X-Google-Docs-Key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/api/google-docs/tasks/{taskId}/dates': {
        post: {
          summary: 'Поставить обе даты карточки: «Дедлайн (публикация)» и «Окончание работ» (под ключом Google Docs)',
          description:
            'Универсальный метод для ОБЕИХ дат одним запросом: publishDate (свойство "Дедлайн (публикация)") и ' +
            'workEndDate (отдельное свойство "Окончание работ"). Оба поля необязательны, но хотя бы одно должно быть ' +
            'задано; каждое обновляется атомарно.',
          security: [{ googleDocsApiKey: [] }],
          parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    publishDate: { type: 'string', format: 'date', description: 'дата публикации (YYYY-MM-DD), необязательно' },
                    workEndDate: { type: 'string', format: 'date', description: 'окончание работ (YYYY-MM-DD), необязательно' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { task: { $ref: '#/components/schemas/Task' } } } } } },
            400: { description: 'ни publishDate, ни workEndDate, либо дата некорректна', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { description: 'Неверный или отсутствующий X-Google-Docs-Key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/api/google-docs/tasks': {
        post: {
          summary: 'Создать карточку и сразу поставить даты «Дедлайн (публикация)» и «Окончание работ» (под ключом Google Docs)',
          description:
            'Создаёт новую карточку через Google-Docs API (отдельный ключ GOOGLE_DOCS_API_KEY) и в том же запросе ' +
            'ставит обе даты: publishDate и workEndDate. Повторно использует ту же механику, что и /api/automation/tasks.',
          security: [{ googleDocsApiKey: [] }],
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
                    text: { type: 'string', description: 'текст поста (тело)' },
                    keywords: { type: 'string', description: 'ключевые слова/мысли — отдельное поле-бриф, не текст поста' },
                    publishDate: { type: 'string', format: 'date', description: 'дата публикации / «Дедлайн (публикация)» (YYYY-MM-DD), необязательно' },
                    workEndDate: { type: 'string', format: 'date', description: '«Окончание работ» (YYYY-MM-DD), необязательно' },
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
            401: { description: 'Неверный или отсутствующий X-Google-Docs-Key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/api/bot/channels': {
        post: {
          summary: 'Бот сообщает об изменении своего членства в чате/канале (my_chat_member)',
          description:
            'Вызывать на КАЖДЫЙ апдейт my_chat_member от Telegram (бота добавили, удалили, ' +
            'повысили до админа) — не только на "добавили". actorUserId/actorName/actorUsername ' +
            '(my_chat_member.from) запоминаются только при ПЕРВОМ появлении чата — повторные события ' +
            'обновляют title/status, но не перезаписывают "кто добавил". Заполняет вкладку "Бот" ' +
            'в /ceo/bot-chats.',
          security: [{ botApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['chatId', 'status'],
                  properties: {
                    chatId: { type: 'string', description: 'Telegram chat.id (отрицательный для групп/каналов)' },
                    chatType: { type: 'string', enum: ['group', 'supergroup', 'channel', 'private'] },
                    title: { type: 'string' },
                    status: { type: 'string', example: 'administrator', description: 'my_chat_member.new_chat_member.status: member/administrator/left/kicked/...' },
                    actorUserId: { type: 'string', description: 'my_chat_member.from.id — кто выполнил действие' },
                    actorName: { type: 'string' },
                    actorUsername: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { chat: { $ref: '#/components/schemas/BotChat' } } } } } },
            400: { description: 'chatId/status не переданы', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { description: 'Неверный или отсутствующий X-Bot-Key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/api/bot/messages': {
        post: {
          summary: 'Бот сообщает о входящем сообщении (личный чат)',
          description:
            'Вызывать на каждое входящее текстовое сообщение из личного чата с ботом — потенциальный ' +
            'лид. Регистрирует и сам чат, если это первый контакт (у личных чатов нет my_chat_member ' +
            'при первом сообщении — только при блокировке/разблокировке). Заполняет вкладку "Переписка" ' +
            'в /ceo/bot-leads.',
          security: [{ botApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['chatId'],
                  properties: {
                    chatId: { type: 'string' },
                    chatType: { type: 'string', example: 'private' },
                    chatTitle: { type: 'string', description: 'опционально — если пусто, берётся из fromName/fromUsername' },
                    telegramMessageId: { type: 'string' },
                    fromUserId: { type: 'string' },
                    fromName: { type: 'string' },
                    fromUsername: { type: 'string' },
                    text: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Создано', content: { 'application/json': { schema: { type: 'object', properties: { message: { $ref: '#/components/schemas/BotMessage' } } } } } },
            400: { description: 'chatId не передан', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { description: 'Неверный или отсутствующий X-Bot-Key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/api/bot/messages/outgoing': {
        get: {
          summary: 'Очередь исходящих сообщений, поставленных staff из /ceo/bot-leads',
          description:
            'Это приложение НЕ хранит токен Telegram-бота и не шлёт сообщения само — только копит ' +
            'очередь. Опрашивайте этот эндпоинт (например, раз в 30-60с), реально отправляйте каждое ' +
            'сообщение через Telegram Bot API своим credential\'ом, затем подтверждайте через ' +
            'POST /api/bot/messages/{id}/ack — иначе строка так и останется "pending" и будет отдаваться ' +
            'повторно на каждый опрос.',
          security: [{ botApiKey: [] }],
          parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 50, maximum: 200 } }],
          responses: {
            200: {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      messages: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'integer', description: 'id строки — передать обратно в .../ack, это НЕ telegram_message_id' },
                            chatId: { type: 'string' },
                            text: { type: 'string' },
                            createdAt: { type: 'string', format: 'date-time' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            401: { description: 'Неверный или отсутствующий X-Bot-Key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/api/bot/messages/{id}/ack': {
        post: {
          summary: 'Подтверждение отправки одного исходящего сообщения',
          description: 'id — числовой id строки из GET .../outgoing (не telegram_message_id).',
          security: [{ botApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status'],
                  properties: {
                    status: { type: 'string', enum: ['sent', 'failed'] },
                    telegramMessageId: { type: 'string', description: 'опционально — реальный message_id из ответа Telegram, при status=sent' },
                    error: { type: 'string', description: 'опционально — текст ошибки, при status=failed' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { message: { $ref: '#/components/schemas/BotMessage' } } } } } },
            400: { description: 'status не sent/failed, или id не число', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { description: 'Неверный или отсутствующий X-Bot-Key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            404: { description: 'Такой pending-строки нет (или уже подтверждена)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
    },
  };
}

module.exports = { buildOpenApiSpec };
