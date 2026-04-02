import { v4 as uuidv4 } from 'uuid';

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  createdAt: Date;
}

const users: UserRecord[] = [];

export const createUser = (username: string, email: string): UserRecord => {
  if (!username || !email) {
    throw new Error('Username and email are required');
  }

  const newUser: UserRecord = {
    id: uuidv4(),
    username,
    email,
    createdAt: new Date(),
  };

  users.push(newUser);
  return newUser;
};

export const validateUser = (id: string): UserRecord | undefined => {
  return users.find(user => user.id === id);
};
