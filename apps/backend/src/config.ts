import { z } from "zod";
import { timezoneSchema, uuidSchema } from "./contracts";

const configSchema = z.object({
  DATABASE_URL: z.url(),
  DEMO_USER_ID: uuidSchema,
  DEMO_USER_TIMEZONE: timezoneSchema,
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_REALTIME_MODEL: z.string().min(1),
  OPENAI_TRANSCRIPTION_MODEL: z.string().min(1),
  OPENAI_REALTIME_VOICE: z.string().min(1).default("marin"),
  RECONCILIATION_MODEL: z.string().min(1),
  RECONCILIATION_PROMPT_VERSION: z.string().min(1),
  RECONCILIATION_SCHEMA_VERSION: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(environment: NodeJS.ProcessEnv = process.env): Config { return configSchema.parse(environment); }
