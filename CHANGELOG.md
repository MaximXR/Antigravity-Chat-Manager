# История изменений / Changelog

## 1.0.2
### Русский
- **Адаптивная верстка кнопок**: Кнопки действий автоматически выстраиваются в один горизонтальный ряд на широких экранах и перегруппировываются в 3 аккуратных ряда на узких (в боковой панели), при этом кнопка редактирования заметки поднята наверх.
- **Перенос статус-бейджа**: Индикатор нахождения в индексе («В ИНДЕКСЕ» / «ВНЕ ИНДЕКСА») перенесен в правый верхний угол, ровно над кнопками действий.
- **Фильтр по заметкам**: Добавлен переключатель для отображения только тех диалогов, которые содержат заметки (избранные).
- **Увеличенное поле ввода заметки**: Увеличена высота текстового поля при редактировании заметки, чтобы вводимый текст не обрезался.
- **Настройка прокрутки при старте**: Добавлен параметр `antigravity-chat-manager.scrollPosition` в настройки для выбора начального экрана (с самого верха, с фильтров или сразу со списка чатов).
- **Нативные окна подтверждения**: Для массового удаления и восстановления диалогов теперь используются нативные модальные диалоги VS Code вместо заблокированных окон Webview.
- **Исправление массового удаления**: Почищено и доработано массовое удаление файлов вне индекса с выдачей нативного предупреждения.
- **Исправление запуска чатов (кнопка Play)**: Устранена ошибка `Cannot find module 'ws'` (зависимость теперь упаковывается в VSIX). Исправлен запуск диалогов при открытых нескольких окнах IDE и автоматический выбор папки в QuickPick.
- **Улучшение сборки (`build.bat`)**: Скрипт сборки больше не удаляет старые упакованные версии VSIX в каталоге `dist/`.
- **Обновление документации**: В `README.md` добавлена информация об ограничениях IDE (блокировка файлов), инструкции по компиляции и благодарности пользователям.

### English
- **Adaptive Button Layout**: Reorganized action buttons into a flexible layout. Displays in a single horizontal row on wide screens and wraps into 3 compact rows on narrow sidebars (with the `[Edit Note]` button placed on top).
- **Relocated Status Badge**: Moved the index status badge (`В ИНДЕКСЕ` / `ВНЕ ИНДЕКСА`) to the top-right corner, directly above the action buttons.
- **Filter by Notes**: Added a filter toggle to show only dialogues that contain user notes (favorites).
- **Larger Note Input**: Increased the height of the note text area editor to improve typing visibility.
- **Startup Scroll Position Configuration**: Added the `antigravity-chat-manager.scrollPosition` setting, allowing users to configure the initial scroll position on startup (top, filters list, or dialogue list).
- **Native Confirmation Dialogs**: Migrated all bulk action prompts (bulk delete/restore) to native VS Code modal warnings (`vscode.window.showWarningMessage` with `{ modal: true }`) for better safety and reliability.
- **Fixed Bulk Deletion**: Resolved bugs in bulk cleanup actions for orphaned dialogues.
- **Dialogue Launching Fixes**: Fixed the `Cannot find module 'ws'` runtime crash by bundling dependencies. Corrected IDE window focusing during multiple workspace sessions and automatic folder approval in QuickPick prompts.
- **Build Automation**: Modified `build.bat` to keep older packaged VSIX files inside the `dist` directory instead of deleting them.
- **README Updates**: Restructured layout, placing technical details on file locking, compiling instructions, and project acknowledgments below main features.

---

## 1.0.1
### Русский
- Добавлена поддержка локализации на русский и другие языки.
- Повышена стабильность работы расширения.

### English
- Added localization support for Russian and other languages.
- Stability improvements.

---

## 1.0.0
### Русский
- Начальная версия расширения Antigravity Chat Manager.

### English
- Initial release of Antigravity Chat Manager.
