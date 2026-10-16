# App Flow

The application is a web-first prototype of an ambient personal intelligence system following the **Listen → Understand → Remember → Anticipate → Act** pipeline. Users speak naturally with the assistant, which identifies useful information, builds a persistent personal profile called **Mind**, tracks unfinished commitments, and follows up at relevant times.

## Core Screens & User Flow

1. **Voice Conversation:** The user talks naturally about everyday events, people, plans, and promises. The assistant responds conversationally while identifying information worth remembering.

2. **Mind (Personal Memory):** Organizes information from conversations into semantic, episodic, and prospective memories. Users can review, search, correct, or delete memories.

3. **Commitments:** Shows promises and unfinished tasks, their deadlines, and whether they are open, completed, or dismissed.

## Memory Types in Mind

| Memory type | What it remembers | Example | How it is recalled |
|---|---|---|---|
| **Semantic** | Facts and preferences about people or things | “Ananya likes science fiction movies.” | By person or topic (entity + semantic retrieval) |
| **Episodic** | What happened in a particular conversation or event | “I discussed the project idea with Ananya last Tuesday.” | By time and original conversation (time + source retrieval) |
| **Prospective** | Promises, tasks, and actions that still need to happen | “I promised to send Ananya the presentation before Friday.” | By deadline and completion status (deadline + status queries) |

## Complete Example

**1. Conversation:** The user says, “I discussed our project with Ananya on Tuesday. She loves sci-fi movies. I promised to send her the presentation before Friday.”

**2. Understand and remember:** Mind captures three distinct pieces of information:
- **Semantic:** Ananya likes sci-fi movies.
- **Episodic:** The user and Ananya discussed the project on Tuesday.
- **Prospective:** Send Ananya the presentation before Friday (open commitment).

**3. Recall:** During a later voice session, the user asks, “What does Ananya like, and what did we discuss on Tuesday?” The assistant recalls her movie preference and the project discussion from Mind.

**4. Anticipate and act:** As Friday approaches, the app proactively reminds the user about the unfinished presentation, even without an active voice session. (Not included in the v0)

**5. Follow through:** The user says, “I sent her the presentation.” The commitment is marked completed, so the app stops reminding them. The user can inspect or correct the associated memories in Mind at any time.

## Core Objective

Demonstrate the full **Listen → Understand → Remember → Anticipate → Act** loop across conversations, with useful memory recall and reliable follow-up, without building a complete consumer product.
