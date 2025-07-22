import { Router } from 'express';
import { ServerAPI } from '../lib/server-api';

export const apiRouter = Router();

apiRouter.post('/api/verify-token', (req, res) => {
  void ServerAPI.verifyToken(req, res);
});

apiRouter.get('/api/zones', (req, res) => {
  void ServerAPI.getZones(req, res);
});

apiRouter.get('/api/zones/:zone/dns_records', (req, res) => {
  void ServerAPI.getDNSRecords(req, res);
});

apiRouter.post('/api/zones/:zone/dns_records', (req, res) => {
  void ServerAPI.createDNSRecord(req, res);
});

apiRouter.put('/api/zones/:zone/dns_records/:id', (req, res) => {
  void ServerAPI.updateDNSRecord(req, res);
});

apiRouter.delete('/api/zones/:zone/dns_records/:id', (req, res) => {
  void ServerAPI.deleteDNSRecord(req, res);
});

