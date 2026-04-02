export const formatResult = (value: number): string => {
  if (value > 0) {
    return `Positive: ${value}`;
  } else if (value < 0) {
    return `Negative: ${value}`;
  } else {
    return `Zero`;
  }
};

export const isPositive = (value: number): boolean => {
  return value > 0;
};
