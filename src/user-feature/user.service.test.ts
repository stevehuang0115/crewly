import { createUser, validateUser, UserRecord } from './user.service';

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const testCreateUser = () => {
  console.log('Running test: testCreateUser');
  const username = 'testuser';
  const email = 'test@example.com';
  const user = createUser(username, email);

  assert(user.username === username, 'createUser should set the username correctly');
  assert(user.email === email, 'createUser should set the email correctly');
  assert(typeof user.id === 'string', 'createUser should assign a string ID');
  assert(user.createdAt instanceof Date, 'createUser should set a creation date');
  console.log('testCreateUser passed');
};

const testValidateUser = () => {
  console.log('Running test: testValidateUser');
  const username = 'validuser';
  const email = 'valid@example.com';
  const user = createUser(username, email);

  const foundUser = validateUser(user.id);
  assert(foundUser !== undefined, 'validateUser should find an existing user');
  assert(foundUser?.id === user.id, 'validateUser should find the correct user by ID');

  const notFoundUser = validateUser('non-existent-id');
  assert(notFoundUser === undefined, 'validateUser should return undefined for a non-existent user');
  console.log('testValidateUser passed');
};

const runTests = () => {
  try {
    testCreateUser();
    testValidateUser();
    console.log('All user service tests passed!');
  } catch (error) {
    console.error('User service tests failed:', (error as Error).message);
  }
};

runTests();
