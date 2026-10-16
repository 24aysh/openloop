import { Router, type Request } from "express";
import { z } from "zod";
import { commitmentEditSchema, commitmentQuerySchema, cursorSchema, memoryEditSchema, memoryQuerySchema, uuidSchema, versionedSchema, DomainError, type UserScope } from "../contracts";
import { MindReader, MindWriter } from "../mind";

const routeId=(request:Request,name:string)=>uuidSchema.parse(request.params[name]);
const pageFromQuery=(query:Request["query"])=>({
  limit:query.limit===undefined?50:z.coerce.number().int().min(1).max(100).parse(query.limit),
  cursor:query.cursor===undefined?null:cursorSchema.parse(query.cursor),
});
const stringQuery=(value:unknown)=>value===undefined?undefined:z.string().parse(value);
const checkQuery=(query:Request["query"],allowed:readonly string[])=>{
  for(const key of Object.keys(query)) if(!allowed.includes(key)) throw new DomainError("invalid_input","Unknown query parameter",{field:key});
};

export function createMindRouter(reader:MindReader,writer:MindWriter,scopeForRequest:(_request:Request)=>UserScope):Router {
  const router=Router();
  router.get("/api/mind/memories",async(req,res)=>{
    checkQuery(req.query,["state","kind","subject","text","limit","cursor"]);
    const filters=memoryQuerySchema.parse({state:stringQuery(req.query.state),kind:stringQuery(req.query.kind),subject:stringQuery(req.query.subject),text:stringQuery(req.query.text)});
    res.json(await reader.listMemories(scopeForRequest(req),{...filters,...pageFromQuery(req.query)}));
  });
  router.get("/api/commitments",async(req,res)=>{
    checkQuery(req.query,["status","priority","dueBefore","limit","cursor"]);
    const filters=commitmentQuerySchema.parse({status:stringQuery(req.query.status),priority:req.query.priority===undefined?undefined:z.coerce.number().parse(req.query.priority),dueBefore:stringQuery(req.query.dueBefore)});
    res.json(await reader.listCommitments(scopeForRequest(req),{...filters,...pageFromQuery(req.query)}));
  });
  router.get("/api/sessions/:sessionId/transcript",async(req,res)=>{checkQuery(req.query,["limit","cursor"]);res.json(await reader.getTranscript(scopeForRequest(req),routeId(req,"sessionId"),pageFromQuery(req.query)));});
  router.get("/api/mind/:entityType/:id/provenance",async(req,res)=>{
    checkQuery(req.query,[]);
    const type=z.enum(["memory","commitment"]).parse(req.params.entityType);
    res.json(await reader.getProvenance(scopeForRequest(req),{type,id:routeId(req,"id")}));
  });
  router.patch("/api/mind/memories/:id",async(req,res)=>{res.json(await writer.editMemory(scopeForRequest(req),routeId(req,"id"),memoryEditSchema.parse(req.body)));});
  router.delete("/api/mind/memories/:id",async(req,res)=>{res.json(await writer.deleteMemory(scopeForRequest(req),routeId(req,"id"),versionedSchema.parse(req.body)));});
  router.patch("/api/commitments/:id",async(req,res)=>{res.json(await writer.editCommitment(scopeForRequest(req),routeId(req,"id"),commitmentEditSchema.parse(req.body)));});
  router.delete("/api/commitments/:id",async(req,res)=>{res.json(await writer.deleteCommitment(scopeForRequest(req),routeId(req,"id"),versionedSchema.parse(req.body)));});
  return router;
}
