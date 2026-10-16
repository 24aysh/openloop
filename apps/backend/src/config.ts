import { z } from "zod";
import { timezoneSchema, uuidSchema } from "./contracts";

const configSchema = z.object({
  DATABASE_URL: z.url(),
  DEMO_USER_ID: uuidSchema,
  DEMO_USER_TIMEZONE: timezoneSchema,
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(environment: NodeJS.ProcessEnv = process.env): Config { return configSchema.parse(environment); }
