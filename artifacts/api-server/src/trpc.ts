import { initTRPC } from "@trpc/server";
import type { Request, Response } from "express";
import superjson from "superjson";

interface Context {
  req: Request;
  res: Response;
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
