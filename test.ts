import { createUser, getUser, createOrder } from './src/controllers/api.controller';
import { AppService } from './src/services/app.service';

const appService = new AppService();

// Test cases for createUser
console.log('--- Testing createUser ---');
console.log(createUser('John Doe', 'john.doe@example.com')); // Valid
console.log(createUser('', 'jane.doe@example.com')); // Invalid name
console.log(createUser('Jane Doe', '')); // Invalid email
console.log(createUser('Jane Doe', 'invalid-email')); // Invalid email format

// Test cases for getUser
console.log('\n--- Testing getUser ---');
const user = appService.createUser('Test User', 'test.user@example.com');
console.log(getUser(user.id)); // Valid user
console.log(getUser('non-existent-id')); // Non-existent user

// Test cases for createOrder
console.log('\n--- Testing createOrder ---');
const orderItems = [
  { productId: 'prod1', quantity: 2, price: 10 },
  { productId: 'prod2', quantity: 1, price: 20 },
];
console.log(createOrder(user.id, orderItems)); // Valid order
console.log(createOrder(user.id, [])); // Invalid order items
