import { Router } from 'express';
import { ServerAPI } from '../lib/server-api';
import { asyncHandler } from '../lib/async-handler';

/**
 * Express router wiring the API endpoints used by the client and server.
 * The endpoints are implemented in `ServerAPI` and wrapped in `asyncHandler`
 * to forward errors to the global error middleware.
 */
export const apiRouter = Router();

apiRouter.post('/api/verify-token', asyncHandler(ServerAPI.verifyToken()));

apiRouter.get('/api/zones', asyncHandler(ServerAPI.getZones()));

apiRouter.get(
  '/api/zones/:zone/dns_records',
  asyncHandler(ServerAPI.getDNSRecords()),
);

apiRouter.post(
  '/api/zones/:zone/dns_records',
  asyncHandler(ServerAPI.createDNSRecord()),
);

apiRouter.put(
  '/api/zones/:zone/dns_records/:id',
  asyncHandler(ServerAPI.updateDNSRecord()),
);

apiRouter.delete(
  '/api/zones/:zone/dns_records/:id',
  asyncHandler(ServerAPI.deleteDNSRecord()),
);

