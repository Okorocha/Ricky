// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../../api-server/src/app-router";

export const trpc = createTRPCReact<AppRouter>();
