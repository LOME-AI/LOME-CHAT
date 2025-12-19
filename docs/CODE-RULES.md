# Code Rules

Coding standards for all contributors (human and AI).

---

## Core Principles

### 95% Test Coverage

- No exceptions
- Tests written before or with implementation
- No skipped or commented tests
- Coverage checked on every push

### Type Safety

- Explicit return types on all functions
- No `any` types without documented justification
- Rely on Drizzle and Zod inference for generated types
- Never manually duplicate inferred types

### Fail Fast

- Validate preconditions immediately
- Never defer errors with fallback values
- Missing config = immediate crash with clear message
- Invalid input = reject at boundary, not deep in logic

### Never Hide Problems

- No `|| true` to hide command failures
- No `2>/dev/null` to suppress errors
- No `@ts-ignore` without explanation
- No `eslint-disable` without justification
- No `--force` or `--legacy-peer-deps`
- Fix root causes, don't mask symptoms

---

## Error Handling

- Never swallow errors silently
- Use custom error classes with context
- Log with sufficient detail for debugging
- Graceful degradation where appropriate
- Every external call wrapped in try/catch

---

## Patterns

### Single Source of Truth

- Drizzle schema defines database types
- Zod schemas define API contracts
- Types flow from these sources, never duplicated

### Idempotency

- Every operation safe to retry
- Use unique constraints and upsert
- Check completion before external calls
- Content-addressable keys for storage

### Direct Resource Access

- No gatekeeper services
- Type-safe wrappers for all external resources
- Packages provide safety without network hops

### Serverless Mindset

- Handle cold starts gracefully
- No persistent in-memory state
- State lives in database or Redis only

---

## Code Organization

### Naming

- Components: `PascalCase.tsx`
- Utilities: `camelCase.ts`
- Constants: `SCREAMING_SNAKE_CASE`
- Types: `PascalCase`
- Tests: `*.test.ts`

### Structure

- Colocate tests with source
- Shared code in `packages/`, never copy-pasted
- One component/function per file
- `index.ts` for exports only

### Imports

1. External dependencies
2. Internal packages (`@/packages/*`)
3. Relative imports
4. Type imports last

---

## Testing

### Requirements

- Unit tests for all business logic
- Integration tests for database and API operations
- E2E tests for critical user flows
- Tests must not depend on execution order
- No hardcoded dates (use time mocking)
- Test behavior, not implementation

### What to Test

- Happy paths
- Error conditions
- Edge cases and boundaries
- Idempotency
- Input validation

---

## Security

- Validate all external input with Zod
- Never trust client-provided IDs
- Never interpolate user input in queries
- Never hardcode or log secrets
- Rate limit auth endpoints

---

## Performance

- Measure before optimizing
- Add indexes for common queries
- Cache expensive computations
- Paginate list endpoints
- Stream large responses
- Use workers for tasks >5 seconds

---

## Documentation

### When to Comment

- Non-obvious business logic
- Exceptions to established rules
- Complex algorithms
- Subtle edge cases

### When Not to Comment

- Obvious operations
- Self-explanatory names
- Standard patterns
- What code does (code shows this)

### Never Include

- Specific file paths that may move
- Hardcoded version numbers
- Specific timing estimates
- Ephemeral values (container IDs, hashes)

---

## Enforcement

- Pre-commit: Prettier, basic lint
- Pre-push: ESLint, typecheck, tests
- CI: Full test suite, coverage check
- Review: Human judgment on patterns and quality

No exceptions.
