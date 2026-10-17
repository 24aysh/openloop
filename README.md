## openloop

This is a small implementation of a voice agent with which users can naturally and another text llm uses those transcripts to filtrate mind with memories, facts and commitments. Something similar to moonshot(yc s26) that i tried to replicate.

### improvement that i intend to do but i haven't (were not a part of this mvp)

- currently there is no retrieval mechanism for mind, so the agent cannot really make use of mind.
- the agent cannot do any tool calls/ there aren't any tools.
- the notifs can be replaced by something else, like the intent was to capture commitments, it depends on us what we do that with it. In this mvp, i have just decided to log them.

### architecture

### demo run

### local run

for a live browser walkthrough and SQL checks against transcripts, Mind changes, and due logs, follow the [manual testing guide](docs/manual-testing.md).


