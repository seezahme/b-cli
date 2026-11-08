# bb-cli

Spot trading bots for Bybit with a terminal dashboard. Bots run in **paper mode** by default (real prices, simulated money); live mode needs `--live` and typing `LIVE` yourself.

```
bb-cli                 # dashboard: bot table, scrollable logs and a command line
bb-cli new             # create a bot step by step
bb-cli start <bot>     # paper mode; add --live for real orders
bb-cli backtest <bot>  # try a bot on recent history
bb-cli help            # everything else
```

Run `.\bb-cli` inside this folder, or `npm link` once to get `bb-cli` everywhere. Needs Node 20+ (Node 22+ for plugins).

## Strategies
`grid`, `dca`, `trend`, `scalp` and `auto`. `bb-cli types` lists each with its settings. Bots live in `bots.json`.

### Strategy files (auto bots)
An `auto` bot runs a strategy file from `strategy-files/`: it reads the market through indicators, buys when a rule matches and places that rule's stop-loss, take-profit and trailing stop by itself.

```
bb-cli strategy list                 # adaptive, breakout, fvg, bos, sweep, session-open, monday-pullback
bb-cli strategy show fvg             # rules, indicators and params
bb-cli new my-bot type=auto strategy=fvg symbol=BTCUSDT budget=10 rr=3
bb-cli strategy export fvg           # writes fvg.bb-strategy.json to share
bb-cli strategy import <file | https link>
bb-cli strategy new my-idea --from bos   # copy one to edit
```

Strategy files are JSON data, not code: rules like `"close crossesAbove sw.high"` or `"entry - atr * $slAtr"` are read by a small built-in parser, so an imported file can't run anything on your machine. Indicators: `ema`, `sma`, `rsi`, `atr`, `bollinger`, `adx`, `macd`, `donchian`, `swings` (market structure), `fvg` (fair value gaps). Rules can also use `open/high/low/close`, `close[1]` (one candle back), `hour`, `minute`, `weekday` (UTC) and `entry`.

## Keys
`bb-cli login` opens Bybit in your browser; after you authorize, it picks or creates an AI subaccount and saves its API key pair to `.bybit/oauth_token.json` (git-ignored, readable only by you). `bb-cli login status` shows the masked key. Keys can also come from `BYBIT_API_KEY` / `BYBIT_API_SECRET`.

## Plugins
Plugins aren't active in a fresh clone; install them with `bb-cli plugin install <name | folder | git URL>`. They run in a Node permission sandbox: they read only their own folder, write only their `data/` folder, can't start processes and never see API keys. What they can ask bb-cli to do is limited to the permissions in their `plugin.json` (`bots:read`, `bots:create`, `market:read`), and bb-cli asks you before adding a bot.

`plugins-catalog/ai` — create bots from a description with a local model (Ollama, LM Studio, llama.cpp):
```
bb-cli plugin install ai
bb-cli ai setup
bb-cli ai active scalp bot on TSLA with 20 USDT
```

Trading is risky; backtests and paper results don't predict live results.
