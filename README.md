# Pixel Board: onchain-холст на Robinhood Chain

Общий холст 64×64. Выбираешь цвет, кликаешь по пикселю, подписываешь одну транзакцию, и пиксель навсегда записан в блокчейн. Потом нужно подождать (по умолчанию 30 секунд) до следующего пикселя. Можно закрашивать чужие пиксели. Токенов, комиссий и владельца у контракта нет: платишь только газ сети.

```
pixel-board/
├── contracts/            Solidity + Foundry
│   ├── src/PixelBoard.sol      контракт
│   ├── test/PixelBoard.t.sol   18 тестов (включая fuzz)
│   └── script/Deploy.s.sol     скрипт деплоя
├── web/                  сайт: Vite + TypeScript + viem, без фреймворка
│   ├── deploy.html             страница деплоя контракта из кошелька
│   └── src/deployments.json    ← сюда вписываются адреса контрактов
└── .github/workflows/    сайт на GitHub Pages, тесты контракта, верификация на Blockscout
```

Путь такой: **локально → тестнет → мейннет**. Контракт после деплоя изменить нельзя, поэтому сначала всё проверяем там, где ошибки ничего не стоят.

---

## 0. Что нужно установить

- **Node.js 20+** и **git**
- **Foundry** (forge, cast, anvil):
  ```bash
  curl -L https://foundry.paradigm.xyz | bash
  foundryup
  ```
  На Windows: через WSL.
- Браузерный кошелёк: MetaMask, Rabby или любой другой EVM-кошелёк

## 1. Первый запуск и тесты

```bash
cd pixel-board
git init                                   # forge install добавляет библиотеки как git-сабмодули
cd contracts
forge install foundry-rs/forge-std         # стандартная библиотека для тестов
forge test
```

Должно быть `18 passed`. `forge test -vvvv` покажет подробности каждого теста, `forge test --gas-report` покажет, сколько газа стоит каждая функция.

## 2. Локальный блокчейн (без денег)

Три терминала:

```bash
# терминал 1: локальная сеть
anvil
```

```bash
# терминал 2: деплой (это публичный тестовый ключ anvil, в реальных сетях его использовать НЕЛЬЗЯ)
cd contracts
forge script script/Deploy.s.sol --rpc-url local --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

```bash
# терминал 3: сайт
cd web
npm install
npm run dev:anvil
```

Открой http://localhost:5173. Чтобы порисовать, импортируй в MetaMask тестовый аккаунт anvil, например
`0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` (только для локальной сети!). Кнопка «Switch to Local Anvil» сама добавит сеть в кошелёк.

> `npm install` может написать про уязвимости в `picomatch`: это инструменты сборки Vite, в готовый сайт они не попадают.

## 3. Сайт в интернет (GitHub Pages)

1. Запушь проект в репозиторий на GitHub, ветка `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. При каждом пуше, который меняет `web/`, сайт пересобирается и выкладывается на `https://<ник>.github.io/<репозиторий>/`. Свой домен подключается там же, в Settings → Pages.

Пока контракта нет, сайт так и пишет и даёт ссылку на страницу деплоя.

## 4. Деплой контракта из браузера (самый простой путь)

