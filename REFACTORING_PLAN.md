# Refactoring Plan for AppService

This document outlines a plan to refactor the `AppService` god class into smaller, more focused services.

## 1. Identified Code Smells

1.  **God Class:** The `AppService` class has too many responsibilities, including user management, order management, validation, logging, caching, and response formatting. This violates the Single Responsibility Principle (SRP).
2.  **Mixed Concerns:** Business logic is tightly coupled with cross-cutting concerns like logging, caching, and validation. For example, `createUser` directly calls `this.log`.
3.  **In-Memory State:** The service manages state in-memory (`users`, `orders`, `cache`, `logs`), which is not scalable or persistent. While a full database implementation is out of scope for this refactoring, we will structure the code to make it easier to add persistence later.
4.  **Lack of Separation of Concerns:** The class mixes different domains (users, orders) and infrastructure concerns (caching, logging) in a single file, making it hard to maintain and test.

## 2. Proposed Service Decomposition

To address these smells, we will decompose the `AppService` into the following services:

*   `src/services/user.service.ts`: Manages user data and business logic.
*   `src/services/order.service.ts`: Manages order data and business logic.
*   `src/services/cache.service.ts`: Provides a generic caching mechanism.
*   `src/services/logging.service.ts`: Provides a simple logging mechanism.
*   `src/utils/validation.util.ts`: Contains pure validation functions.
*   `src/utils/response.util.ts`: Contains functions for formatting API responses.

## 3. New Service Definitions

### `user.service.ts`
*   **Responsibility:** Handles all user-related operations.
*   **Methods to move:**
    *   `createUser(name: string, email: string): User`
    *   `getUser(id: string): User | undefined`

### `order.service.ts`
*   **Responsibility:** Handles all order-related operations.
*   **Methods to move:**
    *   `createOrder(userId: string, items: ...): Order`
    *   `getOrder(id: string): Order | undefined`

### `cache.service.ts`
*   **Responsibility:** Provides a simple key-value cache.
*   **Methods to move:**
    *   `get<T>(key: string): T | undefined` (from `this.cache.get`)
    *   `set<T>(key: string, value: T): void` (from `this.cache.set`)
    *   `clear(): void` (from `clearCache`)
    *   `getSize(): number` (from `getCacheSize`)

### `logging.service.ts`
*   **Responsibility:** Provides a simple logging service.
*   **Methods to move:**
    *   `log(message: string): void`
    *   `getLogs(): string[]`

### `validation.util.ts`
*   **Responsibility:** Provides pure functions for data validation.
*   **Methods to move:**
    *   `validateEmail(email: string): boolean`
    *   `validateOrderTotal(items: ...): boolean`

### `response.util.ts`
*   **Responsibility:** Provides utility functions for formatting API responses.
*   **Methods to move:**
    *   `formatResponse<T>(data: T): ApiResponse<T>`
    *   `formatError(error: string): ApiResponse<never>`

## 4. Migration Steps

To refactor the application without breaking it, we will follow these steps:

1.  **Create New Files:** Create the new files for the services and utilities listed above.
2.  **Move Pure Functions:** Start with the easiest parts: move the pure functions `validateEmail`, `validateOrderTotal`, `formatResponse`, and `formatError` to their respective utility files (`validation.util.ts`, `response.util.ts`). These have no dependencies on the `AppService` state.
3.  **Extract Logging Service:** Create the `LoggingService` and instantiate it inside `AppService`. Replace calls to `this.log` with `this.loggingService.log`.
4.  **Extract Caching Service:** Create the `CacheService` and instantiate it inside `AppService`. Replace calls to `this.cache` with `this.cacheService`.
5.  **Extract User Service:** Create the `UserService`. It will initially be a simple class. Move the `users` map and the `createUser` and `getUser` methods into it. The `UserService` will need to depend on the `LoggingService` and `CacheService`.
6.  **Extract Order Service:** Create the `OrderService` and move the `orders` map and the `createOrder` and `getOrder` methods into it. The `OrderService` will depend on the `LoggingService`.
7.  **Update `AppService`:** The `AppService` will now become a thin layer that orchestrates calls to the other services. It will no longer have any business logic or state of its own. It will be responsible for instantiating the other services and wiring them together.
8.  **Update `ApiController`:** The controller will need to be updated to inject and use the new services instead of the `AppService` directly for business logic, or continue to use `AppService` as a facade. For this refactoring, we'll keep `AppService` as a facade to minimize changes to the controller.

## 5. Risk Assessment

*   **Medium Risk:** The refactoring touches a central part of the application. The main risk is breaking existing functionality if dependencies are not wired correctly or if logic is moved incorrectly.
*   **Mitigation:**
    *   **Incremental Approach:** We will follow the migration steps carefully, moving one piece of functionality at a time.
    *   **Testing:** After each step, we will need to run existing tests (if any) or manually test the application to ensure that the functionality is still working as expected. Since there are no tests in this project, manual testing will be crucial.
    *   **Code Reviews:** In a team setting, each step of the refactoring would be reviewed by another developer.
*   **Potential Blockers:**
    *   **Circular Dependencies:** We need to be careful to avoid circular dependencies between the new services. The proposed structure (`UserService` depends on `LoggingService` and `CacheService`, `OrderService` depends on `LoggingService`) should avoid this.
    *   **Hidden Dependencies:** There might be hidden dependencies in the code that are not immediately obvious. Careful analysis of the code is required.

This plan provides a clear path to a more modular and maintainable architecture.
