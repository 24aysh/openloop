export function errorMessage(code:string):string {
  switch(code){
    case "backend_unreachable":return "The backend is unreachable. Try refreshing.";
    case "invalid_server_response":return "The backend returned an invalid response.";
    case "version_conflict":return "This record changed. Review the refreshed version before retrying.";
    case "close_pending":return "The capture close is still pending. Check its status again.";
    case "model_refusal":return "Mind extraction is blocked and needs an operator retry.";
    default:return code.replaceAll("_"," ");
  }
}
