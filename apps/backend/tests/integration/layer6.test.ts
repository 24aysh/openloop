import { afterAll,beforeAll,beforeEach,describe,expect,test } from "bun:test";
import type pg from "pg";
import { type RealtimeGateway,type SidebandConnection,type SidebandHandlers,type UUID } from "../../src/contracts";
import { MindReader,MindWriter } from "../../src/mind";
import { ReconciliationRepository,ReconciliationWorker,type ClaimedExtraction,type ExtractionOutcome,type TextExtractor } from "../../src/reconciliation";
import { CommitmentScheduler } from "../../src/scheduling";
import { SessionController,SessionRepository,REALTIME_INSTRUCTIONS,buildRealtimeSessionConfig } from "../../src/sessions";
import { TranscriptIngestor } from "../../src/transcripts";
import { clearTestDatabase,createTestPool,prepareTestDatabase } from "../helpers/database";
import { seedCommitment,seedUser,userId } from "../helpers/factories";

const scope={userId};
const settings={model:"realtime-fixture",transcriptionModel:"transcription-fixture",voice:"marin",instructions:REALTIME_INSTRUCTIONS};
const jobs={model:"text-fixture",promptVersion:"v1",schemaVersion:"1"};

class FakeGateway implements RealtimeGateway {
  handlers:SidebandHandlers|null=null;created=0;
  async createCall():Promise<{callId:string;sdpAnswer:string}>{this.created++;return {callId:`call_${this.created}`,sdpAnswer:"v=0\r\ns=answer\r\n"};}
  connectSideband(_id:string,handlers:SidebandHandlers):SidebandConnection {
    this.handlers=handlers;let close!:()=>void;const closed=new Promise<void>(resolve=>{close=resolve;});
    return {send:()=>{},close:()=>{close();handlers.onClose(1000);},closed};
  }
  async hangup():Promise<void>{}
  message(value:unknown):void{this.handlers?.onMessage(JSON.stringify(value),false);}
  open():void{this.handlers?.onOpen();}
}

const waitFor=async(check:()=>Promise<boolean>):Promise<void>=>{
  for(let attempt=0;attempt<200;attempt++){if(await check())return;await Bun.sleep(10);}
  throw new Error("Timed out waiting for integrated state");
};

let pool:pg.Pool;
beforeAll(async()=>{pool=createTestPool();await prepareTestDatabase(pool);});
beforeEach(async()=>{await clearTestDatabase(pool);await seedUser(pool);});
afterAll(async()=>{await pool?.end();});

