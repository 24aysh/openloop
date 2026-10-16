import index from "./index.html";

Bun.serve({
  port:3000,
  development:true,
  routes:{
    "/api/*":request=>{
      const source=new URL(request.url);
      const target=new URL(source.pathname+source.search,"http://127.0.0.1:3001");
      return fetch(new Request(target,request));
    },
    "/*":index,
  },
});
