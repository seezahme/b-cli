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
`grid`, `dca`, `trend` and `scalp`. `bb-cli types` lists each with its settings. Bots live in `bots.json`.

## Keys
API keys come from the Bybit OAuth flow and are read from `.bybit/oauth_token.json` (git-ignored) or `BYBIT_API_KEY` / `BYBIT_API_SECRET`.

## Plugins
Plugins aren't active in a fresh clone; install them with `bb-cli plugin install <name | folder | git URL>`. They run in a Node permission sandbox: they read only their own folder, write only their `data/` folder, can't start processes and never see API keys. What they can ask bb-cli to do is limited to the permissions in their `plugin.json` (`bots:read`, `bots:create`, `market:read`), and bb-cli asks you before adding a bot.

`plugins-catalog/ai` — create bots from a description with a local model (Ollama, LM Studio, llama.cpp):
```
bb-cli plugin install ai
bb-cli ai setup
bb-cli ai active scalp bot on TSLA with 20 USDT
```

Trading is risky; backtests and paper results don't predict live results.
