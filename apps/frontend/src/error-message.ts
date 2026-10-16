export function errorMessage(code:string):string {
  switch(code){
    case "backend_unreachable":return "The backend is unreachable. Try refreshing.";
    case "proxy_unreachable":return "The frontend proxy could not reach the backend. Check that the backend is running on port 3001.";
    case "service_unavailable":return "The backend is temporarily unavailable. Check its terminal logs and readiness endpoint.";
    case "invalid_server_response":return "The backend returned an invalid response.";
    case "integrity_error":return "Transcript capture stopped after a conflicting Realtime event. Check the backend transcript log for this session.";
    case "version_conflict":return "This record changed. Review the refreshed version before retrying.";
    case "close_pending":return "The capture close is still pending. Check its status again.";
    case "model_refusal":return "Mind extraction is blocked and needs an operator retry.";
    default:return code.replaceAll("_"," ");
  }
}
