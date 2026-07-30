import { router, publicProcedure } from "./trpc";
import { botRouter } from "./bot/router";

export const appRouter = router({
  auth: router({
    me: publicProcedure.query(() => null),
    logout: publicProcedure.mutation(() => ({ success: true as const })),
  }),
  bot: botRouter,
});

export type AppRouter = typeof appRouter;
