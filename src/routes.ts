import { Router } from 'express';
import { requireAuth } from './middleware/auth';
import { analyticsRouter } from './modules/analytics/analytics.routes';
import { authRouter } from './modules/auth/auth.routes';
import { budgetsRouter } from './modules/budgets/budgets.routes';
import { payeesRouter } from './modules/payees/payees.routes';
import { pdfPasswordsRouter } from './modules/pdfPasswords/pdfPasswords.routes';
import { statementsRouter } from './modules/statements/statements.routes';
import { transactionsRouter } from './modules/transactions/transactions.routes';
import { usersRouter } from './modules/users/users.routes';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);

// everything below needs a valid access token
apiRouter.use(requireAuth);
apiRouter.use('/users', usersRouter);
apiRouter.use('/pdf-passwords', pdfPasswordsRouter);
apiRouter.use('/statements', statementsRouter);
apiRouter.use('/transactions', transactionsRouter);
apiRouter.use('/budgets', budgetsRouter);
apiRouter.use('/analytics', analyticsRouter);
apiRouter.use('/payees', payeesRouter);
