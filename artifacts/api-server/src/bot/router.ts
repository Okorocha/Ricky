import { router, publicProcedure } from "../trpc";
import { db } from "@workspace/db";
import { signals, activeSetups, activeTrades, telegramLog } from "@workspace/db";
import { desc, eq, count } from "drizzle-orm";
import { fetchGoldData, scanZones, sendTelegram } from "./telegram";

export const botRouter = router({
  // Get current price
  price: publicProcedure.query(async () => {
    const data = await fetchGoldData();
    return data
      ? { price: data.price, bid: data.bid, ask: data.ask, spread: data.spread, source: data.source }
      : null;
  }),

  // Get recent signals
  signals: publicProcedure.query(async () => {
    return await db.select().from(signals).orderBy(desc(signals.createdAt)).limit(50);
  }),

  // Get active trades
  activeTrades: publicProcedure.query(async () => {
    return await db.select().from(activeTrades).where(eq(activeTrades.closed, false));
  }),

  // Get all trades (including closed)
  tradeHistory: publicProcedure.query(async () => {
    return await db.select().from(activeTrades).orderBy(desc(activeTrades.confirmedAt)).limit(100);
  }),

  // Get active setups
  activeSetups: publicProcedure.query(async () => {
    return await db.select().from(activeSetups);
  }),

  // Get telegram log (public — no auth required in this deployment)
  telegramLog: publicProcedure.query(async () => {
    return await db.select().from(telegramLog).orderBy(desc(telegramLog.sentAt)).limit(200);
  }),

  // Manual scan trigger
  triggerScan: publicProcedure.mutation(async () => {
    try {
      const data = await fetchGoldData();
      if (!data) {
        return { ok: true, setupFound: false, count: 0, reason: "No price data available", message: "No price data available" };
      }
      const result = await scanZones(data);
      return { ok: true, ...result, message: result.setupFound ? `${result.count} setup(s) found` : result.reason };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Bot] triggerScan error:", err);
      return { ok: false, setupFound: false, count: 0, reason: msg, message: `Scan error: ${msg}` };
    }
  }),

  // Manual alive check
  aliveCheck: publicProcedure.mutation(async () => {
    const data = await fetchGoldData();
    const price = data?.price || 0;
    const msg = `XAU/USD Manual Check\nPrice: $${price.toFixed(2)}\nTime: ${new Date().toISOString()}`;
    await sendTelegram(msg, "manual_check");
    return { ok: true, price };
  }),

  // Get bot stats
  stats: publicProcedure.query(async () => {
    const allTrades = await db.select().from(activeTrades);
    const openTrades = allTrades.filter((t) => !t.closed);
    const [sigCountRow] = await db.select({ value: count() }).from(signals);
    const [msgCountRow] = await db.select({ value: count() }).from(telegramLog);
    return {
      signals: sigCountRow?.value ?? 0,
      trades: allTrades.length,
      activeTrades: openTrades.length,
      messages: msgCountRow?.value ?? 0,
    };
  }),
});
