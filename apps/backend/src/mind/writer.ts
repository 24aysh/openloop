import type pg from "pg";
import { z } from "zod";
import { commitmentEditSchema, commitmentSchema, counterSchema, memoryEditSchema, memorySchema, nextCounter, userScopeSchema, uuidSchema, versionedSchema, type Commitment, type CommitmentEdit, type Memory, type MemoryEdit, type UserScope, type UUID, type Versioned, type MindWriterContract } from "../contracts";
import { DomainError } from "../contracts";
import { withTransaction } from "../db/transaction";
import { commitmentFromRow, COMMITMENT_COLUMNS, memoryFromRow, MEMORY_COLUMNS } from "./rows";
import { applyExtraction } from "./extraction-apply";
import type { JobClaim, ValidatedChangeSet, ApplyResult } from "../contracts";

export async function lockMindState(client: pg.PoolClient, userId: UUID) {
  const result = await client.query<{revision:string}>("SELECT revision FROM mind_state WHERE user_id=$1 FOR UPDATE",[userId]);
  if (!result.rows[0]) throw new DomainError("not_found","User not found");
  return counterSchema.parse(result.rows[0].revision);
}
export async function advanceMindState(client: pg.PoolClient, userId: UUID) {
  const result = await client.query<{revision:string}>("UPDATE mind_state SET revision=revision+1,updated_at=now() WHERE user_id=$1 RETURNING revision",[userId]);
  if (!result.rows[0]) throw new DomainError("not_found","User not found");
  return counterSchema.parse(result.rows[0].revision);
}
export async function databaseNow(client: pg.PoolClient): Promise<Date> {
  const result = await client.query<{now:Date}>("SELECT now() AS now");
  const value=result.rows[0]?.now;
  if (!(value instanceof Date)) throw new Error("Database clock unavailable");
  return value;
}
export async function addChange(client: pg.PoolClient, input: {userId:UUID;memoryId?:UUID;commitmentId?:UUID;jobId?:UUID;version:string;operation:string;actor:"user"|"reconciler";afterState:Memory|Commitment}):Promise<UUID> {
  const id=uuidSchema.parse(crypto.randomUUID());
  await client.query(`INSERT INTO mind_changes(id,user_id,job_id,memory_id,commitment_id,entity_version,operation,actor,after_state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[id,input.userId,input.jobId??null,input.memoryId??null,input.commitmentId??null,input.version,input.operation,input.actor,JSON.stringify(input.afterState)]);
  return id;
}
function validate<T>(schema:z.ZodType<T>,value:unknown):T {
  const result=schema.safeParse(value);
  if (!result.success) throw new DomainError("invalid_input","Invalid domain input");
  return result.data;
}
function differentFields(oldValue:object,newValue:object,keys:readonly string[]):boolean {
  return keys.some(key=>Reflect.get(oldValue,key)!==Reflect.get(newValue,key));
}

export class MindWriter implements MindWriterContract {
  constructor(private readonly pool:pg.Pool) {}

  async editMemory(scope:UserScope,id:UUID,input:MemoryEdit):Promise<Memory> {
    userScopeSchema.parse(scope); uuidSchema.parse(id); const edit=validate(memoryEditSchema,input);
    return withTransaction(this.pool,{isolation:"read committed"},async client=>{
      await lockMindState(client,scope.userId);
      const found=await client.query(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE user_id=$1 AND id=$2 FOR UPDATE`,[scope.userId,id]);
      if (!found.rows[0]) throw new DomainError("not_found","Memory not found");
      const previous=memoryFromRow(found.rows[0]);
      if (previous.version!==edit.expectedVersion) throw new DomainError("version_conflict","Memory version changed",{currentVersion:previous.version});
      if (previous.state==="deleted") throw new DomainError("invalid_input","Deleted memory cannot be edited");
      const releaseOnly=edit.releaseManualOverride===true && Object.keys(edit).length===2;
      if (releaseOnly && !previous.manualOverride) throw new DomainError("invalid_input","Memory has no override to release");
      if (!releaseOnly && !differentFields(previous,{
        ...previous,subject:edit.subject??previous.subject,predicate:edit.predicate??previous.predicate,content:edit.content??previous.content,
        occurredAt:edit.occurredAt===undefined?previous.occurredAt:edit.occurredAt,timeText:edit.timeText===undefined?previous.timeText:edit.timeText,
      },["subject","predicate","content","occurredAt","timeText"])) throw new DomainError("invalid_input","Memory edit has no effect");
      const next={...previous,subject:edit.subject??previous.subject,predicate:edit.predicate??previous.predicate,content:edit.content??previous.content,
        occurredAt:edit.occurredAt===undefined?previous.occurredAt:edit.occurredAt,timeText:edit.timeText===undefined?previous.timeText:edit.timeText,
        version:nextCounter(previous.version),manualOverride:releaseOnly?false:true,updatedAt:previous.updatedAt};
      validate(memorySchema,next);
      const updated=await client.query(`UPDATE memories SET subject=$3,predicate=$4,content=$5,occurred_at=$6,time_text=$7,version=$8,manual_override=$9,updated_at=now()
        WHERE user_id=$1 AND id=$2 RETURNING ${MEMORY_COLUMNS}`,[scope.userId,id,next.subject,next.predicate,next.content,next.occurredAt,next.timeText,next.version,next.manualOverride]);
      const record=memoryFromRow(updated.rows[0] ?? {});
      await addChange(client,{userId:scope.userId,memoryId:id,version:record.version,operation:releaseOnly?"release_override":"update",actor:"user",afterState:record});
      await advanceMindState(client,scope.userId);
      return record;
    });
  }

  async deleteMemory(scope:UserScope,id:UUID,input:Versioned):Promise<Memory> {
    userScopeSchema.parse(scope); uuidSchema.parse(id); const guard=validate(versionedSchema,input);
    return withTransaction(this.pool,{isolation:"read committed"},async client=>{
      await lockMindState(client,scope.userId);
      const found=await client.query(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE user_id=$1 AND id=$2 FOR UPDATE`,[scope.userId,id]);
      if (!found.rows[0]) throw new DomainError("not_found","Memory not found");
      const previous=memoryFromRow(found.rows[0]);
      if (previous.version!==guard.expectedVersion) throw new DomainError("version_conflict","Memory version changed",{currentVersion:previous.version});
      if (previous.state==="deleted") throw new DomainError("invalid_input","Memory already deleted");
      const updated=await client.query(`UPDATE memories SET state='deleted',version=$3,manual_override=true,updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING ${MEMORY_COLUMNS}`,[scope.userId,id,nextCounter(previous.version)]);
      const record=memoryFromRow(updated.rows[0] ?? {});
      await addChange(client,{userId:scope.userId,memoryId:id,version:record.version,operation:"delete",actor:"user",afterState:record});
      await advanceMindState(client,scope.userId);
      return record;
    });
  }

  async editCommitment(scope:UserScope,id:UUID,input:CommitmentEdit):Promise<Commitment> {
    userScopeSchema.parse(scope); uuidSchema.parse(id); const edit=validate(commitmentEditSchema,input);
    return withTransaction(this.pool,{isolation:"read committed"},async client=>{
      await lockMindState(client,scope.userId);
      const found=await client.query(`SELECT ${COMMITMENT_COLUMNS} FROM commitments WHERE user_id=$1 AND id=$2 FOR UPDATE`,[scope.userId,id]);
      if (!found.rows[0]) throw new DomainError("not_found","Commitment not found");
      const previous=commitmentFromRow(found.rows[0]);
      if (previous.version!==edit.expectedVersion) throw new DomainError("version_conflict","Commitment version changed",{currentVersion:previous.version});
      const releaseOnly=edit.releaseManualOverride===true && Object.keys(edit).length===2;
      if (releaseOnly && !previous.manualOverride) throw new DomainError("invalid_input","Commitment has no override to release");
      const status=edit.status??previous.status;
      const dueAt=edit.dueAt===undefined?previous.dueAt:edit.dueAt;
      const reopening=previous.status!=="open" && status==="open";
      const scheduleChanged=dueAt!==previous.dueAt || reopening;
      const clock=await databaseNow(client);
      const next={...previous,title:edit.title??previous.title,subject:edit.subject===undefined?previous.subject:edit.subject,status,priority:edit.priority??previous.priority,
        dueAt,dueTimezone:edit.dueTimezone===undefined?previous.dueTimezone:edit.dueTimezone,dueText:edit.dueText===undefined?previous.dueText:edit.dueText,
        duePrecision:edit.duePrecision??previous.duePrecision,version:nextCounter(previous.version),scheduleVersion:scheduleChanged?nextCounter(previous.scheduleVersion):previous.scheduleVersion,
        manualOverride:releaseOnly?false:true,completedAt:status==="completed"?(previous.status==="completed"?previous.completedAt:clock.toISOString()):null,
        dismissedAt:status==="dismissed"?(previous.status==="dismissed"?previous.dismissedAt:clock.toISOString()):null};
      validate(commitmentSchema,next);
      if (!releaseOnly && !differentFields(previous,next,["title","subject","status","priority","dueAt","dueTimezone","dueText","duePrecision"])) throw new DomainError("invalid_input","Commitment edit has no effect");
      const updated=await client.query(`UPDATE commitments SET title=$3,subject=$4,status=$5,priority=$6,due_at=$7,due_timezone=$8,due_text=$9,due_precision=$10,
        version=$11,schedule_version=$12,manual_override=$13,completed_at=$14,dismissed_at=$15,updated_at=now()
        WHERE user_id=$1 AND id=$2 RETURNING ${COMMITMENT_COLUMNS}`,[scope.userId,id,next.title,next.subject,next.status,next.priority,next.dueAt,next.dueTimezone,next.dueText,next.duePrecision,next.version,next.scheduleVersion,next.manualOverride,next.completedAt,next.dismissedAt]);
      const record=commitmentFromRow(updated.rows[0] ?? {});
      const operation=releaseOnly?"release_override":status!==previous.status ? status==="completed"?"complete":status==="dismissed"?"dismiss":"reopen":"update";
      await addChange(client,{userId:scope.userId,commitmentId:id,version:record.version,operation,actor:"user",afterState:record});
      await advanceMindState(client,scope.userId);
      return record;
    });
  }

  async applyExtraction(claim:JobClaim,changes:ValidatedChangeSet):Promise<ApplyResult> { return applyExtraction(this.pool,claim,changes); }
}
