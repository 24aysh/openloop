import express from "express";
import { readConfig } from "./config";
import { createPool, checkDatabase } from "./db/pool";
import { withTransaction } from "./db/transaction";
import { MindReader, MindWriter } from "./mind";
import { createMindRouter } from "./http/mind-routes";
import { errorResponse } from "./http/error-response";
import { OpenAIRealtimeGateway, REALTIME_INSTRUCTIONS, SessionController, SessionRepository, createSessionRouter, startSessionSupervisor } from "./sessions";
import { startTranscriptScanLoop, TranscriptIngestor } from "./transcripts";
import { OpenAITextExtractor, ReconciliationRepository, ReconciliationWorker, startReconciliationLoop } from "./reconciliation";
import { CommitmentLogEmitter, CommitmentScheduler, startSchedulingLoop, StdoutTerminalSink } from "./scheduling";

const config=readConfig();
const pool=createPool(config.DATABASE_URL);
await checkDatabase(pool);
await withTransaction(pool,{isolation:"read committed"},async client=>{
  await client.query("INSERT INTO users(id,timezone) VALUES($1,$2) ON CONFLICT (id) DO NOTHING",[config.DEMO_USER_ID,config.DEMO_USER_TIMEZONE]);
  await client.query("INSERT INTO mind_state(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING",[config.DEMO_USER_ID]);
});

const app=express();
const scope={userId:config.DEMO_USER_ID};
const ingestor=new TranscriptIngestor(pool,{model:config.RECONCILIATION_MODEL,promptVersion:config.RECONCILIATION_PROMPT_VERSION,schemaVersion:config.RECONCILIATION_SCHEMA_VERSION});
const sessions=new SessionController(new SessionRepository(pool),new OpenAIRealtimeGateway(config.OPENAI_API_KEY),ingestor,
  {model:config.OPENAI_REALTIME_MODEL,transcriptionModel:config.OPENAI_TRANSCRIPTION_MODEL,voice:config.OPENAI_REALTIME_VOICE,instructions:REALTIME_INSTRUCTIONS});
await sessions.recoverAtStartup();
let shuttingDown=false;let backgroundHealthy=true;
app.use(createSessionRouter(sessions,()=>scope));
app.use(express.json({limit:"32kb",strict:true}));
app.use(createMindRouter(new MindReader(pool),new MindWriter(pool),()=>scope));
app.get("/health/live",(_request,response)=>response.json({ok:true}));
app.get("/health/ready",async(_request,response)=>{try{if(!backgroundHealthy || shuttingDown)throw new Error("not_ready");await checkDatabase(pool);response.json({ok:true});}catch{response.status(503).json({ok:false});}});
app.use(errorResponse);
const server=app.listen(config.PORT,"127.0.0.1");
const backgroundError=()=>{backgroundHealthy=false;process.exitCode=1;void shutdown();};
const transcriptScan=startTranscriptScanLoop(ingestor,backgroundError);
const sessionSupervisor=startSessionSupervisor(sessions,backgroundError);
const reconciliationScan=startReconciliationLoop(new ReconciliationWorker(new ReconciliationRepository(pool),new OpenAITextExtractor(config.OPENAI_API_KEY),new MindWriter(pool)),backgroundError);
const schedulingScan=startSchedulingLoop(new CommitmentScheduler(pool),new CommitmentLogEmitter(pool,new StdoutTerminalSink()),backgroundError);
async function shutdown():Promise<void> {
  if(shuttingDown) return;shuttingDown=true;
  await new Promise<void>(resolve=>{
    const force=setTimeout(()=>{server.closeAllConnections();resolve();},5000);
    server.close(()=>{clearTimeout(force);resolve();});
  });
  await Promise.allSettled([sessionSupervisor.stop(),transcriptScan.stop(),reconciliationScan.stop(),schedulingScan.stop()]);
  await sessions.shutdown();
  await pool.end();
}
process.once("SIGINT",()=>{void shutdown();});
process.once("SIGTERM",()=>{void shutdown();});
