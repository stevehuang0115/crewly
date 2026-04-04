/**
 * Tests for User Input Validation
 *
 * Comprehensive tests for all validation paths including edge cases.
 *
 * @module controllers/user/user-validation.test
 */

import {
  validateUsername,
  validateEmail,
  validatePassword,
  validateCreateUserInput,
} from './user-validation.js';

// =============================================================================
// Username Validation
// =============================================================================

describe('validateUsername', () => {
  it('should accept a valid alphanumeric username', () => {
    const result = validateUsername('john_doe');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.data).toBe('john_doe');
  });

  it('should accept hyphens in username', () => {
    const result = validateUsername('john-doe');
    expect(result.valid).toBe(true);
  });

  it('should trim whitespace', () => {
    const result = validateUsername('  alice  ');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.data).toBe('alice');
  });

  it('should reject null', () => {
    const result = validateUsername(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.field).toBe('username');
      expect(result.error.error).toContain('required');
    }
  });

  it('should reject undefined', () => {
    const result = validateUsername(undefined);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.error).toContain('required');
  });

  it('should reject empty string', () => {
    const result = validateUsername('');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.error).toContain('required');
  });

  it('should reject whitespace-only string', () => {
    const result = validateUsername('   ');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.error).toContain('required');
  });

  it('should reject non-string types', () => {
    expect(validateUsername(123).valid).toBe(false);
    expect(validateUsername(true).valid).toBe(false);
    expect(validateUsername({}).valid).toBe(false);
    expect(validateUsername([]).valid).toBe(false);
  });

  it('should reject username shorter than 3 chars', () => {
    const result = validateUsername('ab');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.error).toContain('at least 3');
  });

  it('should accept username of exactly 3 chars', () => {
    expect(validateUsername('abc').valid).toBe(true);
  });

  it('should reject username longer than 32 chars', () => {
    const result = validateUsername('a'.repeat(33));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.error).toContain('at most 32');
  });

  it('should accept username of exactly 32 chars', () => {
    expect(validateUsername('a'.repeat(32)).valid).toBe(true);
  });

  it('should reject special characters', () => {
    expect(validateUsername('john@doe').valid).toBe(false);
    expect(validateUsername('john doe').valid).toBe(false);
    expect(validateUsername('john.doe').valid).toBe(false);
    expect(validateUsername('john!').valid).toBe(false);
  });

  it('should include field name in error', () => {
    const result = validateUsername('');
    if (!result.valid) {
      expect(result.error.field).toBe('username');
    }
  });
});

// =============================================================================
// Email Validation
// =============================================================================

describe('validateEmail', () => {
  it('should accept a valid email', () => {
    const result = validateEmail('user@example.com');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.data).toBe('user@example.com');
  });

  it('should normalize to lowercase', () => {
    const result = validateEmail('User@Example.COM');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.data).toBe('user@example.com');
  });

  it('should trim whitespace', () => {
    const result = validateEmail('  user@example.com  ');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.data).toBe('user@example.com');
  });

  it('should reject null', () => {
    const result = validateEmail(null);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.error).toContain('required');
  });

  it('should reject undefined', () => {
    expect(validateEmail(undefined).valid).toBe(false);
  });

  it('should reject empty string', () => {
    expect(validateEmail('').valid).toBe(false);
  });

  it('should reject whitespace-only string', () => {
    expect(validateEmail('   ').valid).toBe(false);
  });

  it('should reject non-string types', () => {
    expect(validateEmail(123).valid).toBe(false);
    expect(validateEmail(true).valid).toBe(false);
    expect(validateEmail({}).valid).toBe(false);
  });

  it('should reject email without @', () => {
    const result = validateEmail('userexample.com');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.error).toContain('@');
  });

  it('should reject email with no domain', () => {
    expect(validateEmail('user@').valid).toBe(false);
  });

  it('should reject email with no local part', () => {
    expect(validateEmail('@example.com').valid).toBe(false);
  });

  it('should reject email with spaces', () => {
    expect(validateEmail('user @example.com').valid).toBe(false);
  });

  it('should accept email with subdomain', () => {
    expect(validateEmail('user@mail.example.com').valid).toBe(true);
  });

  it('should accept email with + and dots in local part', () => {
    expect(validateEmail('user.name+tag@example.com').valid).toBe(true);
  });

  it('should include field name in error', () => {
    const result = validateEmail('bad');
    if (!result.valid) {
      expect(result.error.field).toBe('email');
    }
  });
});

