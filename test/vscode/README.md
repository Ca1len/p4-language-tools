# Проверка установленного VSIX в редакторе

Тест создаёт временный профиль и проект, устанавливает переданный VSIX и проверяет подсветку типа, действия и поля, F12 в закрытый include, hover и inlay-подсказку имени аргумента, а также текущий аргумент signature help для P4₁₄ и P4₁₆.

В Linux и macOS тестовый компилятор воспроизводит вывод `p4c-vendor` при опечатке `aply` в закрытом `src/switch.p4`. Команда **P4: Check Project** запускает проверку уже сохранённых файлов. Тест проверяет ошибку и диапазон, применяет предложенный Quick Fix, сохраняет файл и проверяет снятие диагностики. Затем тестовый компилятор имитирует сбой backend без координат. В веб-сценарии проверяется сообщение в канале **P4 Compiler**.

Чтобы отдельно проверить настоящий компилятор, укажите в `P4TEST_BINARY` путь к p4test с диагностикой `---- Originating from:`. Тест вызывает функцию с аргументом неверного типа, проверяет основное сообщение и ссылку на объявление в подключённом файле. В веб-сценарии тест открывает эту ссылку из Problems и проверяет положение курсора.

В Linux с настольным VS Code и работающим дисплеем достаточно Python 3:

```sh
python3 test/vscode/run.py --code code ./p4-language-tools-0.3.2.vsix
```

Другой вариант использует официальный Microsoft VS Code Server с веб-интерфейсом и Chromium. Расширение запускается в настоящем Node Extension Host. Тест проверяет цвета токенов в Monaco, а в сценарии с `p4c-vendor` также проверяет подчёркивание, сообщение в Problems и маркеры в Explorer.

```sh
python3 -m venv /tmp/p4-host-venv
/tmp/p4-host-venv/bin/pip install playwright
/tmp/p4-host-venv/bin/playwright install chromium
curl -fL https://update.code.visualstudio.com/1.100.3/server-linux-x64-web/stable -o /tmp/p4-test-code-server.tgz
mkdir -p /tmp/p4-test-code-server
tar -xzf /tmp/p4-test-code-server.tgz -C /tmp/p4-test-code-server --strip-components=1
/tmp/p4-host-venv/bin/python test/vscode/web.py --server /tmp/p4-test-code-server/bin/code-server ./p4-language-tools-0.3.2.vsix
```

Сценарий запускает сервер с `--accept-server-license-terms` на случайном loopback-порту с токеном, устанавливает отдельный тестовый драйвер в тот же временный профиль и удаляет профиль по завершении. Если Chromium уже установлен, передайте путь через `--chromium`. Для проверки с компилятором укажите путь перед вызовом Python, например `P4TEST_BINARY=/usr/local/bin/p4test`.
