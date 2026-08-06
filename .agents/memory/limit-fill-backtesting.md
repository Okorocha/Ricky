---
name: Limit-fill backtesting
description: Backtest modeling rule for Ricky's order-block limit entries
---

Ricky's order-block signals are pending limit setups, not immediate market trades. A backtest must first check whether subsequent price action reaches the entry during the setup's four-hour lifetime; only then should TP/SL outcome tracking begin.

**Why:** An assumed fill produced dramatically inflated performance compared with historical limit fills. The fill-aware replay showed that many distant entries were never reached, and counting TP1/TP2/TP3 before a real fill creates misleading results.

**How to apply:** Report generated setups, filled setups, fill rate, and outcomes on filled setups separately. Do not describe an unfilled setup as having hit a target.