1. Открой `https://<ник>.github.io/<репозиторий>/deploy.html` (или локально: `npm run dev` → http://localhost:5173/deploy.html).
2. Выбери сеть. **Сначала Testnet**: тестовый ETH бесплатный, его выдаёт [кран Alchemy](https://www.alchemy.com/faucets/robinhood-testnet) (0.1 ETH в сутки, у крана есть требования к кошельку).
3. Задай кулдаун, подключи кошелёк и нажми **Deploy**. Кошелёк покажет транзакцию и цену, подтверди её.
4. Страница покажет адрес контракта. Впиши его в `web/src/deployments.json`:
   ```json
   "testnet": { "address": "0x…", "cooldown": 30 }
   ```
   и запушь. Дальше всё само:
   - сайт пересобирается, и доска появляется;
   - workflow **Verify contracts** публикует исходник контракта на Blockscout (зелёная галочка «verified» у адреса).

**Мейннет**: то же самое, только выбираешь **Mainnet**. ETH в Robinhood Chain переводится через [мост Arbitrum из Ethereum](https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum) (около 10 минут) или сторонние мосты (Relay, Across); список в [доках Robinhood Chain](https://docs.robinhood.com/chain/bridging). Как только в `deployments.json` появляется адрес мейннета, сайт сам переключается на мейннет. Тестовая доска остаётся доступна по ссылке `?network=testnet`.

Сколько это стоит: деплой занимает около 0.8 млн газа, один пиксель от 50 до 160 тыс. Первый пиксель с нового адреса дороже, потому что создаются новые записи в хранилище. Страница деплоя заранее показывает оценку в ETH. На L2 это обычно доли цента за пиксель.

Страница деплоя отправляет тот же байткод, что собирает Foundry из `contracts/`. Он лежит в `web/src/bytecode.ts`. Если меняешь контракт, обнови его командой `cd contracts && forge inspect PixelBoard bytecode`, иначе CI упадёт с подсказкой.

## 5. Деплой через Foundry (командная строка)

Тот же результат, но из терминала.

Кошелёк для деплоя (один раз). Заведи **отдельный** аккаунт только для деплоя и положи его ключ в зашифрованное хранилище Foundry:
```bash
cast wallet import deployer --interactive   # вставляешь ключ, придумываешь пароль
cast wallet address --account deployer      # проверить адрес
```
Ключ хранится зашифрованным в `~/.foundry/keystores/`, а не в файлах проекта.

Тестнет (деплой и сразу верификация на Blockscout):
```bash
cd contracts
COOLDOWN=30 forge script script/Deploy.s.sol \
  --rpc-url robinhood_testnet --account deployer --broadcast \
  --verify --verifier blockscout \
  --verifier-url https://explorer.testnet.chain.robinhood.com/api/
```

Мейннет. Сначала прогон без `--broadcast`: это симуляция, она показывает, сколько газа и ETH понадобится. Потом настоящий деплой:
```bash
COOLDOWN=30 forge script script/Deploy.s.sol --rpc-url robinhood --account deployer
COOLDOWN=30 forge script script/Deploy.s.sol \
  --rpc-url robinhood --account deployer --broadcast \
  --verify --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/
```

Адрес из строки `PixelBoard deployed at: 0x…` впиши в `web/src/deployments.json`, как в разделе 4.

---

## Как это устроено

**Контракт** (`contracts/src/PixelBoard.sol`):
- вся доска хранится в одном `bytes` на 4096 байт: один байт на пиксель, это номер цвета 0–15. Пиксель (x, y) лежит по индексу `y * 64 + x`;
- `paint(x, y, color)` проверяет границы, цвет и кулдаун, записывает пиксель и автора и испускает событие `PixelPainted`;
- `getBoard()` отдаёт всю доску за один вызов, `getPixel()` отдаёт цвет и последнего автора, `nextPaintAt(addr)` показывает, когда можно рисовать снова;
- ошибки кастомные (`CooldownActive(readyAt)`, `OutOfBounds`, `InvalidColor`), поэтому сайт показывает понятный текст вместо «execution reverted»;
- нет `owner`, нет `payable`, нет апгрейдов. Красть нечего, худший сценарий: кто-то закрасит твой рисунок (это часть игры).

**Сайт** (`web/src`):
- `config.ts`: сети, `deployments.json`: адреса контрактов, `palette.ts`: 16 цветов (порядок совпадает с комментарием в контракте);
- при загрузке один вызов `getBoard()`, потом каждые 2,5 с опрос новых событий `PixelPainted`, а раз в 30 с полная перечитка доски на случай, если что-то пропущено;
- перед отправкой транзакция «проигрывается» через `simulateContract`. Если она упадёт (например, из-за кулдауна), кошелёк даже не откроется, а пользователь увидит причину;
- кошельки находятся по стандарту EIP-6963, так что несколько установленных расширений не конфликтуют. Сети Robinhood Chain нет в кошельке? Кнопка добавит её сама.

**Публичный RPC** ограничен по частоте запросов. Если игроков станет много или браузер не сможет до него достучаться, возьми RPC-ключ у Alchemy и пропиши его в `web/.env.local` (пример лежит в `.env.local.example`). Ключ будет виден в коде сайта, поэтому в панели Alchemy ограничь его своим доменом.

## Куда развивать

- Таймлапс: события `PixelPainted` хранят всю историю, из них можно проиграть, как рисовалась доска
- Лидерборд по количеству пикселей (тоже из событий)
- Зум и пипетка (взять цвет с доски)
- Ссылка на конкретный пиксель (`#x,y` в адресе страницы)
- WalletConnect для мобильных кошельков без встроенного браузера
- Доска побольше. Это уже новый контракт, ведь старый неизменяем
