import { Router } from 'express';
import { ServerAPI } from '../lib/server-api';
import { asyncHandler } from '../lib/async-handler';

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

