import { Request, Response } from 'express';

export const getHealth = async (req: Request, res: Response): Promise<Response> => {
  try {
    return res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: 'Internal Server Error',
    });
  }
};
