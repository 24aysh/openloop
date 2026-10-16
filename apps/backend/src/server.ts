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
import { logOperational, safeErrorCode } from "./operational-log";
import { NotificationFeed } from "./notifications/feed";
import { createNotificationRouter } from "./notifications/routes";

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
app.use(createSessionRouter(sessions,()=>scope,()=>!shuttingDown));
app.use(express.json({limit:"32kb",strict:true}));
app.use(createMindRouter(new MindReader(pool),new MindWriter(pool),()=>scope));
const notificationStreams=new Set<()=>void>();
app.use(createNotificationRouter(new NotificationFeed(pool),()=>scope,notificationStreams));
app.get("/health/live",(_request,response)=>response.json({ok:true}));
app.get("/health/ready",async(_request,response)=>{try{if(!backgroundHealthy || shuttingDown)throw new Error("not_ready");await checkDatabase(pool);response.json({ok:true});}catch{response.status(503).json({ok:false});}});
app.use(errorResponse);
const server=app.listen(config.PORT,"127.0.0.1");
logOperational("backend","listening",{port:config.PORT});
const backgroundError=(loop:string)=>(error:unknown)=>{
  logOperational("backend","background_failed",{loop,code:safeErrorCode(error)});
  backgroundHealthy=false;process.exitCode=1;
  void shutdown().catch(shutdownError=>{logOperational("backend","shutdown_failed",{code:safeErrorCode(shutdownError)});process.exitCode=1;});
};
const transcriptScan=startTranscriptScanLoop(ingestor,backgroundError("transcript_scan"));
const sessionSupervisor=startSessionSupervisor(sessions,backgroundError("session_supervisor"));
const reconciliationScan=startReconciliationLoop(new ReconciliationWorker(new ReconciliationRepository(pool),new OpenAITextExtractor(config.OPENAI_API_KEY),new MindWriter(pool)),backgroundError("reconciliation_scan"));
const schedulingScan=startSchedulingLoop(new CommitmentScheduler(pool),new CommitmentLogEmitter(pool,new StdoutTerminalSink()),backgroundError("scheduling_scan"));
let shutdownWork:Promise<void>|null=null;
function shutdown():Promise<void> {
  if(shutdownWork!==null)return shutdownWork;
  shuttingDown=true;
  logOperational("backend","shutdown_started");
  for(const close of notificationStreams)close();
  shutdownWork=(async()=>{
    const loops=Promise.allSettled([sessionSupervisor.stop(),transcriptScan.stop(),reconciliationScan.stop(),schedulingScan.stop()]);
    try{await sessions.drainForShutdown();}
    finally{
      const sessionCleanup=await Promise.allSettled([sessions.shutdown()]);
      if(sessionCleanup[0]?.status==="rejected")process.exitCode=1;
      await loops;
      await new Promise<void>(resolve=>{
        const force=setTimeout(()=>{server.closeAllConnections();resolve();},5000);
        server.close(()=>{clearTimeout(force);resolve();});
      });
      await pool.end();
      logOperational("backend","shutdown_complete");
    }
  })();
  return shutdownWork;
}
process.once("SIGINT",()=>{void shutdown().catch(()=>{process.exitCode=1;});});
process.once("SIGTERM",()=>{void shutdown().catch(()=>{process.exitCode=1;});});
