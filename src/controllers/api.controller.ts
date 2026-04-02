/**
 * API Controller with error handling issues.
 */
import { AppService } from '../services/app.service.js';
import { validateEmail, validateOrderTotal } from '../utils/validators.js';

interface OrderItem {
  productId: string;
  quantity: number;
  price: number;
}



export function createUser(name: string, email: string) {
  const appService = new AppService();
  try {
    if (typeof name !== 'string' || name.trim() === '') {
      return appService.formatError('Name is required');
    }
    if (typeof email !== 'string' || email.trim() === '') {
      return appService.formatError('Email is required');
    }
    if (!validateEmail(email)) {
      return appService.formatError('Invalid email format');
    }
    const user = appService.createUser(name, email);
    return appService.formatResponse(user);
  } catch (error) {
    return appService.formatError(error instanceof Error ? error.message : 'An unknown error occurred');
  }
}

export function getUser(id: string) {
  const appService = new AppService();
  try {
    const user = appService.getUser(id);
    if (!user) {
      return appService.formatError('User not found');
    }
    return appService.formatResponse(user);
  } catch (error) {
    return appService.formatError(error instanceof Error ? error.message : 'An unknown error occurred');
  }
}

export function createOrder(userId: string, items: OrderItem[]) {
  const appService = new AppService();
  try {
    if (!validateOrderTotal(items)) {
      return appService.formatError('Invalid order items');
    }
    const order = appService.createOrder(userId, items);
    return appService.formatResponse(order);
  } catch (error) {
    return appService.formatError(error instanceof Error ? error.message : 'An unknown error occurred');
  }
}
