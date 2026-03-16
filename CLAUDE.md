# Claude Code Development Guidelines for Crewly

This document outlines the technical preferences and workflow standards for maintaining the Crewly codebase. All Claude Code instances working on this project should follow these guidelines.

## 🏗️ Project Structure

### Core Components
- **Backend** (`/backend/src/`) - Express.js server with TypeScript
- **Frontend** (`/frontend/src/`) - React.js with TypeScript  
- **MCP Server** (`/mcp-server/src/`) - TypeScript MCP server for agent communication
- **CLI** (`/cli/src/`) - Command-line interface for Crewly operations

### Build System
- All TypeScript code compiles to `/dist/` directory
- Frontend builds to `/frontend/dist/`
- Each component has its own `tsconfig.json`

### System Design Documentation
- **Specifications Directory** (`/specs/`) - Contains authoritative system design documents
- **Technical Architecture** - Documented in `specs/project.md` 
- **MCP Implementation** - Detailed in `specs/mcp-design.md`
- **UI/UX Guidelines** - Defined in `specs/frontend-design.md`
- **User Workflows** - Mapped in `specs/user-journey.md`

## 📝 Code Standards

### TypeScript Requirements
- **Always use TypeScript** - No vanilla JavaScript files in source
- **Strict type checking** - Enable all TypeScript strict mode options
- **Explicit types** - Define interfaces and types for all data structures
- **No `any` types** - Use proper typing or `unknown` with type guards

### File Organization
**CRITICAL: One Source File, One Test File Policy**

For both frontend and backend development, **every source file must have a corresponding test file** placed directly next to it:

```
✅ Correct Structure (Frontend & Backend):
src/
├── components/
│   ├── TeamCard.tsx
│   ├── TeamCard.test.tsx
│   ├── Modal.tsx
│   └── Modal.test.tsx
├── services/
│   ├── api.service.ts
│   ├── api.service.test.ts
│   ├── auth.service.ts
│   └── auth.service.test.ts
├── types/
│   ├── index.ts
│   └── index.test.ts          # Test type utilities and validators
└── utils/
    ├── helpers.ts
    └── helpers.test.ts

❌ Incorrect - NO separate test directories:
src/services/api.service.ts
tests/services/api.service.test.ts
__tests__/api.service.test.ts
```

**Mandatory Requirements:**
- **Every `.ts` file** → Must have corresponding `.test.ts` file
- **Every `.tsx` file** → Must have corresponding `.test.tsx` file  
- **Test files** → Must be in the **same directory** as source files
- **No exceptions** → Even utility files and type definitions need tests

### Import/Export Standards
- Use **ES modules** (`import`/`export`) - No CommonJS `require()`
- **Relative imports** for local files: `./component.js`
- **Absolute imports** for packages: `express`, `react`
- Always include `.js` extension in imports for Node.js compatibility

### Constants and Configuration Management
**CRITICAL: No hardcoded values in source code**

#### Constants Organization
- **Cross-domain constants** → `/config/constants.ts` (shared across backend, frontend, CLI, MCP)
- **Backend-specific constants** → `/config/backend-constants.ts` (backend-only values)
- **Frontend-specific constants** → `/config/frontend-constants.ts` (UI-related constants)
- **CLI-specific constants** → `/config/cli-constants.ts` (CLI command configurations)
- **Centralized exports** → `/config/index.ts` (single import point for all constants)

#### Centralized Constants Structure
```typescript
// /config/constants.ts - Cross-domain shared constants
export const CREWLY_CONSTANTS = {
  SESSIONS: {
    ORCHESTRATOR_NAME: 'crewly-orc',
    DEFAULT_TIMEOUT: 120000,
    REGISTRATION_CHECK_INTERVAL: 5000,
  },
  PATHS: {
    CREWLY_HOME: '.crewly',
    TEAMS_FILE: 'teams.json',
    PROJECTS_FILE: 'projects.json',
    CONFIG_DIR: 'config',
    PROMPTS_DIR: 'prompts',
  },
  AGENT_STATUSES: {
    INACTIVE: 'inactive',
    ACTIVATING: 'activating', 
    ACTIVE: 'active',
  },
  WORKING_STATUSES: {
    IDLE: 'idle',
    IN_PROGRESS: 'in_progress',
  },
} as const;

export const MCP_CONSTANTS = {
  PORTS: {
    DEFAULT: 3001,
    HEALTH_CHECK: '/health',
  },
  TIMEOUTS: {
    RESPONSE: 30000,
    CONNECTION: 10000,
  },
} as const;
```

