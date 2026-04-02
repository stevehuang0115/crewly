export const validateEmail = (email: string): boolean => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

export const validateOrderTotal = (items: { price: number; quantity: number }[]): boolean => {
  return items.every(i => i.price > 0 && i.quantity > 0);
};
