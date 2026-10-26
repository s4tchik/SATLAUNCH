<div align="center">
  <img src="src/assets/icons/sat-app.svg" width="92" alt="SAT LAUNCHER logo" />
  <h1>SAT LAUNCHER</h1>
  <p><strong>Your Minecraft Java world, gathered in one place.</strong></p>
  <p>Windows desktop launcher · Isolated instances · Mods and maps · Skin editor · Music</p>
</div>

---

## Русский

SAT LAUNCHER — настольный лаунчер для Minecraft Java Edition. Он собирает игровые версии, отдельные сборки, контент сообщества, локальные профили, редактор скинов и музыкальную библиотеку в одном интерфейсе.

### Возможности

- **Отдельные сборки Minecraft** — версии, загрузчики, моды, ресурспаки, шейдеры, конфиги и миры не смешиваются между сборками.
- **Каталоги прямо в лаунчере** — поиск и установка контента из поддерживаемых источников, включая Modrinth, GitHub и другие интеграции.
- **Официальные и офлайн-профили** — вход через Microsoft для лицензированных аккаунтов и локальный офлайн-профиль для поддерживаемых сценариев. Офлайн-режим не предоставляет доступ к Realms или онлайн-сервисам Mojang.
- **Редактор скинов** — 2D/3D-просмотр, слои и инструменты рисования.
- **Музыкальный плеер** — локальная библиотека и поддерживаемая интеграция с Яндекс Музыкой.
- **Диагностика и обслуживание** — журналы запуска, диагностика сборок, очистка кэша и файлов логов.
- **Русский и английский интерфейс**.
- **Автообновления через GitHub Releases** для установщиков, собранных с release-каналом репозитория.

### Требования

- Windows x64.
- Интернет для загрузки Minecraft, контента, официальной авторизации и получения обновлений.
- Node.js 22 или совместимая версия для разработки и сборки.
- Для онлайн-игры и серверных сервисов требуется официальный аккаунт Minecraft; офлайн-профиль предназначен для локального запуска и не заменяет авторизацию Microsoft.

### Запуск из исходников

```bash
npm install
npm start
```

Проверка синтаксиса и тестов:

```bash
npm run check
```

Сборка установщика Windows x64:

```bash
npm run dist
```

Результат сборки появляется в каталоге `release/`.

### Настройка автообновлений

Автообновление распространяется через GitHub Releases. Канал релизов настроен на `s4tchik/SATLAUNCH`. Workflow GitHub Actions в `.github/workflows/release.yml` собирает NSIS-установщик и автоматически публикует артефакты, когда новая версия попадает в `main`/`master` или отправляется соответствующий тег.

Чтобы выпустить обновление:

1. Измените `version` в `package.json` на новую версию: сейчас `1.0.0`, следующий выпуск должен быть `1.0.1`. Не переиспользуйте опубликованный номер версии.
2. Зафиксируйте и отправьте исходники в ветку `main` или `master`. GitHub Actions проверит проект, соберёт установщик и опубликует GitHub Release с установщиком и `latest.yml`.
3. Как альтернативу можно отправить тег вроде `v1.0.0`; он должен совпадать с версией `package.json`. Полный существующий релиз повторно не публикуется.
4. В Actions проверьте успешную сборку, а в релизе наличие `latest.yml` и `.blockmap`.

**Важно:** изменения исходников сначала необходимо отправить в GitHub — Actions не может опубликовать локальные файлы, которых нет в репозитории. Пользователям нужно установить NSIS-пакет `*-Setup.exe` с настроенным каналом обновлений. Отдельный/портативный `SATLAUN.exe`, извлечённый из установщика, не поддерживает самостоятельное обновление. Уже установленную старую версию без `app-update.yml` нужно один раз обновить через новый `Setup.exe`; после этого новые версии будут предлагаться в лаунчере.

### Структура проекта

- `main.js` — основной процесс Electron, запуск Minecraft, профили, диагностика, автообновления и файловое обслуживание.
- `preload.js` — безопасный мост IPC между интерфейсом и основным процессом.
- `src/` — интерфейс, стили, локализация и модули ядра.
- `scripts/secure-build.js` — сборка установщика с восстановлением исходников после упаковки.
- `release-config.json` — настройки канала GitHub Releases.
- `.github/workflows/release.yml` — автоматическая публикация релизов для новых версий в `main`/`master` и по тегам.
- `tests/` — автоматические проверки регрессий.

### Проблемы и обратная связь

