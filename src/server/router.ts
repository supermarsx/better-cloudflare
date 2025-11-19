import { Router } from 'express';
import { ServerAPI } from '../lib/server-api';
import { asyncHandler } from '../lib/async-handler';

/**
 * Express router wiring the API endpoints used by the client and server.
 * The endpoints are implemented in `ServerAPI` and wrapped in `asyncHandler`
 * to forward errors to the global error middleware.
 */
/**
 * Router containing API endpoints for the express server.
 *
 * Endpoints:
 * - POST /api/verify-token
 * - GET /api/zones
 * - GET /api/zones/:zone/dns_records
 * - POST /api/zones/:zone/dns_records
 * - PUT /api/zones/:zone/dns_records/:id
 * - DELETE /api/zones/:zone/dns_records/:id
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

