import express, { Router, type Request } from "express";
import { DomainError, startSessionRequestSchema, uuidSchema, type SessionControllerContract, type UserScope } from "../contracts";

const noQuery=(request:Request)=>{if(Object.keys(request.query).length>0) throw new DomainError("invalid_input","Unknown query parameter");};
const sessionId=(request:Request)=>uuidSchema.parse(request.params.sessionId);

export function createSessionRouter(controller:SessionControllerContract,scopeForRequest:(_request:Request)=>UserScope):Router {
  const router=Router();
  router.post("/api/sessions",express.json({limit:"70kb",strict:true}),async(request,response)=>{
    noQuery(request);const result=await controller.start(scopeForRequest(request),startSessionRequestSchema.parse(request.body));
    response.status(result.replayed?200:201).json(result.response);
  });
  router.get("/api/sessions/:sessionId",async(request,response)=>{noQuery(request);response.json(await controller.status(scopeForRequest(request),sessionId(request)));});
  router.post("/api/sessions/:sessionId/activate",async(request,response)=>{noQuery(request);response.json(await controller.activate(scopeForRequest(request),sessionId(request)));});
  router.post("/api/sessions/:sessionId/heartbeat",async(request,response)=>{noQuery(request);response.json(await controller.heartbeat(scopeForRequest(request),sessionId(request)));});
  router.post("/api/sessions/:sessionId/close",async(request,response)=>{
    noQuery(request);const status=await controller.close(scopeForRequest(request),sessionId(request));
    response.status(["closed","incomplete","failed"].includes(status.state)?200:202).json(status);
  });
  return router;
}