#### Import Patterns
```typescript
// ✅ Import cross-domain constants
import { CREWLY_CONSTANTS, MCP_CONSTANTS } from '../config';

// ✅ Import specific backend constants  
import { ORCHESTRATOR_SESSION_NAME, DEFAULT_WEB_PORT } from '../config';

// ✅ Import domain-specific constants
import * as BackendConstants from '../config/backend-constants.js';

// ✅ Import grouped constants for convenience
import { BACKEND_CONSTANTS, CROSS_DOMAIN_CONSTANTS } from '../config';

// ❌ Don't import from individual domain files directly
import { ORCHESTRATOR_SESSION_NAME } from '../config/backend-constants.js'; // Avoid

// ❌ Don't use hardcoded values
const sessionName = 'crewly-orc'; // Use ORCHESTRATOR_SESSION_NAME instead
```

#### Constants Best Practices
1. **Use const assertions** (`as const`) for immutable objects
2. **Group related constants** into logical namespaces  
3. **Use SCREAMING_SNAKE_CASE** for constant names
4. **Import from `/config`** - Use centralized config directory for all constants
5. **Document constant purposes** with JSDoc comments
6. **Never inline magic numbers** - always extract to named constants
7. **Use enums for related string/number values** that form a closed set
8. **Maintain 1:1 source-to-test ratio** - Every constants file needs a test file

#### Prohibited Hardcoded Values
- **Port numbers** (3000, 3001, 8080, etc.)
- **Timeout values** (30000, 120000, etc.)
- **File paths** ('.crewly', 'config/prompts', etc.)
- **Status strings** ('active', 'inactive', 'pending', etc.)
- **Session names** ('crewly-orc', default session patterns)
- **API endpoints** ('/health', '/api/teams', etc.)
- **Magic numbers** (retry counts, buffer sizes, etc.)
- **Default configurations** (check intervals, batch sizes, etc.)

## 🧪 Testing Standards

### Test File Placement
**Critical:** Write test files **next to source files**, not in separate test directories.

```
✅ Correct:
src/
├── user.service.ts
├── user.service.test.ts
├── auth.controller.ts  
└── auth.controller.test.ts

❌ Incorrect:
src/user.service.ts
tests/user.service.test.ts
```

### Test File Naming
- Unit tests: `*.test.ts`
- Integration tests: `*.integration.test.ts`
- End-to-end tests: `*.e2e.test.ts`

### Testing Requirements
**MANDATORY: Every source file must have tests**

1. **Unit tests** for all business logic functions
2. **Integration tests** for API endpoints and database operations
3. **Component tests** for React components
4. **MCP server tests** for all MCP tools and protocols

**One-to-One Mapping Policy:**
- **Backend services** → `service.test.ts` next to `service.ts`
- **Frontend components** → `Component.test.tsx` next to `Component.tsx`
- **API controllers** → `controller.test.ts` next to `controller.ts`
- **Utility functions** → `utils.test.ts` next to `utils.ts`
- **Type definitions** → `types.test.ts` for type guards and validators

### Test Coverage Goals
- **Minimum 80%** code coverage for new features
- **100% coverage** for critical business logic
- All **public API methods** must have tests

## 🔄 Development Workflow

### Before Starting Development
1. **Read system specifications** - Always review `/specs/` directory to understand system design:
   - `specs/project.md` - Core architecture and technical specifications
   - `specs/mcp-design.md` - MCP server implementation details
   - `specs/frontend-design.md` - UI/UX design patterns
   - `specs/user-journey.md` - User workflows and interactions
   - Task-specific specs in `specs/tasks/` subdirectories
2. **Read existing code** to understand patterns and conventions
3. **Check for existing tests** to understand expected behavior
4. **Run the build** to ensure starting from a clean state:
   ```bash
   npm run build
   ```

### During Development
1. **Write code** following TypeScript standards
2. **Write tests** immediately after implementing features
3. **Use existing patterns** found in the codebase
4. **Update types** when modifying data structures
5. **Update specifications** when making significant architectural changes:
   - Modify existing spec files in `/specs/` when changing system behavior
   - Create new spec files for new features or components
   - Ensure specs accurately reflect implemented functionality
   - Update technical diagrams and workflow descriptions

