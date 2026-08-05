---
name: Annual backtest data
description: Historical market-data constraints for long Ricky backtests
---

Yahoo Finance provides approximately one year of hourly GC=F history but restricts 30-minute history to a recent window. An annual strategy run therefore needs either a historical-data provider with longer 30-minute coverage or must clearly label an hourly-bar proxy.

**Why:** Treating hourly bars as 30-minute bars changes signal frequency and trade outcomes, so annual results should not be presented as exact live-strategy performance.

**How to apply:** Prefer Twelve Data or another source with adequate intraday history for exact annual testing; if unavailable, report the 1-hour GC=F proxy and its limitation alongside the results.