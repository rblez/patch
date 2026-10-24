# AGENTS.md

## Rules

1. **Do not add tests by default.**  
   Do not write tests that merely restate or describe the implementation. Add a test only when it protects an important behavior, reproduces a real bug, or is explicitly requested.

2. **Think through the architecture before implementing.**  
   Before changing code, understand the relevant system and decide where the change belongs. Prefer clear separation of concerns and changes that strengthen the existing architecture over local patches, duplicated logic, or new abstractions added for convenience.

3. **Use Conventional Commits.**  
   Commit messages should use the conventional format, including a scope when useful:
   - `feat(compiler): add style shorthand`
   - `fix(lsp): preserve element context in completions`
   - `refactor(runtime): separate ownership from scheduling`
   - `docs(readme): document snapshot workflow`
   - `chore(cli): rename binary to patch`