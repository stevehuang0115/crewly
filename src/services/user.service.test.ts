import { createUser, validateUser, UserRecord } from './user.service';
import { db } from './data.service';

// Mock the db
jest.mock('./data.service', () => ({
  db: {
    users: [],
  },
}));

describe('User Service', () => {
  beforeEach(() => {
    db.users = [];
  });

  describe('createUser', () => {
    it('should create a new user and return it', () => {
      const user = {
        name: 'John Doe',
        email: 'john.doe@example.com',
      };
      const newUser = createUser(user);
      expect(newUser).toHaveProperty('id');
      expect(newUser.name).toBe(user.name);
      expect(newUser.email).toBe(user.email);
      expect(db.users).toContain(newUser);
    });
  });

  describe('validateUser', () => {
    it('should return true for a valid user', () => {
      const user: UserRecord = {
        id: '1',
        name: 'John Doe',
        email: 'john.doe@example.com',
      };
      expect(validateUser(user)).toBe(true);
    });

    it('should return false for a user with no name', () => {
      const user: UserRecord = {
        id: '1',
        name: '',
        email: 'john.doe@example.com',
      };
      expect(validateUser(user)).toBe(false);
    });

    it('should return false for a user with no email', () => {
      const user: UserRecord = {
        id: '1',
        name: 'John Doe',
        email: '',
      };
      expect(validateUser(user)).toBe(false);
    });
  });
});