describe("integrated completed-turn loop",()=>{
  test("ingests a final turn once, extracts source-backed Mind, completes the same commitment, and suppresses its due log",async()=>{
    const gateway=new FakeGateway();let now=new Date();
    const ingestor=new TranscriptIngestor(pool,jobs,()=>now);
    const controller=new SessionController(new SessionRepository(pool),gateway,ingestor,settings,()=>now);
    const reader=new MindReader(pool);const writer=new MindWriter(pool);
    const due=new Date(now.getTime()-60_000).toISOString();
    const firstText=`Ananya likes science fiction. We discussed the project Tuesday. I promised to send Ananya the presentation by ${due}. That is high priority.`;
    const secondText="I sent Ananya the presentation.";
    const extractor:TextExtractor={async extract(input:ClaimedExtraction):Promise<ExtractionOutcome>{
      const part=input.newParts[0];if(!part)throw new Error("Missing source part");
      const source=[{part_id:part.partId,evidence_text:part.text}];
      if(part.text===firstText)return {kind:"success",proposals:[
        {entity:"memory",action:"create",target_id:null,expected_version:null,commitment:null,
          memory:{kind:"semantic",subject:"Ananya",predicate:"movie_preference",content:"Ananya likes science fiction",occurred_at:null,time_text:null},sources:source},
        {entity:"memory",action:"create",target_id:null,expected_version:null,commitment:null,
          memory:{kind:"episodic",subject:"Ananya",predicate:"project_discussion",content:"Discussed the project with Ananya",occurred_at:null,time_text:"Tuesday"},sources:source},
        {entity:"commitment",action:"create",target_id:null,expected_version:null,memory:null,
          commitment:{title:"Send Ananya the presentation",subject:"Ananya",status:"open",priority:1,due_text:due,due_precision:"instant",
            temporal_kind:"offset",offset_datetime:due,local_date:null,local_time:null,timezone:null,relative_seconds:null},sources:source},
      ]};
      const existing=input.mind.commitments[0];if(!existing)throw new Error("Missing original commitment");
      return {kind:"success",proposals:[{entity:"commitment",action:"complete",target_id:existing.id,expected_version:existing.version,memory:null,
        commitment:{title:existing.title,subject:existing.subject,status:"completed",priority:existing.priority,due_text:null,due_precision:"none",
          temporal_kind:"none",offset_datetime:null,local_date:null,local_time:null,timezone:null,relative_seconds:null},sources:source}]};
    }};
    const worker=new ReconciliationWorker(new ReconciliationRepository(pool),extractor,writer);
    async function speak(text:string,item:string):Promise<UUID>{
      const started=await controller.start(scope,{startRequestId:crypto.randomUUID() as UUID,sdpOffer:"v=0\r\ns=offer\r\n",timezone:"Asia/Kolkata"});
      gateway.open();await Bun.sleep(0);const effective={id:`provider_${item}`,...buildRealtimeSessionConfig(settings)};
      gateway.message({type:"session.created",event_id:`created_${item}`,session:effective});
      gateway.message({type:"session.updated",event_id:`updated_${item}`,session:effective});
      await waitFor(async()=>(await controller.status(scope,started.response.sessionId)).captureReady);
      await controller.activate(scope,started.response.sessionId);
      const final={type:"conversation.item.input_audio_transcription.completed",event_id:`final_${item}`,item_id:item,content_index:0,transcript:text};
      gateway.message(final);
      gateway.message({type:"conversation.item.created",event_id:`item_${item}`,previous_item_id:null,
        item:{id:item,type:"message",role:"user",status:"completed",content:[{type:"input_audio"}]}});
      gateway.message(final);
      await waitFor(async()=>(await reader.getTranscript(scope,started.response.sessionId,{limit:50,cursor:null})).items[0]?.parts[0]?.state==="complete");
      await ingestor.scanReadySessions();
      await waitFor(async()=>(await controller.status(scope,started.response.sessionId)).sealedThrough===1);
      await controller.close(scope,started.response.sessionId);now=new Date(now.getTime()+2000);await controller.tick();
      await waitFor(async()=>(await controller.status(scope,started.response.sessionId)).state==="closed");
      return started.response.sessionId;
    }
    try{
      const firstSession=await speak(firstText,"user_one");
      expect(await worker.tick()).toBe("applied");
      const snapshot=await reader.getSnapshot(scope);
      expect(snapshot.memories.map(item=>item.kind).sort()).toEqual(["episodic","semantic"]);
      expect(snapshot.commitments).toHaveLength(1);
      const commitment=snapshot.commitments[0]!;expect(commitment).toMatchObject({priority:1,status:"open",duePrecision:"instant"});
      const source=await reader.getProvenance(scope,{type:"commitment",id:commitment.id});
      expect(source[0]?.sources[0]?.sessionId).toBe(firstSession);
      expect((await reader.getTranscript(scope,firstSession,{limit:50,cursor:null})).items).toHaveLength(1);
      const secondSession=await speak(secondText,"user_two");expect(await worker.tick()).toBe("applied");
      const updated=(await reader.listCommitments(scope,{limit:50,cursor:null})).items[0]!;
      expect(updated.id).toBe(commitment.id);expect(updated.status).toBe("completed");
      expect((await reader.getProvenance(scope,{type:"commitment",id:commitment.id})).map(change=>change.operation)).toEqual(["create","complete"]);
      expect((await controller.status(scope,secondSession)).appliedThrough).toBe(1);
      expect((await new CommitmentScheduler(pool).tick()).createdLogIds).toHaveLength(0);
      const seeded=await seedCommitment(pool,undefined,userId,new Date(now.getTime()-60_000).toISOString());
      expect((await new CommitmentScheduler(pool).tick()).createdLogIds).toHaveLength(1);
      expect((await pool.query("SELECT commitment_id FROM commitment_logs")).rows[0]?.commitment_id).toBe(seeded.id);
    }finally{await controller.shutdown();}
  });
});
