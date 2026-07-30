import {
  pgTable,
  serial,
  text,
  real,
  boolean,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: varchar("role", { length: 10 }).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const signals = pgTable("signals", {
  id: serial("id").primaryKey(),
  direction: varchar("direction", { length: 20 }).notNull(),
  zoneLabel: varchar("zoneLabel", { length: 100 }).notNull(),
  zoneTier: varchar("zoneTier", { length: 20 }).notNull(),
  entry: real("entry").notNull(),
  sl: real("sl").notNull(),
  slDistance: real("slDistance").notNull(),
  tp1: real("tp1").notNull(),
  tp2: real("tp2").notNull(),
  tp3: real("tp3").notNull(),
  currentPrice: real("currentPrice").notNull(),
  session: varchar("session", { length: 50 }),
  priority: varchar("priority", { length: 10 }),
  reason: text("reason"),
  status: varchar("status", { length: 20 }).notNull(),
  zoneKey: varchar("zoneKey", { length: 20 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const activeSetups = pgTable("activeSetups", {
  id: serial("id").primaryKey(),
  zoneKey: varchar("zoneKey", { length: 20 }).notNull(),
  direction: varchar("direction", { length: 20 }).notNull(),
  zoneLabel: varchar("zoneLabel", { length: 100 }).notNull(),
  zoneTier: varchar("zoneTier", { length: 20 }).notNull(),
  entry: real("entry").notNull(),
  sl: real("sl").notNull(),
  slDistance: real("slDistance").notNull(),
  tp1: real("tp1").notNull(),
  tp2: real("tp2").notNull(),
  tp3: real("tp3").notNull(),
  currentPrice: real("currentPrice").notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  session: varchar("session", { length: 50 }),
  priority: varchar("priority", { length: 10 }),
  detectedAt: timestamp("detectedAt").defaultNow().notNull(),
});

export const activeTrades = pgTable("activeTrades", {
  id: serial("id").primaryKey(),
  tradeId: varchar("tradeId", { length: 50 }).notNull(),
  direction: varchar("direction", { length: 20 }).notNull(),
  zone: varchar("zone", { length: 100 }).notNull(),
  zoneTier: varchar("zoneTier", { length: 20 }).notNull(),
  entry: real("entry").notNull(),
  sl: real("sl").notNull(),
  slDistance: real("slDistance").notNull(),
  tp1: real("tp1").notNull(),
  tp2: real("tp2").notNull(),
  tp3: real("tp3").notNull(),
  tp1Hit: boolean("tp1Hit").default(false).notNull(),
  tp2Hit: boolean("tp2Hit").default(false).notNull(),
  tp3Hit: boolean("tp3Hit").default(false).notNull(),
  slHit: boolean("slHit").default(false).notNull(),
  closed: boolean("closed").default(false).notNull(),
  confirmedAt: timestamp("confirmedAt").defaultNow().notNull(),
  tp1HitAt: timestamp("tp1HitAt"),
  tp2HitAt: timestamp("tp2HitAt"),
  tp3HitAt: timestamp("tp3HitAt"),
  slHitAt: timestamp("slHitAt"),
});

export const telegramLog = pgTable("telegramLog", {
  id: serial("id").primaryKey(),
  type: varchar("type", { length: 30 }).notNull(),
  content: text("content").notNull(),
  sentAt: timestamp("sentAt").defaultNow().notNull(),
  success: boolean("success").default(true).notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Signal = typeof signals.$inferSelect;
export type InsertSignal = typeof signals.$inferInsert;
export type ActiveSetup = typeof activeSetups.$inferSelect;
export type InsertActiveSetup = typeof activeSetups.$inferInsert;
export type ActiveTrade = typeof activeTrades.$inferSelect;
export type InsertActiveTrade = typeof activeTrades.$inferInsert;
export type TelegramLog = typeof telegramLog.$inferSelect;
export type InsertTelegramLog = typeof telegramLog.$inferInsert;