При запуске лаунчер ограничивает максимальную память Minecraft примерно половиной физической ОЗУ, чтобы оставить место Windows и нативным графическим буферам. Если сбой отмечен как `Error section: Post render`, для диагностики временно отключите шейдеры/ресурспаки и проверьте графические моды и драйвер. Перед созданием отчёта о сбое приложите соответствующий `logs/latest.log`, crash-report либо `hs_err_pid*.log` из папки конкретной сборки. Не публикуйте токены авторизации, файлы `auth.bin` или другие секреты из профиля пользователя.

---


**Примечание о приватности:** отключение ссылок на репозиторий внутри приложения не запрещает открыть публичный репозиторий через браузер. Чтобы закрыть исходники и сохранить автообновления, сделай `s4tchik/SATLAUNCH` приватным и создай отдельный публичный репозиторий только для релизов. В настройках Actions исходного репозитория добавь переменную `SAT_RELEASE_REPOSITORY` со значением `владелец/репозиторий-релизов` и секрет `SAT_RELEASE_GH_TOKEN` с правом `Contents: Read and write` для репозитория релизов. Workflow будет публиковать туда установщики и метаданные обновления; пользователям не нужен доступ к приватному исходному репозиторию.

## English

SAT LAUNCHER is a Windows desktop launcher for Minecraft Java Edition. It brings game versions, isolated instances, community content, local profiles, a skin editor and a music library together in one interface.

### Features

- **Isolated Minecraft instances** — versions, loaders, mods, resource packs, shaders, configs and worlds remain separated.
- **In-app content catalogs** — search for and install content from supported sources, including Modrinth, GitHub and other integrations.
- **Official and offline profiles** — Microsoft sign-in for licensed accounts and local offline profiles for supported scenarios. Offline mode does not provide access to Realms or Mojang online services.
- **Community skins without a Microsoft sign-in** — CustomSkinLoader provider configuration supports TLauncher (including its direct PNG fallback), ElyBy, LittleSkin, BlessingSkin and local PNG files. A skin must exist for the exact nickname on a compatible provider; official Realms/authentication is not unlocked.
- **Skin editor** — 2D/3D preview, layers and drawing tools.
- **Music player** — local music library and a supported Yandex Music integration.
- **Diagnostics and maintenance** — launch logs, instance diagnostics, cache cleanup and log-file cleanup.
- **Russian and English interface**.
- **GitHub Releases auto-updates** for installers built with the repository release feed configured.

### Requirements

- Windows x64.
- Internet access to download Minecraft and content, sign in officially and receive updates.
- Node.js 22 or a compatible version for development and packaging.
- Online play and Mojang services require an official Minecraft account. Offline profiles are for local launch scenarios and are not a substitute for Microsoft authentication.

### Run from source

```bash
npm install
npm start
```

Run syntax checks and tests:

```bash
npm run check
```

Build the Windows x64 installer:

```bash
npm run dist
```

Build output is written to `release/`.

### Configure automatic updates

Updates are distributed through GitHub Releases. The release channel is configured for `s4tchik/SATLAUNCH`. The GitHub Actions workflow at `.github/workflows/release.yml` builds the NSIS installer and publishes update artifacts automatically when a version-bumped commit reaches `main`/`master` or a matching version tag is pushed.

To publish an update:

1. Change `version` in `package.json` to a new version (current release: `1.0.0`; next release: `1.0.1`). Never reuse a published version number.
2. Commit and push the changed source to the `main` or `master` branch. GitHub Actions runs checks, builds the Windows installer and publishes the installer plus `latest.yml` automatically.
3. Alternatively, push the matching version tag (for example `v1.0.0` for version `1.0.0`). Existing complete releases are not published twice.
4. Check the Actions run and confirm `latest.yml`/`.blockmap` are attached to the release.

**Important:** source changes must first be pushed to GitHub. End users must install the NSIS `*-Setup.exe` build that contains the update feed; a loose/portable `SATLAUN.exe` is not a supported self-updating distribution. Existing installations that lack `app-update.yml` need one update using the new Setup.exe. Future releases are then offered inside the launcher.

### Project layout

- `main.js` — Electron main process, Minecraft launching, profiles, diagnostics, auto-updates and file maintenance.
- `preload.js` — secure IPC bridge between the interface and the main process.
- `src/` — interface, styles, localization and core modules.
- `scripts/secure-build.js` — installer build script that restores source files after packaging.
- `release-config.json` — GitHub Releases feed configuration.
- `.github/workflows/release.yml` — automatic version-gated release workflow for pushes to `main`/`master` and version tags.
- `tests/` — automated regression tests.

### Bug reports

