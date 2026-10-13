# Agent Instructions

## Project context

We are building a **web-first prototype of an ambient personal intelligence assistant**, not a full consumer product. It lets users have natural voice conversations, extracts and retains relevant information in a persistent personal profile called **Mind**, tracks unresolved commitments, and proactively follows up when action is needed. The core loop is **Listen → Understand → Remember → Anticipate → Act**.

**Read `app-flow.md`** It is the source of truth for the intended user journey, core screens, memory types, and example behavior. Keep changes aligned with that scope; clarify or document deviations rather than introducing unrelated features.

## 1. Inspect before implementing

Do not start coding immediately. Before making a feature, fix, refactor, or utility:

- Read the relevant repository structure, configuration, package manifests, and project documentation.
- Search for existing implementations, abstractions, helpers, tools, agents, schemas, protocols, and tests that can be reused or extended.
- Trace the relevant call sites and data flow before changing shared behavior.
- Inspect existing tests and follow the project's established naming, architecture, formatting, and error-handling conventions.
- Prefer the smallest coherent change; do not refactor unrelated code or introduce a new pattern without a clear reason.

Before **every editing session** and before any requested commit, inspect:

```bash
git status --short
git diff
git diff --staged
```

Treat existing uncommitted changes as user-owned. Never overwrite, revert, stage, or commit unrelated changes.

## 2. Plan non-trivial changes

For non-trivial work, write a short implementation plan **before editing**. Include:

- Existing code or abstractions to reuse.
- Files/modules expected to change and the behavior being added or modified.
- Tests to add/update and commands to validate the change.
- Compatibility, API, schema, data migration, and rollout concerns, if applicable.
- Whether a new dependency is truly needed, and why.

Keep the plan practical and proportional to the task. Update it if inspection reveals important new constraints.

## 3. General engineering standards

- Write clear, simple, production-style code. Prefer explicit behavior over cleverness, premature generalization, or unnecessary layers.
- Keep functions focused and modules organized by domain/responsibility, not as a collection of unrelated utilities.
- Reuse established interfaces and patterns; avoid duplicate logic and inconsistent representations of the same data.
- Minimize dependencies. Use standard-library or already-installed solutions when they meet the requirements.
- Validate untrusted input at system boundaries; handle errors deliberately instead of silently ignoring them.
- Keep configuration and secrets out of source code. Never commit credentials, tokens, `.env` files, or sensitive test fixtures.
- Use the project's logging/tracing facilities instead of `print()` or `console.log()` for production diagnostics. Do not log secrets, private conversations, or personal memory content unnecessarily.
- Make external actions safe to retry where applicable; avoid duplicate reminders, notifications, or tool executions.
- Update documentation when a user-facing behavior, public interface, configuration, or setup step changes.
- Avoid unrelated reformatting, speculative optimizations, and large mechanical changes unless explicitly requested.

## 4. Python best practices

- Follow the repository's existing Python version, formatter, linter, test runner, and package conventions.
- Add type hints to new or modified public functions and important data structures; avoid unnecessary `Any` and ambiguous return values.
- Prefer small, focused functions and explicit interfaces. Use `dataclass`, `TypedDict`, or existing validation models when appropriate; do not introduce a framework for a simple structure.
- Avoid mutable default arguments, hidden global state, and broad `except Exception` handlers that conceal failures.
- Raise meaningful exceptions, preserve the original cause when useful, and distinguish expected failures from programming errors.
- Use context managers for files, connections, and other resources; release resources reliably on failure.
- For async code, avoid blocking the event loop, untracked background tasks, and swallowed cancellation. Define timeouts and cleanup behavior for network operations.
- Prefer parameterized queries and existing data-access abstractions over handcrafted SQL string interpolation.
- Write focused `pytest` tests (or use the repository's test framework) for success, failure, edge cases, and important state transitions.

## 5. TypeScript / React best practices

- Respect the project's TypeScript configuration and existing lint, formatting, and build conventions; prefer strict typing.
- Avoid `any`, `@ts-ignore`, unchecked casts, and non-null assertions unless genuinely unavoidable and justified.
- Model domain states with precise types and discriminated unions; handle all cases explicitly where practical.
- Validate runtime data from APIs, tools, browser storage, and external services; static TypeScript types do not validate JSON.
- Use `async`/`await` consistently, handle rejected promises, and clean up subscriptions, listeners, and active sessions.
- Keep UI components focused; separate presentation from data access, business logic, and side effects.
- In React/Next.js, follow existing Server/Client Component boundaries and avoid exposing server-only credentials or logic to the browser.
- Use accessible, semantic UI controls and make loading, error, empty, and success states explicit.
- Add or update unit/integration tests for changed logic and run the project's typecheck, lint, and relevant tests.

## 6. Verification and handoff

- Test the smallest relevant scope first, then run broader checks as appropriate.
- Verify edge cases, failure paths, concurrency/retry behavior, and compatibility with existing callers when relevant.
- Review the final diff for unintended changes, dead code, leaked secrets, and unnecessary dependencies.
- Report what changed, what was tested, and any remaining limitations. Never claim tests passed unless they were actually run.
- If a check cannot run, explain why and state what remains unverified.

## 7. Commit policy

**Never commit unless the user explicitly asks.** If asked to commit, inspect the working tree and staged diff, stage only intended changes, and use a signed-off Conventional Commit:

```bash
git commit -s -m "<type>: <short purpose>"
```

Use a short, production-style message. Preferred types:

- `feat` — new behavior or capability
- `fix` — bug fix
- `refactor` — structural change without intended behavior change
- `perf` — performance improvement
- `test` — test-only change
- `docs` — documentation-only change
- `chore` — maintenance
- `build` — dependency, build, or packaging change
- `ci` — CI workflow change
