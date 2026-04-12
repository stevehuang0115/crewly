/**
 * User Input Validation
 *
 * Validates request bodies for the /api/users endpoint.
 * Provides field-level validation with structured error responses.
 *
 * @module controllers/user/user-validation
 */

// =============================================================================
// Constants
// =============================================================================

/** Minimum password length */
const MIN_PASSWORD_LENGTH = 8;

/** Maximum username length */
const MAX_USERNAME_LENGTH = 32;

/** Minimum username length */
const MIN_USERNAME_LENGTH = 3;

/** Username pattern: alphanumeric, underscores, hyphens */
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Email validation pattern (RFC 5322 simplified) */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// =============================================================================
// Types
// =============================================================================

/**
 * Structured validation error
 */
export interface ValidationError {
  /** Error message */
  error: string;
  /** Field that failed validation */
  field?: string;
}

/**
 * Validation result — either valid with cleaned data, or invalid with error
 */
export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; error: ValidationError };

/**
 * Validated user creation input
 */
export interface ValidatedUserInput {
  username: string;
  email: string;
  password: string;
}

// =============================================================================
// Field Validators
// =============================================================================

/**
 * Validate the username field.
 *
 * Rules:
 * - Required, non-empty
 * - Must be a string
 * - Alphanumeric, underscores, hyphens only
 * - Length between 3 and 32 characters
 * - Trimmed of whitespace
 *
 * @param value - Raw username value
 * @returns Validation result with trimmed username or error
 */
export function validateUsername(value: unknown): ValidationResult<string> {
  if (value === null || value === undefined) {
    return { valid: false, error: { error: 'username is required', field: 'username' } };
  }

  if (typeof value !== 'string') {
    return { valid: false, error: { error: 'username must be a string', field: 'username' } };
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: { error: 'username is required', field: 'username' } };
  }

  if (trimmed.length < MIN_USERNAME_LENGTH) {
    return {
      valid: false,
      error: { error: `username must be at least ${MIN_USERNAME_LENGTH} characters`, field: 'username' },
    };
  }

  if (trimmed.length > MAX_USERNAME_LENGTH) {
    return {
      valid: false,
      error: { error: `username must be at most ${MAX_USERNAME_LENGTH} characters`, field: 'username' },
    };
  }

  if (!USERNAME_PATTERN.test(trimmed)) {
    return {
      valid: false,
      error: { error: 'username must contain only letters, numbers, underscores, and hyphens', field: 'username' },
    };
  }

  return { valid: true, data: trimmed };
}

/**
 * Validate the email field.
 *
 * Rules:
 * - Required, non-empty
 * - Must be a string
 * - Must contain @ and match email format
 * - Trimmed and lowercased
 *
 * @param value - Raw email value
 * @returns Validation result with normalized email or error
 */
export function validateEmail(value: unknown): ValidationResult<string> {
  if (value === null || value === undefined) {
    return { valid: false, error: { error: 'email is required', field: 'email' } };
  }

  if (typeof value !== 'string') {
    return { valid: false, error: { error: 'email must be a string', field: 'email' } };
  }

  const trimmed = value.trim().toLowerCase();

  if (trimmed.length === 0) {
    return { valid: false, error: { error: 'email is required', field: 'email' } };
  }

  if (!trimmed.includes('@')) {
    return { valid: false, error: { error: 'email must contain @', field: 'email' } };
  }

  if (!EMAIL_PATTERN.test(trimmed)) {
    return { valid: false, error: { error: 'email format is invalid', field: 'email' } };
  }

  return { valid: true, data: trimmed };
}

/**
 * Validate the password field.
 *
 * Rules:
 * - Required, non-empty
 * - Must be a string
 * - Minimum 8 characters
 * - Not trimmed (spaces in passwords are intentional)
 *
 * @param value - Raw password value
 * @returns Validation result with password or error
 */
export function validatePassword(value: unknown): ValidationResult<string> {
  if (value === null || value === undefined) {
    return { valid: false, error: { error: 'password is required', field: 'password' } };
  }

  if (typeof value !== 'string') {
    return { valid: false, error: { error: 'password must be a string', field: 'password' } };
  }

  if (value.length === 0) {
    return { valid: false, error: { error: 'password is required', field: 'password' } };
  }

  if (value.length < MIN_PASSWORD_LENGTH) {
    return {
      valid: false,
      error: { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters`, field: 'password' },
    };
  }

  return { valid: true, data: value };
}

// =============================================================================
// Composite Validator
// =============================================================================

/**
 * Validate a complete user creation request body.
 *
 * Validates all three required fields (username, email, password) and
 * returns the first error encountered, or cleaned data on success.
 *
 * @param body - Raw request body
 * @returns Validation result with all validated fields or first error
 */
export function validateCreateUserInput(body: unknown): ValidationResult<ValidatedUserInput> {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: { error: 'Request body is required' } };
  }

  const obj = body as Record<string, unknown>;

  const usernameResult = validateUsername(obj.username);
  if (!usernameResult.valid) return usernameResult;

  const emailResult = validateEmail(obj.email);
  if (!emailResult.valid) return emailResult;

  const passwordResult = validatePassword(obj.password);
  if (!passwordResult.valid) return passwordResult;

  return {
    valid: true,
    data: {
      username: usernameResult.data,
      email: emailResult.data,
      password: passwordResult.data,
    },
  };
}
