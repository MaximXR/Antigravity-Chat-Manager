---
description: "ТРИГГЕР: Использовать ВСЕГДА, когда нужно скомпилировать, упаковать в VSIX, обновить GitHub релиз или подготовить к публикации на Open VSX расширение VS Code / Antigravity IDE."
---

# Инструкция по сборке и публикации расширений на Open VSX

Миссия: Обеспечить успешную валидацию, сборку VSIX-пакета и его публикацию на Open VSX (open-vsx.org) с корректной привязкой к репозиторию, лицензированием и обходом ограничений CSP в IDE.

## 1. Подготовка метаданных (`package.json`)

- **Имя издателя (`publisher`)**:
  - Установи СТРОГО `"publisher": "MaximXR"` (чувствительно к регистру). Оно должно совпадать с пространством имен (namespace) на open-vsx.org.
- **Лицензия (`license`)**:
  - Пропиши `"license": "MIT"`. Отсутствие поля или файла лицензии ведет к ошибке валидации Open VSX (`no license found`).
- **Репозиторий (`repository`)**:
  - Укажи корректный URL:
    ```json
    "repository": {
      "type": "git",
      "url": "https://github.com/MaximXR/Antigravity-Chat-Manager.git"
    }
    ```

## 2. Требования к лицензированию (`LICENSE`)

- В корне проекта обязан находиться файл `LICENSE` (или `LICENSE.txt`).
- Для MIT-лицензии с требованиями к форкам добавь дополнительный абзац:
  ```text
  ADDITIONAL ATTRIBUTION REQUIREMENT:
  Any forks, modifications, redistribution, or derivative works of this software must include a prominent and visible link back to the original repository:
  https://github.com/MaximXR/Antigravity-Chat-Manager
  in their repository README, documentation, and extension description pages.
  ```

## 3. С скриншоты и Content Security Policy (CSP)

- **Относительные пути в README.md**:
  - **ЗАПРЕЩЕНО** использовать абсолютные ссылки вида `raw.githubusercontent.com/` для картинок/скриншотов. Они блокируются политиками CSP в IDE.
  - Используй строго относительные пути в `README.md` (например: `resources/screenshot.png`). При сборке VSIX компилятор `vsce` автоматически преобразует их в валидные абсолютные ссылки `https://github.com/.../raw/HEAD/...`, которые разрешены CSP.

## 4. Оптимизация сборки (`.vscodeignore`)

- Обязательно исключи из финального `.vsix` пакета все служебные файлы разработки, чтобы уменьшить размер архива.
- Пример `.vscodeignore`:
  ```text
  .git/**
  .gitignore
  .vscodeignore
  drafts/**
  temp_resources/**
  generate_icons.py
  merge_logos.py
  *.lock_test
  *.vsix
  dist/**
  ```

## 5. Компиляция и сборка VSIX

- **Выходная папка**: Все скомпилированные `.vsix` файлы должны собираться строго в подкаталог `dist/` в корне проекта.
- **Команда сборки**:
  ```powershell
  npx @vscode/vsce package --allow-missing-repository -o dist/Antigravity-chat-manager-1.0.0.vsix
  ```

## 6. Локальное тестирование в IDE

- После сборки скопируй файлы расширения в папку активных расширений IDE для ручной проверки:
  - Путь назначения: `C:\Users\sss77\.antigravity-ide\extensions\MaximXR.antigravity-chat-manager-1.0.0\`
  - Команда синхронизации в PowerShell:
    ```powershell
    Copy-Item -Path "e:\Antigravity\Antigravity Chat Manager\*" -Destination "C:\Users\sss77\.antigravity-ide\extensions\MaximXR.antigravity-chat-manager-1.0.0\" -Recurse -Force -Exclude ".git", ".gitignore", ".vscodeignore", "dist", "drafts", "temp_resources", "generate_icons.py", "merge_logos.py"
    ```

## 7. Загрузка релиза на GitHub

- **Обход ошибки авторизации GITHUB_TOKEN**:
  - Перед вызовом команд GitHub CLI (`gh`) **ОБЯЗАТЕЛЬНО** очисти переменную окружения `GITHUB_TOKEN`, чтобы форсировать авторизацию через связку ключей пользователя `MaximXR`:
    ```powershell
    $env:GITHUB_TOKEN = $null
    ```
- **Загрузка ассета VSIX в релиз**:
  - Залей собранный пакет в существующий тег релиза (с флагом переопределения `--clobber` при перезаливке):
    ```powershell
    $env:GITHUB_TOKEN = $null
    gh release upload v1.0.0 dist/Antigravity-chat-manager-1.0.0.vsix --clobber
    ```

## 8. Загрузка на Open VSX

- **Ручной способ**:
  - Перейди в веб-интерфейс [open-vsx.org](https://open-vsx.org/).
  - Войди под аккаунтом `MaximXR`.
  - Открой панель управления пространством имен `MaximXR` и перетащи (drag & drop) файл `dist/Antigravity-chat-manager-1.0.0.vsix` для загрузки.
- **CLI способ**:
  - Выполни команду публикации с токеном доступа (PAT):
    ```bash
    npx ovsx publish dist/Antigravity-chat-manager-1.0.0.vsix -p <token>
    ```
