import { createUser, validateUser } from './user.service';

export const handleCreateUser = (username: string, email: string) => {
  try {
    const newUser = createUser(username, email);
    return { success: true, user: newUser };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
};

export const handleValidateUser = (id: string) => {
  const user = validateUser(id);
  if (user) {
    return { success: true, user };
  } else {
    return { success: false, error: 'User not found' };
  }
};
