import { Router } from 'express';

import { login, loginSchema, logout, me, register, registerSchema } from '../controllers/authController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';

export const authRouter = Router();

authRouter.post('/register', validate(registerSchema), register);
authRouter.post('/login', validate(loginSchema), login);
authRouter.post('/logout', logout);
authRouter.get('/me', requireAuth, me);
