import type pg from "pg";
import { TranscriptIntegrityError, ITEM_SELECT, type ItemRow, type SessionRow } from "./internal";

export async function assemble(client:pg.PoolClient,session:SessionRow):Promise<ItemRow[]> {
  const result=await client.query<ItemRow>(`SELECT ${ITEM_SELECT} FROM transcript_items WHERE user_id=$1 AND session_id=$2 ORDER BY provider_item_id FOR UPDATE`,[session.user_id,session.id]);
  const items=result.rows;
  const byId=new Map(items.map(item=>[item.provider_item_id,item]));
  const roots=items.filter(item=>item.predecessor_known && item.previous_item_id===null);
  if(roots.length>1) throw new TranscriptIntegrityError("multiple_roots");
  const successor=new Map<string,ItemRow>();
  for(const item of items){
    if(!item.predecessor_known || item.previous_item_id===null) continue;
    if(item.previous_item_id===item.provider_item_id || successor.has(item.previous_item_id)) throw new TranscriptIntegrityError("branch_or_self_link");
    successor.set(item.previous_item_id,item);
  }
  for(const item of items){
    const seen=new Set<string>();let current:ItemRow|undefined=item;
    while(current && current.predecessor_known && current.previous_item_id!==null){
      if(seen.has(current.provider_item_id)) throw new TranscriptIntegrityError("cycle");
      seen.add(current.provider_item_id);
      current=byId.get(current.previous_item_id);
    }
  }
  const chain:ItemRow[]=[];
  let current=roots[0];
  while(current){chain.push(current);current=successor.get(current.provider_item_id);}
  if(chain.length<session.sealed_through) throw new TranscriptIntegrityError("sealed_chain_short");
  for(const [position,item] of chain.entries()){
    const ordinal=position+1;
    if(item.ordinal!==null && item.ordinal!==ordinal) throw new TranscriptIntegrityError("ordinal_changed");
    if(item.ordinal===null) await client.query("UPDATE transcript_items SET ordinal=$3,updated_at=now() WHERE user_id=$1 AND id=$2",[session.user_id,item.id,ordinal]);
    item.ordinal=ordinal;
  }
  for(const item of items) if(item.ordinal!==null && !chain.some(placed=>placed.id===item.id)) throw new TranscriptIntegrityError("placed_item_missing");
  if(session.ordered_through>chain.length) throw new TranscriptIntegrityError("ordered_chain_short");
  if(chain.length!==session.ordered_through){
    await client.query("UPDATE voice_sessions SET ordered_through=$3,updated_at=now() WHERE user_id=$1 AND id=$2",[session.user_id,session.id,chain.length]);
    session.ordered_through=chain.length;
  }
  return chain;
}