The launcher now limits Minecraft’s maximum heap to roughly half of physical RAM, leaving room for Windows and native graphics buffers. For Minecraft 26.3 only, a confirmed OpenGL `0xC0000005` crash paired with Post render/watchdog evidence triggers one diagnostic retry with the Vulkan backend; if Vulkan fails too, SAT returns the instance to the default backend. Vulkan is a fallback experiment, not a guaranteed fix. If the crash is marked `Error section: Post render`, temporarily disable shaders/resource packs and check rendering mods and the GPU driver. When reporting a crash, include the relevant `logs/latest.log`, crash report or `hs_err_pid*.log` from the affected instance folder. Never publish sign-in tokens, `auth.bin` or other private user-profile data.

---

<div align="center">
  <sub>SAT LAUNCHER · Built for Minecraft Java Edition · Windows x64</sub>
</div>


**Privacy note:** hiding in-app links does not prevent someone from opening a public repository in a browser. To keep source code private while preserving auto-updates, make `s4tchik/SATLAUNCH` private and create a separate public releases-only repository. In the source repository's Actions settings, set the `SAT_RELEASE_REPOSITORY` variable to `owner/releases-repo` and add the `SAT_RELEASE_GH_TOKEN` secret with `Contents: Read and write` access to that releases repository. The workflow will publish installers and update metadata there; end users do not need access to the private source repository.
## Java runtime compatibility / Совместимость Java

- The launcher reads the required Java major version from Mojang version metadata and validates manually selected Java runtimes before launch.
- Minecraft 26.1–26.3 requires Java 25; Java 21 is not a compatible runtime for these releases.
- SAT LAUNCHER downloads the matching official Mojang runtime when automatic Java selection is enabled.

- Лаунчер берёт требуемую версию Java из метаданных Mojang и проверяет вручную выбранную Java перед запуском.
- Для Minecraft 26.1–26.3 необходима Java 25; Java 21 для этих версий не подходит.
- При включённом автоматическом выборе SAT LAUNCHER загружает подходящую официальную среду Java от Mojang.



## v42 — no capes / плащи полностью отключены

- `enableCape` is forced to `false` for generated offline CustomSkinLoader configs. The mod may still load skins, but it cannot apply profile cape URLs.
- Cape-related fields and the cape-only OptiFine provider are removed from the offline load list, including fields migrated from older settings.
- The updater panel shows the actual GitHub/updater error, and GitHub Actions automatically builds and publishes release assets for a new package version.
- The Windows app icon uses transparent padding instead of an opaque square background.

В v42 параметр `enableCape` принудительно выключен для офлайн-конфигурации CustomSkinLoader. Скины продолжают загружаться, но плащи не применяются. Все поля плащей, включая старые настройки и провайдер OptiFine, удаляются из списка источников. Также уведомление обновления показывает настоящую ошибку, релизы автоматически публикуются GitHub Actions, а иконка лаунчера имеет прозрачный фон без непрозрачного квадрата.

## Community skin support for offline profiles / Скины для офлайн-профилей

SAT LAUNCHER can load locally selected PNG skins and community skins from compatible CustomSkinLoader providers (including TLauncher, ElyBy, LittleSkin and BlessingSkin) without fabricating a Microsoft/Mojang session. Skin servers must have a skin registered for the player's nickname; a random offline nickname cannot be guaranteed to have a skin. Community skins are client-side: other players may need a compatible skin loader to see those textures too. This does not enable official authentication, Realms or license-gated multiplayer.

SAT LAUNCHER supports this by installing the client-side CustomSkinLoader mod and preserving its community providers in `CustomSkinLoader/CustomSkinLoader.json`; local PNGs take priority over remote providers.


## Скины для офлайн-профилей

SAT LAUNCHER поддерживает локальные PNG-скины и загрузку скинов с совместимых community-серверов CustomSkinLoader: TLauncher, ElyBy, LittleSkin и BlessingSkin. Для этого не подделывается сессия Microsoft/Mojang и не требуется лицензия именно для загрузки текстуры. На выбранном сервере должен быть зарегистрирован скин для соответствующего ника — случайному офлайн-нику наличие скина не гарантируется. Загрузка скинов клиентская: у других игроков также должен быть совместимый загрузчик/источник, чтобы увидеть те же текстуры. Это не открывает доступ к официальной авторизации, Realms или серверам, требующим лицензию.

При офлайн-профиле лаунчер включает клиентский CustomSkinLoader и сохраняет community-провайдеры в `CustomSkinLoader/CustomSkinLoader.json`; локальный PNG имеет приоритет над удалёнными источниками.
