# Antigravity Chat Manager

[Русский](#русский) | [English](#english)

---

## Русский

**Antigravity Chat Manager** — это расширение для Antigravity IDE, предоставляющее удобный визуальный интерфейс для управления диалогами (чатами) искусственного интеллекта на локальном диске и в индексе среды разработки.

### Какие проблемы решает расширение?

1. **Потеря диалогов (выпадение из индекса)**:
   Antigravity IDE со временем вытесняет старые диалоги из левой панели истории (индекса). При этом файлы диалога (логи, файлы шагов, артефакты) остаются лежать на диске в виде «мусора». Расширение находит такие осиротевшие чаты на диске и позволяет в один клик:
   - **Восстановить** их обратно в историю чатов IDE.
   - **Удалить** их физически, освободив занятое дисковое пространство.
2. **Трудность ориентирования в диалогах**:
   В стандартном интерфейсе IDE сложно ориентироваться, когда диалогов становится много. Расширение решает эту проблему с помощью:
   - Фильтрации диалогов по конкретным проектам (рабочим областям).
   - Полнотекстового поиска по заголовкам и UUID.
   - Сортировки по дате создания, объёму файлов на диске и имени.
   - **Пользовательских заметок (аннотаций)** для каждого диалога.

### Где хранятся заметки?
Заметки хранятся локально на вашем компьютере в глобальной папке:
`~/.gemini/antigravity-ide/annotations/<uuid>_note.txt`
Это гарантирует, что:
- Файлы проекта в вашей рабочей области не засоряются служебными файлами заметок.
- При удалении диалога через интерфейс расширения файл заметки автоматически удаляется с диска бэкендом (так как его имя начинается с UUID диалога).

### Основные возможности
- **Мониторинг диска**: Отображает размер файлов диалога, количество связанных файлов на диске и точное время создания.
- **Детекция мусора (Осиротевших диалогов)**: Показывает, какие диалоги находятся в индексе (активные), а какие были удалены из индекса (но остались на диске как мусор).
- **Пользовательские заметки**: Возможность быстро добавлять, редактировать (кликнув на строку заметки) и удалять текстовые заметки к диалогам прямо в карточке.
- **Фильтр по проектам**: Удобный селектор проектов для отображения диалогов, принадлежащих только выбранному воркспейсу.
- **Массовые операции**: 
  - **Восстановить все вне индекса** — возвращает все осиротевшие чаты обратно в боковую панель истории IDE.
  - **Удалить все вне индекса** — полностью и физически очищает файлы осиротевших чатов с диска для освобождения места.
- **Индивидуальные действия**:
  - Открытие папки диалога на диске.
  - Поиск файлов диалога по UUID.
  - Копирование названия и UUID чата в буфер обмена одним кликом.
  - Удаление или восстановление конкретного диалога.
- **Настройка иконок**: Возможность переключить стиль иконки боковой панели (чат/диалог или корзина) через стандартные настройки VS Code.
- **Интеграция с IDE**: Кнопка быстрого открытия настроек (шестерёнка ⚙️) и кнопка перезагрузки окна для мгновенного применения изменений истории в левой панели.
- **Кроссплатформенность**: Работает на Windows, macOS и Linux.
- **Двуязычный интерфейс**: Автоматически переключается на русский или английский язык в зависимости от системной локали IDE.

### Скриншоты / Screenshots

#### Подробный вид (Detailed View)
![Подробный вид](resources/screenshot_detailed.png)

#### Компактный вид (Compact View)
![Компактный вид](resources/screenshot_compact_ru.png)

### Системные требования
- Установленный интерпретатор Python 3 (`python` или `python3` в PATH) для работы фоновой службы.

---

## English

**Antigravity Chat Manager** is an extension for Antigravity IDE that provides a convenient visual interface to manage AI dialogues (chats) on your local disk and in the development environment index.

### What Problems Does It Solve?

1. **Dialogue Loss (Orphaned Chats)**:
   Antigravity IDE eventually displaces older dialogues from the history panel (index). However, their logs, step files, and artifacts remain on the disk as clutter. The extension scans your disk, highlights these orphaned chats, and lets you:
   - **Restore** them back to the IDE history panel.
   - **Delete** them physically to reclaim storage space.
2. **Hard Navigation**:
   It is hard to navigate and search through a flat list of numerous dialogues inside the IDE. The extension solves this by offering:
   - Filtering dialogues by specific projects (workspaces).
   - Full-text search by titles or UUIDs.
   - Sorting by creation date, disk size, or name.
   - **Custom annotations (notes)** for every dialogue.

### Where Are the Notes Stored?
Notes are saved locally on your computer in the global folder:
`~/.gemini/antigravity-ide/annotations/<uuid>_note.txt`
This ensures that:
- Your workspace project directories are not cluttered with extension metadata files.
- When you delete a dialogue via the extension UI, the note file is automatically wiped from disk by the backend (as its name starts with the dialogue UUID).

### Key Features
- **Disk Monitoring**: Displays dialogue file size, the number of associated files on disk, and precise creation timestamps.
- **Orphan / Trash Detection**: Identifies which dialogues are indexed (active) and which have been unindexed (orphaned files remaining on disk).
- **Custom Annotations**: Add, edit (by clicking the note row), and delete notes for dialogues directly in their cards.
- **Project Filter**: Workspace selector to display dialogues belonging only to the selected workspace.
- **Bulk Operations**:
  - **Restore all orphaned** — returns all orphaned dialogues back to the IDE history panel.
  - **Delete all orphaned** — permanently erases orphaned dialogue files from disk to reclaim storage space.
- **Individual Actions**:
  - Open dialogue directory on disk.
  - Search dialogue files on disk by UUID.
  - Copy title or UUID to clipboard with a single click.
  - Delete or restore a specific dialogue.
- **Customizable Icons**: Toggle between chat/dialogue icon and trash icon for the sidebar panel via standard VS Code settings.
- **IDE Integration**: Quick settings button (gear icon ⚙️) and window reload button to instantly apply changes in the left history panel.
- **Cross-Platform**: Fully compatible with Windows, macOS, and Linux.
- **Localization**: Automatically switches between English and Russian based on your IDE locale settings.

### Screenshots

#### Detailed View
![Detailed View](resources/screenshot_detailed.png)

#### Compact View
![Compact View](resources/screenshot_compact_en.png)

### Prerequisites
- Python 3 interpreter (`python` or `python3` in PATH) is required to run the backend service.

---

## Сборка расширения / Packaging

Для сборки расширения в готовый файл `.vsix`, выполните команду в корневой папке проекта:
```bash
npx @vscode/vsce package
```
To build the extension into a `.vsix` file, run the following command in the project root:
```bash
npx @vscode/vsce package
```