// =============================================================================
// Password Validation
// =============================================================================

describe('validatePassword', () => {
  it('should accept a valid password', () => {
    const result = validatePassword('SecureP@ss1');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.data).toBe('SecureP@ss1');
  });

  it('should accept password of exactly 8 chars', () => {
    expect(validatePassword('12345678').valid).toBe(true);
  });

  it('should preserve spaces in password (not trim)', () => {
    const result = validatePassword('pass word123');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.data).toBe('pass word123');
  });

  it('should reject null', () => {
    const result = validatePassword(null);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.error).toContain('required');
  });

  it('should reject undefined', () => {
    expect(validatePassword(undefined).valid).toBe(false);
  });

  it('should reject empty string', () => {
    const result = validatePassword('');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.error).toContain('required');
  });

  it('should reject non-string types', () => {
    expect(validatePassword(12345678).valid).toBe(false);
    expect(validatePassword(true).valid).toBe(false);
    expect(validatePassword({}).valid).toBe(false);
  });

  it('should reject password shorter than 8 chars', () => {
    const result = validatePassword('short');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.error).toContain('at least 8');
  });

  it('should reject password of 7 chars', () => {
    expect(validatePassword('1234567').valid).toBe(false);
  });

  it('should include field name in error', () => {
    const result = validatePassword('');
    if (!result.valid) {
      expect(result.error.field).toBe('password');
    }
  });
});

// =============================================================================
// Composite Validation
// =============================================================================

describe('validateCreateUserInput', () => {
  const validInput = {
    username: 'john_doe',
    email: 'john@example.com',
    password: 'securepass123',
  };

  it('should accept valid input', () => {
    const result = validateCreateUserInput(validInput);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.username).toBe('john_doe');
      expect(result.data.email).toBe('john@example.com');
      expect(result.data.password).toBe('securepass123');
    }
  });

  it('should normalize email and trim username', () => {
    const result = validateCreateUserInput({
      username: '  Alice  ',
      email: '  ALICE@EXAMPLE.COM  ',
      password: 'password123',
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.username).toBe('Alice');
      expect(result.data.email).toBe('alice@example.com');
    }
  });

  it('should reject null body', () => {
    const result = validateCreateUserInput(null);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.error).toContain('body is required');
  });

  it('should reject undefined body', () => {
    expect(validateCreateUserInput(undefined).valid).toBe(false);
  });

  it('should reject non-object body', () => {
    expect(validateCreateUserInput('string').valid).toBe(false);
    expect(validateCreateUserInput(42).valid).toBe(false);
  });

  it('should report username error first when both username and email are invalid', () => {
    const result = validateCreateUserInput({
      username: '',
      email: 'bad',
      password: 'short',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.field).toBe('username');
  });

  it('should report email error when username is valid but email is invalid', () => {
    const result = validateCreateUserInput({
      username: 'valid',
      email: 'bad',
      password: 'longpassword',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.field).toBe('email');
  });

  it('should report password error when username and email are valid', () => {
    const result = validateCreateUserInput({
      username: 'valid',
      email: 'valid@example.com',
      password: 'short',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.field).toBe('password');
  });

  it('should reject when username is missing', () => {
    const result = validateCreateUserInput({
      email: 'test@example.com',
      password: 'longpassword',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.field).toBe('username');
  });

  it('should reject when email is missing', () => {
    const result = validateCreateUserInput({
      username: 'testuser',
      password: 'longpassword',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.field).toBe('email');
  });

  it('should reject when password is missing', () => {
    const result = validateCreateUserInput({
      username: 'testuser',
      email: 'test@example.com',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.field).toBe('password');
  });
});