### Before Completing Work
**MANDATORY:** Always perform this checklist before marking work as complete:

#### 1. Build Verification
```bash
# Build all components
npm run build

# Verify no TypeScript errors
npm run typecheck

# Check linting
npm run lint
```

#### 2. Test Execution
```bash
# Run all unit tests
npm run test:unit

# Run integration tests  
npm run test:integration

# Run MCP server tests
npm run test:mcp

# Run full test suite
npm test
```

#### 3. Functionality Verification
```bash
# Test CLI functionality
npx crewly start --no-browser

# Verify MCP server integration
curl http://localhost:3001/health

# Test backend health
curl http://localhost:3000/health
```

#### 4. Code Quality Checks
- **No console.log** statements in production code
- **No commented-out code** blocks
- **No TODO comments** without GitHub issues
- **Proper error handling** with try/catch blocks

## 🚀 Deployment Standards

### Build Process
All deployments must pass:
1. **TypeScript compilation** - No type errors
2. **Linting** - ESLint rules must pass
3. **Unit tests** - 100% pass rate required
4. **Integration tests** - All must pass
5. **Build verification** - Compiled code must run successfully

### Environment Configuration
- Use **environment variables** for configuration
- **No hardcoded values** in source code
- Support for **development**, **test**, and **production** environments

## 📚 Documentation Requirements

### Code Documentation
**MANDATORY: All functions must have proper descriptions**

#### Function Documentation Requirements
Every function, method, and class must include:

```typescript
/**
 * Brief description of what this function does (one line)
 * 
 * Detailed explanation if the function is complex, including:
 * - Purpose and business logic
 * - Algorithm or approach used
 * - Side effects or state changes
 * 
 * @param paramName - Description of what this parameter does
 * @param options - Configuration object with specific properties
 * @returns Description of return value and its structure
 * @throws Description of when and what errors might be thrown
 * 
 * @example
 * ```typescript
 * const result = await processUserData(userData, { validate: true });
 * ```
 */
async function processUserData(
  userData: UserInput, 
  options: ProcessOptions
): Promise<ProcessedUser> {
  // Implementation
}
```

#### Documentation Standards
- **JSDoc comments** for all public functions, methods, and classes
- **Inline comments** for complex business logic within functions
- **Parameter descriptions** for all function parameters
- **Return type descriptions** explaining what is returned
- **Example usage** for non-trivial functions
- **Error handling documentation** for functions that can throw
- **README.md** updates for new features
- **API documentation** for new endpoints
- **Type definitions** with descriptive comments

#### Comment Quality Requirements
- **Be specific** - "Validates user input" not "Validates data"
- **Explain why** - Not just what the code does, but why it's needed
- **Include edge cases** - Document special handling or limitations
- **Update with changes** - Comments must stay current with code

### Commit Standards
```bash
# Feature commits
feat: add get_agent_logs MCP tool with terminal monitoring

# Bug fixes  
fix: resolve TypeScript compilation errors in MCP server

# Tests
test: add comprehensive unit tests for ActivityMonitor service

# Refactoring
refactor: migrate MCP server from JavaScript to TypeScript
```

## 🔧 Tool-Specific Guidelines

### Backend Development
- **Express.js** with TypeScript
- **Service layer pattern** - separate business logic from controllers
- **Dependency injection** where appropriate
- **Async/await** - no callback-style code

### Frontend Development  
- **React** with TypeScript and hooks
- **Component composition** over inheritance
- **Custom hooks** for shared logic
- **Proper state management** (Context API or external library)

### MCP Server Development
- **HTTP-based MCP protocol** implementation
- **Tool definitions** with proper TypeScript interfaces
- **Error handling** with appropriate HTTP status codes
- **Rate limiting** for tool calls

### CLI Development
- **Commander.js** for argument parsing
- **Chalk** for colored output
- **Proper error codes** and user-friendly messages
- **Help text** for all commands and options

## 🚨 Critical Rules

