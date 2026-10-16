import type pg from "pg";
import { databaseTimestampSchema, prioritySchema, uuidSchema, type UserScope } from "../contracts";
import { DomainError } from "../contracts";

export type NotificationEvent = Readonly<{
  id:string;
  commitmentId:string;
  title:string;
  priority:1|2|3;
  dueAt:string;
  loggedAt:string;
  active:boolean;
}>;

export function parseEventCursor(value:unknown):string {
  if(value===undefined || value===null || value==="")return "0";
  if(typeof value!=="string" || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value)>9223372036854775807n)
    throw new DomainError("invalid_input","Invalid notification cursor");
  return value;
}

export class NotificationFeed {
  constructor(private readonly pool:pg.Pool){}

  async latestId(scope:UserScope):Promise<string> {
    const result=await this.pool.query<{id:string}>("SELECT coalesce(max(id),0)::text AS id FROM notification_events WHERE user_id=$1",[scope.userId]);
    return result.rows[0]?.id??"0";
  }

  async after(scope:UserScope,cursor:string):Promise<readonly NotificationEvent[]> {
    const result=await this.pool.query<{
      id:string;commitment_id:string;title_snapshot:string;priority:number;due_at:Date;emitted_at:Date;active:boolean;
    }>(`SELECT e.id::text AS id,l.commitment_id,l.title_snapshot,l.priority,l.due_at,l.emitted_at,
        (c.status='open' AND c.schedule_version=l.schedule_version) AS active
      FROM notification_events e
      JOIN commitment_logs l ON l.user_id=e.user_id AND l.id=e.commitment_log_id
      JOIN commitments c ON c.user_id=l.user_id AND c.id=l.commitment_id
      WHERE e.user_id=$1 AND e.id>$2::bigint ORDER BY e.id LIMIT 50`,[scope.userId,parseEventCursor(cursor)]);
    return result.rows.map(row=>({id:row.id,commitmentId:uuidSchema.parse(row.commitment_id),title:row.title_snapshot,
      priority:prioritySchema.parse(row.priority),dueAt:databaseTimestampSchema.parse(row.due_at),
      loggedAt:databaseTimestampSchema.parse(row.emitted_at),active:row.active}));
  }
}
