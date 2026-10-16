import index from "./index.html";

Bun.serve({
  port:3000,
  development:true,
  routes:{
    "/api/*":async request=>{
      const source=new URL(request.url);
      const target=new URL(source.pathname+source.search,"http://127.0.0.1:3001");
      try{return await fetch(new Request(target,request));}
      catch(error){
        const code=typeof error==="object"&&error!==null&&"code" in error&&typeof error.code==="string"?error.code:"proxy_fetch_failed";
        process.stderr.write(`${JSON.stringify({timestamp:new Date().toISOString(),component:"frontend_proxy",event:"upstream_failed",method:request.method,path:source.pathname,code})}\n`);
        return Response.json({error:{code:"proxy_unreachable",message:"Frontend proxy could not reach backend"}},{status:502});
      }
    },
    "/*":index,
  },
});
