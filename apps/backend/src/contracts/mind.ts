import type { Counter, PageRequest, Timestamp, UserScope, UUID } from "./common";
import type { Memory, MemoryEdit, MemoryPage, MemoryQuery } from "./memories";
import type { Commitment, CommitmentEdit, CommitmentPage, CommitmentQuery } from "./commitments";
import type { TranscriptPage } from "./transcripts";
import type { ApplyResult, JobClaim, ValidatedChangeSet } from "./reconciliation";
export type MindChangeOperation="create"|"update"|"delete"|"complete"|"dismiss"|"reopen"|"release_override";

export type EntityRef = Readonly<{type:"memory"|"commitment";id:UUID}>;
export type ChangeSource = Readonly<{transcriptPartId:UUID;sessionId:UUID;itemId:UUID;itemOrdinal:number;contentIndex:number;evidenceText:string}>;
export type ChangeWithSources = Readonly<{id:UUID;entityVersion:Counter;operation:MindChangeOperation;actor:"reconciler"|"user";jobId:UUID|null;afterState:Memory|Commitment;createdAt:Timestamp;sources:readonly ChangeSource[]}>;
export type MindSnapshot = Readonly<{revision:Counter;memories:readonly Memory[];commitments:readonly Commitment[]}>;

export interface MindReaderContract {
  getSnapshot(scope:UserScope):Promise<MindSnapshot>;
  listMemories(scope:UserScope,query:MemoryQuery&PageRequest):Promise<MemoryPage>;
  listCommitments(scope:UserScope,query:CommitmentQuery&PageRequest):Promise<CommitmentPage>;
  getTranscript(scope:UserScope,sessionId:UUID,page:PageRequest):Promise<TranscriptPage>;
  getProvenance(scope:UserScope,entity:EntityRef):Promise<readonly ChangeWithSources[]>;
}
export interface MindWriterContract {
  editMemory(scope:UserScope,id:UUID,edit:MemoryEdit):Promise<Memory>;
  deleteMemory(scope:UserScope,id:UUID,guard:{expectedVersion:Counter}):Promise<Memory>;
  editCommitment(scope:UserScope,id:UUID,edit:CommitmentEdit):Promise<Commitment>;
  applyExtraction(claim:JobClaim,changes:ValidatedChangeSet):Promise<ApplyResult>;
}
