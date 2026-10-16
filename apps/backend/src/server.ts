import express from "express";
import { readConfig } from "./config";
import { createPool, checkDatabase } from "./db/pool";
import { withTransaction } from "./db/transaction";
import { MindReader, MindWriter } from "./mind";
import { createMindRouter } from "./http/mind-routes";
import { errorResponse } from "./http/error-response";

const config=readConfig();
const pool=createPool(config.DATABASE_URL);
await checkDatabase(pool);
await withTransaction(pool,{isolation:"read committed"},async client=>{
  await client.query("INSERT INTO users(id,timezone) VALUES($1,$2) ON CONFLICT (id) DO NOTHING",[config.DEMO_USER_ID,config.DEMO_USER_TIMEZONE]);
  await client.query("INSERT INTO mind_state(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING",[config.DEMO_USER_ID]);
});

const app=express();
app.use(express.json({limit:"32kb",strict:true}));
const scope={userId:config.DEMO_USER_ID};
app.use(createMindRouter(new MindReader(pool),new MindWriter(pool),()=>scope));
app.use(errorResponse);
app.get("/health/live",(_request,response)=>response.json({ok:true}));
app.get("/health/ready",async(_request,response)=>{try{await checkDatabase(pool);response.json({ok:true});}catch{response.status(503).json({ok:false});}});
const server=app.listen(config.PORT,"127.0.0.1");
const shutdown=async()=>{server.close();await pool.end();};
process.once("SIGINT",()=>{void shutdown();});
process.once("SIGTERM",()=>{void shutdown();});
