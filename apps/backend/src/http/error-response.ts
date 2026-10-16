import type { ErrorRequestHandler } from "express";
import { DomainError } from "../contracts";
import { ZodError } from "zod";

const statusByCode:Record<DomainError["code"],number>={
  not_found:404,invalid_input:400,version_conflict:409,capture_closed:409,ordering_gap:409,
  stale_claim:409,stale_snapshot:409,dependency_blocked:409,active_session_exists:409,
  start_request_conflict:409,restart_required:409,session_not_ready:409,upstream_failure:502,setup_timeout:504,
};
export const errorResponse:ErrorRequestHandler=(error:unknown,_request,response,_next)=>{
  if(error instanceof DomainError){response.status(statusByCode[error.code]).json({error:{code:error.code,message:error.message,...(error.details?{details:error.details}:{})}});return;}
  if(error instanceof ZodError || error instanceof SyntaxError){response.status(400).json({error:{code:"invalid_input",message:"Invalid request"}});return;}
  if(typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large") {response.status(413).json({error:{code:"invalid_input",message:"Request body too large"}});return;}
  response.status(503).json({error:{code:"service_unavailable",message:"Service unavailable"}});
};
