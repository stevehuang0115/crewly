import { Request, Response } from 'express';
import { createUser, validateUser } from '../services/user.service';

export function createUserHandler(req: Request, res: Response) {
  const user = req.body;
  if (!validateUser(user)) {
    return res.status(400).send({ message: 'Invalid user' });
  }
  const newUser = createUser(user);
  res.status(201).send(newUser);
}
