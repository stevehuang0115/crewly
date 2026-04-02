export interface User {
  id: string;
  name: string;
  email: string;
}

export function createUser(name: string, email: string): User {
  return { id: String(Date.now()), name, email };
}

export function validateEmail(email: any): boolean {
  return email.includes('@');
}