### Never Skip These Steps
1. **Always read system specifications** before starting implementation - Review `/specs/` directory
2. **Always write tests** alongside code - One source file = One test file
3. **Always document functions** with proper JSDoc comments
4. **Always run the full build** before completion
5. **Always verify tests pass** before marking work complete
6. **Always update specifications** when making significant architectural changes
7. **Never commit untested code** to main branch
8. **Never leave TypeScript errors** unresolved
9. **Never create source files without corresponding test files**
10. **Never put premium/paid content in the OSS repo** - Premium templates, norms/SOPs, and paid skills belong on Cloud Service (crewlyai.com), not in `config/templates/`. OSS repo only has basic/free templates.
11. **Always follow the Code Commit SOP** (9 steps, 3 review rounds) - See `specs/git-workflow.md` and team norms

### Error Prevention
- **Type check** before every commit
- **Test coverage** verification required
- **Build success** mandatory before completion
- **Manual testing** of modified functionality

## 📋 Completion Checklist Template

Use this checklist for every development task:

```markdown
## Pre-Completion Checklist

### Code Quality
- [ ] TypeScript compilation successful (`npm run build`)
- [ ] No linting errors (`npm run lint`) 
- [ ] No TypeScript type errors (`npm run typecheck`)
- [ ] Tests written for new functionality (1:1 source-to-test ratio)
- [ ] Test coverage meets requirements
- [ ] All functions have proper JSDoc documentation
- [ ] Every source file has corresponding test file in same directory

### Testing
- [ ] Unit tests pass (`npm run test:unit`)
- [ ] Integration tests pass (`npm run test:integration`)
- [ ] MCP tests pass (`npm run test:mcp`)
- [ ] Full test suite passes (`npm test`)

### Functionality
- [ ] Feature works as expected in development
- [ ] CLI commands function properly (`npx crewly start`)
- [ ] MCP server responds correctly (health check)
- [ ] Backend API endpoints accessible

### Documentation
- [ ] JSDoc comments added to all functions and classes
- [ ] Complex business logic has inline comments
- [ ] All function parameters and return types documented
- [ ] README updated if applicable
- [ ] CHANGELOG.md updated for user-facing changes
- [ ] Type definitions documented
- [ ] Error handling documented for functions that throw

### Specifications
- [ ] Reviewed relevant specs in `/specs/` directory before implementation
- [ ] Updated system specs when making architectural changes
- [ ] Created new spec files for new features or major components
- [ ] Verified implementation matches specification requirements
- [ ] Updated technical diagrams and workflow descriptions if affected

### Final Verification
- [ ] Clean build from scratch works
- [ ] No console errors in browser/terminal
- [ ] All modified files saved and committed
- [ ] Work matches requirements exactly
```

---

## 🎯 Success Criteria

Work is considered **complete** only when:
1. **All builds pass** without errors or warnings
2. **All tests pass** with 100% success rate  
3. **Functionality works** as demonstrated by manual testing
4. **Code quality** meets all standards outlined above
5. **Documentation** is updated appropriately

**Remember:** The goal is not just working code, but maintainable, tested, and documented code that follows project conventions.

## 🔒 Enforcement Rules

### File Creation Policy
**CRITICAL:** When creating any new source file:
1. **Create the test file first** or **immediately after** the source file
2. **Test file must be in the same directory** as the source file  
3. **Test file must follow naming convention**: `filename.test.ts` or `filename.test.tsx`
4. **No source file exists without its corresponding test file**

### Function Documentation Policy  
**CRITICAL:** Before committing any code:
1. **Every function must have JSDoc comments** with description, parameters, and return value
2. **Complex functions must include examples** in JSDoc comments
3. **Functions that throw errors must document when and what they throw**
4. **No undocumented public functions or methods allowed**

### Specification Compliance Policy  
**CRITICAL:** When working on Crewly:
1. **Read specifications first** - Review `/specs/` directory before any implementation
2. **Update specifications during development** - Modify or create spec files when making architectural changes
3. **Verify implementation matches specs** - Ensure code aligns with documented system design
4. **Keep specifications current** - Specs must accurately reflect the implemented system

### Violations Are Blocking Issues
- **Ignoring system specifications** → Implementation review failure, must align with specs first
- **Missing test files** → Code review failure, must fix before merge
- **Missing function documentation** → Build failure, must fix before deploy  
- **Test files in wrong location** → Immediate refactoring required
- **Incomplete JSDoc** → Documentation review failure
- **Outdated specifications** → Architecture review failure, must update specs with changes

These policies ensure code quality, maintainability, team consistency, and architectural alignment across the entire Crewly project.